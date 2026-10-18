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

  it('handles the live client being unavailable', async () => {
    const { deps } = createDeps()
    const live = await new ManualOverlayService(deps).getLiveData()
    expect(live.available).toBe(false)
    expect(live.error).toBeTruthy()
  })
})
