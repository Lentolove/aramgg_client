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
  ManualOverlayLiveData,
  ManualOverlayReminder,
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
export const AUTO_SCREENSHOT_SETTING_KEY = 'autoScreenshot'

export const DEFAULT_MANUAL_OVERLAY_SETTINGS: ManualOverlaySettings = {
  autoScreenshot: false,
  hotkey: DEFAULT_MANUAL_OVERLAY_HOTKEY,
  showInChampSelect: false,
  shrinkageAlpha: DEFAULT_SHRINKAGE_ALPHA,
  focusable: false,
  reminderEnabled: true,
  augmentLevels: '1,7,11,15',
  reminderOnlyWhenDead: false,
  startWindowSec: DEFAULT_START_WINDOW_SEC,
  iconMatchEnabled: true,
}

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
  type: 'refresh' | 'pick' | 'correct' | 'replace-picked' | 'acknowledge'
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
  logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; debug: (...args: any[]) => void }
}

function sanitizeSettings(raw: unknown, legacyAutoScreenshot: unknown): ManualOverlaySettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<ManualOverlaySettings>
  const alpha = Number(value.shrinkageAlpha)
  const startWindow = Number(value.startWindowSec ?? DEFAULT_START_WINDOW_SEC)
  return {
    autoScreenshot: typeof value.autoScreenshot === 'boolean'
      ? value.autoScreenshot
      : legacyAutoScreenshot === true,
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
  private refreshPromise: Promise<ManualOverlayState> | null = null
  private warmedUp = false

  constructor(deps: ManualOverlayDeps) {
    this.deps = deps
    this.settings = sanitizeSettings(
      deps.store.get(MANUAL_OVERLAY_SETTINGS_KEY),
      deps.store.get(AUTO_SCREENSHOT_SETTING_KEY),
    )
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
      revision: 0,
    }
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
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }
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

  /** 是否允许旧版持续自动截图（app-config 用它来门控 startAutoScreenshotForGame）。 */
  isAutoScreenshotEnabled(): boolean {
    return this.settings.autoScreenshot === true
  }

  setSettings(patch: unknown): ManualOverlaySettings {
    const merged = sanitizeSettings(
      { ...this.settings, ...(patch && typeof patch === 'object' ? patch : {}) },
      this.settings.autoScreenshot,
    )
    const hotkeyChanged = merged.hotkey !== this.settings.hotkey
    this.settings = merged
    this.deps.store.set(MANUAL_OVERLAY_SETTINGS_KEY, { ...merged })
    this.deps.store.set(AUTO_SCREENSHOT_SETTING_KEY, merged.autoScreenshot)
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
          if (!this.state.phase || !IN_GAME_PHASES.has(this.state.phase)) {
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

  /** 托盘「显示手动浮窗」等：随时显示 */
  showOverlay(reason = 'manual'): void {
    this.showFor(reason)
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
      })
      this.lastReminder = null
    } else if (HIDE_PHASES.has(phase)) {
      // 结算后保留已选列表直到下一局开始，方便回看；只清掉候选卡
      patch.candidates = []
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
    } else if (this.state.liveGame) {
      // 2999 仍有响应 = 游戏还在进行（LCU 阶段可能不准），不隐藏
      return
    } else if (HIDE_PHASES.has(phase) || phase === 'ChampSelect') {
      this.hideFor(`phase:${phase}`)
    }
  }

  // ------------------------------------------------------------------ refresh

  refresh(source: 'button' | 'hotkey' = 'button'): Promise<ManualOverlayState> {
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
      if (capture.hasLolWindow === false && !lastError) {
        lastError = '未找到游戏窗口，已改为整屏截图'
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

      return this.update({
        refreshing: false,
        lastRefreshAt: this.now(),
        // 识别为空时保留上一次结果，避免一次失败把卡片清掉
        candidates: candidates.length > 0 ? candidates : this.state.candidates,
        lastCapture,
        lastError,
      })
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
    if (this.state.picked.some((picked) => String(picked.id) === String(augment.id))) {
      return this.update({ candidates: [] })
    }
    return this.update({
      picked: [...this.state.picked, { ...augment, pickedAt: this.now() }].slice(-6),
      candidates: [],
    })
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
      return duplicate ? [] : [{ ...augment, pickedAt: item.pickedAt }]
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
    return this.update({ candidates: [], lastError: null })
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
    })
  }

  // ------------------------------------------------------------------ live client

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
        return { ...empty, error: response ? `HTTP ${response.status}` : '2999 端口不可用（不在对局中？）' }
      }
      const parsed = parseLiveClientPlayers(response.data.activePlayer, response.data.allPlayers)
      const timing = parseLiveTiming(response.data)
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
      }
    } catch (error) {
      return { ...empty, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
