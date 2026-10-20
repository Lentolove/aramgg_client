/**
 * 手动刷新浮窗的主进程状态机。
 *
 * - 不依赖 OCR 是否成功：浮窗在 InProgress（可选 ChampSelect）阶段常驻显示，英雄由 LCU/2999 检测；
 * - 刷新（按钮或全局快捷键）= 截一次游戏窗口 → 现有 OCR + 名称匹配 → 广播三张候选卡；
 * - 已选海克斯在本局内记忆，新的一局（ChampSelect / GameStart）自动清空，可手动移除。
 *
 * 所有 Electron / OCR / LCU 依赖都通过 deps 注入，便于单元测试。
 */
import type {
  GameflowPhase,
  ManualOverlayAlternative,
  ManualOverlayAugmentRef,
  ManualOverlayCandidate,
  ManualOverlayInferredSource,
  ManualOverlayLiveData,
  ManualOverlayPickedAugment,
  ManualOverlayReminder,
  ManualOverlaySection,
  ManualOverlaySettings,
  ManualOverlayState,
} from '../../../shared/ipc-contract.ts'
import {
  combineSlotRecognition,
  DEFAULT_COMBINE_THRESHOLDS,
  type IconMatch,
} from '../../../shared/augment-icon-match.ts'
import {
  computeRefreshReminder,
  DEFAULT_START_WINDOW_SEC,
  formatLevelSchedule,
  parseLevelSchedule,
} from '../../../shared/refresh-reminder.ts'
import { parseLiveClientPlayers } from '../../../shared/augment-build-heuristic.ts'
import { DEFAULT_SHRINKAGE_ALPHA } from '../../../shared/augment-choice-ranking.ts'

export const DEFAULT_MANUAL_OVERLAY_HOTKEY = 'CommandOrControl+Shift+R'
export const MANUAL_OVERLAY_SETTINGS_KEY = 'manualOverlay.settings'
/** 0.3.2：海克斯卡改成「排序分」为主数字，胜率默认隐藏；旧设置迁移一次（之后用户可以再打开） */
export const HIDE_WIN_RATES_MIGRATION_KEY = 'manualOverlay.migrations.hideWinRatesDefault'
export const MANUAL_OVERLAY_COLLAPSED_KEY = 'manualOverlay.collapsed'
export const DEFAULT_COLLAPSE_HOTKEY = 'CommandOrControl+Shift+H'
const SECTIONS: ManualOverlaySection[] = ['cards', 'picked', 'build']

export const DEFAULT_MANUAL_OVERLAY_SETTINGS: ManualOverlaySettings = {
  hotkey: DEFAULT_MANUAL_OVERLAY_HOTKEY,
  showInChampSelect: false,
  shrinkageAlpha: DEFAULT_SHRINKAGE_ALPHA,
  focusable: false,
  reminderEnabled: true,
  augmentLevels: '1,7,11,15',
  reminderOnlyWhenDead: false,
  startWindowSec: DEFAULT_START_WINDOW_SEC,
  iconMatchEnabled: true,
  autoFollowUp: true,
  collapseHotkey: DEFAULT_COLLAPSE_HOTKEY,
  minimalMode: false,
  opacity: 0.92,
  scale: 1,
  collapsedSections: [],
  hideWinRates: true,
}

function clampNumber(value: unknown, min: number, max: number, fallback: number, step = 0.01): number {
  const number = Number(value)
  if (value == null || !Number.isFinite(number)) return fallback
  return Math.round(Math.min(max, Math.max(min, number)) / step) * step
}

/** 自动跟拍：每次识别完成后隔多久再拍、最长跟多久 */
export const FOLLOW_UP_INTERVAL_MS = 2500
export const FOLLOW_UP_MAX_MS = 45000

/** 新的一局从这些阶段开始；Reconnect → InProgress 不算新局。 */
const NEW_GAME_PHASES = new Set<string>(['ChampSelect', 'GameStart'])
// LCU 还会报告 'Reconnect'（未列入 GameflowPhase 类型），按对局中处理
const IN_GAME_PHASES = new Set<string>(['GameStart', 'InProgress', 'Reconnect'])
const HIDE_PHASES = new Set<string>([
  'None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'WaitingForStats', 'PreEndOfGame', 'EndOfGame',
])

export interface RawImageLike {
  buffer: Buffer
  width: number
  height: number
  channels: number
}

export type CaptureImage = Buffer | RawImageLike

export interface CaptureResultLike {
  success: boolean
  buffer?: Buffer
  /** RGBA 原始像素（优先使用，省掉 PNG 编解码） */
  raw?: RawImageLike
  enumerateMs?: number
  convertMs?: number
  error?: string
  captureMode?: 'window' | 'screen'
  windowName?: string
  width?: number
  height?: number
  hasLolWindow?: boolean
}

export interface AnalysisResultLike {
  success: boolean
  error?: string
  analysis?: {
    augments?: Array<Record<string, any>>
    cardCount?: number
    slotDiagnostics?: Array<Record<string, any>>
    rerollButtons?: { visible?: boolean } | null
  }
}

export interface RefreshLogRecord {
  type: 'refresh' | 'pick' | 'correct' | 'replace-picked' | 'acknowledge' | 'choice-closed' | 'live-augments'
  ts: number
  [key: string]: unknown
}

export interface ManualOverlayDeps {
  capture: () => Promise<CaptureResultLike>
  analyze: (image: CaptureImage) => Promise<AnalysisResultLike>
  warmup?: () => Promise<unknown>
  /** 图标匹配：返回 3 个卡位各自的前 N 名 */
  matchIcons?: (image: CaptureImage) => Promise<IconMatch[][]>
  iconIndexStatus?: () => { ready: boolean; count: number; error: string | null }
  ensureIconIndex?: () => Promise<unknown>
  /** 全部海克斯（按名字搜索更正用） */
  listAugments?: () => Promise<ManualOverlayAugmentRef[]>
  /** 刷新/选择/更正日志（jsonl），用于校准提醒时机与识别效果 */
  appendLog?: (record: RefreshLogRecord) => void
  getLiveClientAllGameData: () => Promise<{ status: number; data: any } | null>
  /** 选人阶段的我方阵容（LCU champ-select；不在选人时返回 null） */
  getChampSelectTeam?: () => Promise<{ selfChampionId: number | null; allyChampionIds: number[] } | null>
  store: { get: (key: string) => unknown; set: (key: string, value: unknown) => void }
  shortcuts: {
    register: (accelerator: string, callback: () => void) => boolean
    unregister: (accelerator: string) => void
    isRegistered?: (accelerator: string) => boolean
  }
  showWindow: (reason?: string) => Promise<void> | void
  hideWindow: (reason?: string) => void
  broadcast: (state: ManualOverlayState) => void
  now?: () => number
  /** 定时器（测试可注入）；返回取消函数 */
  schedule?: (callback: () => void, ms: number) => () => void
  logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; debug: (...args: any[]) => void }
}

