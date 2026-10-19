/**
 * 海克斯感知的出装评分引擎（纯函数）。
 *
 * 分数 = 英雄数据先验（真实统计：出场率、收缩胜率、核心路线）
 *      + Σ 海克斯画像 · 装备属性/机制（模型）
 *      + 海克斯点名装备加分（升级类）
 *      + 已有组件进度（2999 实时装备）
 *      + 对局阵容（team-comp.ts：双方英雄画像 + 实时装备 → 魔抗/护甲/重伤/穿透/保命/补前排…，有上限）
 *        没有阵容信息时退回到「敌方装备的法/物比例、治疗装数量」
 * 然后在约束下（一双鞋、唯一被动不重复、6 格）贪心组出整套 6 件 + 「下一件」，每件附带可解释的原因与分项分数。
 *
 * 诚实声明：数据源没有「海克斯 × 装备」的统计，海克斯部分是规则模型，不是测得的胜率。
 */

import {
  MECHANIC_LABELS,
  STAT_LABELS,
  parseAugmentProfile,
  parseItemProfile,
  type AugmentProfile,
  type ItemProfile,
  type Mechanic,
  type RawAugmentLike,
  type RawItemLike,
  type StatKey,
  type WeightKey,
  type WeightMap,
} from './profiles.ts'
import type { TeamAnalysis, TeamNeeds } from './team-comp.ts'

// ---------------------------------------------------------------------------
// 输入

export interface BuildRecordLike {
  itemIds?: Array<number | string>
  items?: Array<number | string>
  coreItemIds?: Array<number | string>
  itemId?: number | string
  id?: number | string
  step?: number
  games?: number
  wins?: number
  winRate?: number
  pickRate?: number
  [key: string]: unknown
}

export interface ChampionBuildLike {
  tags?: unknown
  buildTags?: string
  games?: number
  wins?: number
  winRate?: number
  stats?: { games?: number; wins?: number; winRate?: number }
  coreItems?: BuildRecordLike[]
  fullItems?: BuildRecordLike[]
  itemExtensions?: BuildRecordLike[]
  situationalItems?: BuildRecordLike[]
  /** 统计来源：'arammeta'（ARAM 海克斯大乱斗实测）或 dtodo（默认） */
  source?: string
  /** 出鞋比例（有的数据源直接提供） */
  bootsShare?: number
  [key: string]: unknown
}

export interface EngineInput {
  builds: ChampionBuildLike[]
  /** 装备列表（英雄数据里的 items，或 item-profiles.json） */
  items: Array<RawItemLike | ItemProfile> | Record<string, RawItemLike>
  /** 已持有的海克斯（画像或原始数据） */
  augments: Array<AugmentProfile | RawAugmentLike>
  ownedItemIds?: Array<number | string>
  enemyItemIds?: Array<number | string>
  slots?: number
  /** 是否同时计算「无海克斯」基线并标注变化（默认 true） */
  compareBaseline?: boolean
  /** 流派选择：auto（默认，统计 + 海克斯）、popular（场次最多）、winrate（样本足够里收缩胜率最高）或指定 builds 下标 */
  archetype?: 'auto' | 'popular' | 'winrate' | number
  /** 装备先验：pick（出场率为主，默认）或 winrate（收缩胜率为主） */
  priorMode?: 'pick' | 'winrate'
  /** 用户手动换装：把 from 换成 to（保持格位；不合规则时忽略） */
  swaps?: ItemSwap[]
  /** 对局阵容分析（analyzeTeamComp）；有它时代替「敌方装备」项 */
  team?: TeamAnalysis | null
  /** 实测装备组合（arammeta items：两件同出的场次、胜率、相对英雄基线的提升） */
  itemPairs?: Array<{ ids: number[]; g: number; wr: number; lift: number }>
  /** 实测单件提升（把组合效应与单件效应分开） */
  itemSingles?: Array<{ ids: number[]; g: number; lift: number }>
}

export interface ItemSwap {
  from: number
  to: number
}

// ---------------------------------------------------------------------------
// 输出

export interface ScoreBreakdown {
  prior: number
  synergy: number
  progress: number
  enemy: number
  /** 阵容项（有上限） */
  comp: number
  /** 实测组合项（与已选装备同出的额外胜率） */
  pair: number
  total: number
}

export type ItemChange = 'new' | 'up' | 'down' | 'same' | null

export interface EngineItem {
  itemId: number
  name: string
  score: ScoreBreakdown
  reasons: string[]
  owned: boolean
  isNext: boolean
  boots: boolean
  change: ItemChange
  /** 在无海克斯基线中的位置（不在基线中为 null） */
  baselineIndex: number | null
  /** 主要贡献的海克斯 */
  drivers: string[]
  /** 该格的备选（引擎的次优候选，同为鞋/非鞋且不与其他格冲突） */
  alternatives: ItemAlternative[]
  /** 用户手动换上的；swappedFrom = 原推荐 */
  swappedFrom: number | null
  /** 数据先验：该流派里出这件的场次与收缩胜率（没有统计时为 null） */
  priorGames: number | null
  priorWinRate: number | null
}

export interface ItemAlternative {
  itemId: number
  name: string
  total: number
  /** 相对当前格装备的分差（负数 = 引擎认为略差） */
  delta: number
  reason: string
}

export interface ArchetypeChoice {
  index: number
  label: string
  games: number
  winRate: number | null
  score: number
  baselineIndex: number
  reasons: string[]
}

export interface EngineResult {
  archetype: ArchetypeChoice | null
  archetypes: ArchetypeChoice[]
  items: EngineItem[]
  nextItemId: number | null
  /** 被挤出基线的装备 */
  removed: Array<{ itemId: number; name: string; reason: string }>
  weights: WeightMap
  mechanics: Mechanic[]
  damageType: 'AP' | 'AD'
  notes: string[]
  /** 供反向（海克斯卡）评分复用 */
  context: EngineContext
  /** 阵容对这套出装的影响（没有阵容信息时为 null） */
  team: TeamImpact | null
  /** 6 件里来自 海克斯模型 / 阵容 的分数合计 */
  contributions: { augment: number; comp: number }
}

export interface TeamImpact {
  needs: TeamNeeds
  canTank: boolean
  canDamage: boolean
  /** 阵容让流派变了（例如墨菲特 法强 → 坦克） */
  routeNote: string | null
  /** 与「不看阵容」相比，因为阵容换进来 / 挤出去的装备 */
  added: Array<{ itemId: number; name: string; reason: string }>
  removed: Array<{ itemId: number; name: string }>
}

export interface EngineContext {
  itemIndex: Map<number, ItemProfile>
  archetypeVector: Partial<Record<StatKey, number>>
  archetypeTags: Partial<Record<Mechanic, number>>
  damageType: 'AP' | 'AD'
  plannedItemIds: number[]
  ownedItemIds: number[]
  /** 阵容需求（反向评分海克斯卡时用） */
  team: { needs: TeamNeeds; canTank: boolean; canDamage: boolean } | null
}

// ---------------------------------------------------------------------------
// 常量（可调参数集中在这里）

