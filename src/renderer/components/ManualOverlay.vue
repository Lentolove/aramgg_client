<template>
  <div
    ref="frameRef"
    class="mo-frame"
    :class="{ 'mo-collapsed': collapsed }"
    :style="frameStyle"
  >
    <!-- 收起：小条 -->
    <div v-if="collapsed" class="mo-shell mo-bar">
      <img
        v-if="championId"
        class="mo-bar-champion"
        :src="getChampionSquareIconUrl(championId)"
        :title="championLabel"
        alt=""
      >
      <div class="mo-bar-next" :title="nextItem ? `下一件：${nextItem.name}` : '暂无出装'">
        <img v-if="nextItem" :src="getItemIconUrl(nextItem.itemId)" alt="">
        <span v-else class="mo-bar-empty">?</span>
      </div>
      <div class="mo-bar-text">
        <span class="mo-bar-label">下一件</span>
        <span class="mo-bar-name">{{ nextItem?.name || '—' }}</span>
      </div>
      <span v-if="state.candidates.length" class="mo-bar-dot" title="有三选一待处理，展开查看" />
      <button
        class="mo-icon-btn mo-icon-primary mo-no-drag"
        :class="{ 'mo-spin': state.refreshing }"
        :disabled="state.refreshing"
        :title="`刷新（${hotkeyLabel}）`"
        @click="refresh"
      >⟳</button>
      <button class="mo-icon-btn mo-no-drag" :title="`展开${collapseHotkeyLabel ? `（${collapseHotkeyLabel}）` : ''}`" @click="setCollapsed(false)">▾</button>
    </div>

    <!-- 展开 -->
    <div v-else class="mo-shell" :style="shellStyle">
      <header class="mo-header">
        <img
          v-if="championId"
          class="mo-champion-icon"
          :src="getChampionSquareIconUrl(championId)"
          alt=""
        >
        <div class="mo-title">
          <div class="mo-champion-name">{{ championLabel }}</div>
          <div class="mo-subtitle">
            <span>{{ phaseLabel }}</span>
            <span v-if="state.autoWatching" class="mo-watching" title="识别到三选一后每 2.5 秒自动再拍，关闭三选一后自动记录所选">· 自动跟拍</span>
          </div>
        </div>
        <button
          class="mo-btn mo-btn-primary mo-no-drag"
          :disabled="state.refreshing"
          :title="`三选一出现时刷新（${hotkeyLabel}）`"
          @click="refresh"
        >{{ state.refreshing ? '识别中' : '刷新' }}</button>
        <button
          class="mo-icon-btn mo-no-drag"
          :title="`收起${collapseHotkeyLabel ? `（${collapseHotkeyLabel}）` : ''}`"
          @click="setCollapsed(true)"
        >▴</button>
        <button
          class="mo-icon-btn mo-no-drag"
          :class="{ 'mo-icon-active': showSettings }"
          title="设置"
          @click="showSettings = !showSettings"
        >⚙</button>
        <button class="mo-icon-btn mo-no-drag" title="隐藏（快捷键可再次唤出）" @click="hide">×</button>
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
        <button class="mo-btn mo-btn-primary mo-btn-small" :disabled="state.refreshing" @click="refresh">刷新</button>
        <button class="mo-btn mo-btn-small" title="本次已处理，不再提醒" @click="acknowledgeReminder">忽略</button>
      </div>

      <div class="mo-body">
        <div v-if="statusMessages.length" class="mo-status">
          <div v-for="(message, index) in statusMessages" :key="index">{{ message }}</div>
        </div>

        <!-- 设置 -->
        <section v-if="showSettings" class="mo-section mo-settings mo-no-drag">
          <div class="mo-settings-grid">
            <label class="mo-setting-row">
              <span>刷新快捷键</span>
              <select v-model="settings.hotkey" @change="saveSettings">
                <option v-for="option in hotkeyOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label class="mo-setting-row">
              <span>收起快捷键</span>
              <select v-model="settings.collapseHotkey" @change="saveSettings">
                <option v-for="option in collapseHotkeyOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label class="mo-setting-row">
              <span>背景不透明度</span>
              <input v-model.number="settings.opacity" type="range" min="0.5" max="1" step="0.02" @change="saveSettings">
              <span class="mo-setting-value">{{ Math.round(settings.opacity * 100) }}%</span>
            </label>
            <label class="mo-setting-row">
              <span>界面缩放</span>
              <input v-model.number="settings.scale" type="range" min="0.8" max="1.4" step="0.05" @change="saveSettings">
              <span class="mo-setting-value">{{ Math.round(settings.scale * 100) }}%</span>
            </label>
            <label class="mo-setting-row">
              <span>样本收缩强度 α</span>
              <select v-model.number="settings.shrinkageAlpha" @change="saveSettings">
                <option v-for="value in alphaOptions" :key="value" :value="value">{{ value }}</option>
              </select>
            </label>
            <label class="mo-setting-row">
              <span>海克斯等级</span>
              <select v-model="settings.augmentLevels" @change="saveSettings">
                <option v-for="value in levelOptions" :key="value" :value="value">{{ value }}</option>
              </select>
            </label>
            <label class="mo-setting-row">
              <span>开局提醒窗口</span>
              <select v-model.number="settings.startWindowSec" @change="saveSettings">
                <option v-for="value in startWindowOptions" :key="value" :value="value">{{ value }} 秒</option>
              </select>
            </label>
          </div>
          <label class="mo-check">
            <input v-model="settings.minimalMode" type="checkbox" @change="saveSettings">
            <span>极简模式：识别到三选一自动展开，关闭后自动收起</span>
          </label>
          <label class="mo-check">
            <input v-model="settings.autoFollowUp" type="checkbox" @change="saveSettings">
            <span>刷新后自动跟拍三选一，关闭时自动记录所选</span>
          </label>
          <label class="mo-check">
            <input v-model="settings.iconMatchEnabled" type="checkbox" @change="saveSettings">
            <span>卡片图标匹配（与文字识别交叉校验）</span>
          </label>
          <label class="mo-check">
            <input v-model="settings.reminderEnabled" type="checkbox" @change="saveSettings">
            <span>「可以刷新了」提醒（读 2999，不截图）</span>
          </label>
          <label class="mo-check">
            <input v-model="settings.reminderOnlyWhenDead" type="checkbox" @change="saveSettings">
            <span>只在阵亡时提醒</span>
          </label>
          <label class="mo-check">
            <input v-model="settings.showInChampSelect" type="checkbox" @change="saveSettings">
            <span>选人阶段也显示浮窗</span>
          </label>
          <label class="mo-check">
            <input v-model="settings.focusable" type="checkbox" @change="saveSettings">
            <span>浮窗可获得焦点（重启生效）</span>
          </label>
          <label class="mo-check">
            <input v-model="settings.autoScreenshot" type="checkbox" @change="saveSettings">
            <span>持续自动截图（旧模式）</span>
          </label>
          <div class="mo-settings-foot">
            <button class="mo-btn mo-btn-small" @click="resetGame">清空本局记录</button>
            <span class="mo-muted">{{ iconIndexLabel }}</span>
          </div>
        </section>

        <!-- 三选一 -->
        <section v-if="rankedCards.length" class="mo-section">
          <div class="mo-section-head mo-no-drag">
            <button class="mo-section-toggle" @click="toggleSection('cards')">
              <span class="mo-chevron" :class="{ 'mo-chevron-closed': isSectionCollapsed('cards') }">▾</span>
              <span class="mo-section-title">本次三选一</span>
            </button>
            <button v-if="!isSectionCollapsed('cards')" class="mo-link" :class="{ 'mo-link-active': cardDetails }" @click="cardDetails = !cardDetails">详情</button>
          </div>
          <div v-if="!isSectionCollapsed('cards')" class="mo-cards">
            <template v-for="entry in rankedCards" :key="`${entry.card.slot}-${entry.card.id}`">
              <div
                class="mo-card mo-no-drag"
                :class="cardClass(entry)"
                role="button"
                tabindex="0"
                :title="cardTooltip(entry)"
                @click="pick(entry.card)"
              >
                <div class="mo-card-icon-wrap">
                  <img v-if="entry.card.iconPath" class="mo-card-icon" :src="getAugmentIconUrl(entry.card.iconPath)" alt="">
                </div>
                <div class="mo-card-main">
                  <div class="mo-card-name">
                    <span
                      class="mo-card-title"
                      title="识别错了？点这里更正"
                      @click.stop="openCorrection({ kind: 'slot', slot: entry.card.slot, currentId: entry.card.id })"
                    >{{ entry.card.name }}</span>
                    <span v-if="entry.card.source === 'icon-low'" class="mo-warn-dot" title="只有图标匹配且把握不大，点名字确认">!</span>
                  </div>
                  <div class="mo-card-stats">
                    <template v-if="entry.method === 'shrunk'">
                      <span class="mo-wr">{{ formatPercent(entry.shrunkWinRate) }}</span>
                      <span class="mo-delta" :class="deltaClass(entry.delta)">{{ formatDelta(entry.delta) }}</span>
                      <span
                        v-if="synergyText(entry)"
                        class="mo-synergy"
                        :class="(entry.synergy?.score ?? 0) > 0 ? 'mo-synergy-up' : 'mo-synergy-down'"
                      >{{ synergyText(entry) }}</span>
                    </template>
                    <span v-else class="mo-muted">{{ entry.note }}</span>
                  </div>
                  <div v-if="cardDetails" class="mo-card-detail">
                    <div v-if="entry.method === 'shrunk'">{{ entry.games }} 场 · 原始胜率 {{ formatPercent(entry.rawWinRate) }}</div>
                    <div v-if="entry.card.source && entry.card.source !== 'icon+ocr'">识别：{{ sourceTitle(entry.card) }}</div>
                    <div v-if="entry.synergy?.reasons?.length" class="mo-card-detail-synergy">{{ entry.synergy.reasons.join('；') }}</div>
                  </div>
                </div>
                <span v-if="entry.relativeLabel" class="mo-rank" :class="badgeClass(entry)">{{ entry.relativeLabel }}</span>
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
            <div v-if="cardDetails" class="mo-footnote">
              <div v-if="ranking.method === 'rank-fallback'">无胜率数据：按热度排序，仅供参考</div>
              <div v-else-if="ranking.baselineWinRate != null">
                收缩胜率 = (胜场 + α×{{ ranking.baselineSource === 'cards' ? '三卡平均' : '英雄平均' }}) / (场次 + α)，α={{ ranking.alpha }}，基准 {{ formatPercent(ranking.baselineWinRate) }}；契合度最多调整 ±2 个百分点
              </div>
              <div>{{ ranking.summary }}</div>
              <div v-if="captureLabel">{{ captureLabel }}</div>
              <button class="mo-link mo-no-drag" @click="clearCandidates">清除本次三选一</button>
            </div>
          </div>
        </section>

        <!-- 已选海克斯 -->
        <section class="mo-section">
          <div class="mo-section-head mo-no-drag">
            <button class="mo-section-toggle" @click="toggleSection('picked')">
              <span class="mo-chevron" :class="{ 'mo-chevron-closed': isSectionCollapsed('picked') }">▾</span>
              <span class="mo-section-title">已选海克斯</span>
              <span v-if="state.picked.length" class="mo-count">{{ state.picked.length }}</span>
            </button>
            <span v-if="isSectionCollapsed('picked') && state.picked.length" class="mo-mini-icons">
              <img v-for="augment in state.picked" :key="`mini-${augment.id}`" :src="getAugmentIconUrl(augment.iconPath || '')" :title="augment.name" alt="">
            </span>
          </div>
          <template v-if="!isSectionCollapsed('picked')">
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
                >{{ augment.name }}</span>
                <span v-if="augment.inferred === 'recommended'" class="mo-chip-tag" :title="inferredTitle(augment)">推断</span>
                <span v-else-if="augment.inferred === 'live-client'" class="mo-chip-tag" :title="inferredTitle(augment)">自动</span>
                <button class="mo-chip-x mo-no-drag" title="移除" @click="unpick(augment.id)">×</button>
              </span>
            </div>
            <div v-else class="mo-empty">点三选一的卡片记录；关掉三选一后也会自动记录</div>
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
          </template>
        </section>

        <!-- 出装 -->
        <section class="mo-section">
          <div class="mo-section-head mo-no-drag">
            <button class="mo-section-toggle" @click="toggleSection('build')">
              <span class="mo-chevron" :class="{ 'mo-chevron-closed': isSectionCollapsed('build') }">▾</span>
              <span class="mo-section-title">推荐出装</span>
              <span v-if="archetypeName" class="mo-archetype" :class="{ 'mo-archetype-changed': archetypeChanged }">{{ archetypeName }}</span>
            </button>
            <button v-if="!isSectionCollapsed('build')" class="mo-link" :class="{ 'mo-link-active': buildDetails }" @click="buildDetails = !buildDetails">详情</button>
          </div>
          <template v-if="!isSectionCollapsed('build')">
            <div v-if="championLoading" class="mo-empty">加载英雄数据…</div>
            <template v-else-if="engine.items.length">
              <div v-if="plans.length > 1" class="mo-plan-tabs mo-no-drag" role="tablist">
                <button
                  v-for="plan in plans"
                  :key="plan.key"
                  class="mo-plan-tab"
                  :class="{ 'mo-plan-tab-active': activePlan?.key === plan.key }"
                  role="tab"
                  :title="`${plan.description}\n路线：${plan.routeLabel} · ${plan.routeGames} 场 · 胜率 ${formatPercent(plan.routeWinRate)}`"
                  @click="selectPlan(plan.key)"
                >{{ planTabLabel(plan) }}</button>
              </div>
              <div v-if="planHint" class="mo-plan-hint mo-no-drag">
                <span>{{ planHint }}</span>
                <button class="mo-link mo-link-active" @click="selectPlan('adapted')">查看</button>
                <button class="mo-link" @click="dismissPlanHint">×</button>
              </div>
              <div class="mo-slots mo-no-drag" @mouseleave="hoverItemId = null">
                <div
                  v-for="item in engine.items"
                  :key="item.itemId"
                  class="mo-slot"
                  :class="{
                    'mo-slot-next': item.isNext,
                    'mo-slot-owned': item.owned,
                    'mo-slot-focus': focusItem && focusItem.itemId === item.itemId && !item.isNext,
                    'mo-slot-open': slotMenuItemId === item.itemId,
                  }"
                  :title="itemTooltip(item)"
                  @mouseenter="hoverItemId = item.itemId"
                  @click="toggleSlotMenu(item)"
                >
                  <img :src="getItemIconUrl(item.itemId)" alt="">
                  <span
                    v-if="changeBadge(item)"
                    class="mo-slot-badge"
                    :class="changeBadge(item)!.cls"
                  >{{ changeBadge(item)!.text }}</span>
                  <span v-if="item.owned" class="mo-slot-check">✓</span>
                  <span v-if="item.swappedFrom" class="mo-slot-swapped" title="你换过这一格">换</span>
                </div>
              </div>
              <div v-if="slotMenuItem" class="mo-slot-menu mo-no-drag">
                <div class="mo-slot-menu-head">
                  <span>第 {{ engine.items.indexOf(slotMenuItem) + 1 }} 格：{{ slotMenuItem.name }}</span>
                  <button class="mo-link" @click="slotMenuItemId = null">关闭</button>
                </div>
                <div v-if="slotMenuItem.owned" class="mo-empty">已经买了，不能换</div>
                <template v-else>
                  <button
                    v-for="alt in slotMenuItem.alternatives"
                    :key="`slot-alt-${alt.itemId}`"
                    class="mo-slot-alt"
                    @click="swapSlot(slotMenuItem, alt)"
                  >
                    <img :src="getItemIconUrl(alt.itemId)" alt="">
                    <span class="mo-slot-alt-main">
                      <span class="mo-slot-alt-name">
                        {{ alt.name }}
                        <span v-if="alt.itemId === slotMenuItem.swappedFrom" class="mo-slot-alt-tag">原推荐</span>
                      </span>
                      <span class="mo-slot-alt-reason">{{ alt.reason }}</span>
                    </span>
                    <span class="mo-slot-alt-delta" :class="alt.delta >= 0 ? 'mo-up' : 'mo-muted'">{{ formatSigned(alt.delta) }}</span>
                  </button>
                  <div v-if="!slotMenuItem.alternatives.length" class="mo-empty">没有合规的备选</div>
                </template>
              </div>
              <div v-if="focusItem && !slotMenuItem" class="mo-focus">
                <div class="mo-focus-head">
                  <span class="mo-focus-tag">{{ focusItem.isNext ? '下一件' : focusItem.owned ? '已有' : `第 ${focusIndex + 1} 件` }}</span>
                  <span class="mo-focus-name">{{ focusItem.name }}</span>
                  <span
                    v-if="Math.abs(focusItem.score.synergy) >= 0.3"
                    class="mo-synergy"
                    :class="focusItem.score.synergy > 0 ? 'mo-synergy-up' : 'mo-synergy-down'"
                  >海克斯 {{ focusItem.score.synergy > 0 ? '+' : '' }}{{ focusItem.score.synergy.toFixed(1) }}</span>
                </div>
                <div
                  v-for="(reason, index) in focusReasons"
                  :key="index"
                  class="mo-focus-reason"
                  :class="{ 'mo-focus-reason-secondary': index > 0 }"
                >{{ reason }}</div>
              </div>
              <div v-if="buildDetails" class="mo-build-details">
                <div class="mo-detail-plans">
                  <div v-for="plan in plans" :key="`plan-detail-${plan.key}`" class="mo-detail-plan" :class="{ 'mo-detail-plan-active': activePlan?.key === plan.key }">
                    <b>{{ planTabLabel(plan) }}</b>
                    <span>{{ plan.routeLabel }} · {{ plan.routeGames }} 场 · 胜率 {{ formatPercent(plan.routeWinRate) }}{{ plan.usesAugments ? ' · 含海克斯模型' : ' · 纯数据' }}</span>
                    <span class="mo-detail-plan-desc">{{ plan.description }}</span>
                  </div>
                </div>
                <div v-if="tagSummary" class="mo-detail-line">海克斯偏好：{{ tagSummary }}</div>
                <ol class="mo-detail-items">
                  <li v-for="item in engine.items" :key="`detail-${item.itemId}`">
                    <div class="mo-detail-item-head">
                      <img :src="getItemIconUrl(item.itemId)" alt="">
                      <span>{{ item.name }}</span>
                      <span class="mo-muted mo-detail-score" :title="scoreTitle(item)">{{ item.score.total.toFixed(1) }}</span>
                    </div>
                    <div v-for="(reason, index) in item.reasons" :key="index" class="mo-detail-reason">{{ reason }}</div>
                  </li>
                </ol>
                <div v-if="state.picked.length && engine.removed.length" class="mo-detail-line">
                  被挤掉：<span v-for="removed in engine.removed" :key="`removed-${removed.itemId}`" class="mo-removed-item" :title="removed.reason">{{ removed.name }}</span>
                </div>
                <div v-for="(note, index) in engine.notes" :key="`note-${index}`" class="mo-detail-line">{{ note }}</div>
                <div class="mo-detail-line">{{ liveLabel }}</div>
                <div class="mo-detail-line mo-disclaimer">海克斯加成是规则模型（数据源没有海克斯×装备胜率）；先验来自该英雄的真实出装统计。</div>
              </div>
            </template>
            <div v-else class="mo-empty">暂无该英雄的出装数据</div>
          </template>
        </section>
      </div>
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
  applySwap,
  generateBuildPlans,
  localizeArchetype,
  planDifference,
  recommendBuild,
  resolvePlan,
  type BuildPlan,
  type BuildPlanKey,
  type ItemAlternative,
  type ItemSwap,
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
  ManualOverlaySection,
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
  collapsed: false,
  collapseHotkey: 'CommandOrControl+Shift+H',
  collapseHotkeyRegistered: false,
  collapseHotkeyError: null,
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
  collapseHotkey: 'CommandOrControl+Shift+H',
  minimalMode: false,
  opacity: 0.92,
  scale: 1,
  collapsedSections: [],
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
const collapseHotkeyOptions = [
  { value: 'CommandOrControl+Shift+H', label: 'Ctrl+Shift+H' },
  { value: 'CommandOrControl+Alt+H', label: 'Ctrl+Alt+H' },
  { value: 'F9', label: 'F9' },
  { value: 'F7', label: 'F7' },
  { value: '', label: '不使用' },
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
const engineInput = computed(() => ({
  builds: championData.value?.builds || [],
  items: engineItems.value,
  augments: heldProfiles.value,
  ownedItemIds: live.value?.found ? live.value.ownedItemIds : [],
  enemyItemIds: live.value?.found ? live.value.enemyItemIds : [],
}))

// ------------------------------------------------------------- 方案切换 + 换装（每局记住）
interface BuildPrefs {
  gameRevision: number
  championId: number | null
  plan: BuildPlanKey | null
  swaps: Partial<Record<BuildPlanKey, ItemSwap[]>>
  /** 选方案时持有的海克斯（之后海克斯变了才提示） */
  planAugmentKey?: string | null
  /** 已关闭提示的海克斯组合 */
  hintDismissedKey?: string | null
  savedAt?: number
}
/** 超过这么久没动过的记录视为上一局的（应用重启后 gameRevision 会从头计数） */
const BUILD_PREFS_MAX_AGE_MS = 90 * 60 * 1000
const BUILD_PREFS_KEY = 'aramgg.manualOverlay.buildPrefs'

function loadBuildPrefs(): BuildPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(BUILD_PREFS_KEY) || 'null')
    if (raw && typeof raw === 'object') return { gameRevision: -1, championId: null, plan: null, swaps: {}, ...raw }
  } catch {
    // ignore
  }
  return { gameRevision: -1, championId: null, plan: null, swaps: {} }
}
const buildPrefs = ref<BuildPrefs>(loadBuildPrefs())