function sanitizeSettings(raw: unknown): ManualOverlaySettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<ManualOverlaySettings>
  const alpha = Number(value.shrinkageAlpha)
  const startWindow = Number(value.startWindowSec ?? DEFAULT_START_WINDOW_SEC)
  return {
    hotkey: typeof value.hotkey === 'string' && value.hotkey.trim()
      ? value.hotkey.trim()
      : DEFAULT_MANUAL_OVERLAY_HOTKEY,
    showInChampSelect: value.showInChampSelect === true,
    shrinkageAlpha: Number.isFinite(alpha) && alpha >= 0 && alpha <= 100000 ? alpha : DEFAULT_SHRINKAGE_ALPHA,
    focusable: value.focusable === true,
    reminderEnabled: value.reminderEnabled !== false,
    augmentLevels: formatLevelSchedule(parseLevelSchedule(value.augmentLevels ?? DEFAULT_MANUAL_OVERLAY_SETTINGS.augmentLevels)),
    reminderOnlyWhenDead: value.reminderOnlyWhenDead === true,
    startWindowSec: Number.isFinite(startWindow) && startWindow >= 0 && startWindow <= 600
      ? Math.round(startWindow)
      : DEFAULT_START_WINDOW_SEC,
    iconMatchEnabled: value.iconMatchEnabled !== false,
    autoFollowUp: value.autoFollowUp !== false,
    collapseHotkey: typeof value.collapseHotkey === 'string'
      ? value.collapseHotkey.trim()
      : DEFAULT_COLLAPSE_HOTKEY,
    minimalMode: value.minimalMode === true,
    opacity: Number(clampNumber(value.opacity, 0.5, 1, 0.92).toFixed(2)),
    scale: Number(clampNumber(value.scale, 0.8, 1.4, 1, 0.05).toFixed(2)),
    collapsedSections: Array.isArray(value.collapsedSections)
      ? SECTIONS.filter((section) => (value.collapsedSections as unknown[]).includes(section))
      : [],
    hideWinRates: value.hideWinRates !== false,
  }
}

function toCandidate(augment: Record<string, any>, index: number): ManualOverlayCandidate | null {
  if (!augment || augment.missing || augment.id == null) return null
  return {
    id: augment.id,
    name: String(augment.name ?? augment.id),
    rarity: augment.rarity ?? null,
    iconPath: augment.iconPath ?? augment.iconUrl ?? null,
    slot: Number.isInteger(augment.detectedSlot) ? augment.detectedSlot : index,
    confidence: typeof augment.confidence === 'number' ? augment.confidence : null,
  }
}

/**
 * 把 OCR 结果（按卡位）与图标匹配结果合并成最终的三张候选卡。
 * 只靠图标（OCR 没认出）的卡位，要求画面确实像三选一界面：OCR 检测到刷新按钮 / 至少认出一张，
 * 或者至少两个卡位的图标都高置信。
 */
export function combineRecognition(
  ocrCandidates: ManualOverlayCandidate[],
  iconMatches: IconMatch[][] | null,
  rerollVisible: boolean,
): ManualOverlayCandidate[] {
  const bySlot = new Map<number, ManualOverlayCandidate>()
  for (const candidate of ocrCandidates) {
    if (candidate.slot >= 0 && candidate.slot <= 2 && !bySlot.has(candidate.slot)) bySlot.set(candidate.slot, candidate)
  }
  const icons = iconMatches ?? [[], [], []]
  const confidentIconSlots = icons.filter((matches) => {
    const [top, second] = matches
    return !!top && top.score >= DEFAULT_COMBINE_THRESHOLDS.iconConfident &&
      top.score - (second?.score ?? 0) >= DEFAULT_COMBINE_THRESHOLDS.iconMargin
  }).length
  const allowIconOnly = rerollVisible || ocrCandidates.length > 0 || confidentIconSlots >= 2

  const result: ManualOverlayCandidate[] = []
  for (let slot = 0; slot < 3; slot++) {
    const ocr = bySlot.get(slot) ?? null
    const matches = icons[slot] ?? []
    if (!ocr && !allowIconOnly) continue
    const combined = combineSlotRecognition(slot, ocr ? {
      id: ocr.id,
      name: ocr.name,
      iconPath: ocr.iconPath ?? null,
      rarity: ocr.rarity ?? null,
      confidence: ocr.confidence ?? null,
    } : null, matches)
    if (!combined) continue
    result.push({
      id: combined.id,
      name: combined.name,
      rarity: combined.rarity ?? null,
      iconPath: combined.iconPath ?? null,
      slot,
      source: combined.source,
      confidence: Number(combined.confidence.toFixed(3)),
      iconScore: combined.iconScore,
      alternatives: combined.alternatives.slice(0, 6).map((alt): ManualOverlayAlternative => ({
        id: alt.id,
        name: alt.name,
        iconPath: alt.iconPath ?? null,
        rarity: alt.rarity ?? null,
        score: alt.score,
        source: alt.source,
      })),
    })
  }
  return result
}

