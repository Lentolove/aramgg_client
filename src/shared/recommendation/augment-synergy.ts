/**
 * 反向：给三选一的海克斯卡加「与当前局面的契合度」。
 *
 *   契合 = 与当前/计划装备的协同（同一套 海克斯×装备 模型）
 *        + 与当前路线属性的契合（当前方案所选路线的出装属性构成；已有装备锁定路线时跟着已有装备走）
 *        + 与已持有海克斯的机制重合
 *        + augmentTrios 命中（真实统计：该英雄这三个海克斯组合的胜率，样本少，收缩）
 *        + 阵容（模型：缺前排时坦度卡、对面法伤高时魔抗卡、对面回复多时重伤卡…，有上限）
 *
 * 最终排序 = 本英雄这张卡的实测提升（收缩，只扣 0.5σ 做保险）+ λ × 契合（模型，±5 个百分点封顶）。
 * 契合足够大时会改变排序：例如对面 5 法师时魔抗/坦度卡、已选同机制海克斯的卡。
 */

import { NO_DATA_LABEL, type AugmentChoiceInput, type AugmentChoiceRanking, type ChoiceRelativeLabel, type RankedAugmentChoice } from '../augment-choice-ranking.ts'
import { augmentItemSynergy, type EngineContext } from './build-engine.ts'
import { MECHANIC_LABELS, STAT_LABELS, type AugmentProfile, type StatKey, type WeightKey } from './profiles.ts'

export interface AugmentTrioLike {
  augmentIds?: Array<number | string>
  games?: number
  wins?: number
  winRate?: number
}

export interface CardSynergy {
  score: number
  parts: { items: number; archetype: number; held: number; trio: number; team: number }
  reasons: string[]
}

export const SYNERGY_PARAMS = {
  /** 每 1 分契合 ≈ 多少胜率（0.004 = 0.4 个百分点） */
  lambda: 0.009,
  maxAdjust: 0.05,
  trioAlpha: 100,
  trioWeight: 0.25,
  heldMechanicWeight: 1.2,
  archetypeWeight: 2,
  teamWeight: 2.5,
  teamCap: 3,
} as const

const round1 = (value: number) => Math.round(value * 10) / 10