function saveBuildPrefs(patch: Partial<BuildPrefs>) {
  buildPrefs.value = { ...buildPrefs.value, ...patch, savedAt: Date.now() }
  try {
    localStorage.setItem(BUILD_PREFS_KEY, JSON.stringify(buildPrefs.value))
  } catch {
    // ignore
  }
}

/** 新的一局或换了英雄：清空方案选择和换装（英雄还没加载出来时不算换英雄） */
let stateLoaded = !hasElectronAPI()
watch(() => [state.value.gameRevision, championId.value] as const, ([revision, id]) => {
  if (!stateLoaded) return
  const prefs = buildPrefs.value
  const stale = !prefs.savedAt || Date.now() - prefs.savedAt > BUILD_PREFS_MAX_AGE_MS
  const championChanged = id != null && prefs.championId != null && id !== prefs.championId
  if (prefs.gameRevision !== revision || championChanged || stale) {
    saveBuildPrefs({ gameRevision: revision, championId: id, plan: null, swaps: {} })
  } else if (id != null && prefs.championId == null) {
    saveBuildPrefs({ championId: id })
  }
})

const plans = computed<BuildPlan[]>(() => generateBuildPlans(engineInput.value, { swaps: buildPrefs.value.swaps }))
const activePlan = computed(() => resolvePlan(plans.value, buildPrefs.value.plan))

