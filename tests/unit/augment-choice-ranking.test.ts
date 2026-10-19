import { describe, expect, it } from 'vitest'
import {
  computeChampionAugmentBaseline,
  posteriorStandardError,
  rankAugmentChoices,
  shrinkWinRate,
} from '../../src/shared/augment-choice-ranking.ts'

describe('augment choice ranking', () => {
  it('computes a games-weighted champion baseline from records or maps', () => {
    const baseline = computeChampionAugmentBaseline({
      a: { win_rate: 0.6, num_games: 100, num_win_games: 60 },
      b: { winRate: 0.4, games: 300 },
      c: { winRate: null, games: 50 },
    })
    expect(baseline.games).toBe(400)
    expect(baseline.winRate).toBeCloseTo((60 + 120) / 400, 6)
    expect(computeChampionAugmentBaseline(null)).toEqual({ winRate: null, games: 0 })
  })

  it('shrinks small samples toward the prior', () => {
    expect(shrinkWinRate(8, 10, 0.5, 300)).toBeCloseTo((8 + 150) / 310, 6)
    expect(shrinkWinRate(0, 0, 0.52, 300)).toBeCloseTo(0.52, 6)
    expect(posteriorStandardError(0.5, 0, 300)).toBeCloseTo(Math.sqrt(0.25 / 300), 6)
  })

  it('prefers a well-sampled card over a tiny-sample high winrate card', () => {
    const ranking = rankAugmentChoices(
      [
        { id: 1, name: '小样本', winRate: 0.8, games: 20 },
        { id: 2, name: '大样本', winRate: 0.58, games: 5000 },
        { id: 3, name: '一般', winRate: 0.5, games: 3000 },
      ],
      [{ winRate: 0.5, games: 100000 }],
    )
    expect(ranking.method).toBe('shrunk')
    expect(ranking.baselineSource).toBe('champion')
    expect(ranking.choices.map((choice) => choice.card.id)).toEqual([2, 1, 3])
    expect(ranking.choices[0].relativeLabel).toBe('首选')
    expect(ranking.choices[0].delta).toBeGreaterThan(0.07)
    expect(ranking.choices[0].note).toContain('5000 场')
    expect(ranking.choices[0].note).toContain('相对英雄平均 +')
    expect(ranking.topTie).toBe(false)
  })

  it('marks the top two as 差不多 when within noise', () => {
    const ranking = rankAugmentChoices(
      [
        { id: 1, winRate: 0.515, games: 400 },
        { id: 2, winRate: 0.51, games: 400 },
        { id: 3, winRate: 0.4, games: 4000 },
      ],
      [{ winRate: 0.5, games: 50000 }],
    )
    expect(ranking.topTie).toBe(true)
    expect(ranking.choices[0].relativeLabel).toBe('差不多')
    expect(ranking.choices[1].relativeLabel).toBe('差不多')
    expect(ranking.choices[2].relativeLabel).toBe('末选')
  })

  it('falls back to rank/tier/pickRate when no card has winrate, and labels it', () => {
    const ranking = rankAugmentChoices(
      [
        { id: 1, tier: 3, pickRate: 0.2 },
        { id: 2, tier: 1, pickRate: 0.01 },
        { id: 3, tier: 3, pickRate: 0.3 },
      ],
      [],
    )
    expect(ranking.method).toBe('rank-fallback')
    expect(ranking.choices.map((choice) => choice.card.id)).toEqual([2, 3, 1])
    expect(ranking.choices[0].note).toContain('无胜率数据')
  })

  it('treats cards without data as prior-only and skips missing slots', () => {
    const ranking = rankAugmentChoices(
      [
        { id: 1, winRate: 0.45, games: 2000 },
        { id: 2 },
        { id: 3, missing: true },
      ],
      { x: { winRate: 0.5, games: 10000 } },
    )
    expect(ranking.choices).toHaveLength(2)
    // 没数据的卡排最后、标「无数据」，不参与首选/次选/末选
    expect(ranking.choices[0].card.id).toBe(1)
    expect(ranking.choices[0].relativeLabel).toBe('首选')
    expect(ranking.choices[1].card.id).toBe(2)
    expect(ranking.choices[1].method).toBe('prior-only')
    expect(ranking.choices[1].relativeLabel).toBe('无数据')
    expect(ranking.choices[1].note).toContain('场次不足')
  })

  it('uses the three-card mean when the champion baseline is missing', () => {
    const ranking = rankAugmentChoices(
      [
        { id: 1, winRate: 0.6, games: 1000 },
        { id: 2, winRate: 0.4, games: 1000 },
      ],
      null,
    )
    expect(ranking.baselineSource).toBe('cards')
    expect(ranking.baselineWinRate).toBeCloseTo(0.5, 6)
    expect(ranking.choices[0].note).toContain('三卡平均')
  })

  it('returns none for empty input', () => {
    expect(rankAugmentChoices([], null).method).toBe('none')
  })
})
