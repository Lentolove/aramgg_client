/**
 * 推荐必须随局面变化：同一英雄换敌方阵容 / 换已选海克斯，海克斯档位与出装要跟着变，并给出大白话理由。
 * 数据：真实对局夹具（resources/arammeta + tests/fixtures/real-matches），阵容为合成。
 */
import { describe, expect, it } from 'vitest'
import { loadEvalInputs } from '../../scripts/eval-real-matches/eval.ts'
import { LINEUPS, scenario, trioRanking } from '../../scripts/eval-real-matches/scenarios.ts'

const inputs = loadEvalInputs()
const names = (choices: any[]) => choices.map((c) => c.card.id)

describe('推荐随阵容与已选海克斯变化', () => {
  it('敌方全物理时护甲向海克斯（狂徒豪气）明显加分、排名不降，并说明原因', () => {
    const trio = [1098, 1063, 1038]
    const vsAp = trioRanking(inputs, 141, trio, LINEUPS['AP重'], [])
    const vsAd = trioRanking(inputs, 141, trio, LINEUPS['AD重'], [])
    const card = (list: any[]) => list.find((c) => c.card.id === 1063)!
    expect(names(vsAd).indexOf(1063)).toBeLessThanOrEqual(names(vsAp).indexOf(1063))
    expect(card(vsAd).adjustPoints - card(vsAp).adjustPoints).toBeGreaterThanOrEqual(1)
    expect(card(vsAd).points).toBeGreaterThan(card(vsAp).points)
    expect(card(vsAd).plainReason).toContain('护甲')
  })

  it('已选海克斯改变三选一（墨菲特持有「和我一起困在这里」后坦度卡明显加分）', () => {
    const trio = [2102, 1152, 1353]
    const none = trioRanking(inputs, 54, trio, LINEUPS['AP重'], [])
    const held = trioRanking(inputs, 54, trio, LINEUPS['AP重'], [1413])
    const gain = (id: number) => held.find((c) => c.card.id === id)!.adjustPoints - none.find((c) => c.card.id === id)!.adjustPoints
    expect(Math.max(gain(1152), gain(1353))).toBeGreaterThanOrEqual(0.8)
    expect(names(held).indexOf(2102)).toBeGreaterThanOrEqual(names(none).indexOf(2102))
    for (const choice of [...none, ...held]) {
      expect(['S', 'A', 'B', 'C']).toContain(choice.tier)
      expect(choice.plainReason).toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('出装随敌方伤害类型变化：法系多补魔抗、物理多补护甲，理由是大白话', () => {
    const ap = scenario(inputs, 157, LINEUPS['AP重'], [])
    const ad = scenario(inputs, 157, LINEUPS['AD重'], [])
    expect(ap.build).not.toEqual(ad.build)
    expect(ap.notes.some((note) => note.includes('优先魔抗'))).toBe(true)
    expect(ad.notes.some((note) => note.includes('护甲'))).toBe(true)
    for (const note of [...ap.notes, ...ad.notes]) expect(note).not.toMatch(/undefined|n=/)
  })

  it('坦克对 5 法系也一定带魔抗装', () => {
    const r = scenario(inputs, 54, LINEUPS['AP重'], [1413])
    expect(r.notes.some((note) => /魔抗/.test(note) && !/靴/.test(note.split(':')[0]))).toBe(true)
  })
})