const engine = computed(() => activePlan.value?.result ?? recommendBuild(engineInput.value))

const augmentKey = computed(() => state.value.picked.map((augment) => String(augment.id)).sort().join(','))

function selectPlan(key: BuildPlanKey) {
  slotMenuItemId.value = null
  saveBuildPrefs({ plan: key, planAugmentKey: augmentKey.value, hintDismissedKey: null })
}

function dismissPlanHint() {
  saveBuildPrefs({ hintDismissedKey: augmentKey.value })
}

function planTabLabel(plan: BuildPlan) {
  return [plan.label, ...plan.aliases].join(' · ')
}

/** 选了别的方案之后海克斯又变了，且「海克斯适配」与当前方案相差很多：提示（可关闭） */
const planHint = computed(() => {
  const prefs = buildPrefs.value
  const current = activePlan.value
  const adapted = plans.value.find((plan) => plan.key === 'adapted')
  if (!current || !adapted || current.key === 'adapted') return null
  if (prefs.planAugmentKey == null || prefs.planAugmentKey === augmentKey.value) return null
  if (prefs.hintDismissedKey === augmentKey.value) return null
  const difference = planDifference(current.result, adapted.result)
  return difference >= 3 ? `海克斯变了：「海克斯适配」与当前方案差 ${difference} 件` : null
})

