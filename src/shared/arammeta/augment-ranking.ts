/**
 * 三选一排序：移植 arammeta（scripts/tierlist_engine.py build_champ_augment_picks）的方法。
 *
 *   后验平均胜率 m：Beta 先验以「该英雄基线胜率」为中心、强度 k（arammeta 拟合，默认 350）→ 展示值
 *   保守下界 lcb：后验 10% 分位（正态近似 m − 1.2816·sd）
 *   排序分 = lcb − 基线（arammeta 榜单里的海克斯直接用它发布的 score，含 0.003×选取率提升）
 *   稀有度内比较：同时给出该卡在本英雄同稀有度海克斯里的名次
 * arammeta 没有这张卡时退回 dtodo 胜率（同样的收缩 + 下界，基线用 dtodo 的英雄平均）。
 */

import {
  computeChampionAugmentBaseline,
  NO_DATA_LABEL,
  type AugmentChoiceInput,
  type AugmentChoiceRanking,
  type ChampionAugmentStatInput,
  type ChoiceRelativeLabel,
  type RankedAugmentChoice,
} from '../augment-choice-ranking.ts'
import type { ArammetaAugmentStat, ArammetaChampion, ArammetaRarity } from './normalize.ts'

export const ARAMMETA_PRIOR_STRENGTH = 350
export const ARAMMETA_LCB_Z = 1.2815515655446004

export type CardStatSource = 'arammeta' | 'dtodo' | 'none'

export interface ArammetaRankedChoice<T extends AugmentChoiceInput = AugmentChoiceInput> extends RankedAugmentChoice<T> {
  source: CardStatSource
  /** 保守下界 − 基线 */
  lcbLift: number | null
  /** 排序分（arammeta score 或 lcbLift） */
  score: number | null
  pickRate: number | null
  rarity: ArammetaRarity | null
  /** 在本英雄同稀有度海克斯里的名次（1 = 最好） */
  rarityRank: { rank: number; total: number } | null
}

const toId = (value: unknown) => String(value ?? '')

export function posteriorSd(mean: number, games: number, prior = ARAMMETA_PRIOR_STRENGTH): number {
  return Math.sqrt(Math.max(0, mean * (1 - mean)) / (Math.max(0, games) + prior + 1))
}

/** 后验平均（已收缩）→ 保守下界 − 基线 */
export function lcbLiftOf(mean: number, games: number, baseline: number, prior = ARAMMETA_PRIOR_STRENGTH): number {
  return mean - ARAMMETA_LCB_Z * posteriorSd(mean, games, prior) - baseline
}

/** 原始胜率 → 后验平均（向基线收缩） */
export function shrinkToBaseline(rawWinRate: number, games: number, baseline: number, prior = ARAMMETA_PRIOR_STRENGTH): number {
  return (rawWinRate * games + baseline * prior) / (games + prior)
}

function statScore(stat: ArammetaAugmentStat, baseline: number): number {
  return stat.score ?? stat.lcb ?? lcbLiftOf(stat.wr, stat.g, baseline)
}

/** 本英雄同稀有度海克斯的名次表 */
function rarityRanks(champion: ArammetaChampion, baseline: number, rarityOf: (id: number) => ArammetaRarity | null) {
  const byRarity = new Map<ArammetaRarity, Array<{ id: number; score: number }>>()
  for (const stat of champion.augments) {
    if (stat.g <= 0) continue
    const rarity = stat.rarity ?? rarityOf(stat.id)
    if (!rarity) continue
    const list = byRarity.get(rarity) ?? []
    list.push({ id: stat.id, score: statScore(stat, baseline) })
    byRarity.set(rarity, list)
  }
  const ranks = new Map<number, { rank: number; total: number }>()
  for (const list of byRarity.values()) {
    list.sort((a, b) => b.score - a.score)
    list.forEach((entry, index) => ranks.set(entry.id, { rank: index + 1, total: list.length }))
  }
  return ranks
}

const normalizeRate = (value: unknown): number | null => {
  const n = Number(value)
  if (value == null || value === '' || !Number.isFinite(n)) return null
  return n > 1 ? n / 100 : n
}

const RARITY_ALIASES: Record<string, ArammetaRarity> = {
  kprismatic: 'kPrismatic', prismatic: 'kPrismatic', '2': 'kPrismatic',
  kgold: 'kGold', gold: 'kGold', '1': 'kGold',
  ksilver: 'kSilver', silver: 'kSilver', '0': 'kSilver',
}
export function normalizeRarity(value: unknown): ArammetaRarity | null {
  return RARITY_ALIASES[String(value ?? '').toLowerCase()] ?? null
}

export interface ArammetaRankingOptions {
  /** dtodo 的英雄海克斯统计（兜底基线） */
  fallbackStats?: Iterable<ChampionAugmentStatInput> | Record<string, ChampionAugmentStatInput> | null
  /** 没有 arammeta 稀有度时（池里但不在榜单）按 id 查稀有度 */
  rarityOf?: (id: number) => ArammetaRarity | null
  noiseZ?: number
}

