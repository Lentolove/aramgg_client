<template>
  <div class="mo-root">
    <header class="mo-header">
      <img
        v-if="championId"
        class="mo-champion-icon"
        :src="getChampionSquareIconUrl(championId)"
        alt=""
      >
      <div class="mo-title">
        <div class="mo-champion-name">{{ championLabel }}</div>
        <div class="mo-subtitle">{{ phaseLabel }}</div>
      </div>
      <button
        class="mo-btn mo-btn-primary mo-no-drag"
        :disabled="state.refreshing"
        :title="`快捷键：${hotkeyLabel}`"
        @click="refresh"
      >
        {{ state.refreshing ? '识别中…' : '刷新' }}
      </button>
      <button class="mo-btn mo-icon-btn mo-no-drag" title="设置" @click="showSettings = !showSettings">⚙</button>
      <button class="mo-btn mo-icon-btn mo-no-drag" title="隐藏（快捷键可再次唤出）" @click="hide">×</button>
    </header>

    <div class="mo-body">
      <div class="mo-hint">
        <span>三选一出现时点「刷新」或按 <b>{{ hotkeyLabel }}</b></span>
        <span v-if="!state.hotkeyRegistered" class="mo-warn">（{{ state.hotkeyError || '快捷键未注册' }}）</span>
      </div>
      <div v-if="state.lastError" class="mo-status mo-warn">{{ state.lastError }}</div>
      <div v-if="championError" class="mo-status mo-warn">{{ championError }}</div>

      <!-- 设置 -->
      <section v-if="showSettings" class="mo-section mo-settings mo-no-drag">
        <label class="mo-setting">
          <input v-model="settings.autoScreenshot" type="checkbox" @change="saveSettings">
          <span>持续自动截图（旧模式，默认关闭）</span>
        </label>
        <label class="mo-setting">
          <input v-model="settings.showInChampSelect" type="checkbox" @change="saveSettings">
          <span>选人阶段也显示浮窗</span>
        </label>
        <label class="mo-setting">
          <span>刷新快捷键</span>
          <select v-model="settings.hotkey" @change="saveSettings">
            <option v-for="option in hotkeyOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label class="mo-setting">
          <span>样本收缩强度 α</span>
          <select v-model.number="settings.shrinkageAlpha" @change="saveSettings">
            <option v-for="value in alphaOptions" :key="value" :value="value">{{ value }}</option>
          </select>
        </label>
        <label class="mo-setting">
          <input v-model="settings.focusable" type="checkbox" @change="saveSettings">
          <span>浮窗可获得焦点（重启生效；默认关闭以免抢游戏焦点）</span>
        </label>
        <div class="mo-setting">
          <button class="mo-btn" @click="resetGame">清空本局记录</button>
        </div>
      </section>

      <!-- 三选一 -->
      <section v-if="rankedCards.length" class="mo-section">
        <div class="mo-section-title">
          <span>本次三选一</span>
          <span class="mo-muted">{{ ranking.summary }}</span>
        </div>
        <div class="mo-cards">
          <button
            v-for="entry in rankedCards"
            :key="entry.card.id"
            class="mo-card mo-no-drag"
            :class="cardClass(entry)"
            title="点击标记为已选"
            @click="pick(entry.card)"
          >
            <img v-if="entry.card.iconPath" class="mo-card-icon" :src="getAugmentIconUrl(entry.card.iconPath)" alt="">
            <div class="mo-card-main">
              <div class="mo-card-name">
                <span>{{ entry.card.name }}</span>
                <span v-if="entry.relativeLabel" class="mo-badge" :class="badgeClass(entry)">{{ entry.relativeLabel }}</span>
              </div>
              <div class="mo-card-stats">
                <template v-if="entry.method === 'shrunk'">
                  <span title="收缩后胜率">{{ formatPercent(entry.shrunkWinRate) }}</span>
                  <span :class="deltaClass(entry.delta)" title="相对基准（百分点）">{{ formatDelta(entry.delta) }}</span>
                  <span class="mo-muted">{{ entry.games }} 场 · 原始 {{ formatPercent(entry.rawWinRate) }}</span>
                </template>
                <span v-else class="mo-muted">{{ entry.note }}</span>
              </div>
            </div>
          </button>
        </div>
        <div class="mo-footnote">
          <span v-if="ranking.method === 'rank-fallback'">⚠ 无胜率数据：按热度排序，仅供参考</span>
          <span v-else-if="ranking.baselineWinRate != null">
            收缩胜率 = (胜场 + α×{{ ranking.baselineSource === 'cards' ? '三卡平均' : '英雄平均' }}) / (场次 + α)，α={{ ranking.alpha }}，基准 {{ formatPercent(ranking.baselineWinRate) }}
          </span>
          <button class="mo-link mo-no-drag" @click="clearCandidates">清除</button>
        </div>
      </section>

      <!-- 已选海克斯 -->
      <section class="mo-section">
        <div class="mo-section-title">
          <span>本局已选海克斯</span>
          <span class="mo-muted">{{ state.picked.length ? '点 × 移除' : '点上方卡片标记' }}</span>
        </div>
        <div v-if="state.picked.length" class="mo-chips">
          <span v-for="augment in state.picked" :key="augment.id" class="mo-chip">
            <img v-if="augment.iconPath" :src="getAugmentIconUrl(augment.iconPath)" alt="">
            <span>{{ augment.name }}</span>
            <button class="mo-chip-x mo-no-drag" title="移除" @click="unpick(augment.id)">×</button>
          </span>
        </div>
        <div v-else class="mo-muted mo-empty">还没有记录</div>
      </section>

      <!-- 出装 -->
      <section class="mo-section">
        <div class="mo-section-title">
          <span>推荐出装</span>
          <span class="mo-muted">{{ liveLabel }}</span>
        </div>
        <div v-if="championLoading" class="mo-muted mo-empty">加载英雄数据…</div>
        <template v-else>
          <div v-if="tagSummary" class="mo-tags">倾向：{{ tagSummary }}</div>
          <ol v-if="build.items.length" class="mo-items">
            <li
              v-for="item in build.items"
              :key="item.itemId"
              class="mo-item"
              :class="{ 'mo-item-owned': item.owned, 'mo-item-next': item.isNext }"
            >
              <img class="mo-item-icon" :src="item.iconUrl || getItemIconUrl(item.itemId)" alt="">
              <div class="mo-item-main">
                <div class="mo-item-name">
                  <span>{{ item.name }}</span>
                  <span v-if="item.isNext" class="mo-badge mo-badge-next">下一件</span>
                  <span v-else-if="item.owned" class="mo-badge mo-badge-owned">已有</span>
                </div>
                <div v-for="(reason, index) in item.reasons" :key="index" class="mo-item-reason">{{ reason }}</div>
              </div>
            </li>
          </ol>
          <div v-for="(note, index) in build.notes" :key="`note-${index}`" class="mo-muted mo-note">{{ note }}</div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { electronAPI, hasElectronAPI } from '../native/electron-api.ts'
