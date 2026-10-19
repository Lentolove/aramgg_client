/**
 * 真实对局回归（全部 30 名玩家）：只断言合理性规则（不混搭、鞋子对路、抗性响应阵容、无数据标注），
 * 不断言与实际出装的重合度（对局 16.15、统计 16.20，重合度只作参考，避免过拟合）。
 * 详细报告：node scripts/eval-real-matches/run.mjs report
 */
import { describe, expect, it } from 'vitest'
import { evaluateAll, summarize } from '../../scripts/eval-real-matches/eval.ts'

describe('真实对局回归（docs/samples，queue 2400）', () => {
  it('30 名玩家的方案都满足合理性规则', () => {
    const players = evaluateAll()
    const metrics = summarize(players)
    expect(metrics.players).toBe(30)
    expect(metrics.illegalPlans).toBe(0)
    expect(metrics.mixedPlans).toBe(0)
    expect(metrics.mixedOwnedPlans).toBe(0)
    expect(metrics.bootsIssues).toBe(0)
    expect(metrics.stasisAdviceForTanks).toBe(0)
    expect(metrics.trioNoDataMislabeled).toBe(0)
    expect(metrics.playersVs3ApMrNeed).toBe(metrics.playersVs3Ap)
    expect(metrics.playersVs3AdArmorNeed).toBe(metrics.playersVs3Ad)
    expect(metrics.tanksVs3ApWithMr).toBe(metrics.tanksVs3Ap)
    // 主流方案的鞋 = 路线里出场最多的（允许一处几乎同场次的并列）
    expect(metrics.popularBootsNotTop).toBeLessThanOrEqual(1)
    // 每名玩家至少有一个方案
    for (const player of players) expect(player.plans.length).toBeGreaterThan(0)
  }, 120_000)
})
