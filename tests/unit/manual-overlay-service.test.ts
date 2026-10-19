import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MANUAL_OVERLAY_HOTKEY,
  ManualOverlayService,
  type ManualOverlayDeps,
} from '../../src/main/services/manual-overlay/manual-overlay-service.ts'

function createDeps(overrides: Partial<ManualOverlayDeps> = {}) {
  const storeValues = new Map<string, unknown>()
  const registered = new Map<string, () => void>()
  const deps: ManualOverlayDeps = {
    capture: vi.fn(async () => ({
      success: true,
      buffer: Buffer.from('png'),
      captureMode: 'window' as const,
      windowName: 'League of Legends (TM) Client',
      width: 1920,
      height: 1080,
      hasLolWindow: true,
    })),
    analyze: vi.fn(async () => ({
      success: true,
      analysis: {
        augments: [
          { id: 3, name: 'C', detectedSlot: 2, iconPath: 'c.png' },
          { id: 1, name: 'A', detectedSlot: 0, iconPath: 'a.png' },
          { id: 2, name: 'B', detectedSlot: 1 },
        ],
      },
    })),
    warmup: vi.fn(async () => {}),
    getLiveClientAllGameData: vi.fn(async () => null),
    store: { get: (key) => storeValues.get(key), set: (key, value) => { storeValues.set(key, value) } },
    shortcuts: {
      register: vi.fn((accelerator: string, callback: () => void) => {
        registered.set(accelerator, callback)
        return true
      }),
      unregister: vi.fn((accelerator: string) => { registered.delete(accelerator) }),
    },
    showWindow: vi.fn(),
    hideWindow: vi.fn(),
    broadcast: vi.fn(),
    // 默认不触发自动跟拍定时器，跟拍行为在 manual-overlay-follow-up.test.ts 里单独测
    schedule: vi.fn(() => () => {}),
    ...overrides,
  }
  return { deps, storeValues, registered }
}