import { getAugmentIconUrl, getChampionSquareIconUrl, getItemIconUrl } from '../service/cdn.js'
import {
  rankAugmentChoices,
  type AugmentChoiceInput,
  type RankedAugmentChoice,
} from '../../shared/augment-choice-ranking.ts'
import {
  STAT_TAG_LABELS,
  buildItemIndex,
  recommendBuildForAugments,
  summarizeEnemyDamage,
  type StatTag,
} from '../../shared/augment-build-heuristic.ts'
import type {
  ChampionMonitorState,
  ManualOverlayCandidate,
  ManualOverlayLiveData,
  ManualOverlaySettings,
  ManualOverlayState,
} from '../../shared/ipc-contract.ts'

type CardInput = AugmentChoiceInput & ManualOverlayCandidate & {
  winRate: number | null
  games: number | null
  wins: number | null
  rank: number | null
  tier: number | null
  pickRate: number | null
}

const LIVE_POLL_INTERVAL_MS = 5000

const state = ref<ManualOverlayState>({
  phase: null,
  gameRevision: 0,
  candidates: [],
  picked: [],
  refreshing: false,
  lastRefreshAt: null,
  lastError: null,
  lastCapture: null,
  hotkey: 'CommandOrControl+Shift+R',
  hotkeyRegistered: false,
  hotkeyError: null,
  revision: 0,
})
const settings = reactive<ManualOverlaySettings>({
  autoScreenshot: false,
  hotkey: 'CommandOrControl+Shift+R',
  showInChampSelect: false,
  shrinkageAlpha: 300,
  focusable: false,
})
const showSettings = ref(false)
const championId = ref<number | null>(null)
const championData = ref<Record<string, any> | null>(null)
const championLoading = ref(false)
const championError = ref<string | null>(null)
const live = ref<ManualOverlayLiveData | null>(null)