function countSources(candidates: ManualOverlayCandidate[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const candidate of candidates) {
    const key = candidate.source ?? 'ocr'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function parseLiveTiming(data: any): { gameTime: number | null; level: number | null; isDead: boolean | null; respawnTimer: number | null } {
  const gameTime = Number(data?.gameData?.gameTime)
  const level = Number(data?.activePlayer?.level)
  const activeName = String(data?.activePlayer?.riotId ?? data?.activePlayer?.summonerName ?? '')
  const players = Array.isArray(data?.allPlayers) ? data.allPlayers : []
  const self = players.find((player: any) =>
    activeName && (player?.riotId === activeName || player?.summonerName === activeName))
  return {
    gameTime: Number.isFinite(gameTime) ? Math.round(gameTime * 10) / 10 : null,
    level: Number.isFinite(level) && level > 0 ? level : (Number.isFinite(Number(self?.level)) ? Number(self.level) : null),
    isDead: typeof self?.isDead === 'boolean' ? self.isDead : null,
    respawnTimer: Number.isFinite(Number(self?.respawnTimer)) ? Math.round(Number(self.respawnTimer) * 10) / 10 : null,
  }
}

/**
 * 从 2999 的 activePlayer / 自己的 allPlayers 条目里找「海克斯」字段。
 * 游戏是否在海克斯大乱斗里提供该字段未经验证：找不到就返回空，并把字段名带出去用于诊断。
 */
export function extractLiveAugmentIds(data: any): { ids: number[]; keys: string[] } {
  const ids = new Set<number>()
  const keys = new Set<string>()
  const activeName = String(data?.activePlayer?.riotId ?? data?.activePlayer?.summonerName ?? '')
  const players = Array.isArray(data?.allPlayers) ? data.allPlayers : []
  const self = players.find((player: any) =>
    activeName && (player?.riotId === activeName || player?.summonerName === activeName))
  const addValue = (value: unknown, depth: number) => {
    if (depth > 3 || value == null) return
    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
      const id = Number(value)
      if (Number.isInteger(id) && id > 0 && id < 10_000_000) ids.add(id)
    } else if (Array.isArray(value)) {
      value.forEach((entry) => addValue(entry, depth + 1))
    } else if (typeof value === 'object') {
      const record = value as Record<string, unknown>
      addValue(record.id ?? record.augmentId ?? record.augmentID, depth + 1)
    }
  }
  const scan = (record: unknown, prefix: string, depth: number) => {
    if (!record || typeof record !== 'object' || depth > 2) return
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      if (/augment/i.test(key)) {
        keys.add(`${prefix}${key}`)
        addValue(value, 0)
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        scan(value, `${prefix}${key}.`, depth + 1)
      }
    }
  }
  scan(data?.activePlayer, 'activePlayer.', 0)
  scan(self, 'self.', 0)
  return { ids: [...ids], keys: [...keys] }
}

function sanitizeAugmentRef(value: unknown): ManualOverlayAugmentRef | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = record.id
  if (typeof id !== 'number' && typeof id !== 'string') return null
  if (String(id).length === 0 || String(id).length > 32) return null
  return {
    id,
    name: String(record.name ?? id).slice(0, 64),
    rarity: (typeof record.rarity === 'number' || typeof record.rarity === 'string') ? record.rarity : null,
    iconPath: typeof record.iconPath === 'string' ? record.iconPath.slice(0, 512) : null,
  }
}

export class ManualOverlayService {
  private readonly deps: ManualOverlayDeps
  private state: ManualOverlayState
  private settings: ManualOverlaySettings
  private registeredHotkey: string | null = null
  private registeredCollapseHotkey: string | null = null
  private refreshPromise: Promise<ManualOverlayState> | null = null
  private warmedUp = false

  constructor(deps: ManualOverlayDeps) {
    this.deps = deps
    this.settings = sanitizeSettings(
      deps.store.get(MANUAL_OVERLAY_SETTINGS_KEY),
    )
    if (deps.store.get(HIDE_WIN_RATES_MIGRATION_KEY) !== true) {
      // 一次性：旧版本存的 hideWinRates=false 改成 true
      this.settings = { ...this.settings, hideWinRates: true }
      if (deps.store.get(MANUAL_OVERLAY_SETTINGS_KEY) != null) deps.store.set(MANUAL_OVERLAY_SETTINGS_KEY, { ...this.settings })
      deps.store.set(HIDE_WIN_RATES_MIGRATION_KEY, true)
    }
    this.state = {
      phase: null,
      gameRevision: 0,
      candidates: [],
      picked: [],
      refreshing: false,
      lastRefreshAt: null,
      lastError: null,
      lastCapture: null,
      hotkey: this.settings.hotkey,
      hotkeyRegistered: false,
      hotkeyError: null,
      acknowledgedStage: 0,
      iconIndex: { ready: false, count: 0, error: null },
      liveGame: false,
      pendingChoice: null,
      autoWatching: false,
      collapsed: deps.store.get(MANUAL_OVERLAY_COLLAPSED_KEY) === true,
      collapseHotkey: this.settings.collapseHotkey,
      collapseHotkeyRegistered: false,
      collapseHotkeyError: null,
      revision: 0,
    }
  }

  // ------------------------------------------------------------------ collapse

  isCollapsed(): boolean {
    return this.state.collapsed
  }

  /** 收起/展开（记住到下次启动）。source=auto 来自极简模式。 */
  setCollapsed(value: unknown, source: 'user' | 'hotkey' | 'auto' = 'user'): ManualOverlayState {
    const collapsed = value === true
    if (collapsed === this.state.collapsed) return this.getState()
    this.deps.store.set(MANUAL_OVERLAY_COLLAPSED_KEY, collapsed)
    this.deps.logger?.debug(`[manual-overlay] ${collapsed ? 'collapse' : 'expand'} (${source})`)
    return this.update({ collapsed })
  }

  toggleCollapsed(source: 'user' | 'hotkey' = 'user'): ManualOverlayState {
    return this.setCollapsed(!this.state.collapsed, source)
  }

  /** 极简模式：卡片出现 → 展开；卡片消失 → 收起 */
  private applyMinimalMode(previousCount: number, nextCount: number): void {
    if (!this.settings.minimalMode || previousCount === nextCount) return
    if (previousCount === 0 && nextCount > 0 && this.state.collapsed) {
      this.state = { ...this.state, collapsed: false }
      this.deps.store.set(MANUAL_OVERLAY_COLLAPSED_KEY, false)
    } else if (previousCount > 0 && nextCount === 0 && !this.state.collapsed) {
      this.state = { ...this.state, collapsed: true }
      this.deps.store.set(MANUAL_OVERLAY_COLLAPSED_KEY, true)
    }
  }

  // ------------------------------------------------------------------ follow-up
  private followUpCancel: (() => void) | null = null
  private followUpStartedAt: number | null = null
  private loggedLiveKeysRevision = -1
  private emptyStreak = 0

  private scheduleTimer(callback: () => void, ms: number): () => void {
    if (this.deps.schedule) return this.deps.schedule(callback, ms)
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  }

  private stopFollowUp(): void {
    this.followUpCancel?.()
    this.followUpCancel = null
    this.followUpStartedAt = null
    this.emptyStreak = 0
    if (this.state.autoWatching) this.update({ autoWatching: false })
  }