describe('ManualOverlayService', () => {
  it('defaults to autoScreenshot off and the default hotkey', () => {
    const { deps } = createDeps()
    const service = new ManualOverlayService(deps)
    expect(service.isAutoScreenshotEnabled()).toBe(false)
    expect(service.getSettings().hotkey).toBe(DEFAULT_MANUAL_OVERLAY_HOTKEY)
  })

  it('honours a legacy autoScreenshot=true store value', () => {
    const { deps, storeValues } = createDeps()
    storeValues.set('autoScreenshot', true)
    expect(new ManualOverlayService(deps).isAutoScreenshotEnabled()).toBe(true)
  })

  it('refresh captures once, runs OCR and broadcasts candidates sorted by slot', async () => {
    const { deps } = createDeps()
    const service = new ManualOverlayService(deps)
    const state = await service.refresh()
    expect(deps.capture).toHaveBeenCalledTimes(1)
    expect(deps.analyze).toHaveBeenCalledTimes(1)
    expect(state.candidates.map((candidate) => candidate.name)).toEqual(['A', 'B', 'C'])
    expect(state.refreshing).toBe(false)
    expect(state.lastError).toBeNull()
    expect(state.lastCapture?.recognizedCount).toBe(3)
    expect(deps.broadcast).toHaveBeenCalled()
  })

  it('coalesces concurrent refreshes', async () => {
    const { deps } = createDeps()
    const service = new ManualOverlayService(deps)
    await Promise.all([service.refresh(), service.refresh('hotkey')])
    expect(deps.capture).toHaveBeenCalledTimes(1)
  })

  it('keeps previous candidates and reports when OCR finds nothing', async () => {
    const { deps } = createDeps()
    const service = new ManualOverlayService(deps)
    await service.refresh()
    vi.mocked(deps.analyze).mockResolvedValueOnce({ success: true, analysis: { augments: [] } })
    const state = await service.refresh()
    expect(state.candidates).toHaveLength(3)
    expect(state.lastError).toContain('没有识别到海克斯')
  })

  it('reports capture failures without throwing', async () => {
    const { deps } = createDeps({ capture: vi.fn(async () => ({ success: false, error: 'boom' })) })
    const state = await new ManualOverlayService(deps).refresh()
    expect(state.lastError).toContain('boom')
    expect(deps.analyze).not.toHaveBeenCalled()
  })

  it('remembers picks for the game, dedupes, and supports removal', async () => {
    const { deps } = createDeps()
    const service = new ManualOverlayService(deps)
    service.setPhase('InProgress')
    await service.refresh()
    let state = service.pick({ id: 1, name: 'A', iconPath: 'a.png' })
    expect(state.picked.map((augment) => augment.id)).toEqual([1])
    expect(state.candidates).toEqual([])
    state = service.pick({ id: 1, name: 'A' })
    expect(state.picked).toHaveLength(1)
    service.pick({ id: 2, name: 'B' })
    state = service.unpick(1)
    expect(state.picked.map((augment) => augment.id)).toEqual([2])
    expect(service.pick({ bogus: true }).picked).toHaveLength(1)
  })

  it('resets picks on a new game but not on GameStart after ChampSelect or on Reconnect', () => {
    const { deps } = createDeps()
    const service = new ManualOverlayService(deps)
    service.setPhase('InProgress')
    service.pick({ id: 1, name: 'A' })
    service.setPhase('EndOfGame')
    expect(service.getState().picked).toHaveLength(1)
    service.setPhase('ChampSelect')
    expect(service.getState().picked).toHaveLength(0)
    const revision = service.getState().gameRevision
    service.setPhase('GameStart')
    expect(service.getState().gameRevision).toBe(revision)
    service.setPhase('InProgress')
    service.pick({ id: 5, name: 'E' })
    service.setPhase('Reconnect' as never)
    service.setPhase('InProgress')
    expect(service.getState().picked).toHaveLength(1)
  })

  it('shows the window in game, hides it outside, and warms up OCR once', () => {
    const { deps } = createDeps()
    const service = new ManualOverlayService(deps)
    service.setPhase('ChampSelect')
    expect(deps.showWindow).not.toHaveBeenCalled()
    service.setPhase('InProgress')
    expect(deps.showWindow).toHaveBeenCalledTimes(1)
    expect(deps.warmup).toHaveBeenCalledTimes(1)
    service.setPhase('EndOfGame')
    expect(deps.hideWindow).toHaveBeenCalled()
    service.setPhase('InProgress')
    expect(deps.warmup).toHaveBeenCalledTimes(1)
  })

  it('optionally shows the overlay in champ select', () => {
    const { deps } = createDeps()
    const service = new ManualOverlayService(deps)
    service.setSettings({ showInChampSelect: true })
    service.setPhase('ChampSelect')
    expect(deps.showWindow).toHaveBeenCalled()
  })

  it('registers the hotkey, triggers a refresh, and re-registers when changed', async () => {
    const { deps, registered, storeValues } = createDeps()
    const service = new ManualOverlayService(deps)
    expect(service.registerHotkey()).toBe(true)
    expect(registered.has(DEFAULT_MANUAL_OVERLAY_HOTKEY)).toBe(true)
    registered.get(DEFAULT_MANUAL_OVERLAY_HOTKEY)?.()
    await vi.waitFor(() => expect(deps.capture).toHaveBeenCalledTimes(1))
    expect(deps.showWindow).toHaveBeenCalled()

    service.setSettings({ hotkey: 'F8' })
    expect(deps.shortcuts.unregister).toHaveBeenCalledWith(DEFAULT_MANUAL_OVERLAY_HOTKEY)
    expect(registered.has('F8')).toBe(true)
    expect(service.getState().hotkey).toBe('F8')
    expect(storeValues.get('manualOverlay.settings')).toMatchObject({ hotkey: 'F8' })
  })

  it('reports hotkey conflicts', () => {
    const { deps } = createDeps()
    vi.mocked(deps.shortcuts.register).mockReturnValue(false)
    const service = new ManualOverlayService(deps)
    expect(service.registerHotkey()).toBe(false)
    expect(service.getState().hotkeyError).toContain('占用')
  })

  it('sanitizes settings', () => {
    const { deps } = createDeps()
    const service = new ManualOverlayService(deps)
    const settings = service.setSettings({ shrinkageAlpha: -5, hotkey: '   ', autoScreenshot: true, extra: 1 })
    expect(settings).toEqual({
      autoScreenshot: true,
      hotkey: DEFAULT_MANUAL_OVERLAY_HOTKEY,
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
    expect(service.isAutoScreenshotEnabled()).toBe(true)
  })

  it('parses live client data', async () => {
    const { deps } = createDeps({
      getLiveClientAllGameData: vi.fn(async () => ({
        status: 200,
        data: {
          activePlayer: { riotId: 'Me#1' },
          allPlayers: [
            { riotId: 'Me#1', team: 'ORDER', championName: 'Annie', items: [{ itemID: 3020 }] },
            { riotId: 'Foe#1', team: 'CHAOS', items: [{ itemID: 3089 }] },
          ],
        },
      })),
    })
    const live = await new ManualOverlayService(deps).getLiveData()
    expect(live).toMatchObject({ available: true, found: true, ownedItemIds: [3020], enemyItemIds: [3089] })
  })

  it('returns both teams from 2999 for team-comp analysis', async () => {
    const { deps } = createDeps({
      getLiveClientAllGameData: vi.fn(async () => ({
        status: 200,
        data: {
          activePlayer: { riotId: 'Me#1' },
          allPlayers: [
            { riotId: 'Me#1', team: 'ORDER', championName: 'Annie', rawChampionName: 'game_character_displayname_Annie', items: [] },
            { riotId: 'Foe#1', team: 'CHAOS', championName: 'Zed', rawChampionName: 'game_character_displayname_Zed', scores: { kills: 3, deaths: 0 }, items: [{ itemID: 3142 }] },
          ],
        },
      })),
    })
    const live = await new ManualOverlayService(deps).getLiveData()
    expect(live.teamSource).toBe('live')
    expect(live.players).toHaveLength(2)
    expect(live.players?.[1]).toMatchObject({ isAlly: false, kills: 3, itemIds: [3142] })
  })

  it('falls back to the LCU ally team during champ select', async () => {
    const getChampSelectTeam = vi.fn(async () => ({ selfChampionId: 54, allyChampionIds: [54, 99, 81] }))
    const { deps } = createDeps({ getChampSelectTeam })
    const service = new ManualOverlayService(deps)
    expect((await service.getLiveData()).teamSource).toBeUndefined()
    expect(getChampSelectTeam).not.toHaveBeenCalled() // 不在选人阶段不打 LCU
    service.setPhase('ChampSelect')
    const live = await service.getLiveData()
    expect(live).toMatchObject({ available: false, teamSource: 'champ-select', allyChampionIds: [54, 99, 81], selfChampionId: 54 })
  })

  it('handles the live client being unavailable', async () => {
    const { deps } = createDeps()
    const live = await new ManualOverlayService(deps).getLiveData()
    expect(live.available).toBe(false)
    expect(live.error).toBeTruthy()
  })
})

describe('ManualOverlayService recognition, correction and reminder', () => {
  const iconMatch = (id: number, score: number) => ({
    id, name: `icon${id}`, score, ncc: score, colorSimilarity: score, hamming: 8, iconPath: `${id}.png`, rarity: 1,
  })

  it('passes raw capture pixels to OCR and icon matching and merges the results', async () => {
    const raw = { buffer: Buffer.alloc(16), width: 2, height: 2, channels: 4 }
    const matchIcons = vi.fn(async () => [
      [iconMatch(1, 0.9), iconMatch(7, 0.7)],
      [iconMatch(8, 0.9), iconMatch(2, 0.75)],
      [iconMatch(9, 0.81), iconMatch(3, 0.6)],
    ])
    const appendLog = vi.fn()
    const { deps } = createDeps({
      capture: vi.fn(async () => ({ success: true, raw, captureMode: 'window' as const, width: 2, height: 2, hasLolWindow: true })),
      matchIcons,
      appendLog,
      getLiveClientAllGameData: vi.fn(async () => ({
        status: 200,
        data: {
          gameData: { gameTime: 33.3 },
          activePlayer: { riotId: 'Me#1', level: 3 },
          allPlayers: [{ riotId: 'Me#1', isDead: false, respawnTimer: 0, level: 3 }],
        },
      })),
    })
    const service = new ManualOverlayService(deps)
    const state = await service.refresh()
    expect(deps.analyze).toHaveBeenCalledWith(raw)
    expect(matchIcons).toHaveBeenCalledWith(raw)
    expect(state.candidates.map((candidate) => [candidate.slot, candidate.id, candidate.source])).toEqual([
      [0, 1, 'icon+ocr'],
      [1, 8, 'icon'], // 图标高置信且领先 → 覆盖 OCR 的 2
      [2, 3, 'ocr'], // 图标 0.81 不够 → 用 OCR
    ])
    expect(state.candidates[1].alternatives?.map((alt) => alt.id)).toEqual([2, 8])
    expect(state.lastCapture?.sources).toEqual({ 'icon+ocr': 1, icon: 1, ocr: 1 })
    await vi.waitFor(() => expect(appendLog).toHaveBeenCalled())
    expect(appendLog.mock.calls[0][0]).toMatchObject({
      type: 'refresh', trigger: 'button', gameTime: 33.3, level: 3, isDead: false, stagesReached: 1,
    })
  })

  it('does not trust icon-only matches when the screen does not look like a selection', async () => {
    const { deps } = createDeps({
      analyze: vi.fn(async () => ({ success: true, analysis: { augments: [], rerollButtons: { visible: false } } })),
      matchIcons: vi.fn(async () => [[iconMatch(1, 0.8)], [], []]),
    })
    const state = await new ManualOverlayService(deps).refresh()
    expect(state.candidates).toEqual([])
    expect(state.lastError).toContain('没有识别到')
  })

  it('accepts tentative icon-only matches when reroll buttons are visible', async () => {
    const { deps } = createDeps({
      analyze: vi.fn(async () => ({ success: true, analysis: { augments: [], rerollButtons: { visible: true } } })),
      matchIcons: vi.fn(async () => [[iconMatch(1, 0.8)], [iconMatch(2, 0.9), iconMatch(3, 0.7)], []]),
    })
    const state = await new ManualOverlayService(deps).refresh()
    expect(state.candidates.map((candidate) => [candidate.id, candidate.source])).toEqual([[1, 'icon-low'], [2, 'icon']])
  })

  it('skips icon matching when disabled', async () => {
    const matchIcons = vi.fn(async () => [[], [], []])
    const { deps } = createDeps({ matchIcons })
    const service = new ManualOverlayService(deps)
    service.setSettings({ iconMatchEnabled: false })
    await service.refresh()
    expect(matchIcons).not.toHaveBeenCalled()
  })

  it('corrects a card and the matching picked augment', async () => {
    const appendLog = vi.fn()
    const { deps } = createDeps({ appendLog })
    const service = new ManualOverlayService(deps)
    await service.refresh()
    service.pick({ id: 2, name: 'B' })
    // pick 会清空候选；重新识别后更正第 2 张
    await service.refresh()
    const state = service.correct(1, { id: 42, name: 'Fixed', iconPath: 'f.png' })
    expect(state.candidates.find((candidate) => candidate.slot === 1)).toMatchObject({ id: 42, name: 'Fixed', source: 'manual' })
    expect(state.picked.map((augment) => augment.id)).toEqual([42])
    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({ type: 'correct', slot: 1, fromId: 2, toId: 42 }))
    expect(service.correct(5, { id: 1, name: 'x' }).revision).toBe(state.revision) // 非法卡位忽略
  })

  it('replaces a picked augment without creating duplicates', () => {
    const { deps } = createDeps()
    const service = new ManualOverlayService(deps)
    service.pick({ id: 1, name: 'A' })
    service.pick({ id: 2, name: 'B' })
    expect(service.replacePicked(1, { id: 3, name: 'C' }).picked.map((augment) => augment.id)).toEqual([3, 2])
    expect(service.replacePicked(3, { id: 2, name: 'B' }).picked.map((augment) => augment.id)).toEqual([2])
    expect(service.replacePicked(99, { id: 5, name: 'E' }).picked.map((augment) => augment.id)).toEqual([2])
  })

  it('computes the refresh reminder from live data and supports acknowledging it', async () => {
    let level = 3
    let isDead = false
    const { deps } = createDeps({
      getLiveClientAllGameData: vi.fn(async () => ({
        status: 200,
        data: {
          gameData: { gameTime: level === 3 ? 10 : 500 },
          activePlayer: { riotId: 'Me#1', level },
          allPlayers: [{ riotId: 'Me#1', team: 'ORDER', isDead, respawnTimer: isDead ? 12 : 0 }],
        },
      })),
    })
    const service = new ManualOverlayService(deps)
    expect((await service.getLiveData()).reminder).toMatchObject({ active: true, urgent: true, stage: 1 })
    service.pick({ id: 1, name: 'A' })
    level = 7
    const pending = await service.getLiveData()
    expect(pending).toMatchObject({ level: 7, isDead: false, gameTime: 500 })
    expect(pending.reminder).toMatchObject({ active: true, urgent: false, stage: 2 })
    isDead = true
    expect((await service.getLiveData()).reminder).toMatchObject({ urgent: true })
    expect(service.acknowledgeReminder().acknowledgedStage).toBe(2)
    expect((await service.getLiveData()).reminder?.active).toBe(false)
    service.setSettings({ reminderEnabled: false })
    expect((await service.getLiveData()).reminder).toBeNull()
    expect(service.resetGame().acknowledgedStage).toBe(0)
  })

  it('builds the icon index when the game starts', async () => {
    const ensureIconIndex = vi.fn(async () => {})
    const iconIndexStatus = vi.fn(() => ({ ready: true, count: 200, error: null }))
    const { deps } = createDeps({ ensureIconIndex, iconIndexStatus })
    const service = new ManualOverlayService(deps)
    service.setPhase('InProgress')
    expect(ensureIconIndex).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(service.getState().iconIndex).toEqual({ ready: true, count: 200, error: null }))
  })

  it('lists augments for search, dropping invalid entries', async () => {
    const { deps } = createDeps({ listAugments: vi.fn(async () => [{ id: 1, name: 'A' }, { name: 'no id' } as any]) })
    expect(await new ManualOverlayService(deps).listAugments()).toEqual([{ id: 1, name: 'A', rarity: null, iconPath: null }])
  })
})

