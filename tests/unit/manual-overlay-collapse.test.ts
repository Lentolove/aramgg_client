import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_COLLAPSE_HOTKEY,
  MANUAL_OVERLAY_COLLAPSED_KEY,
  ManualOverlayService,
  type ManualOverlayDeps,
} from '../../src/main/services/manual-overlay/manual-overlay-service.ts'
import { anchoredResize } from '../../src/main/modules/window-position.ts'

function setup(initialStore: Record<string, unknown> = {}, offers: unknown[][] = []) {
  const storeValues = new Map<string, unknown>(Object.entries(initialStore))
  const registered = new Map<string, () => void>()
  const queue = [...offers]
  const deps: ManualOverlayDeps = {
    capture: vi.fn(async () => ({ success: true, buffer: Buffer.from('png') })),
    analyze: vi.fn(async () => ({ success: true, analysis: { augments: (queue.length > 1 ? queue.shift() : queue[0]) ?? [] } })),
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
    schedule: () => () => {},
  }
  return { service: new ManualOverlayService(deps), deps, storeValues, registered }
}

const CARDS = [
  { id: 1, name: 'A', detectedSlot: 0 },
  { id: 2, name: 'B', detectedSlot: 1 },
  { id: 3, name: 'C', detectedSlot: 2 },
]

describe('manual overlay collapse state', () => {
  it('defaults to expanded and remembers collapse across sessions', () => {
    const first = setup()
    expect(first.service.getState().collapsed).toBe(false)
    const state = first.service.setCollapsed(true)
    expect(state.collapsed).toBe(true)
    expect(first.storeValues.get(MANUAL_OVERLAY_COLLAPSED_KEY)).toBe(true)
    expect(first.deps.broadcast).toHaveBeenLastCalledWith(expect.objectContaining({ collapsed: true }))

    const second = setup({ [MANUAL_OVERLAY_COLLAPSED_KEY]: true })
    expect(second.service.getState().collapsed).toBe(true)
    expect(second.service.toggleCollapsed().collapsed).toBe(false)
    expect(second.storeValues.get(MANUAL_OVERLAY_COLLAPSED_KEY)).toBe(false)
  })

  it('only accepts a strict boolean true', () => {
    const { service } = setup()
    expect(service.setCollapsed('yes').collapsed).toBe(false)
    expect(service.setCollapsed(1).collapsed).toBe(false)
  })

  it('registers the collapse hotkey and toggles with it (expanding also shows the overlay)', () => {
    const { service, registered, deps } = setup()
    service.registerHotkey()
    expect(service.getState().collapseHotkeyRegistered).toBe(true)
    const toggle = registered.get(DEFAULT_COLLAPSE_HOTKEY)!
    toggle()
    expect(service.getState().collapsed).toBe(true)
    toggle()
    expect(service.getState().collapsed).toBe(false)
    expect(deps.showWindow).toHaveBeenCalled()
  })

  it('rejects a collapse hotkey equal to the refresh hotkey and allows disabling it', () => {
    const { service, registered } = setup()
    service.registerHotkey()
    service.setSettings({ collapseHotkey: 'CommandOrControl+Shift+R' })
    expect(service.getState().collapseHotkeyRegistered).toBe(false)
    expect(service.getState().collapseHotkeyError).toContain('相同')
    service.setSettings({ collapseHotkey: '' })
    expect(service.getState().collapseHotkey).toBe('')
    expect([...registered.keys()]).toEqual(['CommandOrControl+Shift+R'])
  })

  it('sanitizes layout settings', () => {
    const { service } = setup()
    const settings = service.setSettings({ opacity: 3, scale: 0.1, collapsedSections: ['build', 'bogus', 'cards'] })
    expect(settings.opacity).toBe(1)
    expect(settings.scale).toBe(0.8)
    expect(settings.collapsedSections).toEqual(['cards', 'build'])
    expect(service.setSettings({ opacity: 'x', scale: null }).opacity).toBe(0.92)
  })

  it('minimal mode expands when cards appear and collapses when they are cleared', async () => {
    const { service } = setup({ [MANUAL_OVERLAY_COLLAPSED_KEY]: true }, [CARDS])
    service.setSettings({ minimalMode: true })
    const state = await service.refresh()
    expect(state.candidates).toHaveLength(3)
    expect(state.collapsed).toBe(false)
    expect(service.pick({ id: 1, name: 'A' }).collapsed).toBe(true)
  })

  it('without minimal mode, cards never change the collapse state', async () => {
    const { service } = setup({ [MANUAL_OVERLAY_COLLAPSED_KEY]: true }, [CARDS])
    expect((await service.refresh()).collapsed).toBe(true)
  })
})

describe('anchoredResize', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }

  it('keeps the top-left corner on the left half of the screen', () => {
    expect(anchoredResize({ x: 16, y: 300, width: 336, height: 560 }, { width: 233, height: 64 }, area))
      .toEqual({ x: 16, y: 300, width: 233, height: 64 })
  })

  it('keeps the right edge on the right half of the screen', () => {
    const collapsed = anchoredResize({ x: 1560, y: 200, width: 336, height: 560 }, { width: 233, height: 64 }, area)
    expect(collapsed.x + collapsed.width).toBe(1560 + 336)
    const expanded = anchoredResize(collapsed, { width: 336, height: 560 }, area)
    expect(expanded).toEqual({ x: 1560, y: 200, width: 336, height: 560 })
  })

  it('clamps onto the work area when expanding near the bottom edge or off-screen', () => {
    const result = anchoredResize({ x: 10, y: 900, width: 233, height: 64 }, { width: 336, height: 560 }, area)
    expect(result.y + result.height).toBeLessThanOrEqual(1040)
    expect(anchoredResize({ x: -500, y: -40, width: 100, height: 40 }, { width: 336, height: 2000 }, area))
      .toEqual({ x: 0, y: 0, width: 336, height: 1040 })
  })
})