  private scheduleFollowUp(): void {
    if (!this.settings.autoFollowUp) return
    if (this.followUpStartedAt == null) this.followUpStartedAt = this.now()
    if (this.now() - this.followUpStartedAt >= FOLLOW_UP_MAX_MS) {
      this.stopFollowUp()
      return
    }
    this.followUpCancel?.()
    this.followUpCancel = this.scheduleTimer(() => {
      this.followUpCancel = null
      void this.refresh('auto')
    }, FOLLOW_UP_INTERVAL_MS)
    if (!this.state.autoWatching) this.update({ autoWatching: true })
  }

  /** 三选一关闭（或换成了下一轮）但没记录选择 → 先尝试用 2999 的海克斯字段确定，否则交给渲染端按推荐推断 */
  private async handleChoiceClosed(previous: ManualOverlayCandidate[], reason: 'screen-closed' | 'new-offer'): Promise<void> {
    const pickedIds = new Set(this.state.picked.map((augment) => String(augment.id)))
    const open = previous.filter((candidate) => !pickedIds.has(String(candidate.id)))
    if (open.length === 0 || open.length < previous.length) return // 已经记录过这一轮
    this.log({
      type: 'choice-closed',
      gameRevision: this.state.gameRevision,
      reason,
      candidates: open.map((candidate) => ({ slot: candidate.slot, id: candidate.id })),
    })
    const live = await this.fetchLiveAugments()
    const match = open.find((candidate) => live.includes(Number(candidate.id)))
    if (match) {
      this.addPicked(match, 'live-client', open)
      return
    }
    this.update({ pendingChoice: { candidates: open.map((candidate) => ({ ...candidate })), closedAt: this.now(), reason } })
  }

  private async fetchLiveAugments(): Promise<number[]> {
    try {
      const response = await this.deps.getLiveClientAllGameData()
      if (!response || response.status !== 200 || !response.data) return []
      return extractLiveAugmentIds(response.data).ids
    } catch {
      return []
    }
  }

  private addPicked(
    augment: ManualOverlayAugmentRef,
    inferred: ManualOverlayInferredSource | null,
    alternatives: ManualOverlayAugmentRef[] = [],
  ): ManualOverlayState {
    const ref = sanitizeAugmentRef(augment)
    if (!ref) return this.getState()
    const others = alternatives
      .map((alt) => sanitizeAugmentRef(alt))
      .filter((alt): alt is ManualOverlayAugmentRef => alt != null && String(alt.id) !== String(ref.id))
      .slice(0, 4)
    // 推断记录的是「上一轮」：如果屏幕上已经是下一轮的卡，不要把它们清掉
    const inCurrent = this.state.candidates.some((candidate) => String(candidate.id) === String(ref.id))
    const candidates = inferred && !inCurrent ? this.state.candidates : []
    if (this.state.picked.some((picked) => String(picked.id) === String(ref.id))) {
      return this.update({ candidates, pendingChoice: null })
    }
    const entry: ManualOverlayPickedAugment = { ...ref, pickedAt: this.now(), inferred, alternatives: others.length ? others : undefined }
    return this.update({
      picked: [...this.state.picked, entry].slice(-6),
      candidates,
      pendingChoice: null,
    })
  }

  private liveWatchTimer: ReturnType<typeof setInterval> | null = null
  private liveWatchBusy = false
  private liveMisses = 0
  /** 连续这么多次 2999 无响应才认为对局结束（避免偶发超时把浮窗藏掉） */
  static readonly LIVE_GAME_MISS_LIMIT = 5

  private lastTiming: ReturnType<typeof parseLiveTiming> | null = null
  private lastReminder: ManualOverlayReminder | null = null

  private log(record: Omit<RefreshLogRecord, 'ts'>): void {
    if (!this.deps.appendLog) return
    try {
      this.deps.appendLog({ ...record, ts: this.now() } as RefreshLogRecord)
    } catch (error) {
      this.deps.logger?.debug('[manual-overlay] append log failed', error)
    }
  }

  private refreshIconStatus(): void {
    const status = this.deps.iconIndexStatus?.()
    if (status) this.update({ iconIndex: { ...status } })
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private update(patch: Partial<ManualOverlayState>): ManualOverlayState {
    const previousCount = this.state.candidates.length
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }
    if (patch.candidates) this.applyMinimalMode(previousCount, this.state.candidates.length)
    const snapshot = this.getState()
    try {
      this.deps.broadcast(snapshot)
    } catch (error) {
      this.deps.logger?.warn('[manual-overlay] broadcast failed', error)
    }
    return snapshot
  }

  getState(): ManualOverlayState {
    return {
      ...this.state,
      candidates: this.state.candidates.map((candidate) => ({
        ...candidate,
        alternatives: candidate.alternatives?.map((alt) => ({ ...alt })),
      })),
      picked: this.state.picked.map((augment) => ({ ...augment })),
      lastCapture: this.state.lastCapture ? { ...this.state.lastCapture } : null,
      iconIndex: { ...this.state.iconIndex },
    }
  }

  getSettings(): ManualOverlaySettings {
    return { ...this.settings }
  }

  setSettings(patch: unknown): ManualOverlaySettings {
    const merged = sanitizeSettings(
      { ...this.settings, ...(patch && typeof patch === 'object' ? patch : {}) },
    )
    const hotkeyChanged = merged.hotkey !== this.settings.hotkey ||
      merged.collapseHotkey !== this.settings.collapseHotkey
    this.settings = merged
    this.deps.store.set(MANUAL_OVERLAY_SETTINGS_KEY, { ...merged })
    if (hotkeyChanged || !this.state.hotkeyRegistered) {
      this.registerHotkey()
    }
    if (this.state.phase) {
      this.applyVisibility(this.state.phase)
    }
    return this.getSettings()
  }

  // ------------------------------------------------------------------ hotkey

  registerHotkey(): boolean {
    const accelerator = this.settings.hotkey
    if (this.registeredHotkey) {
      try {
        this.deps.shortcuts.unregister(this.registeredHotkey)
      } catch {
        // ignore
      }
      this.registeredHotkey = null
    }

    let ok = false
    let error: string | null = null
    try {
      ok = this.deps.shortcuts.register(accelerator, () => {
        void this.refresh('hotkey')
      })
      if (!ok) error = '快捷键已被其他程序占用'
    } catch (registerError) {
      ok = false
      error = `快捷键格式无效：${registerError instanceof Error ? registerError.message : String(registerError)}`
    }

    if (ok) {
      this.registeredHotkey = accelerator
      this.deps.logger?.info(`[manual-overlay] hotkey registered: ${accelerator}`)
    } else {
      this.deps.logger?.warn(`[manual-overlay] hotkey registration failed: ${accelerator} (${error})`)
    }
    this.update({ hotkey: accelerator, hotkeyRegistered: ok, hotkeyError: error })
    this.registerCollapseHotkey()
    return ok
  }