describe('ManualOverlayService 2999 live-game watch (LCU independent)', () => {
  function liveDeps() {
    let alive = true
    const getLiveClientAllGameData = vi.fn(async () => (alive
      ? { status: 200, data: { gameData: { gameTime: 5 }, activePlayer: { level: 1 }, allPlayers: [] } }
      : null))
    const created = createDeps({ getLiveClientAllGameData })
    return { ...created, setAlive: (value: boolean) => { alive = value } }
  }

  it('shows the overlay when 2999 responds even without any LCU phase', async () => {
    const { deps } = liveDeps()
    const service = new ManualOverlayService(deps)
    expect(await service.checkLiveGame()).toBe(true)
    expect(deps.showWindow).toHaveBeenCalledWith('2999')
    expect(service.getState().liveGame).toBe(true)
    // 已经显示过，不会重复触发
    await service.checkLiveGame()
    expect(deps.showWindow).toHaveBeenCalledTimes(1)
  })

  it('starts a new game (clears picks) when LCU did not report one', async () => {
    const { deps } = liveDeps()
    const service = new ManualOverlayService(deps)
    service.pick({ id: 1, name: 'old' })
    await service.checkLiveGame()
    expect(service.getState().picked).toEqual([])
  })

  it('keeps picks when LCU already reported the game', async () => {
    const { deps } = liveDeps()
    const service = new ManualOverlayService(deps)
    service.setPhase('InProgress')
    service.pick({ id: 1, name: 'A' })
    await service.checkLiveGame()
    expect(service.getState().picked.map((augment) => augment.id)).toEqual([1])
  })

  it('does not hide on an LCU hide phase while 2999 is alive, hides after repeated misses', async () => {
    const { deps, setAlive } = liveDeps()
    const service = new ManualOverlayService(deps)
    await service.checkLiveGame()
    service.setPhase('None')
    expect(deps.hideWindow).not.toHaveBeenCalled()
    setAlive(false)
    for (let i = 0; i < ManualOverlayService.LIVE_GAME_MISS_LIMIT - 1; i++) await service.checkLiveGame()
    expect(deps.hideWindow).not.toHaveBeenCalled()
    await service.checkLiveGame()
    expect(service.getState().liveGame).toBe(false)
    expect(deps.hideWindow).toHaveBeenCalledWith('2999-gone')
  })

  it('stays visible after 2999 disappears if LCU still says InProgress', async () => {
    const { deps, setAlive } = liveDeps()
    const service = new ManualOverlayService(deps)
    service.setPhase('InProgress')
    await service.checkLiveGame()
    setAlive(false)
    for (let i = 0; i < ManualOverlayService.LIVE_GAME_MISS_LIMIT; i++) await service.checkLiveGame()
    expect(deps.hideWindow).not.toHaveBeenCalled()
  })

  it('showOverlay shows on demand (tray)', () => {
    const { deps } = liveDeps()
    new ManualOverlayService(deps).showOverlay('tray')
    expect(deps.showWindow).toHaveBeenCalledWith('tray')
  })

  it('startLiveGameWatch polls and dispose stops it', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = liveDeps()
      const service = new ManualOverlayService(deps)
      service.startLiveGameWatch(1000)
      await vi.advanceTimersByTimeAsync(3100)
      const calls = (deps.getLiveClientAllGameData as any).mock.calls.length
      expect(calls).toBeGreaterThanOrEqual(3)
      service.dispose()
      await vi.advanceTimersByTimeAsync(5000)
      expect((deps.getLiveClientAllGameData as any).mock.calls.length).toBe(calls)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ManualOverlayService pinned (user-shown) overlay', () => {
  it('is not hidden by phase events after a manual show, until the user hides it', () => {
    const { deps } = createDeps()
    const service = new ManualOverlayService(deps)
    service.showOverlay('tray')
    service.setPhase('EndOfGame')
    expect(deps.hideWindow).not.toHaveBeenCalled()
    service.hideOverlay('tray')
    expect(deps.hideWindow).toHaveBeenCalledWith('tray')
    service.setPhase('Lobby')
    expect(deps.hideWindow).toHaveBeenLastCalledWith('phase:Lobby')
  })

  it('pins the overlay when the refresh hotkey is used', async () => {
    const { deps } = createDeps()
    const service = new ManualOverlayService(deps)
    await service.refresh('hotkey')
    expect(service.isPinned()).toBe(true)
    expect(deps.showWindow).toHaveBeenCalledWith('hotkey')
  })
})