export function rankAugmentChoicesArammeta<T extends AugmentChoiceInput>(
  cards: T[],
  champion: ArammetaChampion | null,
  options: ArammetaRankingOptions = {},
): AugmentChoiceRanking<T> & { choices: ArammetaRankedChoice<T>[]; source: 'arammeta' | 'mixed' | 'dtodo' | 'none' } {
  const fallback = computeChampionAugmentBaseline(options.fallbackStats ?? null)
  const baseline = champion?.baselineWr ?? fallback.winRate
  const rarityOf = options.rarityOf ?? (() => null)
  const ranks = champion && champion.baselineWr != null ? rarityRanks(champion, champion.baselineWr, rarityOf) : new Map()
  const statById = new Map((champion?.augments ?? []).map((stat) => [String(stat.id), stat]))
  const noiseZ = options.noiseZ ?? 1

  const present = cards
    .map((card, index) => ({ card, slot: Number.isInteger(card?.detectedSlot) ? Number(card.detectedSlot) : index }))
    .filter(({ card }) => card && !card.missing)

  const evaluated = present.map(({ card, slot }) => {
    const id = toId(card.id ?? card.augmentId)
    const stat = statById.get(id)
    if (stat && stat.g > 0 && champion?.baselineWr != null) {
      const base = champion.baselineWr
      const sd = posteriorSd(stat.wr, stat.g)
      const lcbLift = stat.lcb ?? lcbLiftOf(stat.wr, stat.g, base)
      return {
        card, slot, source: 'arammeta' as const, mean: stat.wr, raw: null, games: stat.g, sd, base,
        lcbLift, score: statScore(stat, base), pick: stat.pick, rarity: stat.rarity ?? rarityOf(stat.id),
        rarityRank: ranks.get(stat.id) ?? null,
      }
    }
    const raw = normalizeRate(card.winRate)
    const games = Number(card.games) || 0
    if (raw != null && games > 0 && fallback.winRate != null) {
      const base = fallback.winRate
      const mean = shrinkToBaseline(raw, games, base)
      const lcbLift = lcbLiftOf(mean, games, base)
      return {
        card, slot, source: 'dtodo' as const, mean, raw, games, sd: posteriorSd(mean, games), base,
        lcbLift, score: lcbLift, pick: normalizeRate(card.pickRate), rarity: null, rarityRank: null,
      }
    }
    return { card, slot, source: 'none' as const, mean: null, raw: null, games: 0, sd: null, base: null, lcbLift: null, score: null, pick: normalizeRate(card.pickRate), rarity: null, rarityRank: null }
  })

  const withData = evaluated.filter((entry) => entry.score != null)
  const sorted = [...evaluated].sort((a, b) => {
    if (a.score == null && b.score == null) return 0
    if (a.score == null) return 1
    if (b.score == null) return -1
    return b.score - a.score
  })
  const labels: ChoiceRelativeLabel[] = ['首选', '次选', '末选']
  const topTie = sorted.length >= 2 && sorted[0].score != null && sorted[1].score != null
    && Math.abs(sorted[0].score - sorted[1].score) <= noiseZ * Math.hypot(sorted[0].sd ?? 0, sorted[1].sd ?? 0)

  const sources = new Set(withData.map((entry) => entry.source))
  const source = !withData.length ? 'none' : sources.size > 1 ? 'mixed' : sources.has('arammeta') ? 'arammeta' : 'dtodo'
  const choices: ArammetaRankedChoice<T>[] = sorted.map((entry, order) => {
    const lift = entry.mean != null && entry.base != null ? entry.mean - entry.base : null
    const note = entry.source === 'arammeta'
      ? `实测·arammeta n=${entry.games}，胜率 ${(entry.mean! * 100).toFixed(1)}%（保守 ${entry.lcbLift! >= 0 ? '+' : '−'}${Math.abs(entry.lcbLift! * 100).toFixed(1)}%）`
      : entry.source === 'dtodo'
        ? `实测·dtodo n=${entry.games}（arammeta 无此卡）`
        : '无胜率数据'
    return {
      card: entry.card,
      slot: entry.slot,
      method: entry.score != null ? 'shrunk' : 'rank-fallback',
      shrunkWinRate: entry.mean,
      rawWinRate: entry.raw,
      delta: lift,
      standardError: entry.sd,
      games: entry.games,
      order,
      relativeLabel: entry.score == null ? NO_DATA_LABEL : (topTie && order < 2 ? '差不多' : labels[order] ?? '末选'),
      note,
      // 排序用「基线 + 保守分」，契合度的 λ 调整叠加在它上面
      sortWinRate: entry.score != null && entry.base != null ? entry.base + entry.score : null,
      source: entry.source,
      lcbLift: entry.lcbLift,
      score: entry.score,
      pickRate: entry.pick,
      rarity: entry.rarity,
      rarityRank: entry.rarityRank,
    }
  })
  const first = choices[0]
  const summary = !withData.length
    ? (present.length ? '无胜率数据' : '未识别到海克斯')
    : topTie ? '前两张差距在噪声范围内，差不多' : `首选「${first?.card?.name || first?.card?.id || '?'}」`
  return {
    method: !present.length ? 'none' : withData.length ? 'shrunk' : 'rank-fallback',
    baselineWinRate: baseline ?? null,
    baselineGames: champion?.augments.reduce((sum, stat) => sum + stat.g, 0) ?? fallback.games,
    baselineSource: 'champion',
    alpha: ARAMMETA_PRIOR_STRENGTH,
    topTie,
    choices,
    summary,
    source,
  }
}