  private registerCollapseHotkey(): boolean {
    if (this.registeredCollapseHotkey) {
      try {
        this.deps.shortcuts.unregister(this.registeredCollapseHotkey)
      } catch {
        // ignore
      }
      this.registeredCollapseHotkey = null
    }
    const accelerator = this.settings.collapseHotkey
    if (!accelerator) {
      this.update({ collapseHotkey: '', collapseHotkeyRegistered: false, collapseHotkeyError: null })
      return false
    }
    let ok = false
    let error: string | null = null
    if (accelerator === this.settings.hotkey) {
      error = '与刷新快捷键相同'
    } else {
      try {
        ok = this.deps.shortcuts.register(accelerator, () => {
          if (this.state.collapsed) {
            this.setCollapsed(false, 'hotkey')
            this.showOverlay('collapse-hotkey')
          } else {
            this.setCollapsed(true, 'hotkey')
          }
        })
        if (!ok) error = '快捷键已被其他程序占用'
      } catch (registerError) {
        error = `快捷键格式无效：${registerError instanceof Error ? registerError.message : String(registerError)}`
      }
    }
    if (ok) this.registeredCollapseHotkey = accelerator
    else this.deps.logger?.warn(`[manual-overlay] collapse hotkey registration failed: ${accelerator} (${error})`)
    this.update({ collapseHotkey: accelerator, collapseHotkeyRegistered: ok, collapseHotkeyError: error })
    return ok
  }

  // ------------------------------------------------------------------ 2999 watch

  /**
   * 不依赖 LCU：周期性探测游戏内 2999 接口，只要有响应就认为正在对局 → 显示浮窗。
   * LCU 没连上、阶段事件漏掉、或客户端权限问题时，浮窗仍然会出现。
   */
  startLiveGameWatch(intervalMs = 3000): void {
    if (this.liveWatchTimer) return
    this.liveWatchTimer = setInterval(() => {
      void this.checkLiveGame()
    }, intervalMs)
    void this.checkLiveGame()
  }

  stopLiveGameWatch(): void {
    if (this.liveWatchTimer) {
      clearInterval(this.liveWatchTimer)
      this.liveWatchTimer = null
    }
  }

  async checkLiveGame(): Promise<boolean> {
    if (this.liveWatchBusy) return this.state.liveGame
    this.liveWatchBusy = true
    try {
      let ok = false
      try {
        const response = await this.deps.getLiveClientAllGameData()
        ok = !!response && response.status === 200 && !!response.data
      } catch {
        ok = false
      }
      if (ok) {
        this.liveMisses = 0
        if (!this.state.liveGame) {
          const phaseKnown = !!this.state.phase && IN_GAME_PHASES.has(this.state.phase)
          this.deps.logger?.info('[manual-overlay] live game detected via 2999', { phase: this.state.phase })
          const patch: Partial<ManualOverlayState> = { liveGame: true }
          if (!phaseKnown && this.state.gameRevision === this.lastLiveGameRevision) {
            // LCU 没报告新的一局：按新局处理，清掉上一局的已选
            Object.assign(patch, {
              gameRevision: this.state.gameRevision + 1,
              candidates: [],
              picked: [],
              lastError: null,
              lastCapture: null,
              acknowledgedStage: 0,
            })
            this.lastReminder = null
          }
          this.update(patch)
          this.lastLiveGameRevision = this.state.gameRevision
          this.showFor('2999')
          this.warmupOnce()
          this.prepareIconIndex()
        }
      } else if (this.state.liveGame) {
        this.liveMisses++
        if (this.liveMisses >= ManualOverlayService.LIVE_GAME_MISS_LIMIT) {
          this.deps.logger?.info('[manual-overlay] live game ended (2999 unavailable)', { phase: this.state.phase })
          this.update({ liveGame: false })
          if (!this.pinned && (!this.state.phase || !IN_GAME_PHASES.has(this.state.phase))) {
            this.hideFor('2999-gone')
          }
        }
      }
      return this.state.liveGame
    } finally {
      this.liveWatchBusy = false
    }
  }

  private lastLiveGameRevision = 0

  /** 用户主动显示（托盘 / 命令行 / 快捷键）后，阶段事件不再自动隐藏，直到用户自己关掉 */
  private pinned = false

  /** 托盘「显示手动浮窗」等：随时显示 */
  showOverlay(reason = 'manual'): void {
    this.pinned = true
    this.showFor(reason)
  }

  /** 用户主动隐藏（浮窗 × / 托盘），解除固定 */
  hideOverlay(reason = 'manual'): void {
    this.pinned = false
    this.hideFor(reason)
  }

  isPinned(): boolean {
    return this.pinned
  }

  private showFor(reason: string): void {
    void Promise.resolve(this.deps.showWindow(reason)).catch((error) => {
      this.deps.logger?.warn('[manual-overlay] show window failed', error)
    })
  }

  private hideFor(reason: string): void {
    try {
      this.deps.hideWindow(reason)
    } catch (error) {
      this.deps.logger?.warn('[manual-overlay] hide window failed', error)
    }
  }

  private warmupOnce(): void {
    if (this.warmedUp || !this.deps.warmup) return
    this.warmedUp = true
    // 进入对局后预热 OCR，让第一次手动刷新不用等模型加载
    void Promise.resolve(this.deps.warmup()).catch((error) => {
      this.warmedUp = false
      this.deps.logger?.warn('[manual-overlay] OCR warmup failed', error)
    })
  }

  dispose(): void {
    this.stopLiveGameWatch()
    if (this.registeredCollapseHotkey) {
      try {
        this.deps.shortcuts.unregister(this.registeredCollapseHotkey)
      } catch {
        // ignore
      }
      this.registeredCollapseHotkey = null
    }
    if (this.registeredHotkey) {
      try {
        this.deps.shortcuts.unregister(this.registeredHotkey)
      } catch {
        // ignore
      }
      this.registeredHotkey = null
    }
  }

  // ------------------------------------------------------------------ phase