// 格位备选：点格子展开，点备选换装
const slotMenuItemId = ref<number | null>(null)
const slotMenuItem = computed(() => engine.value.items.find((item) => item.itemId === slotMenuItemId.value) ?? null)

function toggleSlotMenu(item: EngineItem) {
  slotMenuItemId.value = slotMenuItemId.value === item.itemId ? null : item.itemId
}

function swapSlot(item: EngineItem, alternative: ItemAlternative | { itemId: number }) {
  const plan = activePlan.value
  if (!plan) return
  const current = buildPrefs.value.swaps[plan.key] ?? []
  const next = applySwap(current, item.itemId, item.swappedFrom, alternative.itemId)
  saveBuildPrefs({ swaps: { ...buildPrefs.value.swaps, [plan.key]: next } })
  slotMenuItemId.value = alternative.itemId
}

function formatSigned(value: number) {
  return `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value).toFixed(1)}`
}

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

const archetypeName = computed(() => {
  const archetype = engine.value.archetype
  return archetype ? `${localizeArchetype(archetype.label)}流` : ''
})
const archetypeChanged = computed(() => !!engine.value.archetype && engine.value.archetype.baselineIndex !== 0 && state.value.picked.length > 0)

// ------------------------------------------------------------- 布局：收起 / 分区折叠 / 缩放
const frameRef = ref<HTMLElement | null>(null)
const collapsed = computed(() => state.value.collapsed === true)
const cardDetails = ref(false)
const buildDetails = ref(false)
const hoverItemId = ref<number | null>(null)