export const ENGINE_PARAMS = {
  /** 装备胜率收缩强度（场次） */
  itemAlpha: 150,
  /** 出装流派胜率收缩强度 */
  buildAlpha: 500,
  priorPickWeight: 2.5,
  priorWinWeight: 0.3,
  coreBonus: [0.6, 0.4, 0.25],
  /** 其他流派里的装备：相对当前流派的折扣 */
  offArchetypePenalty: 1.0,
  /** 英雄数据里完全没出现过的装备 */
  unseenPrior: -1.6,
  statSynergy: 3.5,
  mechanicSynergy: 1.2,
  antiMechanicPenalty: 2.0,
  progressWeight: 1.5,
  enemyResistWeight: 2.5,
  antiHealBonus: 1.5,
  archetypePickWeight: 1.2,
  archetypeWinWeight: 0.05,
  archetypeStatWeight: 4,
  archetypeMechanicWeight: 1.5,
  /** 单个海克斯对单件装备的协同上限（点名/升级加分不受限） */
  synergyCap: 4.5,
  /** 同一个海克斯每多满足一件装备，后续装备从它拿到的协同 ×decay */
  synergyDecay: 0.7,
  /** 装备里对本英雄「没用」的属性占比 → 罚分 */
  uselessStatPenalty: 3,
  /** 高胜率方案：先验权重 */
  winratePickWeight: 1.0,
  winrateWinWeight: 0.9,
  /** 高胜率方案：出场占比低于此视为样本太少 */
  winrateMinShare: 0.03,
  winrateOffRoutePenalty: 3,
  /** 高胜率流派：至少占英雄总场次的比例 / 最少场次 */
  winrateRouteMinShare: 0.05,
  winrateRouteMinGames: 300,
  /** 每格展示的备选数量 */
  alternativesPerSlot: 3,
  /** 阵容：抗性需求 × 装备抗性占比 */
  compResistWeight: 3,
  compAntiHealWeight: 2.2,
  compAntiShieldWeight: 1.8,
  compPenetrationWeight: 3,
  compTenacityWeight: 1.6,
  compStasisWeight: 2,
  compFrontlineWeight: 1.8,
  compDamageWeight: 1.2,
  /** 单件装备阵容项上下限 */
  compCap: 3.5,
  compFloor: -2,
  /** 同一需求每多一件满足：抗性/穿透 ×0.7，补前排/补输出 ×0.85（一件就够的需求只给第一件） */
  compResistDecay: 0.7,
  /** 实测组合：收缩强度（场次）、每 1% 组合效应的分数、封顶、最少场次 */
  pairAlpha: 300,
  pairWeight: 0.25,
  pairCap: 1.0,
  pairMinGames: 60,
  compGeneralDecay: 0.85,
  /** 阵容对流派选择：缺前排/缺输出 × 流派坦度差 */
  compRouteWeight: 6,
  /** 「能偏肉」：存在 HP+双抗 占比 ≥ 此值、且场次占比 ≥ compRouteMinShare 的路线 */
  compTankRouteShare: 0.4,
  compRouteMinShare: 0.03,
} as const

/** 阵容用到的特定装备（id → 系数） */
const COMP_ITEMS = {
  antiShield: new Map([[6695, 1]]),
  tenacity: new Map([[3111, 1], [3140, 0.8], [6035, 0.8], [3139, 0.8]]),
  stasis: new Map([[3157, 1], [3102, 0.9], [3026, 0.9], [3814, 0.6]]),
  /** 对坦：百分比/破甲（物理） */
  antiTankAD: new Map([[3071, 0.8], [3153, 0.6]]),
  /** 对坦：百分比灼烧/法穿（法系） */
  antiTankAP: new Map([[6653, 0.9]]),
} as const

/** 一件就够的需求：拿过一件后其余装备不再从它得分 */
const COMP_SINGLE_NEEDS = new Set<keyof TeamNeeds>(['antiHeal', 'antiShield', 'tenacity', 'stasis'])
export const COMP_NEED_LABEL: Record<keyof TeamNeeds, string> = {
  mr: '魔抗', armor: '护甲', antiHeal: '重伤', antiShield: '破盾', penetration: '对坦', tenacity: '韧性/解控', stasis: '保命', frontline: '补前排', damage: '补输出',
}

/** 海克斯机制 → 装备标签（及匹配系数） */
const MECHANIC_ITEM_MATCH: Partial<Record<Mechanic, Array<[Mechanic, number]>>> = {
  'on-hit': [['on-hit', 1]],
  crit: [['crit', 1]],
  'auto-attack': [['on-hit', 0.5], ['auto-attack', 0.4]],
  ability: [['ability', 0.6], ['spellblade', 0.5]],
  ultimate: [['ultimate', 1]],
  tank: [['tank', 0.7]],
  'heal-shield': [['heal-shield', 0.6]],
  burn: [['burn', 1]],
  'item-active': [['item-active', 0.8]],
  cc: [['cc', 0.6]],
  stasis: [['stasis', 1]],
  mana: [['mana', 0.6]],
}

// ---------------------------------------------------------------------------
// 工具