  setPhase(phase: GameflowPhase | null): void {
    if (!phase || phase === this.state.phase) {
      return
    }
    const previous = this.state.phase
    const patch: Partial<ManualOverlayState> = { phase }

    const startsNewGame = NEW_GAME_PHASES.has(phase) &&
      !(phase === 'GameStart' && previous === 'ChampSelect')
    if (startsNewGame) {
      Object.assign(patch, {
        gameRevision: this.state.gameRevision + 1,
        candidates: [],
        picked: [],
        lastError: null,
        lastCapture: null,
        lastRefreshAt: null,
        acknowledgedStage: 0,
        pendingChoice: null,
      })
      this.lastReminder = null
      this.stopFollowUp()
    } else if (HIDE_PHASES.has(phase)) {
      // 结算后保留已选列表直到下一局开始，方便回看；只清掉候选卡
      patch.candidates = []
      patch.pendingChoice = null
      this.stopFollowUp()
    }

    this.update(patch)
    this.applyVisibility(phase)

    if (phase === 'InProgress') {
      this.warmupOnce()
    }
    if (startsNewGame) {
      this.lastLiveGameRevision = this.state.gameRevision
    }
    if (IN_GAME_PHASES.has(phase)) {
      this.prepareIconIndex()
    }
  }

  /** 后台构建图标库（下载/读取缓存），完成后广播状态 */
  prepareIconIndex(): void {
    if (!this.settings.iconMatchEnabled || !this.deps.ensureIconIndex) return
    void Promise.resolve(this.deps.ensureIconIndex())
      .catch((error) => this.deps.logger?.warn('[manual-overlay] icon index build failed', error))
      .finally(() => this.refreshIconStatus())
  }

  private applyVisibility(phase: GameflowPhase): void {
    const shouldShow = IN_GAME_PHASES.has(phase) ||
      (phase === 'ChampSelect' && this.settings.showInChampSelect)
    if (shouldShow) {
      this.showFor(`phase:${phase}`)
    } else if (this.state.liveGame || this.pinned) {
      // 2999 仍有响应 = 游戏还在进行（LCU 阶段可能不准）；或用户手动打开的 → 不隐藏
      return
    } else if (HIDE_PHASES.has(phase) || phase === 'ChampSelect') {
      this.hideFor(`phase:${phase}`)
    }
  }

  // ------------------------------------------------------------------ refresh