export function scoreCardSynergy(
  card: AugmentProfile,
  held: AugmentProfile[],
  context: EngineContext,
  options: { trios?: AugmentTrioLike[]; baselineWinRate?: number | null } = {},
): CardSynergy {
  const reasons: string[] = []

  // 1) 与装备：已有的满权重，计划中的前 3 件 0.6
  const owned = new Set(context.ownedItemIds)
  const planned = context.plannedItemIds.filter((id) => !owned.has(id)).slice(0, 3)
  const targets = [
    ...context.ownedItemIds.map((id) => ({ id, weight: 1 })),
    ...planned.map((id) => ({ id, weight: 0.6 })),
  ]
  let items = 0
  let bestItem: { id: number; name: string; value: number; reason: string | null } | null = null
  for (const { id, weight } of targets) {
    const item = context.itemIndex.get(id)
    if (!item || item.boots) continue
    const result = augmentItemSynergy(card, item, context.damageType)
    items += result.value * weight
    if (!bestItem || Math.abs(result.value * weight) > Math.abs(bestItem.value)) {
      bestItem = { id, name: item.name, value: result.value * weight, reason: result.reason }
    }
  }
  items = targets.length ? items / Math.max(2, targets.length) * 2 : 0
  if (bestItem && Math.abs(bestItem.value) >= 0.8) {
    const verb = owned.has(bestItem.id) ? '已有' : '计划'
    reasons.push(`${bestItem.value > 0 ? '契合' : '不搭'}${verb}「${bestItem.name}」${bestItem.reason ? `：${bestItem.reason}` : ''}`)
  }

  // 2) 与英雄流派属性
  let archetype = 0
  let topStat: { key: StatKey; value: number } | null = null
  for (const [key, weight] of Object.entries(card.weights) as Array<[WeightKey, number]>) {
    const stat: StatKey = key === 'ADAPTIVE' ? context.damageType : key
    const value = weight * (context.archetypeVector[stat] ?? 0) * SYNERGY_PARAMS.archetypeWeight
    archetype += value
    if (!topStat || Math.abs(value) > Math.abs(topStat.value)) topStat = { key: stat, value }
  }
  const weightKeys = Object.keys(card.weights)
  if (weightKeys.length && archetype < 0.15 && card.weights[context.damageType === 'AP' ? 'AD' : 'AP'] && !card.weights[context.damageType]) {
    archetype -= 0.6
    reasons.push(`偏${context.damageType === 'AP' ? '物理' : '法强'}，与本英雄${context.damageType === 'AP' ? '法强' : '物理'}出装不搭`)
  } else if (topStat && topStat.value >= 0.4) {
    reasons.push(`当前路线${context.routeLabel ? `「${context.routeLabel}」` : ''}出装 ${Math.round((context.archetypeVector[topStat.key] ?? 0) * 100)}% 是${STAT_LABELS[topStat.key]}`)
  }

  // 3) 与已持有海克斯的机制重合
  let heldScore = 0
  for (const other of held) {
    const shared = card.mechanics.filter((mechanic) => other.mechanics.includes(mechanic) && !['gold', 'stacks', 'cc'].includes(mechanic))
    if (shared.length) {
      heldScore += shared.length * SYNERGY_PARAMS.heldMechanicWeight
      reasons.push(`与已选「${other.name}」同为${shared.slice(0, 2).map((m) => MECHANIC_LABELS[m]).join('/')}`)
    }
  }

  // 4) 三海克斯组合（真实统计）
  let trio = 0
  const heldIds = held.map((profile) => String(profile.id))
  if (heldIds.length && options.trios?.length && options.baselineWinRate != null) {
    const want = [...heldIds, String(card.id)]
    for (const record of options.trios) {
      const augmentIds = (record.augmentIds ?? []).map(String)
      if (!want.every((id) => augmentIds.includes(id))) continue
      const games = Number(record.games) || 0
      const rate = Number(record.winRate)
      const wins = Number(record.wins) || (Number.isFinite(rate) ? rate * games : 0)
      if (games <= 0) continue
      const shrunk = (wins + SYNERGY_PARAMS.trioAlpha * options.baselineWinRate) / (games + SYNERGY_PARAMS.trioAlpha)
      const value = (shrunk - options.baselineWinRate) * 100 * SYNERGY_PARAMS.trioWeight
      if (Math.abs(value) > Math.abs(trio)) trio = value
      reasons.unshift(`组合数据：含此卡的三海克斯组合 ${games} 场，胜率 ${(wins / games * 100).toFixed(1)}%`)
      break
    }
  }

  // 5) 阵容（模型）
  let teamScore = 0
  const team = context.team
  if (team) {
    const w = card.weights
    const parts: Array<[number, string]> = []
    const tankWeight = (w.HP ?? 0) + (w.ARMOR ?? 0) + (w.MR ?? 0) + (card.mechanics.includes('tank') ? 0.5 : 0)
    if (team.canTank && team.needs.frontline > 0 && tankWeight > 0) parts.push([team.needs.frontline * Math.min(1, tankWeight), '我方缺前排，坦度卡加分'])
    if (team.needs.mr > 0 && (w.MR ?? 0) > 0) parts.push([team.needs.mr * Math.min(1, w.MR ?? 0), '对面法伤高，魔抗卡加分'])
    if (team.needs.armor > 0 && (w.ARMOR ?? 0) > 0) parts.push([team.needs.armor * Math.min(1, w.ARMOR ?? 0), '对面物伤高，护甲卡加分'])
    if (team.needs.antiHeal > 0 && card.mechanics.includes('anti-heal')) parts.push([team.needs.antiHeal, '对面回复多，重伤卡加分'])
    if (team.needs.stasis > 0 && card.mechanics.includes('stasis')) parts.push([team.needs.stasis, '对面爆发高，保命卡加分'])
    if (team.canDamage && team.needs.damage > 0) {
      const dmg = (w[context.damageType] ?? 0) + (w.ADAPTIVE ?? 0)
      if (dmg > 0) parts.push([team.needs.damage * Math.min(1, dmg), '我方缺输出，输出卡加分'])
    }
    teamScore = Math.min(SYNERGY_PARAMS.teamCap, parts.reduce((sum, [value]) => sum + value, 0) * SYNERGY_PARAMS.teamWeight)
    const best = parts.sort((a, b) => b[0] - a[0])[0]
    if (best && teamScore >= 0.5) reasons.push(`阵容：${best[1]}`)
  }

  const score = items + archetype + heldScore + trio + teamScore
  return {
    score: round1(score),
    parts: { items: round1(items), archetype: round1(archetype), held: round1(heldScore), trio: round1(trio), team: round1(teamScore) },
    reasons: reasons.slice(0, 3),
  }
}

export type CardTier = 'S' | 'A' | 'B' | 'C'
export const TIER_LABELS: Record<CardTier, string> = { S: '强烈推荐', A: '推荐', B: '一般', C: '不推荐' }

/** 总分（百分点）→ 档位；同时保证三选一的第一名至少是 B（否则三张都差时没有可选项的提示） */
export function tierOf(points: number | null): CardTier | null {
  if (points == null) return null
  if (points >= 5) return 'S'
  if (points >= 2) return 'A'
  if (points >= -1.2) return 'B'
  return 'C'
}

/** 模型理由 → 玩家一眼能懂的短句 */
export function plainSynergyReason(reason: string): string {
  let m: RegExpExecArray | null
  if ((m = /^当前路线.*出装 \d+% 是(.+)$/.exec(reason))) return `适合你这套${m[1]}出装`
  if ((m = /^契合(已有|计划)「(.+?)」/.exec(reason))) return `和${m[1] === '已有' ? '你已有' : '要出'}的「${m[2]}」搭配`
  if ((m = /^不搭(已有|计划)「(.+?)」/.exec(reason))) return `和${m[1] === '已有' ? '你已有' : '要出'}的「${m[2]}」不搭`
  if ((m = /^与已选「(.+?)」同为(.+)$/.exec(reason))) return `与你已有的「${m[1]}」搭配（都是${m[2]}）`
  return reason.replace(/^阵容：/, '').replace(/卡加分$/, '卡更有用')
}

