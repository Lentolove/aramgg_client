import { describe, expect, it, vi } from 'vitest'
import {
  FOLLOW_UP_INTERVAL_MS,
  FOLLOW_UP_MAX_MS,
  ManualOverlayService,
  extractLiveAugmentIds,
  type ManualOverlayDeps,
} from '../../src/main/services/manual-overlay/manual-overlay-service.ts'

type Offer = Array<{ id: number; name: string; detectedSlot: number }>

const OFFER_A: Offer = [
  { id: 1, name: 'A', detectedSlot: 0 },
  { id: 2, name: 'B', detectedSlot: 1 },
  { id: 3, name: 'C', detectedSlot: 2 },
]
const OFFER_B: Offer = [
  { id: 4, name: 'D', detectedSlot: 0 },
  { id: 5, name: 'E', detectedSlot: 1 },
  { id: 6, name: 'F', detectedSlot: 2 },
]

function setup(options: { offers: Array<Offer | 'fail'>; live?: unknown; listAugments?: ManualOverlayDeps['listAugments'] }) {
  let clock = 1_000
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = []
  const offers = [...options.offers]
  const storeValues = new Map<string, unknown>()
  const deps: ManualOverlayDeps = {
    capture: vi.fn(async () => ({ success: true, buffer: Buffer.from('png'), width: 1920, height: 1080 })),
    analyze: vi.fn(async () => {
      const next = offers.length > 1 ? offers.shift()! : offers[0]
      if (next === 'fail') return { success: false, error: 'ocr down' }
      return { success: true, analysis: { augments: next } }
    }),
    warmup: vi.fn(async () => {}),
    getLiveClientAllGameData: vi.fn(async () => (options.live ? { status: 200, data: options.live } : null)),
    store: { get: (key) => storeValues.get(key), set: (key, value) => { storeValues.set(key, value) } },
    shortcuts: { register: vi.fn(() => true), unregister: vi.fn() },
    showWindow: vi.fn(),
    hideWindow: vi.fn(),
    broadcast: vi.fn(),
    now: () => clock,
    schedule: (callback, ms) => {
      const timer = { at: clock + ms, callback, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    listAugments: options.listAugments,
  }
  const service = new ManualOverlayService(deps)
  /** 推进时钟并跑到期的定时器，等待异步刷新完成 */
  const tick = async (ms = FOLLOW_UP_INTERVAL_MS) => {
    clock += ms
    const due = timers.filter((timer) => !timer.cancelled && timer.at <= clock)
    for (const timer of due) {
      timer.cancelled = true
      timer.callback()
    }
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const pendingTimers = () => timers.filter((timer) => !timer.cancelled).length
  return { service, deps, tick, pendingTimers }
}

describe('manual overlay auto follow-up', () => {
  it('keeps watching after a successful refresh and stops after the max window', async () => {
    const { service, deps, tick, pendingTimers } = setup({ offers: [OFFER_A] })
    service.setPhase('InProgress')
    const state = await service.refresh()
    expect(state.autoWatching).toBe(true)
    expect(pendingTimers()).toBe(1)
    for (let elapsed = 0; elapsed < FOLLOW_UP_MAX_MS + FOLLOW_UP_INTERVAL_MS * 2; elapsed += FOLLOW_UP_INTERVAL_MS) {
      await tick()
    }
    expect(service.getState().autoWatching).toBe(false)
    expect(pendingTimers()).toBe(0)
    const calls = vi.mocked(deps.capture).mock.calls.length
    expect(calls).toBeGreaterThan(5)
    expect(calls).toBeLessThanOrEqual(Math.ceil(FOLLOW_UP_MAX_MS / FOLLOW_UP_INTERVAL_MS) + 2)
  })

  it('does not schedule anything when autoFollowUp is off', async () => {
    const { service, pendingTimers } = setup({ offers: [OFFER_A] })
    service.setSettings({ autoFollowUp: false })
    await service.refresh()
    expect(pendingTimers()).toBe(0)
    expect(service.getState().autoWatching).toBe(false)
  })

  it('needs two empty follow-ups before declaring the choice closed, then exposes pendingChoice', async () => {
    const { service, tick } = setup({ offers: [OFFER_A, [], []] })
    service.setPhase('InProgress')
    await service.refresh()
    await tick()
    // 一次空结果：保留卡片，继续跟
    expect(service.getState().candidates).toHaveLength(3)
    expect(service.getState().pendingChoice).toBeNull()
    await tick()
    const state = service.getState()
    expect(state.candidates).toEqual([])
    expect(state.pendingChoice?.candidates.map((candidate) => candidate.id)).toEqual([1, 2, 3])
    expect(state.pendingChoice?.reason).toBe('screen-closed')
    expect(state.autoWatching).toBe(false)
  })

  it('ignores OCR failures during follow-up instead of treating them as closed', async () => {
    const { service, tick } = setup({ offers: [OFFER_A, 'fail', 'fail', OFFER_A] })
    await service.refresh()
    await tick()
    await tick()
    expect(service.getState().pendingChoice).toBeNull()
    expect(service.getState().candidates).toHaveLength(3)
  })

  it('treats a fully different offer as the next round (rerolls change only one card)', async () => {
    const reroll: Offer = [OFFER_A[0], { id: 9, name: 'Z', detectedSlot: 1 }, OFFER_A[2]]
    const { service, tick } = setup({ offers: [OFFER_A, reroll, OFFER_B] })
    await service.refresh()
    await tick()
    expect(service.getState().pendingChoice).toBeNull()
    expect(service.getState().candidates.map((candidate) => candidate.id)).toEqual([1, 9, 3])
    await tick()
    const state = service.getState()
    expect(state.candidates.map((candidate) => candidate.id)).toEqual([4, 5, 6])
    expect(state.pendingChoice?.reason).toBe('new-offer')
    expect(state.pendingChoice?.candidates.map((candidate) => candidate.id)).toEqual([1, 9, 3])
  })

  it('an inferred pick records alternatives and keeps the next round on screen', async () => {
    const { service, tick } = setup({ offers: [OFFER_A, OFFER_B] })
    await service.refresh()
    await tick()
    const state = service.pick({ id: 2, name: 'B', inferred: 'recommended', alternatives: [{ id: 1, name: 'A' }, { id: 3, name: 'C' }] })
    expect(state.pendingChoice).toBeNull()
    expect(state.picked).toHaveLength(1)
    expect(state.picked[0].inferred).toBe('recommended')
    expect(state.picked[0].alternatives?.map((alt) => alt.id)).toEqual([1, 3])
    expect(state.candidates.map((candidate) => candidate.id)).toEqual([4, 5, 6])
    // 更正成同一轮的另一张：清掉推断标记
    const corrected = service.replacePicked(2, { id: 3, name: 'C' })
    expect(corrected.picked[0].id).toBe(3)
    expect(corrected.picked[0].inferred).toBeNull()
  })

  it('uses 2999 augment ids to resolve the closed choice when the game provides them', async () => {
    const live = {
      activePlayer: { riotId: 'me#1', playerAugments: [{ id: 2 }] },
      allPlayers: [{ riotId: 'me#1', championName: 'Annie', team: 'ORDER', items: [] }],
    }
    const { service, tick } = setup({ offers: [OFFER_A, [], []], live })
    await service.refresh()
    await tick()
    await tick()
    const state = service.getState()
    expect(state.pendingChoice).toBeNull()
    expect(state.picked.map((augment) => [augment.id, augment.inferred])).toEqual([[2, 'live-client']])
  })

  it('a manual pick ends the watch for that round', async () => {
    const { service, pendingTimers } = setup({ offers: [OFFER_A] })
    await service.refresh()
    expect(pendingTimers()).toBe(1)
    const state = service.pick({ id: 1, name: 'A' })
    expect(state.autoWatching).toBe(false)
    expect(pendingTimers()).toBe(0)
    expect(state.picked[0].inferred).toBeNull()
  })
})

describe('extractLiveAugmentIds', () => {
  it('finds augment-like fields on activePlayer and the own allPlayers entry', () => {
    const result = extractLiveAugmentIds({
      activePlayer: { riotId: 'me#1', championStats: { abilityPower: 10 }, augments: [101, '102'] },
      allPlayers: [
        { riotId: 'other#2', augments: [999] },
        { riotId: 'me#1', mayhemAugment: { augmentId: 103 } },
      ],
    })
    expect(result.ids.sort()).toEqual([101, 102, 103])
    expect(result.keys).toEqual(['activePlayer.augments', 'self.mayhemAugment'])
  })

  it('returns nothing for the standard 2999 shape (no augment fields)', () => {
    expect(extractLiveAugmentIds({ activePlayer: { riotId: 'me#1', level: 3 }, allPlayers: [] })).toEqual({ ids: [], keys: [] })
    expect(extractLiveAugmentIds(null)).toEqual({ ids: [], keys: [] })
  })
})