const hotkeyOptions = [
  { value: 'CommandOrControl+Shift+R', label: 'Ctrl+Shift+R' },
  { value: 'CommandOrControl+Shift+A', label: 'Ctrl+Shift+A' },
  { value: 'CommandOrControl+Alt+R', label: 'Ctrl+Alt+R' },
  { value: 'F8', label: 'F8' },
  { value: 'F10', label: 'F10' },
  { value: 'Pause', label: 'Pause' },
]
const alphaOptions = [0, 100, 300, 600, 1000, 3000]

const unsubscribers: Array<() => void> = []
let livePollTimer: ReturnType<typeof setInterval> | null = null
let championLoadSequence = 0

const hotkeyLabel = computed(() => (state.value.hotkey || '').replace('CommandOrControl', 'Ctrl'))

const phaseLabel = computed(() => {
  const labels: Record<string, string> = {
    ChampSelect: '选人阶段',
    GameStart: '加载中',
    InProgress: '对局中',
    Reconnect: '重连中',
    EndOfGame: '已结束',
  }
  return labels[String(state.value.phase)] || String(state.value.phase || '未连接客户端')
})

const championLabel = computed(() => {
  const name = championData.value?.championName
  return name?.nameCN || name?.nameEN || (championId.value ? `英雄 ${championId.value}` : '未检测到英雄')
})

const augmentStats = computed<Record<string, any>>(() => championData.value?.augmentStats || {})
const augmentBaseById = computed(() => {
  const map = new Map<string, Record<string, any>>()
  for (const augment of championData.value?.augments || []) {
    if (augment?.id != null) map.set(String(augment.id), augment)
  }
  return map
})

const championStatList = computed(() => Object.values(augmentStats.value).map((stat: any) => ({
  winRate: stat?.win_rate ?? null,
  games: stat?.num_games ?? null,
  wins: stat?.num_win_games ?? null,
})))

const ranking = computed(() => {
  const cards: CardInput[] = state.value.candidates.map((candidate) => {
    const stat = augmentStats.value[String(candidate.id)] || {}
    return {
      ...candidate,
      detectedSlot: candidate.slot,
      winRate: stat.win_rate ?? null,
      games: stat.num_games ?? null,
      wins: stat.num_win_games ?? null,
      rank: stat.rank ?? null,
      tier: stat.tier ?? null,
      pickRate: stat.pick_rate ?? null,
    }
  })
  return rankAugmentChoices(cards, championStatList.value, { alpha: settings.shrinkageAlpha })
})

/** 按游戏里的左右顺序展示，标签来自三卡相对排序 */
const rankedCards = computed(() => [...ranking.value.choices].sort((a, b) => a.slot - b.slot))

const itemIndex = computed(() => buildItemIndex(championData.value?.items || []))

const build = computed(() => {
  const pickedAugments = state.value.picked.map((augment) => {
    const base = augmentBaseById.value.get(String(augment.id)) || {}
    return {
      id: augment.id,
      name: augment.name || base.name,
      description: base.description || null,
      tooltip: base.tooltip || null,
    }
  })
  const enemyDamage = live.value?.found
    ? summarizeEnemyDamage(live.value.enemyItemIds, itemIndex.value)
    : null
  return recommendBuildForAugments({
    pickedAugments,
    builds: championData.value?.builds || [],
    items: championData.value?.items || [],
    ownedItemIds: live.value?.found ? live.value.ownedItemIds : [],
    enemyDamage,
    maxItems: 8,
  })
})

const tagSummary = computed(() => Object.entries(build.value.tagWeights)
  .sort((a, b) => Number(b[1]) - Number(a[1]))
  .map(([tag, weight]) => `${STAT_TAG_LABELS[tag as StatTag]}${Number(weight) > 1 ? `×${weight}` : ''}`)
  .join('、'))

const liveLabel = computed(() => {
  if (!live.value) return ''
  if (!live.value.available) return '未读取到游戏内数据'
  if (!live.value.found) return '游戏内未找到自己'
  return `已有 ${live.value.ownedItemIds.length} 件`
})

function formatPercent(value: number | null | undefined) {
  const number = Number(value)
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : '—'
}

function formatDelta(value: number | null | undefined) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  const points = number * 100
  return `${points > 0 ? '+' : points < 0 ? '−' : '±'}${Math.abs(points).toFixed(1)}`
}

