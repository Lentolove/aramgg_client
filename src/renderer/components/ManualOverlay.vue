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

    <div
      v-if="reminder?.active"
      class="mo-reminder mo-no-drag"
      :class="{ 'mo-reminder-urgent': reminder.urgent }"
    >
      <span class="mo-reminder-text">
        <b v-if="reminder.urgent">可以刷新了</b>
        <span>{{ reminder.reason }}</span>
      </span>
      <button class="mo-btn mo-btn-primary" :disabled="state.refreshing" @click="refresh">刷新</button>
      <button class="mo-btn" title="本次已处理，不再提醒" @click="acknowledgeReminder">忽略</button>
    </div>

    <div class="mo-body">
      <div class="mo-hint">
        <span>三选一出现时点「刷新」或按 <b>{{ hotkeyLabel }}</b></span>
        <span v-if="state.autoWatching" class="mo-watching">· 自动跟拍中，关掉三选一后自动记录</span>
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
        <label class="mo-setting">
          <input v-model="settings.autoFollowUp" type="checkbox" @change="saveSettings">
          <span>刷新后自动跟拍三选一（2.5 秒一次，最多 45 秒），关闭时自动记录所选</span>
        </label>
        <label class="mo-setting">
          <input v-model="settings.iconMatchEnabled" type="checkbox" @change="saveSettings">
          <span>卡片图标匹配（与文字识别交叉校验）</span>
        </label>
        <label class="mo-setting">
          <input v-model="settings.reminderEnabled" type="checkbox" @change="saveSettings">
          <span>「可以刷新了」提醒（读 2999 等级/阵亡状态，不截图）</span>
        </label>
        <label class="mo-setting">
          <span>海克斯等级</span>
          <select v-model="settings.augmentLevels" @change="saveSettings">
            <option v-for="value in levelOptions" :key="value" :value="value">{{ value }}</option>
          </select>
        </label>
        <label class="mo-setting">
          <span>开局提醒窗口</span>
          <select v-model.number="settings.startWindowSec" @change="saveSettings">
            <option v-for="value in startWindowOptions" :key="value" :value="value">{{ value }} 秒</option>
          </select>
        </label>
        <label class="mo-setting">
          <input v-model="settings.reminderOnlyWhenDead" type="checkbox" @change="saveSettings">
          <span>只在阵亡时提醒（关闭则有待选就常驻提示，阵亡时闪烁）</span>
        </label>
        <div class="mo-setting">
          <button class="mo-btn" @click="resetGame">清空本局记录</button>
          <span class="mo-muted">{{ iconIndexLabel }}</span>
        </div>
      </section>

      <!-- 三选一 -->
      <section v-if="rankedCards.length" class="mo-section">
        <div class="mo-section-title">
          <span>本次三选一</span>
          <span class="mo-muted">{{ ranking.summary }}</span>
        </div>
        <div class="mo-cards">
          <template v-for="entry in rankedCards" :key="`${entry.card.slot}-${entry.card.id}`">
          <div
            class="mo-card mo-no-drag"
            :class="cardClass(entry)"
            role="button"
            tabindex="0"
            title="点击标记为已选；点卡名可更正"
            @click="pick(entry.card)"
          >
            <img v-if="entry.card.iconPath" class="mo-card-icon" :src="getAugmentIconUrl(entry.card.iconPath)" alt="">
            <div class="mo-card-main">
              <div class="mo-card-name">
                <span
                  class="mo-card-title"
                  title="识别错了？点这里更正"
                  @click.stop="openCorrection({ kind: 'slot', slot: entry.card.slot, currentId: entry.card.id })"
                >{{ entry.card.name }} ▾</span>
                <span v-if="entry.relativeLabel" class="mo-badge" :class="badgeClass(entry)">{{ entry.relativeLabel }}</span>
                <span
                  v-if="sourceLabel(entry.card)"
                  class="mo-source"
                  :class="`mo-source-${entry.card.source}`"
                  :title="sourceTitle(entry.card)"
                >{{ sourceLabel(entry.card) }}</span>
              </div>
              <div class="mo-card-stats">
                <template v-if="entry.method === 'shrunk'">
                  <span title="收缩后胜率">{{ formatPercent(entry.shrunkWinRate) }}</span>
                  <span
                    v-if="synergyText(entry)"
                    class="mo-synergy"
                    :class="(entry.synergy?.score ?? 0) > 0 ? 'mo-up' : 'mo-down'"
                    :title="(entry.synergy?.reasons || []).join('；')"
                  >{{ synergyText(entry) }}</span>
                  <span :class="deltaClass(entry.delta)" title="相对基准（百分点）">{{ formatDelta(entry.delta) }}</span>
                  <span class="mo-muted">{{ entry.games }} 场 · 原始 {{ formatPercent(entry.rawWinRate) }}</span>
                </template>
                <span v-else class="mo-muted">{{ entry.note }}</span>
              </div>
              <div v-if="entry.synergy?.reasons?.length" class="mo-card-reason">{{ entry.synergy.reasons[0] }}</div>
            </div>
          </div>
          <div
            v-if="correction && correction.kind === 'slot' && correction.slot === entry.card.slot"
            class="mo-correction mo-no-drag"
          >
            <div class="mo-correction-title">
              <span>更正第 {{ entry.card.slot + 1 }} 张</span>
              <button class="mo-link" @click="closeCorrection">关闭</button>
            </div>
            <div v-if="(entry.card.alternatives || []).length" class="mo-alt-list">
              <button
                v-for="alt in entry.card.alternatives"
                :key="`alt-${alt.source}-${alt.id}`"
                class="mo-alt"
                :class="{ 'mo-alt-current': String(alt.id) === String(entry.card.id) }"
                @click="applyCorrection(alt)"
              >
                <img v-if="alt.iconPath" :src="getAugmentIconUrl(alt.iconPath)" alt="">
                <span class="mo-alt-name">{{ alt.name }}</span>
                <span class="mo-muted">{{ alt.source === 'icon' ? '图标' : '文字' }} {{ formatScore(alt.score) }}</span>
              </button>
            </div>
            <input
              ref="searchInput"
              v-model="searchQuery"
              class="mo-search"
              placeholder="按名字搜索海克斯…"
              @mousedown="onSearchFocus"
              @keydown.esc="closeCorrection"
              @keydown.enter="applyFirstSearchResult"
            >
            <div class="mo-alt-list">
              <button
                v-for="result in searchResults"
                :key="`search-${result.id}`"
                class="mo-alt"
                @click="applyCorrection(result)"
              >
                <img v-if="result.iconPath" :src="getAugmentIconUrl(result.iconPath)" alt="">
                <span class="mo-alt-name">{{ result.name }}</span>
              </button>
            </div>
          </div>
          </template>
        </div>
        <div class="mo-footnote">
          <span v-if="ranking.method === 'rank-fallback'">⚠ 无胜率数据：按热度排序，仅供参考</span>
          <span v-else-if="ranking.baselineWinRate != null">
            收缩胜率 = (胜场 + α×{{ ranking.baselineSource === 'cards' ? '三卡平均' : '英雄平均' }}) / (场次 + α)，α={{ ranking.alpha }}，基准 {{ formatPercent(ranking.baselineWinRate) }}
          </span>
          <button class="mo-link mo-no-drag" @click="clearCandidates">清除</button>
        </div>
        <div v-if="captureLabel" class="mo-timing">{{ captureLabel }}</div>
      </section>

      <!-- 已选海克斯 -->
      <section class="mo-section">
        <div class="mo-section-title">
          <span>本局已选海克斯</span>
          <span class="mo-muted">{{ state.picked.length ? '点名字更正 · 点 × 移除' : '点上方卡片标记，或关掉三选一后自动记录' }}</span>
        </div>
        <div v-if="state.picked.length" class="mo-chips">
          <span
            v-for="augment in state.picked"
            :key="augment.id"
            class="mo-chip"
            :class="{ 'mo-chip-inferred': augment.inferred === 'recommended' }"
          >
            <img v-if="augment.iconPath" :src="getAugmentIconUrl(augment.iconPath)" alt="">
            <span
              class="mo-chip-name mo-no-drag"
              :title="inferredTitle(augment) || '点这里换成别的海克斯'"
              @click="openCorrection({ kind: 'picked', currentId: augment.id })"
            >{{ augment.name }}<span v-if="augment.inferred === 'recommended'" class="mo-chip-tag">推断</span><span v-else-if="augment.inferred === 'live-client'" class="mo-chip-tag">自动</span></span>
            <button class="mo-chip-x mo-no-drag" title="移除" @click="unpick(augment.id)">×</button>
          </span>
        </div>
        <div v-else class="mo-muted mo-empty">还没有记录</div>
        <div v-if="correction && correction.kind === 'picked'" class="mo-correction mo-no-drag">
          <div class="mo-correction-title">
            <span>把「{{ pickedName(correction.currentId) }}」换成</span>
            <button class="mo-link" @click="closeCorrection">关闭</button>
          </div>
          <div v-if="pickedAlternatives(correction.currentId).length" class="mo-alt-list">
            <button
              v-for="alt in pickedAlternatives(correction.currentId)"
              :key="`picked-alt-${alt.id}`"
              class="mo-alt"
              @click="applyCorrection(alt)"
            >
              <img v-if="alt.iconPath" :src="getAugmentIconUrl(alt.iconPath)" alt="">
              <span class="mo-alt-name">{{ alt.name }}</span>
              <span class="mo-muted">同一轮</span>
            </button>
          </div>
          <input
            ref="searchInput"
            v-model="searchQuery"
            class="mo-search"
            placeholder="按名字搜索海克斯…"
            @mousedown="onSearchFocus"
            @keydown.esc="closeCorrection"
            @keydown.enter="applyFirstSearchResult"
          >
          <div class="mo-alt-list">
            <button
              v-for="result in searchResults"
              :key="`search-${result.id}`"
              class="mo-alt"
              @click="applyCorrection(result)"
            >
              <img v-if="result.iconPath" :src="getAugmentIconUrl(result.iconPath)" alt="">
              <span class="mo-alt-name">{{ result.name }}</span>
            </button>
          </div>
        </div>
      </section>

      <!-- 出装 -->
      <section class="mo-section">
        <div class="mo-section-title">
          <span>推荐出装</span>
          <span class="mo-muted">{{ liveLabel }}</span>
        </div>
        <div v-if="championLoading" class="mo-muted mo-empty">加载英雄数据…</div>
        <template v-else>
          <div v-if="archetypeLabel || tagSummary" class="mo-tags">
            <span v-if="archetypeLabel">流派：<b>{{ archetypeLabel }}</b></span>
            <span v-if="tagSummary"> · 海克斯偏好：{{ tagSummary }}</span>
          </div>
          <ol v-if="engine.items.length" class="mo-items">
            <li
              v-for="item in engine.items"
              :key="item.itemId"
              class="mo-item"
              :class="{ 'mo-item-owned': item.owned, 'mo-item-next': item.isNext }"
            >
              <img class="mo-item-icon" :src="getItemIconUrl(item.itemId)" alt="">
              <div class="mo-item-main">
                <div class="mo-item-name">
                  <span>{{ item.name }}</span>
                  <span
                    v-if="changeBadge(item)"
                    class="mo-change"
                    :class="changeBadge(item)!.cls"
                    :title="changeBadge(item)!.title"
                  >{{ changeBadge(item)!.text }}</span>
                  <span v-if="item.isNext" class="mo-badge mo-badge-next">下一件</span>
                  <span v-else-if="item.owned" class="mo-badge mo-badge-owned">已有</span>
                  <span class="mo-item-score" :title="scoreTitle(item)">
                    {{ item.score.total.toFixed(1) }}<span v-if="Math.abs(item.score.synergy) >= 0.3" :class="item.score.synergy > 0 ? 'mo-up' : 'mo-down'">（海克斯{{ item.score.synergy > 0 ? '+' : '' }}{{ item.score.synergy.toFixed(1) }}）</span>
                  </span>
                </div>
                <div v-for="(reason, index) in item.reasons.slice(0, 2)" :key="index" class="mo-item-reason">{{ reason }}</div>
              </div>
            </li>
          </ol>
          <div v-if="state.picked.length && engine.removed.length" class="mo-removed">
            <span class="mo-muted">被挤掉：</span>
            <span v-for="removed in engine.removed" :key="`removed-${removed.itemId}`" class="mo-removed-item" :title="removed.reason">{{ removed.name }}</span>
          </div>
          <div v-for="(note, index) in engine.notes" :key="`note-${index}`" class="mo-muted mo-note">{{ note }}</div>
          <div class="mo-muted mo-note">海克斯加成是规则模型（数据源没有海克斯×装备胜率），先验来自该英雄的真实出装统计</div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { electronAPI, hasElectronAPI } from '../native/electron-api.ts'