/** 一句话理由：契合（阵容/已选海克斯/装备）明显时说契合，否则说本英雄的实测表现 */
export function cardPlainReason(dataPoints: number | null, adjustPoints: number, synergy: CardSynergy | null, games: number): string {
  const contextReason = synergy?.reasons.find((reason) => !reason.startsWith('组合数据')) ?? synergy?.reasons[0]
  const plainContext = contextReason == null ? undefined : plainSynergyReason(contextReason)
  if (plainContext && Math.abs(adjustPoints) >= 1 && (dataPoints == null || Math.abs(adjustPoints) >= Math.abs(dataPoints) * 0.6)) return plainContext
  if (dataPoints == null) return plainContext ?? '暂无该英雄的数据'
  const small = games < 300 ? '（样本少）' : ''
  if (dataPoints >= 1.5) return `该英雄拿这张胜率偏高${small}`
  if (dataPoints <= -1.5) return `该英雄拿这张胜率偏低${small}`
  if (plainContext && Math.abs(adjustPoints) >= 0.5) return plainContext
  return `该英雄拿这张表现一般${small}`
}

export interface SynergyRankedChoice<T extends AugmentChoiceInput> extends RankedAugmentChoice<T> {
  /** 实测部分（百分点） */
  dataPoints: number | null
  /** 契合调整（百分点） */
  adjustPoints: number
  /** 总分（百分点）= 实测 + 契合 */
  points: number | null
  tier: CardTier | null
  tierLabel: string | null
  plainReason: string
  synergy: CardSynergy | null
  /** 胜率 + λ×契合 */
  combinedWinRate: number | null
  /** 排序因为契合度发生了变化 */
  reordered: boolean
}

/** 在胜率排序上叠加契合度并重新排序 */
export function applyCardSynergy<T extends AugmentChoiceInput>(
  ranking: AugmentChoiceRanking<T>,
  synergyOf: (card: T) => CardSynergy | null,
): AugmentChoiceRanking<T> & { choices: SynergyRankedChoice<T>[] } {
  const enriched = ranking.choices.map((choice) => {
    const synergy = synergyOf(choice.card)
    const adjust = synergy
      ? Math.max(-SYNERGY_PARAMS.maxAdjust, Math.min(SYNERGY_PARAMS.maxAdjust, synergy.score * SYNERGY_PARAMS.lambda))
      : 0
    const sortBase = choice.sortWinRate ?? choice.shrunkWinRate
    const combinedWinRate = sortBase != null ? sortBase + adjust : null
    const baseline = ranking.baselineWinRate
    const dataPoints = sortBase != null && baseline != null ? Math.round((sortBase - baseline) * 1000) / 10 : null
    const adjustPoints = Math.round(adjust * 1000) / 10
    const points = dataPoints != null ? Math.round((dataPoints + adjustPoints) * 10) / 10 : null
    const tier = tierOf(points)
    return {
      ...choice, synergy, combinedWinRate, reordered: false, dataPoints, adjustPoints, points, tier,
      tierLabel: tier ? TIER_LABELS[tier] : null,
      plainReason: cardPlainReason(dataPoints, adjustPoints, synergy, choice.games),
    }
  })
  if (ranking.method !== 'shrunk') {
    return { ...ranking, choices: enriched }
  }
  // 没有胜率数据的卡排最后、标「无数据」，不参与首选/次选/末选
  const withData = enriched.filter((choice) => choice.combinedWinRate != null).sort((a, b) => b.combinedWinRate! - a.combinedWinRate!)
  const noData = enriched.filter((choice) => choice.combinedWinRate == null)
  const sorted = [...withData, ...noData]
  const labels: ChoiceRelativeLabel[] = ['首选', '次选', '末选']
  const topTie = withData.length >= 2
    && Math.abs(withData[0].combinedWinRate! - withData[1].combinedWinRate!)
      <= Math.hypot(withData[0].standardError ?? 0, withData[1].standardError ?? 0)
  const choices = sorted.map((choice, order) => ({
    ...choice,
    reordered: order !== choice.order,
    order,
    relativeLabel: (choice.combinedWinRate == null ? NO_DATA_LABEL : topTie && order < 2 ? '差不多' : labels[order] ?? '末选') as ChoiceRelativeLabel,
  }))
  const summary = topTie
    ? '前两张差距在噪声范围内，差不多'
    : `首选「${choices[0]?.card?.name || choices[0]?.card?.id || '?'}」${choices[0]?.reordered ? '（契合度改变了排序）' : ''}`
  return { ...ranking, topTie, choices, summary }
}