const toId = (value: unknown): number | null => {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}
const ids = (values: unknown): number[] => (Array.isArray(values) ? values.map(toId).filter((id): id is number => id != null) : [])
const round1 = (value: number) => Math.round(value * 10) / 10
const round3 = (value: number) => Math.round(value * 1000) / 1000
const pct = (value: number) => `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`
const signed = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`

function recordIds(record: BuildRecordLike): number[] {
  const raw = record.itemIds ?? record.items ?? (record.itemId != null ? [record.itemId] : record.id != null ? [record.id] : [])
  return ids(raw)
}

function isItemProfile(value: unknown): value is ItemProfile {
  return !!value && typeof value === 'object' && 'shares' in (value as object) && 'tags' in (value as object)
}

function isAugmentProfile(value: unknown): value is AugmentProfile {
  return !!value && typeof value === 'object' && 'weights' in (value as object) && 'mechanics' in (value as object)
}

export function buildItemProfileIndex(items: EngineInput['items']): Map<number, ItemProfile> {
  const list = Array.isArray(items) ? items : Object.values(items ?? {})
  const index = new Map<number, ItemProfile>()
  for (const item of list) {
    const id = toId(item?.id)
    if (id == null || index.has(id)) continue
    const raw = item as RawItemLike
    const categories = raw.categories ?? []
    if (categories.includes('Consumable') || categories.includes('Trinket') || raw.requiredChampion) continue
    index.set(id, isItemProfile(item) ? item : parseItemProfile(raw))
  }
  return index
}

export function toAugmentProfile(augment: AugmentProfile | RawAugmentLike, itemIndex?: Map<number, ItemProfile>): AugmentProfile {
  if (isAugmentProfile(augment)) return augment
  const names = itemIndex ? [...itemIndex.values()].map((item) => ({ id: item.id, name: item.name, priceTotal: item.priceTotal })) : []
  return parseAugmentProfile(augment, names)
}

function buildLabel(build: ChampionBuildLike, index: number): string {
  const tags = build.tags
  let label = typeof build.buildTags === 'string' && build.buildTags ? build.buildTags : ''
  if (!label && tags && typeof tags === 'object') {
    label = (Array.isArray(tags) ? tags : Object.values(tags as Record<string, unknown>)).map(String).join(', ')
  }
  return label || `出装 ${index + 1}`
}

const ARCHETYPE_LABELS: Record<string, string> = {
  AP: '法强', AD: '物理', Tank: '坦克', Bruiser: '战士', Crit: '暴击', 'On-Hit': '攻击特效', Lethality: '穿甲',
}
export function localizeArchetype(label: string): string {
  return label.split(/,\s*/).map((part) => ARCHETYPE_LABELS[part] ?? part).join('·')
}

function buildGames(build: ChampionBuildLike): { games: number; wins: number; winRate: number | null } {
  const games = Number(build.games ?? build.stats?.games) || 0
  const rate = Number(build.winRate ?? build.stats?.winRate)
  const winRate = Number.isFinite(rate) && rate > 0 ? (rate > 1 ? rate / 100 : rate) : null
  const wins = Number(build.wins ?? build.stats?.wins) || (winRate != null ? winRate * games : 0)
  return { games, wins, winRate: games > 0 ? wins / games : winRate }
}

/** 统计来源标签：理由行开头标「实测」（有场次）还是「规则」 */
export function sourceLabel(build: ChampionBuildLike | null | undefined): string {
  return build?.source === 'arammeta' ? '实测·arammeta' : '实测·dtodo'
}
/** 阵容 → 装备的映射是规则（需求本身可能来自实测阵容表，见 TeamAnalysis.frontlineMeasured） */
export const COMP_REASON_PREFIX = '规则·阵容：'

interface ItemPrior {
  value: number
  games: number
  share: number
  shrunk: number
  delta: number
  coreIndex: number | null
}

/** 某个出装流派里每件装备的先验（真实统计） */
function computeBuildPriors(
  build: ChampionBuildLike,
  itemIndex: Map<number, ItemProfile>,
  mode: 'pick' | 'winrate' = 'pick',
): Map<number, ItemPrior> {
  const { games: buildGamesTotal, winRate } = buildGames(build)
  const base = winRate ?? 0.5
  const total = Math.max(1, buildGamesTotal)
  const agg = new Map<number, { games: number; wins: number; source: number }>()
  const add = (id: number, games: number, wins: number, source: number) => {
    const current = agg.get(id)
    // source：2=situational（「出了这件」的场次，最可靠），1=core/扩展累加
    if (!current || source > current.source) {
      agg.set(id, { games, wins, source })
    } else if (source === current.source && source === 1) {
      current.games += games
      current.wins += wins
    }
  }
  for (const record of build.situationalItems ?? []) {
    const id = recordIds(record)[0]
    const games = Number(record.games) || 0
    if (id && games > 0) add(id, games, Number(record.wins) || 0, 2)
  }
  const coreOrder = new Map<number, number>()
  ;(build.coreItems ?? []).forEach((record, recordIndex) => {
    const games = Number(record.games) || 0
    const wins = Number(record.wins) || (Number(record.winRate) || 0) * games
    recordIds(record).forEach((id, position) => {
      if (recordIndex === 0 && !coreOrder.has(id)) coreOrder.set(id, position)
      if (!agg.has(id) || agg.get(id)!.source < 2) add(id, games, wins, 1)
    })
  })
  for (const record of build.itemExtensions ?? []) {
    const games = Number(record.games) || 0
    const wins = Number(record.wins) || (Number(record.winRate) || 0) * games
    for (const id of recordIds(record)) {
      if (!agg.has(id) || agg.get(id)!.source < 2) add(id, games, wins, 1)
    }
  }

  const priors = new Map<number, ItemPrior>()
  for (const [id, { games, wins }] of agg) {
    const item = itemIndex.get(id)
    if (!item || !(item.completed || item.boots)) continue
    const share = Math.min(1, games / total)
    const shrunk = (wins + ENGINE_PARAMS.itemAlpha * base) / (games + ENGINE_PARAMS.itemAlpha)
    const delta = shrunk - base
    const coreIndex = coreOrder.has(id) ? coreOrder.get(id)! : null
    const value = mode === 'winrate'
      // 高胜率：胜率为主，出场率只用来排除极少出的装备（收缩已经压住小样本）
      ? ENGINE_PARAMS.winratePickWeight * Math.sqrt(share)
        + ENGINE_PARAMS.winrateWinWeight * delta * 100
        + (share < ENGINE_PARAMS.winrateMinShare ? -2 : 0)
      : ENGINE_PARAMS.priorPickWeight * Math.sqrt(share)
        + ENGINE_PARAMS.priorWinWeight * delta * 100
        + (coreIndex != null ? ENGINE_PARAMS.coreBonus[coreIndex] ?? 0 : 0)
    priors.set(id, { value, games, share, shrunk, delta, coreIndex })
  }
  return priors
}

function archetypeVector(priors: Map<number, ItemPrior>, itemIndex: Map<number, ItemProfile>) {
  const vector: Partial<Record<StatKey, number>> = {}
  const tags: Partial<Record<Mechanic, number>> = {}
  let weight = 0
  for (const [id, prior] of priors) {
    const item = itemIndex.get(id)
    if (!item || item.boots) continue
    const w = prior.share
    weight += w
    for (const [key, share] of Object.entries(item.shares) as Array<[StatKey, number]>) {
      vector[key] = (vector[key] ?? 0) + share * w
    }
    for (const tag of item.tags) tags[tag] = (tags[tag] ?? 0) + w
  }
  if (weight > 0) {
    for (const key of Object.keys(vector) as StatKey[]) vector[key] = vector[key]! / weight
    for (const tag of Object.keys(tags) as Mechanic[]) tags[tag] = tags[tag]! / weight
  }
  return { vector, tags }
}

const tankShareOf = (vector: Partial<Record<StatKey, number>>) => (vector.HP ?? 0) + (vector.ARMOR ?? 0) + (vector.MR ?? 0)
const damageShareOf = (vector: Partial<Record<StatKey, number>>, damageType: 'AP' | 'AD') => (damageType === 'AP'
  ? (vector.AP ?? 0) + (vector.MAGIC_PEN ?? 0)
  : (vector.AD ?? 0) + (vector.CRIT ?? 0) + (vector.AS ?? 0) + (vector.LETHALITY ?? 0) + (vector.ARMOR_PEN ?? 0))

export interface RouteFlex {
  canTank: boolean
  canDamage: boolean
  /** 各路线坦度（HP+双抗 占比） */
  tankShares: number[]
}

function routeFlexOf(entries: Array<{ games: number; vector: Partial<Record<StatKey, number>> }>, champGames: number): RouteFlex {
  const tankShares = entries.map((entry) => Math.round(tankShareOf(entry.vector) * 100) / 100)
  const eligible = entries
    .map((entry, index) => ({ entry, share: tankShares[index] }))
    .filter(({ entry }) => champGames <= 0 || entry.games >= champGames * ENGINE_PARAMS.compRouteMinShare)
  return {
    canTank: eligible.some(({ share }) => share >= ENGINE_PARAMS.compTankRouteShare),
    canDamage: eligible.some(({ share }) => share < 0.35) || eligible.length === 0,
    tankShares,
  }
}

/** 该英雄的数据路线里有没有肉装 / 输出路线（决定「补前排/补输出」能不能用） */
export function championRouteFlex(input: Pick<EngineInput, 'builds' | 'items'>): RouteFlex {
  const itemIndex = buildItemProfileIndex(input.items)
  const entries = (input.builds ?? []).filter((build) => build && typeof build === 'object').map((build) => {
    const priors = computeBuildPriors(build, itemIndex, 'pick')
    return { games: buildGames(build).games, vector: archetypeVector(priors, itemIndex).vector }
  })
  return routeFlexOf(entries, entries.reduce((sum, entry) => sum + entry.games, 0))
}

interface CompPart {
  need: keyof TeamNeeds
  value: number
  reason: string
}

function compPartsFor(
  item: ItemProfile,
  team: TeamAnalysis,
  ctx: { damageType: 'AP' | 'AD'; chosenTank: number; flex: RouteFlex },
): CompPart[] {
  const { needs, enemy } = team
  const s = item.shares
  const parts: CompPart[] = []
  const push = (need: keyof TeamNeeds, value: number, reason: string) => {
    if (Math.abs(value) >= 0.05) parts.push({ need, value, reason })
  }
  // 脆皮拿抗性的收益低一些（但仍然有用）
  const resistScale = ctx.chosenTank >= 0.3 ? 1 : 0.7
  if (needs.mr > 0 && (s.MR ?? 0) > 0) push('mr', needs.mr * (s.MR ?? 0) * ENGINE_PARAMS.compResistWeight * resistScale, `对面法伤 ${pct(enemy.ap)} → 魔抗`)
  if (needs.armor > 0 && (s.ARMOR ?? 0) > 0) push('armor', needs.armor * (s.ARMOR ?? 0) * ENGINE_PARAMS.compResistWeight * resistScale, `对面物伤 ${pct(enemy.ad)} → 护甲`)
  if (needs.antiHeal > 0 && item.tags.includes('anti-heal')) {
    push('antiHeal', needs.antiHeal * ENGINE_PARAMS.compAntiHealWeight, enemy.healers ? `对面 ${enemy.healers} 个回复英雄 → 重伤` : '对面续航多 → 重伤')
  }
  if (needs.antiShield > 0 && COMP_ITEMS.antiShield.has(item.id)) {
    push('antiShield', needs.antiShield * ENGINE_PARAMS.compAntiShieldWeight * COMP_ITEMS.antiShield.get(item.id)!, `对面 ${enemy.shielders} 个护盾英雄 → 破盾`)
  }
  if (needs.penetration > 0) {
    let value = 0
    if (ctx.damageType === 'AD') {
      value += (s.ARMOR_PEN ?? 0) * ENGINE_PARAMS.compPenetrationWeight
      value += (item.tags.includes('max-hp-damage') ? 0.6 : 0) + (COMP_ITEMS.antiTankAD.get(item.id) ?? 0) * 0.8
      value -= (s.LETHALITY ?? 0) * 2
    } else {
      value += (s.MAGIC_PEN ?? 0) * ENGINE_PARAMS.compPenetrationWeight + (COMP_ITEMS.antiTankAP.get(item.id) ?? 0)
    }
    push('penetration', needs.penetration * value, value >= 0 ? `对面 ${enemy.frontliners} 个前排 → 穿透/百分比伤害` : `对面 ${enemy.frontliners} 个前排 → 穿甲（固穿）收益低`)
  }
  if (needs.tenacity > 0 && COMP_ITEMS.tenacity.has(item.id)) {
    push('tenacity', needs.tenacity * ENGINE_PARAMS.compTenacityWeight * COMP_ITEMS.tenacity.get(item.id)!, '对面控制多 → 韧性/解控')
  }
  if (needs.stasis > 0 && COMP_ITEMS.stasis.has(item.id)) {
    // 只给对应伤害类型的保命装（法系中娅/女妖，物理守护天使/夜刃）
    const ap = (s.AP ?? 0) > 0.3
    const fits = (ctx.damageType === 'AP') === ap || ctx.chosenTank >= 0.4
    if (fits) push('stasis', needs.stasis * ENGINE_PARAMS.compStasisWeight * COMP_ITEMS.stasis.get(item.id)!, `对面 ${enemy.assassins || '多'} 个刺客/爆发 → 保命`)
  }
  if (needs.frontline > 0 && ctx.flex.canTank && !item.boots) {
    const tank = (s.HP ?? 0) + (s.ARMOR ?? 0) + (s.MR ?? 0)
    const scale = ctx.chosenTank >= 0.35 ? 1 : 0.5
    push('frontline', needs.frontline * (tank + (item.tags.includes('tank') ? 0.3 : 0)) * ENGINE_PARAMS.compFrontlineWeight * scale, team.frontlineMeasured ? '我方缺前排（实测阵容表）→ 坦度' : '我方缺前排 → 坦度')
  }
  if (needs.damage > 0 && ctx.flex.canDamage && !item.boots) {
    push('damage', needs.damage * damageShareOf(s, ctx.damageType) * ENGINE_PARAMS.compDamageWeight, '我方缺输出 → 输出属性')
  }
  return parts
}

const capComp = (value: number) => Math.max(ENGINE_PARAMS.compFloor, Math.min(ENGINE_PARAMS.compCap, value))

function damageTypeOf(vector: Partial<Record<StatKey, number>>): 'AP' | 'AD' {
  const ap = vector.AP ?? 0
  const ad = (vector.AD ?? 0) + (vector.CRIT ?? 0) + (vector.AS ?? 0) + (vector.LETHALITY ?? 0)
  return ap > ad ? 'AP' : 'AD'
}

/** 某属性对该英雄（当前流派 + 海克斯）有多大用处，0~1 */
function statUsefulness(key: StatKey, vector: Partial<Record<StatKey, number>>, weights: Partial<Record<StatKey, number>>): number {
  if ((weights[key] ?? 0) > 0.2) return 1
  if ((vector[key] ?? 0) >= 0.04) return 1
  switch (key) {
    case 'HP': case 'ARMOR': case 'MR': return 0.7
    case 'HASTE': return 0.8
    case 'MS': return 0.6
    case 'MANA': return (vector.MANA ?? 0) > 0.01 ? 0.8 : 0.2
    case 'LIFESTEAL': case 'OMNIVAMP': return 0.5
    case 'HSP': return 0.4
    default: return 0
  }
}

function mapAdaptive(weights: WeightMap, damageType: 'AP' | 'AD'): Partial<Record<StatKey, number>> {
  const mapped: Partial<Record<StatKey, number>> = {}
  for (const [key, value] of Object.entries(weights) as Array<[WeightKey, number]>) {
    const target: StatKey = key === 'ADAPTIVE' ? damageType : key
    mapped[target] = (mapped[target] ?? 0) + value
  }
  return mapped
}

function augmentScale(profile: AugmentProfile): number {
  // 人工复核的按 1 计；自动解析的按可信度打折
  return profile.source === 'reviewed' ? 1 : Math.max(0.2, profile.confidence)
}

export interface AugmentItemSynergy {
  value: number
  reason: string | null
}

/** 单个海克斯对单件装备的协同分（正负皆可）与一句话原因 */
export function augmentItemSynergy(profile: AugmentProfile, item: ItemProfile, damageType: 'AP' | 'AD'): AugmentItemSynergy {
  const scale = augmentScale(profile)
  const weights = mapAdaptive(profile.weights, damageType)
  let statValue = 0
  let topStat: { key: StatKey; contribution: number } | null = null
  for (const [key, weight] of Object.entries(weights) as Array<[StatKey, number]>) {
    const share = item.shares[key] ?? 0
    if (!share) continue
    const contribution = weight * share * ENGINE_PARAMS.statSynergy * scale
    statValue += contribution
    if (!topStat || Math.abs(contribution) > Math.abs(topStat.contribution)) topStat = { key, contribution }
  }
  let mechanicValue = 0
  let topMechanic: { mechanic: Mechanic; tag: Mechanic; contribution: number } | null = null
  for (const mechanic of profile.mechanics) {
    for (const [tag, factor] of MECHANIC_ITEM_MATCH[mechanic] ?? []) {
      if (!item.tags.includes(tag)) continue
      const contribution = factor * ENGINE_PARAMS.mechanicSynergy * scale
      mechanicValue += contribution
      if (!topMechanic || contribution > topMechanic.contribution) topMechanic = { mechanic, tag, contribution }
      break
    }
  }
  let antiValue = 0
  for (const mechanic of profile.antiMechanics ?? []) {
    if (item.tags.includes(mechanic)) antiValue -= ENGINE_PARAMS.antiMechanicPenalty
  }
  const boost = profile.itemIds.includes(item.id) ? profile.itemBoost : 0
  const capped = Math.max(-ENGINE_PARAMS.synergyCap, Math.min(ENGINE_PARAMS.synergyCap, statValue + mechanicValue))
  const value = capped + antiValue + boost

  let reason: string | null = null
  if (boost > 0) {
    reason = profile.itemBoost >= 4 ? `直接强化「${item.name}」` : `描述点名「${item.name}」`
  } else if (antiValue < 0) {
    reason = `与「${MECHANIC_LABELS[profile.antiMechanics[0]]}」冲突`
  } else if (topMechanic && (!topStat || topMechanic.contribution >= Math.abs(topStat.contribution))) {
    reason = `${MECHANIC_LABELS[topMechanic.mechanic]}协同（本装带${MECHANIC_LABELS[topMechanic.tag]}）`
  } else if (topStat) {
    const share = Math.round((item.shares[topStat.key] ?? 0) * 100)
    reason = topStat.contribution >= 0
      ? `放大${STAT_LABELS[topStat.key]}（本装 ${share}% 价值是${STAT_LABELS[topStat.key]}）`
      : `已给大量${STAT_LABELS[topStat.key]}，本装 ${share}% 价值重复`
  }
  return { value, reason }
}

function recipeGold(item: ItemProfile, owned: Set<number>, itemIndex: Map<number, ItemProfile>, depth = 0): { gold: number; names: string[] } {
  if (depth > 3) return { gold: 0, names: [] }
  let gold = 0
  const names: string[] = []
  const pool = new Set(owned)
  for (const componentId of item.from) {
    const component = itemIndex.get(componentId)
    if (!component) continue
    if (pool.has(componentId)) {
      pool.delete(componentId)
      gold += component.priceTotal
      names.push(component.name)
    } else {
      const nested = recipeGold(component, pool, itemIndex, depth + 1)
      gold += nested.gold
      names.push(...nested.names)
    }
  }
  return { gold, names }
}

export interface EnemySummary {
  apItems: number
  adItems: number
  healItems: number
  dominant: 'AP' | 'AD' | null
}

export function summarizeEnemyItems(enemyItemIds: Array<number | string>, itemIndex: Map<number, ItemProfile>): EnemySummary {
  let apItems = 0
  let adItems = 0
  let healItems = 0
  for (const id of ids(enemyItemIds)) {
    const item = itemIndex.get(id)
    if (!item || !(item.completed || item.boots) || item.boots) continue
    const ap = item.shares.AP ?? 0
    const ad = (item.shares.AD ?? 0) + (item.shares.CRIT ?? 0) + (item.shares.AS ?? 0) + (item.shares.LETHALITY ?? 0)
    if (ap >= 0.3 && ap >= ad) apItems += 1
    else if (ad >= 0.3) adItems += 1
    if ((item.shares.LIFESTEAL ?? 0) + (item.shares.OMNIVAMP ?? 0) + (item.shares.HSP ?? 0) >= 0.12) healItems += 1
  }
  const total = apItems + adItems
  let dominant: EnemySummary['dominant'] = null
  if (total >= 4) {
    if (apItems / total >= 0.65) dominant = 'AP'
    else if (adItems / total >= 0.65) dominant = 'AD'
  }
  return { apItems, adItems, healItems, dominant }
}

interface Candidate {
  item: ItemProfile
  prior: ItemPrior | null
  priorValue: number
  priorReason: string
  synergy: number
  synergyReasons: Array<{ augment: string; value: number; reason: string }>
  /** 每个海克斯的协同（用于组装时的边际递减） */
  perAugment: Array<{ index: number; value: number }>
  fit: number
  fitReason: string | null
  progress: number
  progressNames: string[]
  enemy: number
  enemyReason: string | null
  /** 阵容项（已封顶）与分项 */
  comp: number
  compParts: CompPart[]
  total: number
  /** 组装时（考虑边际递减后）的分数 */
  effective?: number
  compEffective?: number
  pairEffective?: number
  pairReason?: string | null
}

// ---------------------------------------------------------------------------
// 主流程

function runOnce(input: EngineInput, augments: AugmentProfile[], itemIndex: Map<number, ItemProfile>): Omit<EngineResult, 'removed'> & { candidates: Map<number, Candidate> } {
  const builds = (input.builds ?? []).filter((build) => build && typeof build === 'object')
  const slots = input.slots ?? 6
  const owned = ids(input.ownedItemIds ?? [])
  const ownedSet = new Set(owned)
  const notes: string[] = []

  // 1) 汇总海克斯
  const weights: WeightMap = {}
  const mechanics = new Set<Mechanic>()
  for (const augment of augments) {
    const scale = augmentScale(augment)
    for (const [key, value] of Object.entries(augment.weights) as Array<[WeightKey, number]>) {
      weights[key] = Math.round(((weights[key] ?? 0) + value * scale) * 100) / 100
    }
    augment.mechanics.forEach((mechanic) => mechanics.add(mechanic))
  }

  // 2) 流派（真实统计）+ 海克斯倾向 → 选流派
  const perBuild = builds.map((build, index) => {
    const priors = computeBuildPriors(build, itemIndex, input.priorMode ?? 'pick')
    const { vector, tags } = archetypeVector(priors, itemIndex)
    return { build, index, priors, vector, tags, ...buildGames(build), label: buildLabel(build, index) }
  })
  const maxGames = Math.max(1, ...perBuild.map((entry) => entry.games))
  const champGames = perBuild.reduce((sum, entry) => sum + entry.games, 0)
  const champWins = perBuild.reduce((sum, entry) => sum + entry.wins, 0)
  const champBase = champGames > 0 ? champWins / champGames : 0.5
  const team = input.team ?? null
  const flex = routeFlexOf(perBuild, champGames)
  const routeLean = team && flex.canTank && flex.canDamage ? team.needs.frontline - team.needs.damage : 0
  const eligibleTank = perBuild.filter((entry) => champGames <= 0 || entry.games >= champGames * ENGINE_PARAMS.compRouteMinShare)
  const meanTank = eligibleTank.length ? eligibleTank.reduce((sum, entry) => sum + tankShareOf(entry.vector), 0) / eligibleTank.length : 0

  const archetypes: ArchetypeChoice[] = perBuild.map((entry) => {
    const damageType = damageTypeOf(entry.vector)
    const mapped = mapAdaptive(weights, damageType)
    const pickTerm = ENGINE_PARAMS.archetypePickWeight * Math.log(Math.max(entry.games, 1) / maxGames)
    const shrunk = (entry.wins + ENGINE_PARAMS.buildAlpha * champBase) / (entry.games + ENGINE_PARAMS.buildAlpha)
    const winTerm = ENGINE_PARAMS.archetypeWinWeight * (shrunk - champBase) * 100
    let statTerm = 0
    for (const [key, weight] of Object.entries(mapped) as Array<[StatKey, number]>) {
      statTerm += weight * (entry.vector[key] ?? 0) * ENGINE_PARAMS.archetypeStatWeight
    }
    let mechanicTerm = 0
    for (const mechanic of mechanics) {
      for (const [tag, factor] of MECHANIC_ITEM_MATCH[mechanic] ?? []) {
        mechanicTerm += (entry.tags[tag] ?? 0) * factor * ENGINE_PARAMS.archetypeMechanicWeight
      }
    }
    const teamTerm = routeLean !== 0 && (champGames <= 0 || entry.games >= champGames * ENGINE_PARAMS.compRouteMinShare)
      ? ENGINE_PARAMS.compRouteWeight * routeLean * (tankShareOf(entry.vector) - meanTank)
      : 0
    const reasons = [`${sourceLabel(entry.build)}：${entry.games} 场，收缩胜率 ${pct(shrunk)}`]
    if (Math.abs(statTerm + mechanicTerm) >= 0.3) reasons.push(`规则：海克斯倾向 ${signed(statTerm + mechanicTerm)}`)
    if (Math.abs(teamTerm) >= 0.3) reasons.push(`${team?.frontlineMeasured ? '实测阵容表' : '规则'}：阵容${routeLean > 0 ? '缺前排' : '缺输出'} ${signed(teamTerm)}`)
    return {
      index: entry.index,
      label: entry.label,
      games: entry.games,
      winRate: entry.winRate,
      score: pickTerm + winTerm + statTerm + mechanicTerm + teamTerm,
      baselineIndex: entry.index,
      reasons,
    }
  })
  const ranked = [...archetypes].sort((a, b) => b.score - a.score)
  let archetype = ranked[0] ?? null
  const mode = input.archetype ?? 'auto'
  if (mode === 'popular') {
    archetype = [...archetypes].sort((a, b) => b.games - a.games)[0] ?? archetype
  } else if (mode === 'winrate') {
    const minGames = Math.max(ENGINE_PARAMS.winrateRouteMinGames, champGames * ENGINE_PARAMS.winrateRouteMinShare)
    const shrunkOf = (entry: ArchetypeChoice) => {
      const build = perBuild[entry.index]
      return (build.wins + ENGINE_PARAMS.buildAlpha * champBase) / (build.games + ENGINE_PARAMS.buildAlpha)
    }
    archetype = archetypes
      .filter((entry) => entry.games >= minGames)
      .sort((a, b) => shrunkOf(b) - shrunkOf(a))[0] ?? archetype
  } else if (typeof mode === 'number') {
    archetype = archetypes.find((entry) => entry.index === mode) ?? archetype
  }
  const chosen = archetype ? perBuild[archetype.index] : null
  const damageType = chosen ? damageTypeOf(chosen.vector) : 'AD'
  const mappedWeights = mapAdaptive(weights, damageType)

  if (!chosen) notes.push('该英雄没有出装统计，只能按海克斯与通用装备推荐')

  // 3) 候选装备
  const enemy = summarizeEnemyItems(input.enemyItemIds ?? [], itemIndex)
  const candidates = new Map<number, Candidate>()
  const candidateIds = new Set<number>()
  for (const entry of perBuild) for (const id of entry.priors.keys()) candidateIds.add(id)
  for (const augment of augments) for (const id of augment.itemIds) candidateIds.add(id)
  for (const [id, item] of itemIndex) if (item.completed && !item.boots) candidateIds.add(id)
  for (const id of owned) candidateIds.add(id)

  for (const id of candidateIds) {
    const item = itemIndex.get(id)
    if (!item || !(item.completed || item.boots)) continue
    // 先验：当前流派 > 其他流派（打折）> 没出现过
    let prior: ItemPrior | null = chosen?.priors.get(id) ?? null
    let priorValue: number
    let priorReason: string
    const archetypeName = chosen ? localizeArchetype(chosen.label) : ''
    if (prior) {
      priorValue = prior.value
      priorReason = `${sourceLabel(chosen!.build)}（n=${prior.games}）：${archetypeName}流派 ${pct(prior.share)} 场出这件，收缩胜率 ${pct(prior.shrunk)}（${signed(prior.delta * 100)}%）`
    } else {
      const other = perBuild
        .filter((entry) => entry !== chosen && entry.priors.has(id))
        .map((entry) => ({ entry, prior: entry.priors.get(id)! }))
        .sort((a, b) => b.prior.value - a.prior.value)[0]
      if (other) {
        prior = other.prior
        // 高胜率方案只看所选路线自己的统计：别的路线的装备罚得更重
        priorValue = other.prior.value - (input.priorMode === 'winrate' ? ENGINE_PARAMS.winrateOffRoutePenalty : ENGINE_PARAMS.offArchetypePenalty)
        priorReason = `${sourceLabel(other.entry.build)}（n=${other.prior.games}）：${localizeArchetype(other.entry.label)}流派 ${pct(other.prior.share)} 场出（非当前流派，打折）`
      } else {
        priorValue = ENGINE_PARAMS.unseenPrior - (input.priorMode === 'winrate' ? 1.5 : 0)
        priorReason = '规则：该英雄统计里很少出现（纯模型推荐）'
      }
    }

    let synergy = 0
    const synergyReasons: Candidate['synergyReasons'] = []
    const perAugment: Candidate['perAugment'] = []
    augments.forEach((augment, augmentIndex) => {
      const result = augmentItemSynergy(augment, item, damageType)
      if (Math.abs(result.value) < 0.05) return
      synergy += result.value
      perAugment.push({ index: augmentIndex, value: result.value })
      if (result.reason && Math.abs(result.value) >= 0.3) {
        synergyReasons.push({ augment: augment.name, value: result.value, reason: result.reason })
      }
    })

    // 对本英雄没用的属性（例如法师身上的攻速/暴击，除非海克斯让它变得有用）
    let fit = 0
    let fitReason: string | null = null
    if (!item.boots && chosen) {
      let useful = 0
      for (const [key, share] of Object.entries(item.shares) as Array<[StatKey, number]>) {
        useful += share * statUsefulness(key, chosen.vector, mappedWeights)
      }
      if (useful < 0.75) {
        fit = -ENGINE_PARAMS.uselessStatPenalty * (0.75 - useful) / 0.75
        const wasted = (Object.entries(item.shares) as Array<[StatKey, number]>)
          .filter(([key]) => statUsefulness(key, chosen.vector, mappedWeights) < 0.5)
          .sort((a, b) => b[1] - a[1])
          .map(([key]) => STAT_LABELS[key])
        if (wasted.length && fit <= -0.3) fitReason = `本英雄用不上${wasted.slice(0, 2).join('/')}`
      }
    }

    let progress = 0
    let progressNames: string[] = []
    if (!ownedSet.has(id) && owned.length) {
      const { gold, names } = recipeGold(item, ownedSet, itemIndex)
      if (gold > 0 && item.priceTotal > 0) {
        progress = ENGINE_PARAMS.progressWeight * Math.min(1, gold / item.priceTotal) * 2
        progressNames = names
      }
    }

    let enemyValue = 0
    let enemyReason: string | null = null
    const compParts = team ? compPartsFor(item, team, { damageType, chosenTank: chosen ? tankShareOf(chosen.vector) : 0, flex }) : []
    const comp = capComp(compParts.reduce((sum, part) => sum + part.value, 0))
    if (team) {
      // 阵容分析已经混合了敌方装备：不再重复算「敌方装备」项
    } else if (enemy.dominant === 'AP' && (item.shares.MR ?? 0) > 0) {
      enemyValue = ENGINE_PARAMS.enemyResistWeight * (item.shares.MR ?? 0)
      enemyReason = `敌方 ${enemy.apItems}/${enemy.apItems + enemy.adItems} 件法强装 → 魔抗`
    } else if (enemy.dominant === 'AD' && (item.shares.ARMOR ?? 0) > 0) {
      enemyValue = ENGINE_PARAMS.enemyResistWeight * (item.shares.ARMOR ?? 0)
      enemyReason = `敌方 ${enemy.adItems}/${enemy.apItems + enemy.adItems} 件物理装 → 护甲`
    }
    if (!team && enemy.healItems >= 3 && item.tags.includes('anti-heal')) {
      enemyValue += ENGINE_PARAMS.antiHealBonus
      enemyReason = `${enemyReason ? `${enemyReason}；` : ''}敌方 ${enemy.healItems} 件续航装 → 重伤`
    }

    const total = priorValue + synergy + fit + progress + enemyValue + comp
    candidates.set(id, {
      item, prior, priorValue, priorReason, synergy, synergyReasons, perAugment, fit, fitReason, progress, progressNames, enemy: enemyValue, enemyReason, comp, compParts, total,
    })
  }

  // 4) 组 6 件：已有装备先占位，然后贪心（一双鞋、唯一被动不重复、反重伤只拿一件）
  const chosenIds: number[] = []
  const usedPassives = new Set<string>()
  let hasBoots = false
  let hasAntiHealBonus = false
  const augmentUses = augments.map(() => 0)
  const needUses = new Map<keyof TeamNeeds, number>()
  const effectiveComp = (candidate: Candidate) => {
    let value = 0
    for (const part of candidate.compParts) {
      const uses = needUses.get(part.need) ?? 0
      if (part.value <= 0) value += part.value
      else if (COMP_SINGLE_NEEDS.has(part.need)) value += uses > 0 ? 0 : part.value
      // 鞋只和鞋比，不受其他格已满足的需求影响
      else if (candidate.item.boots) value += part.value
      else value += part.value * (part.need === 'frontline' || part.need === 'damage' ? ENGINE_PARAMS.compGeneralDecay : ENGINE_PARAMS.compResistDecay) ** uses
    }
    return capComp(value)
  }
  // 实测组合：与已选装备同出的「组合效应」= 组合提升（收缩）− 两件单件提升的平均
  const singleLift = new Map<number, number>()
  for (const single of input.itemSingles ?? []) {
    if (single.ids.length === 1 && single.g > 0) singleLift.set(single.ids[0], single.lift * single.g / (single.g + ENGINE_PARAMS.pairAlpha))
  }
  const pairInfo = new Map<string, { interaction: number; g: number; wr: number }>()
  for (const pair of input.itemPairs ?? []) {
    if (pair.ids.length !== 2 || pair.g < ENGINE_PARAMS.pairMinGames) continue
    const shrunkLift = pair.lift * pair.g / (pair.g + ENGINE_PARAMS.pairAlpha)
    const singles = pair.ids.map((id) => singleLift.get(id)).filter((value): value is number => value != null)
    const interaction = singles.length ? shrunkLift - singles.reduce((a, b) => a + b, 0) / singles.length : shrunkLift * 0.5
    pairInfo.set([...pair.ids].sort((a, b) => a - b).join('-'), { interaction, g: pair.g, wr: pair.wr })
  }
  const pairTerm = (candidate: Candidate): { value: number; reason: string | null } => {
    if (!pairInfo.size) return { value: 0, reason: null }
    let value = 0
    let best: { abs: number; text: string } | null = null
    for (const id of chosenIds) {
      const info = pairInfo.get([id, candidate.item.id].sort((a, b) => a - b).join('-'))
      if (!info) continue
      const part = info.interaction * 100 * ENGINE_PARAMS.pairWeight
      value += part
      if (!best || Math.abs(part) > best.abs) {
        best = { abs: Math.abs(part), text: `实测·arammeta（n=${info.g}）：与「${itemIndex.get(id)?.name ?? id}」同出胜率 ${pct(info.wr)}，组合效应 ${signed(info.interaction * 100)}%（${signed(part)}）` }
      }
    }
    value = Math.max(-ENGINE_PARAMS.pairCap, Math.min(ENGINE_PARAMS.pairCap, value))
    return { value, reason: best && best.abs >= 0.1 ? best.text : null }
  }
  const effectiveTotal = (candidate: Candidate) => {
    let synergy = 0
    for (const { index, value } of candidate.perAugment) {
      synergy += value > 0 ? value * ENGINE_PARAMS.synergyDecay ** augmentUses[index] : value
    }
    return candidate.total - candidate.synergy + synergy - candidate.comp + effectiveComp(candidate) + pairTerm(candidate).value
  }
  const accept = (candidate: Candidate) => {
    // 先按「放进去之前」的状态算有效分，再登记
    const pair = pairTerm(candidate)
    candidate.effective = effectiveTotal(candidate)
    chosenIds.push(candidate.item.id)
    candidate.pairEffective = pair.value
    candidate.pairReason = pair.reason
    candidate.compEffective = effectiveComp(candidate)
    for (const part of candidate.compParts) {
      if (part.value >= 0.6) needUses.set(part.need, (needUses.get(part.need) ?? 0) + 1)
    }
    for (const { index, value } of candidate.perAugment) {
      // 只有明显受益（≥1 分）才算「用掉」这个海克斯的一份协同
      if (value >= 1) augmentUses[index] += 1
    }
    candidate.item.uniquePassives.forEach((name) => usedPassives.add(name))
    if (candidate.item.boots) hasBoots = true
    if (candidate.item.tags.includes('anti-heal')) hasAntiHealBonus = true
  }
  for (const id of owned) {
    const candidate = candidates.get(id)
    if (candidate && !chosenIds.includes(id) && chosenIds.length < slots) accept(candidate)
  }
  // 该流派里鞋子出场率 → 是否需要鞋
  // 该流派核心三件里带鞋的场次占比 → 是否需要鞋
  let bootsShare = 0.7
  if (chosen && typeof chosen.build.bootsShare === 'number') {
    // 数据源直接给了出鞋比例（arammeta：该英雄各鞋子的出场率之和）
    bootsShare = chosen.build.bootsShare
  } else if (chosen) {
    let coreGames = 0
    let bootsGames = 0
    for (const record of chosen.build.coreItems ?? []) {
      const games = Number(record.games) || 0
      coreGames += games
      if (recordIds(record).some((id) => itemIndex.get(id)?.boots)) bootsGames += games
    }
    bootsShare = coreGames > 0
      ? bootsGames / coreGames
      : [...chosen.priors.entries()].filter(([id]) => itemIndex.get(id)?.boots).reduce((sum, [, prior]) => sum + prior.share, 0)
  }
  const bootsCoreIndex = chosen
    ? [...chosen.priors.entries()].find(([id, prior]) => itemIndex.get(id)?.boots && prior.coreIndex != null)?.[1].coreIndex ?? null
    : null
  const wantsBoots = bootsShare >= 0.4 || augments.some((augment) => augment.mechanics.includes('boots'))

  while (chosenIds.length < slots) {
    const ordered = [...candidates.values()].sort((a, b) => effectiveTotal(b) - effectiveTotal(a))
    const next = ordered.find((candidate) => {
      if (chosenIds.includes(candidate.item.id)) return false
      if (candidate.item.boots && (hasBoots || !wantsBoots)) return false
      if (candidate.item.uniquePassives.some((name) => usedPassives.has(name))) return false
      if (hasAntiHealBonus && candidate.item.tags.includes('anti-heal') && candidate.enemyReason?.includes('重伤')) return false
      // 还没有鞋且只剩一个格子：留给鞋
      if (wantsBoots && !hasBoots && !candidate.item.boots && chosenIds.length === slots - 1) return false
      return true
    })
    if (!next) break
    accept(next)
  }

  // 5) 购买顺序：已有在前；其余按「分数 + 核心位置」排，鞋子放在数据里的典型位置
  const orderKey = (id: number) => {
    const candidate = candidates.get(id)!
    const coreIndex = candidate.prior?.coreIndex
    return (candidate.effective ?? candidate.total) + (coreIndex != null ? 1.5 - coreIndex * 0.5 : 0)
  }
  const ownedPart = chosenIds.filter((id) => ownedSet.has(id))
  const rest = chosenIds.filter((id) => !ownedSet.has(id) && !itemIndex.get(id)?.boots).sort((a, b) => orderKey(b) - orderKey(a))
  const bootsId = chosenIds.find((id) => !ownedSet.has(id) && itemIndex.get(id)?.boots)
  if (bootsId != null) {
    // 鞋子放在数据里的典型位置（核心三件里的位置），没有数据时放第 2 件
    const typical = Math.min(rest.length, candidates.get(bootsId)?.prior?.coreIndex ?? bootsCoreIndex ?? 1)
    rest.splice(Math.max(0, typical - ownedPart.length), 0, bootsId)
  }
  const order = [...ownedPart, ...rest]

  // 6) 用户换装：原位替换（保持格位），只接受同为鞋/非鞋、不与其他格唯一被动冲突的
  const swappedFrom = new Map<number, number>()
  const passivesExcept = (index: number) => {
    const used = new Set<string>()
    order.forEach((id, position) => {
      if (position !== index) itemIndex.get(id)?.uniquePassives.forEach((name) => used.add(name))
    })
    return used
  }
  for (const swap of input.swaps ?? []) {
    const from = toId(swap?.from)
    const to = toId(swap?.to)
    if (from == null || to == null || from === to) continue
    const index = order.indexOf(from)
    const target = candidates.get(to)
    if (index < 0 || !target || order.includes(to) || ownedSet.has(from)) continue
    if (target.item.boots !== Boolean(itemIndex.get(from)?.boots)) continue
    const used = passivesExcept(index)
    if (target.item.uniquePassives.some((name) => used.has(name))) continue
    order[index] = to
    target.effective = effectiveTotal(target)
    swappedFrom.set(to, from)
  }

  const alternativesFor = (index: number): ItemAlternative[] => {
    const current = candidates.get(order[index])!
    const currentTotal = current.effective ?? current.total
    const used = passivesExcept(index)
    const boots = current.item.boots
    const original = swappedFrom.get(order[index])
    const ranked = [...candidates.values()]
      .filter((candidate) => !order.includes(candidate.item.id)
        && candidate.item.boots === boots
        && !candidate.item.uniquePassives.some((name) => used.has(name)))
      .map((candidate) => ({ candidate, total: effectiveTotal(candidate) }))
      .sort((a, b) => b.total - a.total)
    // 换过的格：原推荐永远排第一，方便换回
    if (original != null) {
      const position = ranked.findIndex((entry) => entry.candidate.item.id === original)
      if (position > 0) ranked.unshift(...ranked.splice(position, 1))
    }
    return ranked
      .slice(0, ENGINE_PARAMS.alternativesPerSlot)
      .map(({ candidate, total }) => {
        const synergy = [...candidate.synergyReasons].sort((a, b) => b.value - a.value)[0]
        const compPart = [...candidate.compParts].sort((a, b) => b.value - a.value)[0]
        let reason = candidate.priorReason
        if (compPart && compPart.value >= 0.8 && (!synergy || compPart.value > synergy.value)) reason = `${COMP_REASON_PREFIX}${compPart.reason}`
        else if (synergy && synergy.value > 0) reason = `规则：「${synergy.augment}」${synergy.reason}`
        return {
          itemId: candidate.item.id,
          name: candidate.item.name,
          total: round1(total),
          delta: round1(total - currentTotal),
          reason,
        }
      })
  }

  const plannedItemIds = order
  const items: EngineItem[] = order.map((id, index) => {
    const candidate = candidates.get(id)!
    const reasons = [candidate.priorReason]
    const originalId = swappedFrom.get(id)
    if (originalId != null) reasons.unshift(`你手动换上（原推荐：${itemIndex.get(originalId)?.name ?? originalId}）`)
    const sortedSynergy = [...candidate.synergyReasons].sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    for (const entry of sortedSynergy.slice(0, 3)) {
      reasons.push(`规则：「${entry.augment}」${entry.reason}（${signed(entry.value)}）`)
    }
    if (candidate.fitReason) reasons.push(`规则：${candidate.fitReason}（${signed(candidate.fit)}）`)
    if (candidate.pairReason) reasons.push(candidate.pairReason)
    if (candidate.progressNames.length) reasons.push(`实时：已有组件 ${candidate.progressNames.join('、')}（${signed(candidate.progress)}）`)
    if (candidate.enemyReason) reasons.push(`规则：${candidate.enemyReason}（${signed(candidate.enemy)}）`)
    const compValue = candidate.compEffective ?? candidate.comp
    for (const part of [...candidate.compParts].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 2)) {
      if (Math.abs(part.value) >= 0.3) reasons.push(`${COMP_REASON_PREFIX}${part.reason}（${signed(part.value)}）`)
    }
    if (candidate.compParts.length && Math.abs(compValue - candidate.compParts.reduce((sum, part) => sum + part.value, 0)) >= 0.3) {
      reasons.push(`规则：阵容项合计 ${signed(compValue)}（同类需求已有装备满足 / 封顶）`)
    }
    return {
      itemId: id,
      name: candidate.item.name,
      score: {
        prior: round1(candidate.priorValue),
        // 有效海克斯分（含同一海克斯多件装备的边际递减）
        synergy: round1((candidate.effective ?? candidate.total) - candidate.priorValue - candidate.progress - candidate.enemy - compValue - (candidate.pairEffective ?? 0)),
        progress: round1(candidate.progress),
        enemy: round1(candidate.enemy),
        comp: round1(compValue),
        pair: round1(candidate.pairEffective ?? 0),
        total: round1(candidate.effective ?? candidate.total),
      },
      reasons,
      owned: ownedSet.has(id),
      isNext: false,
      boots: candidate.item.boots,
      change: null,
      baselineIndex: null,
      drivers: sortedSynergy.filter((entry) => entry.value > 0).map((entry) => entry.augment),
      alternatives: alternativesFor(index),
      swappedFrom: originalId ?? null,
      priorGames: candidate.prior && chosen?.priors.get(id) === candidate.prior ? candidate.prior.games : null,
      priorWinRate: candidate.prior && chosen?.priors.get(id) === candidate.prior ? round3(candidate.prior.shrunk) : null,
    }
  })

  // 下一件：第一件没拥有的；如果前两件里有已经攒了组件的，优先它
  const pending = items.filter((item) => !item.owned)
  const withProgress = pending.slice(0, 2).find((item) => item.score.progress > 0)
  const next = withProgress ?? pending[0] ?? null
  if (next) next.isNext = true

  const archetypeVectorValue = chosen?.vector ?? {}
  return {
    archetype,
    archetypes: ranked,
    items,
    nextItemId: next?.itemId ?? null,
    weights,
    mechanics: [...mechanics],
    damageType,
    notes,
    candidates,
    context: {
      itemIndex,
      archetypeVector: archetypeVectorValue,
      archetypeTags: chosen?.tags ?? {},
      damageType,
      plannedItemIds,
      ownedItemIds: owned,
      team: team ? { needs: team.needs, canTank: flex.canTank, canDamage: flex.canDamage } : null,
    },
    team: team ? { needs: team.needs, canTank: flex.canTank, canDamage: flex.canDamage, routeNote: null, added: [], removed: [] } : null,
    contributions: {
      augment: round1(items.reduce((sum, item) => sum + item.score.synergy, 0)),
      comp: round1(items.reduce((sum, item) => sum + item.score.comp, 0)),
    },
  }
}

export function recommendBuild(input: EngineInput): EngineResult {
  const itemIndex = buildItemProfileIndex(input.items)
  const augments = (input.augments ?? []).filter(Boolean).map((augment) => toAugmentProfile(augment, itemIndex))
  const result = runOnce(input, augments, itemIndex)
  const removed: EngineResult['removed'] = []

  if (augments.length && input.compareBaseline !== false) {
    const baseline = runOnce({ ...input, augments: [], swaps: [] }, [], itemIndex)
    const baselineOrder = baseline.items.map((item) => item.itemId)
    for (const [index, item] of result.items.entries()) {
      const baselineIndex = baselineOrder.indexOf(item.itemId)
      item.baselineIndex = baselineIndex >= 0 ? baselineIndex : null
      item.change = baselineIndex < 0 ? 'new' : baselineIndex > index ? 'up' : baselineIndex < index ? 'down' : 'same'
    }
    for (const id of baselineOrder) {
      if (result.items.some((item) => item.itemId === id)) continue
      const candidate = result.candidates.get(id)
      const item = itemIndex.get(id)
      if (!item) continue
      const negative = candidate?.synergyReasons.filter((entry) => entry.value < 0) ?? []
      const reason = negative.length
        ? `「${negative[0].augment}」${negative[0].reason}`
        : '被更契合当前海克斯的装备挤掉'
      removed.push({ itemId: id, name: item.name, reason })
    }
    if (result.archetype && baseline.archetype && result.archetype.index !== baseline.archetype.index) {
      result.notes.unshift(`流派从「${localizeArchetype(baseline.archetype.label)}」切换到「${localizeArchetype(result.archetype.label)}」：${result.archetype.reasons.join('，')}`)
    }
  }
  if (result.team && input.team) {
    // 与「不看阵容」（同样的海克斯）对比：阵容换进来 / 挤出去了哪些装备、流派有没有变
    const without = runOnce({ ...input, team: null, swaps: [] }, augments, itemIndex)
    const withoutIds = new Set(without.items.map((item) => item.itemId))
    for (const item of result.items) {
      if (withoutIds.has(item.itemId) || item.swappedFrom != null) continue
      const candidate = result.candidates.get(item.itemId)
      const part = candidate ? [...candidate.compParts].sort((a, b) => b.value - a.value)[0] : null
      const routeChanged = result.archetype?.index !== without.archetype?.index
      result.team.added.push({ itemId: item.itemId, name: item.name, reason: part && part.value >= 0.3 ? part.reason : routeChanged ? '流派 → 换路线的核心装' : '阵容加分' })
    }
    for (const item of without.items) {
      if (!result.items.some((entry) => entry.itemId === item.itemId)) result.team.removed.push({ itemId: item.itemId, name: item.name })
    }
    if (result.archetype && without.archetype && result.archetype.index !== without.archetype.index) {
      result.team.routeNote = `阵容把流派从「${localizeArchetype(without.archetype.label)}」切到「${localizeArchetype(result.archetype.label)}」`
      result.notes.unshift(`${result.team.routeNote}：${result.archetype.reasons.join('，')}`)
    }
  }
  if (!augments.length && !input.team) result.notes.push('还没有海克斯：显示该英雄数据里的主流出装')
  const { candidates: _candidates, ...rest } = result
  void _candidates
  return { ...rest, removed }
}