const frameStyle = computed(() => ({
  zoom: String(settings.scale || 1),
  '--mo-bg-alpha': String(settings.opacity ?? 0.92),
}))
/** 展开时最高不超过屏幕可用高度的 90%（超出部分在内容区滚动） */
const shellStyle = computed(() => {
  const available = typeof window !== 'undefined' && window.screen?.availHeight ? window.screen.availHeight : 1000
  return { maxHeight: `${Math.round((available * 0.9) / (settings.scale || 1)) - 16}px` }
})

const collapseHotkeyLabel = computed(() => (state.value.collapseHotkey || '').replace('CommandOrControl', 'Ctrl'))

const statusMessages = computed(() => [
  state.value.lastError,
  championError.value,
  state.value.hotkeyRegistered ? null : `刷新快捷键：${state.value.hotkeyError || '未注册'}`,
  state.value.collapseHotkey && !state.value.collapseHotkeyRegistered && state.value.collapseHotkeyError
    ? `收起快捷键：${state.value.collapseHotkeyError}`
    : null,
].filter((message): message is string => !!message))

function isSectionCollapsed(section: ManualOverlaySection) {
  return (settings.collapsedSections || []).includes(section)
}

function toggleSection(section: ManualOverlaySection) {
  const current = new Set(settings.collapsedSections || [])
  if (current.has(section)) current.delete(section)
  else current.add(section)
  settings.collapsedSections = (['cards', 'picked', 'build'] as ManualOverlaySection[]).filter((entry) => current.has(entry))
  void saveSettings()
}

async function setCollapsed(value: boolean) {
  closeCorrection()
  showSettings.value = false
  // 先本地切换，界面立即响应；主进程状态随后广播回来
  state.value = { ...state.value, collapsed: value }
  applyState(await electronAPI.manualOverlay.setCollapsed(value))
}

const nextItem = computed(() => engine.value.items.find((item) => item.isNext) ?? engine.value.items[0] ?? null)
const focusItem = computed(() => {
  const id = hoverItemId.value ?? slotMenuItemId.value
  return engine.value.items.find((item) => item.itemId === id) ?? nextItem.value
})
const focusIndex = computed(() => engine.value.items.findIndex((item) => item.itemId === focusItem.value?.itemId))
/** 焦点装备：最关键的海克斯原因在前，数据先验在后 */
const focusReasons = computed(() => {
  const reasons = focusItem.value?.reasons || []
  return reasons.length > 1 ? [reasons[1], reasons[0]] : reasons.slice(0, 1)
})

function itemTooltip(item: EngineItem) {
  return [item.name, ...item.reasons, scoreTitle(item)].join('\n')
}

function cardTooltip(entry: SynergyRankedChoice<CardInput>) {
  const lines = [`${entry.card.name}（点击记录为已选）`]
  if (entry.method === 'shrunk') {
    lines.push(`收缩胜率 ${formatPercent(entry.shrunkWinRate)}（相对基准 ${formatDelta(entry.delta)}）`)
    lines.push(`${entry.games} 场 · 原始胜率 ${formatPercent(entry.rawWinRate)}`)
  }
  if (entry.synergy?.reasons?.length) lines.push(`契合：${entry.synergy.reasons.join('；')}`)
  const source = sourceTitle(entry.card)
  if (source) lines.push(source)
  return lines.join('\n')
}

// 窗口尺寸跟随内容：收起成小条、分区折叠、缩放都会让窗口实际变小
let resizeObserver: ResizeObserver | null = null
let fitFrame = 0
let lastFit = ''
function scheduleFit() {
  if (!hasElectronAPI() || fitFrame) return
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0
    const element = frameRef.value
    if (!element) return
    const rect = element.getBoundingClientRect()
    const size = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) }
    const key = `${size.width}x${size.height}`
    if (key === lastFit) return
    lastFit = key
    void electronAPI.manualOverlay.fitContent(size).catch(() => {})
  })
}

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
  document.documentElement.classList.add('manual-overlay-window')
  document.body.classList.add('manual-overlay-window')
  if (typeof ResizeObserver !== 'undefined' && frameRef.value) {
    resizeObserver = new ResizeObserver(scheduleFit)
    resizeObserver.observe(frameRef.value)
  }
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
  stateLoaded = true
  if (buildPrefs.value.gameRevision !== state.value.gameRevision ||
    !buildPrefs.value.savedAt || Date.now() - buildPrefs.value.savedAt > BUILD_PREFS_MAX_AGE_MS) {
    saveBuildPrefs({ gameRevision: state.value.gameRevision, championId: null, plan: null, swaps: {} })
  }
  Object.assign(settings, initialSettings)
  applyChampionMonitor(monitor)

  void pollLive()
  livePollTimer = setInterval(() => {
    void pollLive()
  }, LIVE_POLL_INTERVAL_MS)
})

watch(() => [collapsed.value, settings.scale], () => {
  lastFit = ''
  void nextTick(scheduleFit)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (fitFrame) cancelAnimationFrame(fitFrame)
  document.documentElement.classList.remove('manual-overlay-window')
  document.body.classList.remove('manual-overlay-window')
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
  if (livePollTimer) clearInterval(livePollTimer)
  closeCorrection()
})
</script>

<style scoped>
/* ---------- 基础：透明窗口 + 海克斯风格外壳 ---------- */
.mo-frame {
  --mo-gold: #c8aa6e;
  --mo-gold-bright: #f0d89a;
  --mo-gold-dim: rgba(200, 170, 110, 0.35);
  --mo-ivory: #ece3cf;
  --mo-text: #cfd6e0;
  --mo-muted: #8590a2;
  --mo-blue: #0ac8b9;
  --mo-up: #5fd08a;
  --mo-down: #ef6f6f;
  --mo-radius: 10px;
  display: inline-block;
  box-sizing: border-box;
  padding: 8px;
  font-family: "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Segoe UI", sans-serif;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  color: var(--mo-text);
  -webkit-font-smoothing: antialiased;
}
.mo-frame *, .mo-frame *::before, .mo-frame *::after { box-sizing: border-box; }

