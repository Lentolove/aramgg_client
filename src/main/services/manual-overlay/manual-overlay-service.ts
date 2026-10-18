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
  ManualOverlayAugmentRef,
  ManualOverlayCandidate,
  ManualOverlayLiveData,
  ManualOverlaySettings,
  ManualOverlayState,
} from '../../../shared/ipc-contract.ts'
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
}

/** 新的一局从这些阶段开始；Reconnect → InProgress 不算新局。 */
const NEW_GAME_PHASES = new Set<string>(['ChampSelect', 'GameStart'])
// LCU 还会报告 'Reconnect'（未列入 GameflowPhase 类型），按对局中处理
const IN_GAME_PHASES = new Set<string>(['GameStart', 'InProgress', 'Reconnect'])
const HIDE_PHASES = new Set<string>([
  'None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'WaitingForStats', 'PreEndOfGame', 'EndOfGame',
])

export interface CaptureResultLike {
  success: boolean
  buffer?: Buffer
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
  }
}

export interface ManualOverlayDeps {
  capture: () => Promise<CaptureResultLike>
  analyze: (buffer: Buffer) => Promise<AnalysisResultLike>
  warmup?: () => Promise<unknown>
  getLiveClientAllGameData: () => Promise<{ status: number; data: any } | null>
  store: { get: (key: string) => unknown; set: (key: string, value: unknown) => void }
  shortcuts: {
    register: (accelerator: string, callback: () => void) => boolean
    unregister: (accelerator: string) => void
    isRegistered?: (accelerator: string) => boolean
  }
  showWindow: () => Promise<void> | void
  hideWindow: () => void
  broadcast: (state: ManualOverlayState) => void
  now?: () => number
  logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; debug: (...args: any[]) => void }
}

function sanitizeSettings(raw: unknown, legacyAutoScreenshot: unknown): ManualOverlaySettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<ManualOverlaySettings>
  const alpha = Number(value.shrinkageAlpha)
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
      revision: 0,
    }
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
      candidates: this.state.candidates.map((candidate) => ({ ...candidate })),
      picked: this.state.picked.map((augment) => ({ ...augment })),
      lastCapture: this.state.lastCapture ? { ...this.state.lastCapture } : null,
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

  dispose(): void {
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
      })
    } else if (HIDE_PHASES.has(phase)) {
      // 结算后保留已选列表直到下一局开始，方便回看；只清掉候选卡
      patch.candidates = []
    }

    this.update(patch)
    this.applyVisibility(phase)

    if (phase === 'InProgress' && !this.warmedUp && this.deps.warmup) {
      this.warmedUp = true
      // 进入对局后预热 OCR，让第一次手动刷新不用等模型加载
      void Promise.resolve(this.deps.warmup()).catch((error) => {
        this.warmedUp = false
        this.deps.logger?.warn('[manual-overlay] OCR warmup failed', error)
      })
    }
  }

  private applyVisibility(phase: GameflowPhase): void {
    const shouldShow = IN_GAME_PHASES.has(phase) ||
      (phase === 'ChampSelect' && this.settings.showInChampSelect)
    try {
      if (shouldShow) {
        void Promise.resolve(this.deps.showWindow()).catch((error) => {
          this.deps.logger?.warn('[manual-overlay] show window failed', error)
        })
      } else if (HIDE_PHASES.has(phase) || phase === 'ChampSelect') {
        this.deps.hideWindow()
      }
    } catch (error) {
      this.deps.logger?.warn('[manual-overlay] visibility update failed', error)
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
      void Promise.resolve(this.deps.showWindow()).catch(() => {})
    }

    const startedAt = this.now()
    try {
      const capture = await this.deps.capture()
      const captureMs = this.now() - startedAt
      if (!capture.success || !capture.buffer) {
        return this.update({
          refreshing: false,
          lastRefreshAt: this.now(),
          lastError: `截图失败：${capture.error || '未知错误'}`,
        })
      }

      const analyzeStartedAt = this.now()
      const analysis = await this.deps.analyze(capture.buffer)
      const analyzeMs = this.now() - analyzeStartedAt
      const augments = analysis.success ? analysis.analysis?.augments ?? [] : []
      const candidates = augments
        .map(toCandidate)
        .filter((candidate): candidate is ManualOverlayCandidate => candidate != null)
        .sort((a, b) => a.slot - b.slot)
        .slice(0, 3)

      const lastCapture = {
        captureMode: capture.captureMode ?? null,
        windowName: capture.windowName ?? null,
        width: capture.width ?? null,
        height: capture.height ?? null,
        captureMs,
        analyzeMs,
        recognizedCount: candidates.length,
      }

      let lastError: string | null = null
      if (!analysis.success) {
        lastError = `识别失败：${analysis.error || '未知错误'}`
      } else if (candidates.length === 0) {
        lastError = '没有识别到海克斯：请在三选一界面打开时再刷新'
      } else if (candidates.length < 3) {
        lastError = `只识别到 ${candidates.length} 张，可再刷新一次`
      }
      if (capture.hasLolWindow === false && !lastError) {
        lastError = '未找到游戏窗口，已改为整屏截图'
      }

      this.deps.logger?.info('[manual-overlay] refresh completed', {
        source,
        recognized: candidates.map((candidate) => `${candidate.slot}:${candidate.name}`).join(', '),
        captureMs,
        analyzeMs,
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
      return this.update({
        refreshing: false,
        lastRefreshAt: this.now(),
        lastError: `刷新出错：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // ------------------------------------------------------------------ picks

  pick(value: unknown): ManualOverlayState {
    const augment = sanitizeAugmentRef(value)
    if (!augment) return this.getState()
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

  clearCandidates(): ManualOverlayState {
    return this.update({ candidates: [], lastError: null })
  }

  resetGame(): ManualOverlayState {
    return this.update({
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
      return {
        available: true,
        found: parsed.found,
        championName: parsed.championName,
        ownedItemIds: parsed.ownedItemIds,
        enemyItemIds: parsed.enemyItemIds,
        enemyChampionNames: parsed.enemyChampionNames,
      }
    } catch (error) {
      return { ...empty, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