function deltaClass(value: number | null | undefined) {
  const number = Number(value)
  return number > 0.0005 ? 'mo-up' : number < -0.0005 ? 'mo-down' : 'mo-muted'
}

function cardClass(entry: RankedAugmentChoice<CardInput>) {
  return {
    'mo-card-best': entry.order === 0 && !ranking.value.topTie,
    'mo-card-tie': ranking.value.topTie && entry.order < 2,
  }
}

function badgeClass(entry: RankedAugmentChoice<CardInput>) {
  if (entry.relativeLabel === '差不多') return 'mo-badge-tie'
  if (entry.relativeLabel === '首选') return 'mo-badge-best'
  return 'mo-badge-plain'
}

function applyState(next: ManualOverlayState | null | undefined) {
  if (next && typeof next.revision === 'number') {
    state.value = next
  }
}

async function refresh() {
  applyState(await electronAPI.manualOverlay.refresh())
}

async function pick(card: ManualOverlayCandidate) {
  applyState(await electronAPI.manualOverlay.pick({
    id: card.id,
    name: card.name,
    rarity: card.rarity ?? null,
    iconPath: card.iconPath ?? null,
  }))
}

async function unpick(id: number | string) {
  applyState(await electronAPI.manualOverlay.unpick(id))
}

async function clearCandidates() {
  applyState(await electronAPI.manualOverlay.clearCandidates())
}

async function resetGame() {
  applyState(await electronAPI.manualOverlay.resetGame())
}

function hide() {
  electronAPI.manualOverlay.hide()
}

async function saveSettings() {
  const saved = await electronAPI.manualOverlay.setSettings({ ...settings })
  Object.assign(settings, saved)
}