  refresh(source: 'button' | 'hotkey' | 'auto' = 'button'): Promise<ManualOverlayState> {
    if (source !== 'auto') {
      // 手动刷新会重新开始一轮跟拍
      this.followUpCancel?.()
      this.followUpCancel = null
      this.followUpStartedAt = null
    }
    if (this.refreshPromise) {
      return this.refreshPromise
    }
    this.refreshPromise = this.runRefresh(source).finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  private async runRefresh(source: string): Promise<ManualOverlayState> {
    this.update({ refreshing: true, lastError: null })
    if (source === 'hotkey') {
      this.pinned = true
      this.showFor('hotkey')
    }

    const startedAt = this.now()
    // 2999 数据只用于日志（提醒时机校准），与截图并行，不阻塞识别
    const livePromise = this.fetchTiming()
    try {
      const capture = await this.deps.capture()
      const captureMs = this.now() - startedAt
      const image: CaptureImage | undefined = capture.raw ?? capture.buffer
      if (!capture.success || !image) {
        if (source === 'auto') this.stopFollowUp()
        const error = `截图失败：${capture.error || '未知错误'}`
        void this.logRefresh(source, livePromise, { error, captureMs })
        return this.update({
          refreshing: false,
          lastRefreshAt: this.now(),
          lastError: error,
        })
      }

      const useIcons = this.settings.iconMatchEnabled && !!this.deps.matchIcons
      const analyzeStartedAt = this.now()
      let iconMs: number | null = null
      const [analysis, iconMatches] = await Promise.all([
        this.deps.analyze(image).then((result) => result, (error): AnalysisResultLike => ({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })),
        useIcons
          ? this.deps.matchIcons!(image).then((matches) => {
            iconMs = this.now() - analyzeStartedAt
            return matches
          }, (error) => {
            iconMs = this.now() - analyzeStartedAt
            this.deps.logger?.warn('[manual-overlay] icon matching failed', error)
            return null
          })
          : Promise.resolve(null),
      ])
      const analyzeMs = this.now() - analyzeStartedAt
      const augments = analysis.success ? analysis.analysis?.augments ?? [] : []
      const ocrCandidates = augments
        .map(toCandidate)
        .filter((candidate): candidate is ManualOverlayCandidate => candidate != null)
        .sort((a, b) => a.slot - b.slot)
      const candidates = combineRecognition(
        ocrCandidates,
        iconMatches,
        analysis.analysis?.rerollButtons?.visible === true,
      )
      const totalMs = this.now() - startedAt
      const sources = countSources(candidates)

      const lastCapture = {
        captureMode: capture.captureMode ?? null,
        windowName: capture.windowName ?? null,
        width: capture.width ?? null,
        height: capture.height ?? null,
        captureMs,
        analyzeMs,
        iconMs,
        totalMs,
        recognizedCount: candidates.length,
        sources,
      }

      let lastError: string | null = null
      if (!analysis.success && candidates.length === 0) {
        lastError = `识别失败：${analysis.error || '未知错误'}`
      } else if (candidates.length === 0) {
        lastError = '没有识别到海克斯：请在三选一界面打开时再刷新'
      } else if (candidates.length < 3) {
        lastError = `只识别到 ${candidates.length} 张，可再刷新一次或点卡名手动选择`
      }

      this.deps.logger?.info('[manual-overlay] refresh completed', {
        source,
        recognized: candidates.map((candidate) => `${candidate.slot}:${candidate.name}[${candidate.source}]`).join(', '),
        captureMs,
        enumerateMs: capture.enumerateMs ?? null,
        convertMs: capture.convertMs ?? null,
        analyzeMs,
        iconMs,
        totalMs,
        rawCapture: !!capture.raw,
      })
      void this.logRefresh(source, livePromise, {
        captureMs,
        enumerateMs: capture.enumerateMs ?? null,
        convertMs: capture.convertMs ?? null,
        analyzeMs,
        iconMs,
        totalMs,
        rawCapture: !!capture.raw,
        width: capture.width ?? null,
        height: capture.height ?? null,
        recognized: candidates.map((candidate) => ({
          slot: candidate.slot,
          id: candidate.id,
          source: candidate.source,
          confidence: candidate.confidence,
          iconScore: candidate.iconScore,
        })),
        error: lastError,
      })

      const previous = this.state.candidates
      const isAuto = source === 'auto'
      if (isAuto) {
        // 一次空结果可能只是鼠标挡住/动画；连续两次没识别到（且识别本身成功）才算三选一已关闭
        if (candidates.length === 0 && previous.length > 0 && analysis.success && this.emptyStreak === 0) {
          this.emptyStreak = 1
          this.update({ refreshing: false, lastRefreshAt: this.now(), lastCapture })
          this.scheduleFollowUp()
          return this.getState()
        }
        if (candidates.length === 0 && previous.length > 0 && !analysis.success) {
          this.update({ refreshing: false, lastRefreshAt: this.now(), lastCapture })
          this.scheduleFollowUp()
          return this.getState()
        }
        this.emptyStreak = 0
        const closed = candidates.length === 0 && previous.length > 0
        const sameIds = candidates.filter((candidate) => previous.some((old) => String(old.id) === String(candidate.id))).length
        // 三张全换且不是重随（重随只换一张）→ 上一轮已经选完，这是下一轮
        const newOffer = candidates.length >= 2 && previous.length >= 2 && sameIds === 0
        this.update({
          refreshing: false,
          lastRefreshAt: this.now(),
          candidates: candidates.length > 0 ? candidates : [],
          lastCapture,
          lastError: null,
        })
        if (closed || newOffer) {
          await this.handleChoiceClosed(previous, closed ? 'screen-closed' : 'new-offer')
        }
        if (candidates.length > 0) this.scheduleFollowUp()
        else this.stopFollowUp()
        return this.getState()
      }

      const snapshot = this.update({
        refreshing: false,
        lastRefreshAt: this.now(),
        // 识别为空时保留上一次结果，避免一次失败把卡片清掉
        candidates: candidates.length > 0 ? candidates : this.state.candidates,
        lastCapture,
        lastError,
      })
      if (candidates.length >= 2) {
        this.scheduleFollowUp()
        return this.getState()
      }
      return snapshot
    } catch (error) {
      const message = `刷新出错：${error instanceof Error ? error.message : String(error)}`
      void this.logRefresh(source, livePromise, { error: message })
      return this.update({
        refreshing: false,
        lastRefreshAt: this.now(),
        lastError: message,
      })
    }
  }

  private async fetchTiming(): Promise<ReturnType<typeof parseLiveTiming> | null> {
    try {
      const response = await this.deps.getLiveClientAllGameData()
      if (!response || response.status !== 200 || !response.data) return null
      return parseLiveTiming(response.data)
    } catch {
      return null
    }
  }

  private async logRefresh(
    source: string,
    livePromise: Promise<ReturnType<typeof parseLiveTiming> | null>,
    details: Record<string, unknown>,
  ): Promise<void> {
    const timing = await livePromise
    const schedule = parseLevelSchedule(this.settings.augmentLevels)
    this.log({
      type: 'refresh',
      trigger: source,
      gameRevision: this.state.gameRevision,
      gameTime: timing?.gameTime ?? null,
      level: timing?.level ?? null,
      isDead: timing?.isDead ?? null,
      respawnTimer: timing?.respawnTimer ?? null,
      stagesReached: timing?.level != null ? schedule.filter((level) => level <= timing.level!).length : null,
      pickedCount: this.state.picked.length,
      reminderActive: this.lastReminder?.active ?? null,
      ...details,
    })
  }

  // ------------------------------------------------------------------ picks

  pick(value: unknown): ManualOverlayState {
    const augment = sanitizeAugmentRef(value)
    if (!augment) return this.getState()
    this.log({
      type: 'pick',
      gameRevision: this.state.gameRevision,
      id: augment.id,
      name: augment.name,
      gameTime: this.lastTiming?.gameTime ?? null,
      level: this.lastTiming?.level ?? null,
      candidates: this.state.candidates.map((candidate) => ({ slot: candidate.slot, id: candidate.id, source: candidate.source })),
    })
    const record = value as Record<string, unknown>
    const inferred = record.inferred === 'recommended' || record.inferred === 'live-client' ? record.inferred : null
    // 手动点卡 = 本轮结束；自动推断的是上一轮，下一轮可能正在跟拍，不停
    if (!inferred) this.stopFollowUp()
    const alternatives = Array.isArray(record.alternatives) ? record.alternatives as ManualOverlayAugmentRef[] : []
    return this.addPicked(augment, inferred, alternatives)
  }

  unpick(augmentId: unknown): ManualOverlayState {
    const id = String(augmentId ?? '')
    return this.update({
      picked: this.state.picked.filter((picked) => String(picked.id) !== id),
    })
  }

  /** 手动更正某个卡位：替换候选卡；如果旧的那张已经被选中，同步替换已选列表 */
  correct(slotValue: unknown, value: unknown): ManualOverlayState {
    const slot = Number(slotValue)
    const augment = sanitizeAugmentRef(value)
    if (!augment || !Number.isInteger(slot) || slot < 0 || slot > 2) return this.getState()
    const existing = this.state.candidates.find((candidate) => candidate.slot === slot) ?? null
    const corrected: ManualOverlayCandidate = {
      ...augment,
      slot,
      source: 'manual',
      confidence: 1,
      iconScore: existing?.alternatives?.find((alt) => alt.source === 'icon' && String(alt.id) === String(augment.id))?.score ?? null,
      alternatives: existing?.alternatives ?? [],
    }
    const candidates = [...this.state.candidates.filter((candidate) => candidate.slot !== slot), corrected]
      .sort((a, b) => a.slot - b.slot)
    let picked = this.state.picked
    if (existing && picked.some((item) => String(item.id) === String(existing.id))) {
      picked = this.replaceInPicked(picked, existing.id, augment)
    }
    this.log({
      type: 'correct',
      gameRevision: this.state.gameRevision,
      slot,
      fromId: existing?.id ?? null,
      fromSource: existing?.source ?? null,
      toId: augment.id,
      toName: augment.name,
      wasInAlternatives: !!existing?.alternatives?.some((alt) => String(alt.id) === String(augment.id)),
    })
    return this.update({ candidates, picked, lastError: null })
  }

  private replaceInPicked(
    picked: ManualOverlayState['picked'],
    oldId: number | string,
    augment: ManualOverlayAugmentRef,
  ): ManualOverlayState['picked'] {
    const duplicate = picked.some((item) => String(item.id) === String(augment.id))
    return picked.flatMap((item) => {
      if (String(item.id) !== String(oldId)) return [item]
      // 新的海克斯已经在列表里：只删掉旧的，避免重复
      return duplicate ? [] : [{ ...augment, pickedAt: item.pickedAt, inferred: null, alternatives: undefined }]
    })
  }

  replacePicked(oldIdValue: unknown, value: unknown): ManualOverlayState {
    const augment = sanitizeAugmentRef(value)
    const oldId = String(oldIdValue ?? '')
    if (!augment || !this.state.picked.some((item) => String(item.id) === oldId)) return this.getState()
    this.log({
      type: 'replace-picked',
      gameRevision: this.state.gameRevision,
      fromId: oldId,
      toId: augment.id,
      toName: augment.name,
    })
    return this.update({ picked: this.replaceInPicked(this.state.picked, oldId, augment) })
  }

  /** 用户点了「忽略」：把当前已达到的选择次数视为已处理 */
  acknowledgeReminder(): ManualOverlayState {
    const reached = this.lastReminder?.stagesReached ?? 0
    const acknowledgedStage = Math.max(this.state.acknowledgedStage, reached)
    this.lastReminder = this.lastReminder ? { ...this.lastReminder, active: false, urgent: false } : null
    this.log({
      type: 'acknowledge',
      gameRevision: this.state.gameRevision,
      acknowledgedStage,
      gameTime: this.lastTiming?.gameTime ?? null,
      level: this.lastTiming?.level ?? null,
    })
    return this.update({ acknowledgedStage })
  }

  async listAugments(): Promise<ManualOverlayAugmentRef[]> {
    if (!this.deps.listAugments) return []
    try {
      const augments = await this.deps.listAugments()
      return augments
        .map((augment) => sanitizeAugmentRef(augment))
        .filter((augment): augment is ManualOverlayAugmentRef => augment != null)
    } catch (error) {
      this.deps.logger?.warn('[manual-overlay] list augments failed', error)
      return []
    }
  }

  clearCandidates(): ManualOverlayState {
    this.stopFollowUp()
    return this.update({ candidates: [], lastError: null, pendingChoice: null })
  }

  resetGame(): ManualOverlayState {
    this.lastReminder = null
    return this.update({
      acknowledgedStage: 0,
      gameRevision: this.state.gameRevision + 1,
      candidates: [],
      picked: [],
      lastError: null,
      lastCapture: null,
      pendingChoice: null,
    })
  }

  // ------------------------------------------------------------------ live client

  private augmentCatalog: Map<string, ManualOverlayAugmentRef> | null = null

  /** 2999 给出了已持有海克斯时，自动补进「已选」（名字/图标来自海克斯列表） */
  private async syncLiveAugments(ids: number[]): Promise<void> {
    const known = new Set(this.state.picked.map((augment) => String(augment.id)))
    const missing = ids.filter((id) => !known.has(String(id)))
    if (!missing.length) return
    if (!this.augmentCatalog) {
      const list = await this.listAugments()
      this.augmentCatalog = new Map(list.map((augment) => [String(augment.id), augment]))
    }
    let picked = this.state.picked
    for (const id of missing) {
      const ref = this.augmentCatalog.get(String(id))
      if (!ref) continue // 不是海克斯 id（字段含义未知时宁可不加）
      picked = [...picked, { ...ref, pickedAt: this.now(), inferred: 'live-client' as const }]
    }
    if (picked !== this.state.picked) {
      const pendingIds = new Set((this.state.pendingChoice?.candidates ?? []).map((candidate) => String(candidate.id)))
      const resolved = picked.some((augment) => pendingIds.has(String(augment.id)))
      this.update({ picked: picked.slice(-6), pendingChoice: resolved ? null : this.state.pendingChoice })
    }
  }

  async getLiveData(): Promise<ManualOverlayLiveData> {
    const empty: ManualOverlayLiveData = {
      available: false,
      found: false,
      championName: null,
      ownedItemIds: [],
      enemyItemIds: [],
      enemyChampionNames: [],
    }
    try {
      const response = await this.deps.getLiveClientAllGameData()
      if (!response || response.status !== 200 || !response.data) {
        const error = response ? `HTTP ${response.status}` : '2999 端口不可用（不在对局中？）'
        // 还在选人：用 LCU 的我方阵容（开局前就能给阵容建议）
        const champSelect = this.state.phase === 'ChampSelect' ? await this.deps.getChampSelectTeam?.().catch(() => null) : null
        if (champSelect && champSelect.allyChampionIds.length) {
          return { ...empty, error, allyChampionIds: champSelect.allyChampionIds, selfChampionId: champSelect.selfChampionId, teamSource: 'champ-select' }
        }
        return { ...empty, error }
      }
      const parsed = parseLiveClientPlayers(response.data.activePlayer, response.data.allPlayers)
      const timing = parseLiveTiming(response.data)
      const liveAugments = extractLiveAugmentIds(response.data)
      if (this.loggedLiveKeysRevision !== this.state.gameRevision) {
        // 每局记一次 2999 的字段名，用于确认游戏是否提供「已持有海克斯」
        this.loggedLiveKeysRevision = this.state.gameRevision
        this.deps.logger?.info('[manual-overlay] 2999 fields', {
          activePlayer: Object.keys(response.data.activePlayer ?? {}).slice(0, 40),
          augmentKeys: liveAugments.keys,
          augmentIds: liveAugments.ids,
        })
        this.log({ type: 'live-augments', gameRevision: this.state.gameRevision, keys: liveAugments.keys, ids: liveAugments.ids })
      }
      if (liveAugments.ids.length) await this.syncLiveAugments(liveAugments.ids)
      this.lastTiming = timing
      const reminder = this.settings.reminderEnabled
        ? computeRefreshReminder({
          level: timing.level,
          gameTime: timing.gameTime,
          isDead: timing.isDead,
          pickedCount: this.state.picked.length,
          acknowledgedStage: this.state.acknowledgedStage,
          schedule: parseLevelSchedule(this.settings.augmentLevels),
          onlyWhenDead: this.settings.reminderOnlyWhenDead,
          startWindowSec: this.settings.startWindowSec,
        })
        : null
      this.lastReminder = reminder
      return {
        available: true,
        found: parsed.found,
        championName: parsed.championName,
        ownedItemIds: parsed.ownedItemIds,
        enemyItemIds: parsed.enemyItemIds,
        enemyChampionNames: parsed.enemyChampionNames,
        ...timing,
        reminder,
        heldAugmentIds: liveAugments.ids,
        augmentFieldKeys: liveAugments.keys,
        players: parsed.players,
        teamSource: parsed.players.length ? 'live' : null,
      }
    } catch (error) {
      return { ...empty, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