.mo-shell {
  display: flex;
  flex-direction: column;
  width: 320px;
  overflow: hidden;
  border-radius: var(--mo-radius);
  border: 1px solid var(--mo-gold-dim);
  background:
    linear-gradient(180deg, rgba(16, 24, 40, var(--mo-bg-alpha)) 0%, rgba(8, 12, 22, var(--mo-bg-alpha)) 100%);
  box-shadow:
    0 6px 18px rgba(0, 0, 0, 0.45),
    inset 0 1px 0 rgba(240, 216, 154, 0.08);
  -webkit-app-region: drag;
}
.mo-no-drag, .mo-frame button, .mo-frame input, .mo-frame select { -webkit-app-region: no-drag; }

/* ---------- 收起的小条 ---------- */
.mo-bar {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  width: auto;
  height: 48px;
  padding: 0 8px;
}
.mo-bar-champion {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--mo-gold-dim);
  flex: none;
}
.mo-bar-next {
  position: relative;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 6px;
  border: 1px solid var(--mo-gold);
  box-shadow: 0 0 8px rgba(240, 216, 154, 0.35);
  overflow: hidden;
  background: #0b1220;
}
.mo-bar-next img { width: 100%; height: 100%; display: block; }
.mo-bar-empty { display: flex; height: 100%; align-items: center; justify-content: center; color: var(--mo-muted); }
.mo-bar-text { display: flex; flex-direction: column; min-width: 0; max-width: 104px; }
.mo-bar-label { font-size: 10px; color: var(--mo-gold); letter-spacing: 0.5px; }
.mo-bar-name { color: var(--mo-ivory); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mo-bar-dot {
  width: 8px; height: 8px; flex: none; border-radius: 50%;
  background: var(--mo-blue); box-shadow: 0 0 6px var(--mo-blue);
}

/* ---------- 按钮 ---------- */
.mo-btn {
  height: 26px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid var(--mo-gold-dim);
  background: rgba(30, 40, 60, 0.8);
  color: var(--mo-ivory);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.mo-btn:hover:not(:disabled) { border-color: var(--mo-gold); }
.mo-btn:disabled { opacity: 0.55; cursor: default; }
.mo-btn-primary {
  border-color: var(--mo-gold);
  background: linear-gradient(180deg, #2a3c55 0%, #18263a 100%);
  color: var(--mo-gold-bright);
}
.mo-btn-small { height: 22px; padding: 0 8px; font-size: 11px; }
.mo-icon-btn {
  width: 26px;
  height: 26px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--mo-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.mo-icon-btn:hover:not(:disabled), .mo-icon-active { color: var(--mo-gold-bright); border-color: var(--mo-gold-dim); background: rgba(200, 170, 110, 0.08); }
.mo-icon-primary { color: var(--mo-gold-bright); border-color: var(--mo-gold-dim); }
.mo-spin { animation: mo-spin 0.9s linear infinite; }
@keyframes mo-spin { to { transform: rotate(360deg); } }
.mo-link {
  border: none;
  background: none;
  padding: 0 2px;
  color: var(--mo-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.mo-link:hover, .mo-link-active { color: var(--mo-gold-bright); }

/* ---------- 头部 ---------- */
.mo-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 8px 10px;
  border-bottom: 1px solid rgba(200, 170, 110, 0.18);
  background: linear-gradient(90deg, rgba(200, 170, 110, 0.08), transparent 70%);
}
.mo-champion-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--mo-gold);
  flex: none;
}
.mo-title { flex: 1; min-width: 0; margin-left: 2px; }
.mo-champion-name { color: var(--mo-ivory); font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mo-subtitle { color: var(--mo-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mo-watching { color: var(--mo-blue); }

.mo-reminder {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 10px 0;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid rgba(10, 200, 185, 0.4);
  background: rgba(10, 200, 185, 0.08);
}
.mo-reminder-urgent { border-color: var(--mo-blue); animation: mo-pulse 1.2s ease-in-out infinite; }
@keyframes mo-pulse { 50% { background: rgba(10, 200, 185, 0.22); } }
.mo-reminder-text { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 11px; }
.mo-reminder-text b { color: var(--mo-blue); font-size: 12px; }

/* ---------- 内容区与分区 ---------- */
.mo-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 10px 10px;
}
.mo-body::-webkit-scrollbar { width: 6px; }
.mo-body::-webkit-scrollbar-thumb { background: rgba(200, 170, 110, 0.3); border-radius: 3px; }
.mo-body::-webkit-scrollbar-track { background: transparent; }

.mo-status {
  margin-top: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(239, 111, 111, 0.1);
  border: 1px solid rgba(239, 111, 111, 0.3);
  color: #f2b0a5;
  font-size: 11px;
}

.mo-section { margin-top: 8px; }
.mo-section + .mo-section { padding-top: 8px; border-top: 1px solid rgba(200, 170, 110, 0.12); }
.mo-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 22px;
  margin-bottom: 6px;
}
.mo-section-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.mo-section-title { color: var(--mo-gold); font-weight: 700; font-size: 12px; letter-spacing: 1px; }
.mo-chevron { display: inline-block; width: 10px; color: var(--mo-gold); font-size: 10px; transition: transform 0.15s; }
.mo-chevron-closed { transform: rotate(-90deg); }
.mo-count {
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: rgba(200, 170, 110, 0.18); color: var(--mo-gold-bright); font-size: 10px; line-height: 16px; text-align: center;
}
.mo-muted { color: var(--mo-muted); }
.mo-empty { color: var(--mo-muted); font-size: 11px; padding: 2px 0 4px; }

/* ---------- 三选一卡片 ---------- */
.mo-cards { display: flex; flex-direction: column; gap: 6px; }
.mo-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid rgba(120, 140, 170, 0.22);
  background: rgba(20, 30, 48, 0.75);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.mo-card:hover { border-color: var(--mo-gold-dim); background: rgba(28, 40, 62, 0.9); }
.mo-card-best {
  border-color: var(--mo-gold);
  background: linear-gradient(90deg, rgba(200, 170, 110, 0.16), rgba(20, 30, 48, 0.8) 70%);
  box-shadow: 0 0 10px rgba(200, 170, 110, 0.15);
}
.mo-card-tie { border-color: rgba(10, 200, 185, 0.5); }
.mo-card-icon-wrap {
  width: 36px; height: 36px; flex: none; border-radius: 50%;
  background: radial-gradient(circle, rgba(60, 80, 120, 0.6), rgba(10, 16, 28, 0.9));
  display: flex; align-items: center; justify-content: center;
}
.mo-card-icon { width: 32px; height: 32px; }
.mo-card-main { flex: 1; min-width: 0; }
.mo-card-name { display: flex; align-items: center; gap: 4px; }
.mo-card-title {
  color: var(--mo-ivory); font-weight: 700; font-size: 13px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border-bottom: 1px dashed transparent;
}
.mo-card-title:hover { border-bottom-color: var(--mo-gold-dim); }
.mo-warn-dot {
  width: 14px; height: 14px; flex: none; border-radius: 50%; background: #c98a2e; color: #10141c;
  font-size: 10px; font-weight: 700; line-height: 14px; text-align: center;
}
.mo-card-stats { display: flex; align-items: baseline; gap: 6px; margin-top: 1px; }
.mo-wr { color: var(--mo-ivory); font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
.mo-delta { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.mo-up { color: var(--mo-up); }
.mo-down { color: var(--mo-down); }
.mo-synergy { font-size: 10px; padding: 0 5px; border-radius: 8px; line-height: 16px; white-space: nowrap; }
.mo-synergy-up { background: rgba(95, 208, 138, 0.14); color: var(--mo-up); }
.mo-synergy-down { background: rgba(239, 111, 111, 0.14); color: var(--mo-down); }
.mo-card-detail { margin-top: 3px; color: var(--mo-muted); font-size: 10px; line-height: 1.45; }
.mo-card-detail-synergy { color: #a9c7b4; }
.mo-rank {
  flex: none;
  min-width: 44px;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 700;
  text-align: center;
  letter-spacing: 1px;
}
.mo-badge-best { background: linear-gradient(180deg, #e4c77f, #b48d47); color: #1a1408; box-shadow: 0 0 8px rgba(240, 216, 154, 0.35); }
.mo-badge-tie { background: rgba(10, 200, 185, 0.18); color: var(--mo-blue); border: 1px solid rgba(10, 200, 185, 0.45); }
.mo-badge-plain { background: rgba(120, 140, 170, 0.14); color: var(--mo-muted); border: 1px solid rgba(120, 140, 170, 0.25); }
.mo-footnote {
  padding: 6px 8px; border-radius: 6px; background: rgba(0, 0, 0, 0.2);
  color: var(--mo-muted); font-size: 10px; line-height: 1.5;
}

/* ---------- 更正面板 ---------- */
.mo-correction {
  padding: 6px;
  border-radius: 8px;
  border: 1px solid var(--mo-gold-dim);
  background: rgba(6, 10, 18, 0.9);
}
.mo-correction-title { display: flex; justify-content: space-between; align-items: center; color: var(--mo-gold); font-size: 11px; margin-bottom: 4px; }
.mo-search {
  width: 100%; height: 26px; margin: 4px 0; padding: 0 8px; border-radius: 6px;
  border: 1px solid var(--mo-gold-dim); background: rgba(16, 24, 40, 0.9); color: var(--mo-ivory); font: inherit;
}
.mo-search:focus { outline: none; border-color: var(--mo-gold); }
.mo-alt-list { display: flex; flex-direction: column; gap: 2px; }
.mo-alt {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 3px 6px; border-radius: 6px;
  border: 1px solid transparent; background: transparent; color: var(--mo-text); font: inherit; text-align: left; cursor: pointer;
}
.mo-alt:hover { background: rgba(200, 170, 110, 0.1); border-color: var(--mo-gold-dim); }
.mo-alt img { width: 20px; height: 20px; }
.mo-alt-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mo-alt-current { border-color: var(--mo-gold-dim); }

/* ---------- 已选海克斯 ---------- */
.mo-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.mo-chip {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
  height: 24px; padding: 0 4px 0 3px; border-radius: 12px;
  border: 1px solid rgba(200, 170, 110, 0.3); background: rgba(24, 34, 52, 0.85);
}
.mo-chip img { width: 18px; height: 18px; border-radius: 50%; }
.mo-chip-name { color: var(--mo-ivory); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mo-chip-name:hover { color: var(--mo-gold-bright); }
.mo-chip-inferred { border-style: dashed; }
.mo-chip-tag { font-size: 9px; padding: 0 4px; border-radius: 6px; background: rgba(200, 170, 110, 0.2); color: var(--mo-gold-bright); line-height: 14px; }
.mo-chip-x { border: none; background: none; color: var(--mo-muted); font-size: 13px; line-height: 1; padding: 0 2px; cursor: pointer; }
.mo-chip-x:hover { color: var(--mo-down); }
.mo-mini-icons { display: inline-flex; gap: 2px; }
.mo-mini-icons img { width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--mo-gold-dim); }

/* ---------- 出装：6 格 ---------- */
.mo-archetype {
  font-size: 10px; padding: 0 6px; border-radius: 8px; line-height: 16px;
  background: rgba(120, 140, 170, 0.15); color: var(--mo-text);
}
.mo-archetype-changed { background: rgba(10, 200, 185, 0.16); color: var(--mo-blue); }
.mo-slots { display: grid; grid-template-columns: repeat(6, 1fr); gap: 5px; }
.mo-slot {
  position: relative;
  aspect-ratio: 1;
  border-radius: 6px;
  border: 1px solid rgba(120, 140, 170, 0.35);
  background: #0b1220;
  cursor: pointer;
  overflow: visible;
}
.mo-slot img { width: 100%; height: 100%; display: block; border-radius: 5px; }
.mo-slot:hover { border-color: var(--mo-gold-dim); }
.mo-slot-next {
  border: 2px solid var(--mo-gold-bright);
  box-shadow: 0 0 10px rgba(240, 216, 154, 0.55);
}
.mo-slot-focus { border-color: var(--mo-gold); }
.mo-slot-owned img { filter: grayscale(0.7) brightness(0.55); }
.mo-slot-check {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--mo-up); font-size: 16px; font-weight: 700; text-shadow: 0 1px 2px #000;
}
.mo-slot-badge {
  position: absolute; top: 1px; right: 1px; min-width: 15px; height: 15px; padding: 0 3px;
  border-radius: 8px; font-size: 9px; font-weight: 700; line-height: 15px; text-align: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}
.mo-change-new { background: #2f9e5e; color: #fff; }
.mo-change-up { background: #24543a; color: #a6f0c2; }
.mo-change-down { background: #5a2b26; color: #f6b8ac; }

.mo-plan-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 7px;
  padding: 2px;
  border-radius: 7px;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(120, 140, 170, 0.18);
}
.mo-plan-tab {
  flex: 1 1 0;
  min-width: 0;
  height: 22px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--mo-muted);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.mo-plan-tab:hover { color: var(--mo-ivory); }
.mo-plan-tab-active {
  color: #1a1408;
  font-weight: 700;
  background: linear-gradient(180deg, #e4c77f, #b48d47);
  border-color: rgba(240, 216, 154, 0.6);
}
.mo-plan-hint {
  display: flex; align-items: center; gap: 4px; margin-bottom: 6px; padding: 3px 6px; border-radius: 6px;
  background: rgba(10, 200, 185, 0.1); border: 1px solid rgba(10, 200, 185, 0.35); color: var(--mo-blue); font-size: 11px;
}
.mo-plan-hint span { flex: 1; min-width: 0; }
.mo-slot-open { border-color: var(--mo-blue); box-shadow: 0 0 8px rgba(10, 200, 185, 0.45); }
.mo-slot-swapped {
  position: absolute; left: 1px; bottom: 1px; padding: 0 3px; border-radius: 4px;
  background: rgba(10, 200, 185, 0.85); color: #04201d; font-size: 9px; font-weight: 700; line-height: 13px;
}
.mo-slot-menu {
  margin-top: 8px; padding: 6px; border-radius: 8px;
  border: 1px solid rgba(10, 200, 185, 0.4); background: rgba(6, 12, 22, 0.92);
}
.mo-slot-menu-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; color: var(--mo-ivory); font-size: 11px; font-weight: 600; }
.mo-slot-alt {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px; border-radius: 6px;
  border: 1px solid transparent; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.mo-slot-alt:hover { border-color: var(--mo-gold-dim); background: rgba(200, 170, 110, 0.08); }
.mo-slot-alt img { width: 28px; height: 28px; flex: none; border-radius: 4px; border: 1px solid rgba(120, 140, 170, 0.35); }
.mo-slot-alt-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.mo-slot-alt-name { color: var(--mo-ivory); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mo-slot-alt-tag { margin-left: 4px; font-size: 9px; padding: 0 4px; border-radius: 4px; background: rgba(200, 170, 110, 0.2); color: var(--mo-gold-bright); font-weight: 400; }
.mo-slot-alt-reason { color: var(--mo-muted); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mo-slot-alt-delta { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; }
.mo-detail-plans { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
.mo-detail-plan { display: flex; flex-direction: column; padding: 3px 6px; border-left: 2px solid rgba(120, 140, 170, 0.3); }
.mo-detail-plan b { color: var(--mo-ivory); font-size: 11px; }
.mo-detail-plan-active { border-left-color: var(--mo-gold); }
.mo-detail-plan-desc { color: #6f7a8c; }
.mo-focus {
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(200, 170, 110, 0.07);
  border: 1px solid rgba(200, 170, 110, 0.18);
}
.mo-focus-head { display: flex; align-items: center; gap: 6px; }
.mo-focus-tag {
  flex: none; font-size: 10px; padding: 0 6px; line-height: 16px; border-radius: 4px;
  background: var(--mo-gold); color: #1a1408; font-weight: 700;
}
.mo-focus-name { flex: 1; min-width: 0; color: var(--mo-ivory); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mo-focus-reason { margin-top: 3px; font-size: 11px; color: var(--mo-text); line-height: 1.45; }
.mo-focus-reason-secondary { color: var(--mo-muted); font-size: 10px; margin-top: 1px; }

.mo-build-details {
  margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: rgba(0, 0, 0, 0.22);
  font-size: 10px; color: var(--mo-muted); line-height: 1.5;
}
.mo-detail-items { list-style: none; margin: 0; padding: 0; }
.mo-detail-items li { padding: 4px 0; border-bottom: 1px solid rgba(120, 140, 170, 0.12); }
.mo-detail-items li:last-child { border-bottom: none; }
.mo-detail-item-head { display: flex; align-items: center; gap: 6px; color: var(--mo-ivory); font-size: 11px; font-weight: 600; }
.mo-detail-item-head img { width: 18px; height: 18px; border-radius: 3px; }
.mo-detail-score { margin-left: auto; font-weight: 400; }
.mo-detail-reason { padding-left: 24px; }
.mo-detail-line { margin-top: 3px; }
.mo-removed-item { text-decoration: line-through; color: #b98c84; margin-right: 6px; }
.mo-disclaimer { font-style: italic; }

/* ---------- 设置 ---------- */
.mo-settings {
  padding: 8px; border-radius: 8px; border: 1px solid rgba(200, 170, 110, 0.2); background: rgba(0, 0, 0, 0.22);
}
.mo-settings-grid { display: flex; flex-direction: column; gap: 5px; margin-bottom: 6px; }
.mo-setting-row { display: grid; grid-template-columns: 92px 1fr auto; align-items: center; gap: 6px; font-size: 11px; }
.mo-setting-row select, .mo-setting-row input[type="range"] { grid-column: 2 / span 1; width: 100%; }
.mo-setting-row select {
  height: 22px; border-radius: 4px; border: 1px solid var(--mo-gold-dim); background: #111a2a; color: var(--mo-ivory); font: inherit;
}
.mo-setting-row input[type="range"] { accent-color: var(--mo-gold); }
.mo-setting-value { min-width: 34px; text-align: right; color: var(--mo-gold-bright); font-variant-numeric: tabular-nums; }
.mo-check { display: flex; align-items: flex-start; gap: 6px; margin-top: 3px; font-size: 11px; cursor: pointer; }
.mo-check input { margin: 2px 0 0; accent-color: var(--mo-gold); }
.mo-settings-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 8px; font-size: 10px; }

:global(html.manual-overlay-window),
:global(body.manual-overlay-window),
:global(html.manual-overlay-window #app) {
  background: transparent !important;
  height: auto !important;
  min-height: 0 !important;
}
:global(body.manual-overlay-window) { margin: 0; overflow: hidden; }
</style>
