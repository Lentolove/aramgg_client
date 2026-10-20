/**
 * 三选一海克斯排序（纯函数，无 Electron / DOM 依赖）。
 *
 * 方法：经验贝叶斯收缩。把每张卡的胜率向「该英雄所有海克斯的加权平均胜率」收缩，
 *   shrunk = (wins + alpha * baseline) / (games + alpha)
 * alpha 相当于「先验场次」，默认 300：样本越少，越接近英雄平均。
 * 只在三张卡之间给相对标签；前两名差距落在噪声范围内时标记「差不多」。
 * 三张卡都没有胜率时，退回服务端 rank / tier / pickRate（热度排序），并明确标注。
 */

export const DEFAULT_SHRINKAGE_ALPHA = 300
export const DEFAULT_NOISE_Z = 1

export type ChoiceRankingMethod = 'shrunk' | 'prior-only' | 'rank-fallback' | 'none'
export type ChoiceRelativeLabel = '首选' | '次选' | '末选' | '差不多' | '无数据'
/** 没有任何胜率数据的卡：不参与相对排名 */
export const NO_DATA_LABEL: ChoiceRelativeLabel = '无数据'

export interface AugmentChoiceInput {
  id?: number | string | null
  augmentId?: number | string | null
  name?: string
  winRate?: number | null
  games?: number | null
  wins?: number | null
  rank?: number | null
  total?: number | null
  tier?: number | null
  pickRate?: number | null
  missing?: boolean
  detectedSlot?: number
  [key: string]: unknown
}

export interface ChampionAugmentStatInput {
  winRate?: number | null
  win_rate?: number | null
  games?: number | null
  num_games?: number | null
  wins?: number | null
  num_win_games?: number | null
  [key: string]: unknown
}

export interface ChoiceRankingOptions {
  alpha?: number
  noiseZ?: number
}

export interface RankedAugmentChoice<T extends AugmentChoiceInput = AugmentChoiceInput> {
  card: T
  slot: number
  method: ChoiceRankingMethod
  shrunkWinRate: number | null
  rawWinRate: number | null
  delta: number | null
  standardError: number | null
  games: number
  order: number
  relativeLabel: ChoiceRelativeLabel | null
  note: string
  /** 排序用的胜率（arammeta：基线 + 保守下界分）；没有时用 shrunkWinRate */
  sortWinRate?: number | null
}