async function loadChampion(id: number | null) {
  const sequence = ++championLoadSequence
  championError.value = null
  if (!id) {
    championData.value = null
    return
  }
  championLoading.value = true
  try {
    const result = await electronAPI.winrate.loadChampionData(id)
    if (sequence !== championLoadSequence) return
    if (result?.success && result.data) {
      championData.value = result.data as Record<string, any>
    } else {
      championData.value = null
      championError.value = `英雄数据加载失败：${result?.error || '未知错误'}`
    }
  } catch (error) {
    if (sequence !== championLoadSequence) return
    championError.value = `英雄数据加载失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (sequence === championLoadSequence) championLoading.value = false
  }
}

function applyChampionMonitor(monitor: ChampionMonitorState | null | undefined) {
  const id = Number(monitor?.selectedChampionId ?? monitor?.lastChampionId) || null
  if (id !== championId.value) {
    championId.value = id
  }
}

async function pollLive() {
  if (!['InProgress', 'Reconnect'].includes(String(state.value.phase))) {
    return
  }
  try {
    live.value = await electronAPI.manualOverlay.getLiveData()
  } catch {
    live.value = null
  }
}

watch(championId, (id) => {
  void loadChampion(id)
})

watch(() => state.value.gameRevision, () => {
  live.value = null
})

onMounted(async () => {
  if (!hasElectronAPI()) return
  unsubscribers.push(electronAPI.events.on('manual-overlay-state', applyState))
  unsubscribers.push(electronAPI.events.on('champion-monitor-changed', applyChampionMonitor))
  unsubscribers.push(electronAPI.events.on('locale-changed', () => {
    void loadChampion(championId.value)
  }))

  const [initialState, initialSettings, monitor] = await Promise.all([
    electronAPI.manualOverlay.getState(),
    electronAPI.manualOverlay.getSettings(),
    electronAPI.lcu.getChampionMonitorState(),
  ])
  applyState(initialState)
  Object.assign(settings, initialSettings)
  applyChampionMonitor(monitor)

  void pollLive()
  livePollTimer = setInterval(() => {
    void pollLive()
  }, LIVE_POLL_INTERVAL_MS)
})

onBeforeUnmount(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  if (livePollTimer) clearInterval(livePollTimer)
})
</script>

<style scoped>
.mo-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: rgba(12, 16, 24, 0.94);
  color: #e8e1cf;
  font-size: 12px;
  border: 1px solid rgba(200, 170, 110, 0.45);
  box-sizing: border-box;
  user-select: none;
}
.mo-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: rgba(30, 35, 45, 0.95);
  border-bottom: 1px solid rgba(200, 170, 110, 0.3);
  -webkit-app-region: drag;
}
.mo-no-drag { -webkit-app-region: no-drag; }
.mo-champion-icon { width: 28px; height: 28px; border-radius: 4px; }
.mo-title { flex: 1; min-width: 0; }
.mo-champion-name { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mo-subtitle { color: #8c8c8c; font-size: 11px; }
.mo-body { flex: 1; overflow-y: auto; padding: 6px 8px 10px; }
.mo-btn {
  border: 1px solid rgba(200, 170, 110, 0.5);
  background: rgba(40, 45, 55, 0.9);
  color: #e8e1cf;
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
  font-size: 12px;
}
.mo-btn:disabled { opacity: 0.6; cursor: default; }
.mo-btn-primary { background: #1e6f8f; border-color: #3aa0c8; color: #fff; font-weight: 600; }
.mo-icon-btn { padding: 2px 6px; }
.mo-link { background: none; border: 0; color: #6fb3d2; cursor: pointer; font-size: 11px; padding: 0; }
.mo-hint { color: #9aa0a6; font-size: 11px; margin-bottom: 4px; }
.mo-status { font-size: 11px; margin-bottom: 4px; }
.mo-warn { color: #e0a84a; }
.mo-muted { color: #8c8c8c; font-size: 11px; }
.mo-section { margin-top: 8px; }
.mo-section-title { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; font-weight: 600; margin-bottom: 4px; color: #c8aa6e; }
.mo-settings { display: flex; flex-direction: column; gap: 6px; padding: 6px; background: rgba(255, 255, 255, 0.04); border-radius: 4px; }
.mo-setting { display: flex; align-items: center; gap: 6px; }
.mo-setting select { background: #1b1f27; color: #e8e1cf; border: 1px solid #444; border-radius: 3px; }
.mo-cards { display: flex; flex-direction: column; gap: 4px; }
.mo-card {
  display: flex;
  gap: 6px;
  align-items: center;
  text-align: left;
  padding: 5px 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.03);
  color: inherit;
  cursor: pointer;
}
.mo-card:hover { border-color: rgba(200, 170, 110, 0.6); }
.mo-card-best { border-color: rgba(88, 190, 120, 0.8); background: rgba(88, 190, 120, 0.08); }
.mo-card-tie { border-color: rgba(224, 168, 74, 0.7); }
.mo-card-icon { width: 30px; height: 30px; border-radius: 4px; }
.mo-card-main { flex: 1; min-width: 0; }
.mo-card-name { display: flex; align-items: center; gap: 4px; font-weight: 600; }
.mo-card-stats { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; }
.mo-up { color: #58be78; }
.mo-down { color: #e06060; }
.mo-badge { font-size: 10px; padding: 0 4px; border-radius: 3px; font-weight: 600; }
.mo-badge-best { background: #2f7d4a; color: #fff; }
.mo-badge-tie { background: #8a6420; color: #fff; }
.mo-badge-plain { background: #3a3f4a; color: #ccc; }
.mo-badge-next { background: #1e6f8f; color: #fff; }
.mo-badge-owned { background: #3a3f4a; color: #aaa; }
.mo-footnote { display: flex; justify-content: space-between; gap: 6px; color: #8c8c8c; font-size: 10px; margin-top: 3px; }
.mo-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.mo-chip { display: inline-flex; align-items: center; gap: 3px; padding: 1px 4px; background: rgba(200, 170, 110, 0.15); border-radius: 10px; }
.mo-chip img { width: 16px; height: 16px; border-radius: 50%; }
.mo-chip-x { background: none; border: 0; color: #c8aa6e; cursor: pointer; padding: 0 2px; }
.mo-empty { padding: 2px 0; }
.mo-tags { color: #b0b6c0; font-size: 11px; margin-bottom: 4px; }
.mo-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.mo-item { display: flex; gap: 6px; padding: 3px 4px; border-radius: 4px; }
.mo-item-icon { width: 28px; height: 28px; border-radius: 3px; flex-shrink: 0; }
.mo-item-main { min-width: 0; }
.mo-item-name { display: flex; align-items: center; gap: 4px; }
.mo-item-reason { color: #9aa0a6; font-size: 10px; line-height: 1.35; }
.mo-item-owned { opacity: 0.5; }
.mo-item-next { background: rgba(30, 111, 143, 0.25); border: 1px solid rgba(58, 160, 200, 0.6); }
.mo-note { margin-top: 3px; }
</style>
