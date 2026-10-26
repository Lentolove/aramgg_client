/** 三海克斯组合真实胜率 → 三选一信号（v0.3.5） */
import { describe, expect, it } from 'vitest'
import { TRIO_PARAMS, makeLiftOf, trioSignal } from '../../src/shared/recommendation/augment-trios.ts'
import { applyCardSynergy, cardPlainReason, scoreCardSynergy } from '../../src/shared/recommendation/augment-synergy.ts'
import { loadEvalInputs } from '../../scripts/eval-real-matches/eval.ts'
import { trioRanking } from '../../scripts/eval-real-matches/scenarios.ts'

const base = 0.5
const trio = (ids: number[], games: number, winRate: number) => ({ augmentIds: ids, games, wins: Math.round(games * winRate), winRate })

describe('trioSignal', () => {
  it('(a) 候选卡补全高胜率三组合 → 正信号，完整命中', () => {
    const s = trioSignal(3, [1, 2], [trio([1, 2, 3], 300, 0.62)], base)!
    expect(s.kind).toBe('full')
    expect(s.points).toBeGreaterThan(1)
    expect(s.points).toBeLessThanOrEqual(TRIO_PARAMS.capPoints)
  })
  it('(b) 少于 50 局 → 忽略（返回 null，回退规则）', () => {
    expect(trioSignal(3, [1, 2], [trio([1, 2, 3], 40, 0.9)], base)).toBeNull()
    expect(trioSignal(3, [1], [trio([1, 2, 3], 20, 0.9), trio([1, 3, 4], 20, 0.9)], base)).toBeNull()
  })
  it('(c) 组合胜率低于期望 → 负信号', () => {
    expect(trioSignal(3, [1, 2], [trio([1, 2, 3], 300, 0.42)], base)!.points).toBeLessThan(-1)
  })
  it('部分命中：候选 + 1 张已选，相加互不重叠的记录，权重更低', () => {
    const records = [trio([1, 3, 5], 200, 0.55), trio([1, 3, 6], 200, 0.55), trio([2, 7, 8], 500, 0.3)]
    const pair = trioSignal(3, [1], records, base)!
    expect(pair.kind).toBe('pair')
    expect(pair.games).toBe(400)
    const full = trioSignal(3, [1, 5], [trio([1, 3, 5], 400, 0.55)], base)!
    expect(pair.points).toBeLessThan(full.points)
  })
  it('已选 2 张没有完整命中时不把两组相加（避免同一局算两次）', () => {
    const s = trioSignal(3, [1, 2], [trio([1, 3, 9], 100, 0.6), trio([2, 3, 9], 300, 0.6)], base)!
    expect(s.kind).toBe('pair')
    expect(s.games).toBe(300)
  })
  it('单卡提升已计入实测分：组合胜率 = 基线 + 单卡提升时信号≈0', () => {
    const liftOf = makeLiftOf({ 3: { win_rate: 0.6, num_games: 100000 }, 9: { win_rate: 0.5, num_games: 100000 } })
    const s = trioSignal(3, [1, 2], [trio([1, 2, 3], 300, 0.55)], 0.5, liftOf)!
    expect(Math.abs(s.points)).toBeLessThan(0.3)
  })
  it('不带已选海克斯时不产生信号', () => {
    expect(trioSignal(3, [], [trio([1, 2, 3], 300, 0.7)], base)).toBeNull()
  })
})

describe('接入三选一', () => {
  const profile = (id: number, name: string) => ({ id, name, mechanics: [], weights: {} } as any)
  const ctx = { ownedItemIds: [], plannedItemIds: [], itemIndex: new Map(), damageType: 'AD', archetypeVector: {}, routeLabel: null, team: null } as any
  it('命中组合时替代规则的已选海克斯加分，理由是大白话、主卡片不带数字', () => {
    const syn = scoreCardSynergy(profile(3, '候选'), [profile(1, '甲'), profile(2, '乙')], ctx, { trios: [trio([1, 2, 3], 300, 0.65)], baselineWinRate: 0.5 })
    expect(syn.parts.held).toBe(0)
    expect(syn.trioReason).toBe('与你已有的「甲」「乙」组合，该英雄该组合胜率高于平均')
    expect(cardPlainReason(0.5, 2, syn, 1000)).toBe(syn.trioReason)
    expect(syn.trioReason).not.toMatch(/\d/)
    expect(syn.trioDetail).toContain('300 局')
  })
  it('组合加分不被规则部分的 ±5 封顶吃掉', () => {
    const ranking = { method: 'shrunk', baselineWinRate: 0.5, choices: [{ card: { id: 3 }, order: 0, games: 1000, shrunkWinRate: 0.52, sortWinRate: 0.52 }] } as any
    const syn = { score: 1000, parts: { items: 1000, archetype: 0, held: 0, trio: 0, team: 0 }, reasons: [], trio: { points: 2, kind: 'full' } } as any
    const out = applyCardSynergy(ranking, () => syn)
    expect(out.choices[0].adjustPoints).toBeCloseTo(7, 5)
  })
  it('真实数据：墨菲特已选「钢化你心」时，同组合常见的卡理由来自组合数据', () => {
    const inputs = loadEvalInputs()
    const r = trioRanking(inputs, 54, [1181, 1353, 2102], [], [1152])
    const card = r.find((c: any) => c.card.id === 1181)
    expect(card.synergy.trio?.kind).toBe('pair')
    expect(card.plainReason).toContain('组合')
  })
})