import { getAugmentIconUrl, getChampionSquareIconUrl, getItemIconUrl } from '../service/cdn.js'
import {
  rankAugmentChoices,
  type AugmentChoiceInput,
} from '../../shared/augment-choice-ranking.ts'
import {
  applyCardSynergy,
  localizeArchetype,
  recommendBuild,
  resolveAugmentProfile,
  scoreCardSynergy,
  STORED_ITEM_PROFILES,
  type AugmentProfile,
  type EngineItem,
  type SynergyRankedChoice,
} from '../../shared/recommendation/index.ts'
import { MECHANIC_LABELS, STAT_LABELS, type WeightKey } from '../../shared/recommendation/profiles.ts'
import { AUGMENT_LEVEL_PRESETS } from '../../shared/refresh-reminder.ts'
import type {
  ChampionMonitorState,
  ManualOverlayAugmentRef,
  ManualOverlayCandidate,
  ManualOverlayPickedAugment,
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

type CorrectionTarget =
  | { kind: 'slot'; slot: number; currentId: number | string }
  | { kind: 'picked'; currentId: number | string }

const LIVE_POLL_INTERVAL_MS = 3000
const SEARCH_RESULT_LIMIT = 8

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
  acknowledgedStage: 0,
  iconIndex: { ready: false, count: 0, error: null },
  liveGame: false,
  pendingChoice: null,
  autoWatching: false,
  revision: 0,
})
const settings = reactive<ManualOverlaySettings>({
  autoScreenshot: false,
  hotkey: 'CommandOrControl+Shift+R',
  showInChampSelect: false,
  shrinkageAlpha: 300,
  focusable: false,
  reminderEnabled: true,
  augmentLevels: '1,7,11,15',
  reminderOnlyWhenDead: false,
  startWindowSec: 90,
  iconMatchEnabled: true,
  autoFollowUp: true,
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
const levelOptions = computed(() => Array.from(new Set([...AUGMENT_LEVEL_PRESETS, settings.augmentLevels])))
const startWindowOptions = [30, 60, 90, 120, 180]

const correction = ref<CorrectionTarget | null>(null)
const searchQuery = ref('')
const searchInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
const allAugments = ref<ManualOverlayAugmentRef[]>([])
let focusGranted = false

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
  const label = labels[String(state.value.phase)] || String(state.value.phase || '未连接客户端')
  return state.value.liveGame && state.value.phase !== 'InProgress' ? `对局中（2999）· ${label}` : label
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

function toCardInputs(candidates: ManualOverlayCandidate[]): CardInput[] {
  return candidates.map((candidate) => {
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
}

const engineItems = computed(() => {
  const items = championData.value?.items
  const count = Array.isArray(items) ? items.length : Object.keys(items || {}).length
  return count > 0 ? items : STORED_ITEM_PROFILES
})

function profileOf(augment: { id: number | string; name?: string }): AugmentProfile {
  const base = augmentBaseById.value.get(String(augment.id))
  return resolveAugmentProfile(augment, base ? { ...base, id: base.id ?? augment.id } as any : null, engineItems.value)
}

const heldProfiles = computed(() => state.value.picked.map((augment) => profileOf(augment)))

/** 海克斯感知出装引擎：每次已选海克斯 / 2999 装备 / 敌方装备变化都会重新计算 */
const engine = computed(() => recommendBuild({
  builds: championData.value?.builds || [],
  items: engineItems.value,
  augments: heldProfiles.value,
  ownedItemIds: live.value?.found ? live.value.ownedItemIds : [],
  enemyItemIds: live.value?.found ? live.value.enemyItemIds : [],
}))

function rankCards(candidates: ManualOverlayCandidate[]) {
  const base = rankAugmentChoices(toCardInputs(candidates), championStatList.value, { alpha: settings.shrinkageAlpha })
  const trios = championData.value?.augmentTrios || []
  return applyCardSynergy(base, (card) => scoreCardSynergy(
    profileOf(card),
    heldProfiles.value,
    engine.value.context,
    { trios, baselineWinRate: base.baselineWinRate },
  ))
}

const ranking = computed(() => rankCards(state.value.candidates))

/** 按游戏里的左右顺序展示，标签来自三卡相对排序（胜率 + 契合度） */
const rankedCards = computed(() => [...ranking.value.choices].sort((a, b) => a.slot - b.slot))

const archetypeLabel = computed(() => {
  const archetype = engine.value.archetype
  if (!archetype) return ''
  const changed = archetype.baselineIndex !== 0 && state.value.picked.length > 0
  return `${localizeArchetype(archetype.label)}${changed ? '（海克斯改变了流派）' : ''}`
})

const tagSummary = computed(() => {
  const weights = Object.entries(engine.value.weights || {})
    .filter(([, weight]) => Number(weight) >= 0.2)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 4)
    .map(([key]) => STAT_LABELS[key as WeightKey] || key)
  const mechanics = (engine.value.mechanics || []).slice(0, 3).map((mechanic) => MECHANIC_LABELS[mechanic] || mechanic)
  return [...weights, ...mechanics].join('、')
})

function changeBadge(item: EngineItem) {
  if (!state.value.picked.length) return null
  if (item.change === 'new') return { text: '新', cls: 'mo-change-new', title: '无海克斯时不在推荐里' }
  if (item.change === 'up') return { text: '↑', cls: 'mo-change-up', title: `原第 ${(item.baselineIndex ?? 0) + 1} 件，提前了` }
  if (item.change === 'down') return { text: '↓', cls: 'mo-change-down', title: `原第 ${(item.baselineIndex ?? 0) + 1} 件，推后了` }
  return null
}

function scoreTitle(item: EngineItem) {
  const s = item.score
  return `先验 ${s.prior.toFixed(1)} · 海克斯 ${s.synergy >= 0 ? '+' : ''}${s.synergy.toFixed(1)} · 进度 ${s.progress.toFixed(1)} · 敌方 ${s.enemy.toFixed(1)} = ${s.total.toFixed(1)}`
}

function synergyText(entry: SynergyRankedChoice<CardInput>) {
  const score = entry.synergy?.score ?? 0
  if (Math.abs(score) < 0.5) return ''
  return `契合 ${score > 0 ? '+' : '−'}${Math.abs(score).toFixed(1)}`
}

// ------------------------------------------------------------- 自动记录选择
const autoPickedRounds = new Set<number>()

/** 三选一关闭但没点：按推荐（胜率+契合度第一）自动记录，标「推断」，可一键更正 */
watch(() => state.value.pendingChoice, async (pending) => {
  if (!pending || !pending.candidates.length || autoPickedRounds.has(pending.closedAt)) return
  autoPickedRounds.add(pending.closedAt)
  const ranked = rankCards(pending.candidates)
  const top = [...ranked.choices].sort((a, b) => a.order - b.order)[0]?.card
  if (!top) return
  const toRef = (card: ManualOverlayCandidate) => ({
    id: card.id, name: card.name, rarity: card.rarity ?? null, iconPath: card.iconPath ?? null,
  })
  applyState(await electronAPI.manualOverlay.pick({
    ...toRef(top),
    inferred: 'recommended',
    alternatives: pending.candidates.filter((card) => String(card.id) !== String(top.id)).map(toRef),
  }))
})

function pickedAlternatives(id: number | string): ManualOverlayAugmentRef[] {
  const picked = state.value.picked.find((augment) => String(augment.id) === String(id)) as ManualOverlayPickedAugment | undefined
  return picked?.alternatives || []
}

function inferredTitle(augment: ManualOverlayPickedAugment) {
  if (augment.inferred === 'live-client') return '游戏内接口（2999）给出'
  if (augment.inferred === 'recommended') return '三选一关闭时没有点选，按推荐自动记录；选的不是它就点名字更正'
  return ''
}

const reminder = computed(() => (settings.reminderEnabled ? live.value?.reminder ?? null : null))

const iconIndexLabel = computed(() => {
  const index = state.value.iconIndex
  if (!settings.iconMatchEnabled) return ''
  if (index?.ready) return `图标库 ${index.count} 个`
  return index?.error ? `图标库不可用：${index.error}` : '图标库：进入对局后自动准备'
})

const captureLabel = computed(() => {
  const capture = state.value.lastCapture
  if (!capture) return ''
  const parts = [`截图 ${capture.captureMs}ms`, `识别 ${capture.analyzeMs}ms`]
  if (capture.iconMs != null) parts.push(`图标 ${capture.iconMs}ms`)
  if (capture.totalMs != null) parts.push(`共 ${capture.totalMs}ms`)
  return parts.join(' · ')
})

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[\s·・:：'"“”「」()（）-]/g, '')
}

const searchPool = computed<ManualOverlayAugmentRef[]>(() => {
  const map = new Map<string, ManualOverlayAugmentRef>()
  for (const augment of championData.value?.augments || []) {
    if (augment?.id != null && augment?.name) {
      map.set(String(augment.id), {
        id: augment.id,
        name: augment.name,
        rarity: augment.rarity ?? null,
        iconPath: augment.iconPath ?? augment.iconUrl ?? null,
      })
    }
  }
  for (const augment of allAugments.value) {
    if (!map.has(String(augment.id))) map.set(String(augment.id), augment)
  }
  return Array.from(map.values())
})

const searchResults = computed(() => {
  const query = normalizeName(searchQuery.value.trim())
  if (!query) return []
  const games = (id: number | string) => Number(augmentStats.value[String(id)]?.num_games) || 0
  return searchPool.value
    .filter((augment) => normalizeName(augment.name).includes(query))
    .sort((a, b) => {
      const aStarts = normalizeName(a.name).startsWith(query) ? 0 : 1
      const bStarts = normalizeName(b.name).startsWith(query) ? 0 : 1
      return aStarts - bStarts || games(b.id) - games(a.id)
    })
    .slice(0, SEARCH_RESULT_LIMIT)
})

function formatScore(value: number | null | undefined) {
  const number = Number(value)
  return value != null && Number.isFinite(number) ? `${Math.round(number * 100)}` : ''
}

function sourceLabel(card: ManualOverlayCandidate) {
  const labels: Record<string, string> = {
    'icon+ocr': '✓',
    icon: '图标',
    ocr: '文字',
    'icon-low': '待确认',
    manual: '手动',
  }
  return card.source ? labels[card.source] || '' : ''
}

function sourceTitle(card: ManualOverlayCandidate) {
  const score = card.iconScore != null ? `，图标相似度 ${formatScore(card.iconScore)}` : ''
  const titles: Record<string, string> = {
    'icon+ocr': '图标与文字识别一致',
    icon: '按图标识别（文字识别结果不同或缺失）',
    ocr: '按文字识别（图标无法确认）',
    'icon-low': '只有图标匹配且把握不大，请确认',
    manual: '手动更正',
  }
  return `${titles[String(card.source)] || ''}${score}`
}

function pickedName(id: number | string) {
  return state.value.picked.find((augment) => String(augment.id) === String(id))?.name || String(id)
}

async function openCorrection(target: CorrectionTarget) {
  correction.value = target
  searchQuery.value = ''
  if (allAugments.value.length === 0) {
    try {
      allAugments.value = await electronAPI.manualOverlay.listAugments()
    } catch {
      allAugments.value = []
    }
  }
  await nextTick()
}

async function onSearchFocus() {
  // 浮窗默认不可聚焦（不抢游戏焦点）；搜索时临时申请焦点，关闭后恢复
  if (focusGranted) return
  focusGranted = true
  try {
    await electronAPI.manualOverlay.setFocusable(true)
    await nextTick()
    const input = Array.isArray(searchInput.value) ? searchInput.value[0] : searchInput.value
    input?.focus()
  } catch {
    focusGranted = false
  }
}

function closeCorrection() {
  correction.value = null
  searchQuery.value = ''
  if (focusGranted) {
    focusGranted = false
    void electronAPI.manualOverlay.setFocusable(false)
  }
}

async function applyCorrection(augment: ManualOverlayAugmentRef) {
  const target = correction.value
  if (!target) return
  const ref = {
    id: augment.id,
    name: augment.name,
    rarity: augment.rarity ?? null,
    iconPath: augment.iconPath ?? null,
  }
  if (target.kind === 'slot') {
    applyState(await electronAPI.manualOverlay.correct(target.slot, ref))
  } else {
    applyState(await electronAPI.manualOverlay.replacePicked(target.currentId, ref))
  }
  closeCorrection()
}

function applyFirstSearchResult() {
  const first = searchResults.value[0]
  if (first) void applyCorrection(first)
}

async function acknowledgeReminder() {
  applyState(await electronAPI.manualOverlay.acknowledgeReminder())
  if (live.value?.reminder) {
    live.value = { ...live.value, reminder: { ...live.value.reminder, active: false, urgent: false } }
  }
}

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

function cardClass(entry: SynergyRankedChoice<CardInput>) {
  return {
    'mo-card-best': entry.order === 0 && !ranking.value.topTie,
    'mo-card-tie': ranking.value.topTie && entry.order < 2,
  }
}

function badgeClass(entry: SynergyRankedChoice<CardInput>) {
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
  closeCorrection()
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
  if (!state.value.liveGame && !['InProgress', 'Reconnect'].includes(String(state.value.phase))) {
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
  closeCorrection()
})

// 选了/更正之后立刻重新计算提醒，不用等下一次轮询
watch(() => [state.value.picked.length, state.value.acknowledgedStage], () => {
  void pollLive()
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
  closeCorrection()
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
.mo-card-title { cursor: pointer; border-bottom: 1px dashed rgba(200, 170, 110, 0.5); }
.mo-card-title:hover { color: #f0d79a; }
.mo-source { font-size: 10px; padding: 0 3px; border-radius: 3px; background: #2b3038; color: #9aa0a6; }
.mo-source-icon\+ocr { color: #58be78; }
.mo-source-icon-low { background: #6b4a12; color: #ffd48a; }
.mo-source-manual { color: #6fb3d2; }
.mo-correction { margin: 0 0 4px 12px; padding: 5px 6px; border-left: 2px solid #c8aa6e; background: rgba(255, 255, 255, 0.05); border-radius: 0 4px 4px 0; display: flex; flex-direction: column; gap: 4px; }
.mo-correction-title { display: flex; justify-content: space-between; color: #c8aa6e; font-size: 11px; }
.mo-alt-list { display: flex; flex-direction: column; gap: 2px; }
.mo-alt { display: flex; align-items: center; gap: 5px; text-align: left; padding: 2px 4px; border: 1px solid transparent; border-radius: 3px; background: rgba(255, 255, 255, 0.03); color: inherit; cursor: pointer; font-size: 12px; }
.mo-alt:hover { border-color: rgba(200, 170, 110, 0.6); }
.mo-alt img { width: 18px; height: 18px; border-radius: 3px; }
.mo-alt-name { flex: 1; min-width: 0; }
.mo-alt-current { border-color: rgba(88, 190, 120, 0.6); }
.mo-search { background: #1b1f27; color: #e8e1cf; border: 1px solid #555; border-radius: 3px; padding: 3px 5px; font-size: 12px; user-select: text; }
.mo-chip-name { cursor: pointer; }
.mo-chip-name:hover { color: #f0d79a; }
.mo-timing { color: #6c727a; font-size: 10px; margin-top: 2px; }
.mo-reminder { display: flex; align-items: center; gap: 6px; padding: 5px 8px; background: rgba(30, 111, 143, 0.35); border-bottom: 1px solid rgba(58, 160, 200, 0.6); }
.mo-reminder-text { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 11px; }
.mo-reminder-text b { font-size: 14px; color: #fff; }
.mo-reminder-urgent { animation: mo-flash 0.9s ease-in-out infinite alternate; }
@keyframes mo-flash {
  from { background: rgba(30, 111, 143, 0.35); }
  to { background: rgba(214, 150, 40, 0.75); }
}
.mo-watching { color: #7fd1a8; }
.mo-synergy { font-weight: 600; }
.mo-card-reason { font-size: 11px; color: #a9b3c4; margin-top: 2px; }
.mo-chip-inferred { border-style: dashed !important; }
.mo-chip-tag { margin-left: 4px; font-size: 10px; padding: 0 3px; border-radius: 3px; background: rgba(200, 170, 110, 0.25); color: #e8d6a8; }
.mo-change { font-size: 10px; font-weight: 700; padding: 0 4px; border-radius: 3px; }
.mo-change-new { background: #2f7d4f; color: #fff; }
.mo-change-up { background: rgba(47, 125, 79, 0.35); color: #9fe3b9; }
.mo-change-down { background: rgba(160, 80, 60, 0.35); color: #f0b3a3; }
.mo-item-score { margin-left: auto; font-size: 11px; color: #a9b3c4; }
.mo-removed { margin-top: 4px; font-size: 11px; }
.mo-removed-item { text-decoration: line-through; color: #b98c84; margin-right: 6px; }
</style>