export interface AugmentChoiceRanking<T extends AugmentChoiceInput = AugmentChoiceInput> {
  method: ChoiceRankingMethod
  baselineWinRate: number | null
  baselineGames: number
  /** 基线来源：英雄全部海克斯（champion）或仅三张卡（cards，英雄数据缺失时兜底） */
  baselineSource?: 'champion' | 'cards'
  alpha: number
  topTie: boolean
  choices: RankedAugmentChoice<T>[]
  summary: string
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === '') {
    return null
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeRate(value: unknown): number | null {
  const rate = finiteOrNull(value)
  if (rate == null) {
    return null
  }
  // 兼容 0-100 的百分数
  return rate > 1 ? rate / 100 : rate
}

function positiveInt(value: unknown): number | null {
  const number = finiteOrNull(value)
  return number != null && number > 0 ? Math.round(number) : null
}

/** 英雄所有海克斯的场次加权平均胜率（= 总胜场 / 总场次）。 */
export function computeChampionAugmentBaseline(
  stats: Iterable<ChampionAugmentStatInput> | Record<string, ChampionAugmentStatInput> | null | undefined,
): { winRate: number | null; games: number } {
  if (!stats) {
    return { winRate: null, games: 0 }
  }
  const list: ChampionAugmentStatInput[] = Symbol.iterator in Object(stats)
    ? Array.from(stats as Iterable<ChampionAugmentStatInput>)
    : Object.values(stats as Record<string, ChampionAugmentStatInput>)

  let totalGames = 0
  let totalWins = 0
  for (const stat of list) {
    if (!stat || typeof stat !== 'object') continue
    const games = positiveInt(stat.games ?? stat.num_games)
    const winRate = normalizeRate(stat.winRate ?? stat.win_rate)
    if (!games || winRate == null) continue
    const wins = finiteOrNull(stat.wins ?? stat.num_win_games) ?? winRate * games
    totalGames += games
    totalWins += wins
  }

  return totalGames > 0
    ? { winRate: totalWins / totalGames, games: totalGames }
    : { winRate: null, games: 0 }
}

export function shrinkWinRate(wins: number, games: number, prior: number, alpha: number): number {
  const safeAlpha = Math.max(0, alpha)
  const denominator = games + safeAlpha
  return denominator > 0 ? (wins + safeAlpha * prior) / denominator : prior
}

export function posteriorStandardError(rate: number, games: number, alpha: number): number {
  const n = Math.max(1, games + Math.max(0, alpha))
  return Math.sqrt(Math.max(0, rate * (1 - rate)) / n)
}

function compareFallback(left: AugmentChoiceInput, right: AugmentChoiceInput): number {
  const leftRank = positiveInt(left.rank)
  const rightRank = positiveInt(right.rank)
  if (leftRank != null || rightRank != null) {
    if (leftRank == null) return 1
    if (rightRank == null) return -1
    if (leftRank !== rightRank) return leftRank - rightRank
  }
  const leftTier = positiveInt(left.tier)
  const rightTier = positiveInt(right.tier)
  if (leftTier != null || rightTier != null) {
    if (leftTier == null) return 1
    if (rightTier == null) return -1
    if (leftTier !== rightTier) return leftTier - rightTier
  }
  const leftPick = normalizeRate(left.pickRate) ?? -1
  const rightPick = normalizeRate(right.pickRate) ?? -1
  return rightPick - leftPick
}

function formatPoints(delta: number): string {
  const points = delta * 100
  const sign = points > 0 ? '+' : points < 0 ? '−' : '±'
  return `${sign}${Math.abs(points).toFixed(1)}%`
}

/**
 * 对 OCR 识别出的三张卡排序。缺失槽位（missing）保留但不参与排序。
 */
export function rankAugmentChoices<T extends AugmentChoiceInput>(
  cards: T[],
  championStats: Iterable<ChampionAugmentStatInput> | Record<string, ChampionAugmentStatInput> | null | undefined,
  options: ChoiceRankingOptions = {},
): AugmentChoiceRanking<T> {
  const alpha = finiteOrNull(options.alpha) ?? DEFAULT_SHRINKAGE_ALPHA
  const noiseZ = finiteOrNull(options.noiseZ) ?? DEFAULT_NOISE_Z
  const baseline = computeChampionAugmentBaseline(championStats)

  const present = cards
    .map((card, index) => ({
      card,
      slot: Number.isInteger(card?.detectedSlot) ? Number(card.detectedSlot) : index,
    }))
    .filter(({ card }) => card && !card.missing)

  const withData = present.filter(({ card }) =>
    normalizeRate(card.winRate) != null && (positiveInt(card.games) ?? 0) > 0)

  if (present.length === 0) {
    return {
      method: 'none', baselineWinRate: baseline.winRate, baselineGames: baseline.games,
      alpha, topTie: false, choices: [], summary: '未识别到海克斯',
    }
  }

  // 全部缺胜率：退回热度排序（服务端 rank = tier 升序 + 选取率降序）
  if (withData.length === 0) {
    const sorted = [...present].sort((a, b) => compareFallback(a.card, b.card))
    const labels: ChoiceRelativeLabel[] = ['首选', '次选', '末选']
    return {
      method: 'rank-fallback',
      baselineWinRate: baseline.winRate,
      baselineGames: baseline.games,
      alpha,
      topTie: false,
      choices: sorted.map(({ card, slot }, order) => ({
        card,
        slot,
        method: 'rank-fallback',
        shrunkWinRate: null,
        rawWinRate: null,
        delta: null,
        standardError: null,
        games: 0,
        order,
        relativeLabel: labels[order] ?? null,
        note: '无胜率数据，按热度（梯度+选取率）排序，仅供参考',
      })),
      summary: '三张卡都没有胜率数据，已按热度排序',
    }
  }

  // 有胜率的卡用于估计「三张卡的均值」作为英雄基线缺失时的兜底
  const baselineSource: 'champion' | 'cards' = baseline.winRate != null ? 'champion' : 'cards'
  const baselineLabel = baselineSource === 'champion' ? '英雄平均' : '三卡平均'
  const prior = baseline.winRate
    ?? withData.reduce((sum, { card }) => sum + (normalizeRate(card.winRate) ?? 0.5), 0) / withData.length

  const scored = present.map(({ card, slot }) => {
    const rawWinRate = normalizeRate(card.winRate)
    const games = rawWinRate != null ? positiveInt(card.games) ?? 0 : 0
    const wins = rawWinRate != null
      ? finiteOrNull(card.wins) ?? rawWinRate * games
      : 0
    const shrunk = shrinkWinRate(wins, games, prior, alpha)
    const method: ChoiceRankingMethod = games > 0 ? 'shrunk' : 'prior-only'
    return {
      card,
      slot,
      method,
      shrunkWinRate: shrunk,
      rawWinRate,
      delta: shrunk - prior,
      standardError: posteriorStandardError(shrunk, games, alpha),
      games,
    }
  })

  // 有场次的卡在前（按收缩胜率），没场次的（prior-only）排最后、标「无数据」
  scored.sort((a, b) => {
    const dataDiff = Number(b.method === 'shrunk') - Number(a.method === 'shrunk')
    if (dataDiff) return dataDiff
    const diff = b.shrunkWinRate - a.shrunkWinRate
    if (Math.abs(diff) > 1e-12) return diff
    return compareFallback(a.card, b.card)
  })
  const ranked = scored.filter((entry) => entry.method === 'shrunk')

  let topTie = false
  if (ranked.length >= 2) {
    const [first, second] = ranked
    const noise = noiseZ * Math.sqrt(first.standardError ** 2 + second.standardError ** 2)
    topTie = first.shrunkWinRate - second.shrunkWinRate <= noise
  }

  const labels: ChoiceRelativeLabel[] = ['首选', '次选', '末选']
  const choices: RankedAugmentChoice<T>[] = scored.map((entry, order) => {
    const relativeLabel: ChoiceRelativeLabel = entry.method !== 'shrunk' ? NO_DATA_LABEL : topTie && order < 2 ? '差不多' : labels[order] ?? '末选'
    const note = entry.method === 'prior-only'
      ? `场次不足（服务端未给胜率），按${baselineLabel}估计`
      : `${entry.games} 场，相对${baselineLabel} ${formatPoints(entry.delta)}`
    return { ...entry, order, relativeLabel, note }
  })

  const summary = topTie
    ? `前两张差距在噪声范围内（${noiseZ}σ），差不多`
    : `首选「${choices[0]?.card?.name || choices[0]?.card?.id || '?'}」`

  return {
    method: 'shrunk',
    baselineSource,
    baselineWinRate: prior,
    baselineGames: baseline.games,
    alpha,
    topTie,
    choices,
    summary,
  }
}

/**
 * 卡片主数字「排序分」（百分点）：= 排序实际用的值 − 英雄基线。
 * 排序值优先用契合度调整后的 combinedWinRate，其次 sortWinRate（arammeta：基线 + 保守提升），最后收缩胜率。
 * 选它而不是「收缩胜率 − 基线」：保证数字大的卡永远排在前面（首选/次选与数字一致）。
 */
export function rankingPoints(
  choice: { combinedWinRate?: number | null; sortWinRate?: number | null; shrunkWinRate?: number | null },
  baselineWinRate: number | null | undefined,
): number | null {
  const value = choice.combinedWinRate ?? choice.sortWinRate ?? choice.shrunkWinRate
  if (value == null || baselineWinRate == null || !Number.isFinite(value) || !Number.isFinite(baselineWinRate)) return null
  return Math.round((value - baselineWinRate) * 1000) / 10
}
