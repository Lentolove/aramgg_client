/**
 * 「根据已选海克斯推荐出装」的透明启发式（纯函数，无 Electron / DOM 依赖）。
 *
 * 数据接口没有「海克斯 → 出装」的统计，所以这里只做可解释的规则：
 *  (a) 海克斯名称/描述里直接提到的装备（如「升级：中娅」描述里的【中娅沙漏】）排最前；
 *  (b) 用关键词把海克斯打上属性标签（AP/AD/攻速/暴击/护甲/魔抗/生命/技能急速/续航…），
 *      用装备的 categories 给装备打同样的标签，在英雄已有出装路线（coreItems/fullItems/
 *      itemExtensions/situationalItems）中按标签匹配度重新选择/排序；
 *  (c) 结合 Live Client Data（2999）的已有装备标记「已拥有」并高亮下一件；
 *      可选：按敌方装备的法强/物理比例补一件防御装。
 * 每条推荐都附带原因文本。
 */

export type StatTag =
  | 'AP' | 'AD' | 'AS' | 'CRIT' | 'ARMOR' | 'MR' | 'HEALTH'
  | 'HASTE' | 'SUSTAIN' | 'ONHIT' | 'MOVE' | 'LETHALITY' | 'MPEN' | 'MANA'

export const STAT_TAG_LABELS: Record<StatTag, string> = {
  AP: '法强',
  AD: '攻击力',
  AS: '攻速',
  CRIT: '暴击',
  ARMOR: '护甲',
  MR: '魔抗',
  HEALTH: '生命值',
  HASTE: '技能急速',
  SUSTAIN: '治疗/吸血/护盾',
  ONHIT: '攻击特效',
  MOVE: '移速',
  LETHALITY: '物理穿透',
  MPEN: '法术穿透',
  MANA: '法力',
}

/** 关键词规则：同时匹配原始 HTML（<scaleAP> 等标签）与去标签后的文本。中英文都覆盖。 */
const AUGMENT_TAG_RULES: Array<{ tag: StatTag; pattern: RegExp }> = [
  { tag: 'AP', pattern: /scaleAP|法术强度|法强|ability power/i },
  { tag: 'AD', pattern: /scaleAD|攻击力|attack damage/i },
  { tag: 'AS', pattern: /攻击速度|攻速|attack speed/i },
  { tag: 'CRIT', pattern: /scaleCrit|暴击|critical|crit\b/i },
  { tag: 'ARMOR', pattern: /scaleArmor|护甲(?!穿透)|\barmor\b(?! pen)/i },
  { tag: 'MR', pattern: /scaleMR|魔法抗性|魔抗|magic resist/i },
  { tag: 'HEALTH', pattern: /scaleHealth|最大生命值|生命值|max(imum)? health|bonus health/i },
  { tag: 'HASTE', pattern: /技能急速|ability haste/i },
  { tag: 'SUSTAIN', pattern: /<heal|<healing|治疗|生命偷取|全能吸血|护盾|omnivamp|life ?steal|\bheal|\bshield/i },
  { tag: 'ONHIT', pattern: /攻击特效|on-hit/i },
  { tag: 'MOVE', pattern: /移动速度|movement speed|move speed/i },
  { tag: 'LETHALITY', pattern: /穿甲|护甲穿透|lethality|armor pen/i },
  { tag: 'MPEN', pattern: /法术穿透|法穿|magic pen/i },
  { tag: 'MANA', pattern: /法力值|法力|\bmana\b/i },
]

/** Riot 装备 categories → 属性标签 */
const ITEM_CATEGORY_TAGS: Record<string, StatTag> = {
  SpellDamage: 'AP',
  Damage: 'AD',
  AttackSpeed: 'AS',
  CriticalStrike: 'CRIT',
  Armor: 'ARMOR',
  SpellBlock: 'MR',
  MagicResist: 'MR',
  Health: 'HEALTH',
  AbilityHaste: 'HASTE',
  CooldownReduction: 'HASTE',
  LifeSteal: 'SUSTAIN',
  SpellVamp: 'SUSTAIN',
  OnHit: 'ONHIT',
  NonbootsMovement: 'MOVE',
  ArmorPenetration: 'LETHALITY',
  MagicPenetration: 'MPEN',
  Mana: 'MANA',
}

export interface HeuristicAugment {
  id?: number | string | null
  name?: string
  description?: string | null
  tooltip?: string | null
}

export interface HeuristicItem {
  id: number | string
  name?: string | Record<string, string>
  description?: string | Record<string, string> | null
  categories?: string[]
  priceTotal?: number
  inStore?: boolean
  iconUrl?: string | null
  iconPath?: string | null
  to?: Array<number | string>
}

export interface HeuristicBuildRecord {
  itemIds?: Array<number | string>
  items?: Array<number | string>
  coreItemIds?: Array<number | string>
  itemId?: number | string
  id?: number | string
  games?: number
  wins?: number
  winRate?: number
  pickRate?: number
  [key: string]: unknown
}

export interface HeuristicBuild {
  coreItems?: HeuristicBuildRecord[]
  fullItems?: HeuristicBuildRecord[]
  itemExtensions?: HeuristicBuildRecord[]
  situationalItems?: HeuristicBuildRecord[]
  buildTags?: string
  games?: number
  winRate?: number
  [key: string]: unknown
}

export interface EnemyDamageSummary {
  apItems: number
  adItems: number
  /** 'AP' | 'AD' | null（不明显时为 null） */
  dominant: 'AP' | 'AD' | null
}

export interface BuildRecommendationInput {
  pickedAugments: HeuristicAugment[]
  builds: HeuristicBuild[]
  items: HeuristicItem[] | Record<string, HeuristicItem>
  ownedItemIds?: Array<number | string>
  enemyDamage?: EnemyDamageSummary | null
  maxItems?: number
}

export type RecommendationSource = 'augment-reference' | 'core-route' | 'extension' | 'situational' | 'defense'

export interface RecommendedItem {
  itemId: number
  name: string
  iconUrl: string | null
  source: RecommendationSource
  reasons: string[]
  owned: boolean
  isNext: boolean
  tags: StatTag[]
}

export interface ChosenRoute {
  buildIndex: number
  kind: 'core' | 'full'
  recordIndex: number
  itemIds: number[]
  games: number
  winRate: number | null
  tagScore: number
  matchedTags: StatTag[]
}

export interface BuildRecommendation {
  augmentTags: Array<{ augmentName: string; tags: StatTag[]; referencedItemIds: number[] }>
  tagWeights: Partial<Record<StatTag, number>>
  route: ChosenRoute | null
  items: RecommendedItem[]
  nextItemId: number | null
  notes: string[]
}

// ---------------------------------------------------------------------------
// 文本工具

export function stripHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/%i:[a-zA-Z]+%/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function pickLocalized(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const candidate = record.zh_cn ?? record.zh_CN ?? record['zh-CN'] ?? record.en_us ?? record.en_US
      ?? Object.values(record).find((entry) => typeof entry === 'string')
    return typeof candidate === 'string' ? candidate : ''
  }
  return String(value)
}

function toItemId(value: unknown): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function recordItemIds(record: HeuristicBuildRecord | null | undefined): number[] {
  if (!record) return []
  const raw = record.itemIds ?? record.items ?? (record.itemId != null ? [record.itemId] : record.id != null ? [record.id] : [])
  return (Array.isArray(raw) ? raw : []).map(toItemId).filter((id): id is number => id != null)
}

// ---------------------------------------------------------------------------
// 打标签

export function tagAugment(augment: HeuristicAugment): StatTag[] {
  const raw = `${augment?.name ?? ''} ${augment?.description ?? ''} ${augment?.tooltip ?? ''}`
  const text = `${raw} ${stripHtml(raw)}`
  const tags: StatTag[] = []
  for (const { tag, pattern } of AUGMENT_TAG_RULES) {
    if (pattern.test(text) && !tags.includes(tag)) {
      tags.push(tag)
    }
  }
  return tags
}

export function tagItem(item: HeuristicItem | null | undefined): StatTag[] {
  if (!item) return []
  const tags: StatTag[] = []
  for (const category of item.categories ?? []) {
    const tag = ITEM_CATEGORY_TAGS[category]
    if (tag && !tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > 0) return tags
  // 没有 categories 时退回关键词规则（只看属性区）
  const description = pickLocalized(item.description)
  const statsBlock = /<stats>([\s\S]*?)<\/stats>/i.exec(description)?.[1] ?? description
  return tagAugment({ description: statsBlock })
}

// ---------------------------------------------------------------------------
// 装备索引与引用识别

export function buildItemIndex(items: BuildRecommendationInput['items']): Map<number, HeuristicItem> {
  const list = Array.isArray(items) ? items : Object.values(items ?? {})
  const index = new Map<number, HeuristicItem>()
  for (const item of list) {
    const id = toItemId(item?.id)
    if (id != null && !index.has(id)) index.set(id, item)
  }
  return index
}

function itemName(item: HeuristicItem | undefined): string {
  return pickLocalized(item?.name).trim()
}

function isReferenceCandidate(item: HeuristicItem): boolean {
  const name = itemName(item)
  if (name.length < 2) return false
  if (item.inStore === false) return false
  const categories = item.categories ?? []
  if (categories.includes('Consumable') || categories.includes('Trinket')) return false
  // 过滤基础小件（如「鞋子」「长剑」）避免误命中
  const price = Number(item.priceTotal)
  if (Number.isFinite(price) && price > 0 && price < 1000) return false
  return true
}

/**
 * 找出海克斯名称/描述中提到的装备，按首次出现位置排序。
 * 长名称优先，已被长名称覆盖的位置不再匹配短名称。
 */
export function findReferencedItems(
  augment: HeuristicAugment,
  itemIndex: Map<number, HeuristicItem>,
): number[] {
  const augmentName = String(augment?.name ?? '')
  const text = `${augmentName} ${stripHtml(augment?.description)} ${stripHtml(augment?.tooltip)}`
  if (!text.trim()) return []

  const candidates = [...itemIndex.entries()]
    .filter(([, item]) => isReferenceCandidate(item))
    .map(([id, item]) => ({ id, name: itemName(item) }))
    .sort((a, b) => b.name.length - a.name.length)

  const taken: Array<[number, number]> = []
  const hits: Array<{ id: number; position: number }> = []
  const seenNames = new Set<string>()

  for (const { id, name } of candidates) {
    if (seenNames.has(name)) continue
    let from = 0
    while (from <= text.length) {
      const position = text.indexOf(name, from)
      if (position < 0) break
      const end = position + name.length
      const overlaps = taken.some(([start, stop]) => position < stop && start < end)
      if (!overlaps) {
        taken.push([position, end])
        hits.push({ id, position })
        seenNames.add(name)
        break
      }
      from = position + 1
    }
  }

  const ids = hits.sort((a, b) => a.position - b.position).map((hit) => hit.id)
  // 去掉「会合成为另一件被提到的装备」的小件（如提到中娅沙漏时的探索者的护臂）
  return ids.filter((id) => {
    const into = (itemIndex.get(id)?.to ?? []).map(toItemId)
    return !ids.some((other) => other !== id && into.includes(other))
  })
}

// ---------------------------------------------------------------------------
// Live Client Data 解析

export interface LivePlayerLike {
  summonerName?: string
  riotId?: string
  riotIdGameName?: string
  riotIdTagLine?: string
  championName?: string
  team?: string
  items?: Array<{ itemID?: number; itemId?: number; displayName?: string }>
  [key: string]: unknown
}

export interface ParsedLiveClient {
  found: boolean
  championName: string | null
  team: string | null
  ownedItemIds: number[]
  enemyItemIds: number[]
  enemyChampionNames: string[]
}

function normalizeIdentity(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '')
}

export function parseLiveClientPlayers(
  activePlayer: Record<string, unknown> | null | undefined,
  playerList: LivePlayerLike[] | null | undefined,
): ParsedLiveClient {
  const players = Array.isArray(playerList) ? playerList : []
  const identities = [
    activePlayer?.riotId,
    activePlayer?.summonerName,
    activePlayer?.riotIdGameName,
    activePlayer?.riotIdGameName && activePlayer?.riotIdTagLine
      ? `${activePlayer.riotIdGameName}#${activePlayer.riotIdTagLine}` : '',
  ].map(normalizeIdentity).filter(Boolean)

  const me = players.find((player) => [
    player?.riotId,
    player?.summonerName,
    player?.riotIdGameName,
    player?.riotIdGameName && player?.riotIdTagLine ? `${player.riotIdGameName}#${player.riotIdTagLine}` : '',
  ].map(normalizeIdentity).filter(Boolean).some((id) => identities.includes(id)))

  const itemIdsOf = (player: LivePlayerLike | undefined) =>
    (player?.items ?? [])
      .map((item) => toItemId(item?.itemID ?? item?.itemId))
      .filter((id): id is number => id != null)

  if (!me) {
    return { found: false, championName: null, team: null, ownedItemIds: [], enemyItemIds: [], enemyChampionNames: [] }
  }

  const enemies = players.filter((player) => player?.team && player.team !== me.team)
  return {
    found: true,
    championName: me.championName ?? null,
    team: me.team ?? null,
    ownedItemIds: itemIdsOf(me),
    enemyItemIds: enemies.flatMap(itemIdsOf),
    enemyChampionNames: enemies.map((enemy) => String(enemy.championName ?? '')).filter(Boolean),
  }
}

/** 按敌方已购装备粗略判断伤害类型：法强装 vs 攻击/暴击装。 */
export function summarizeEnemyDamage(
  enemyItemIds: Array<number | string>,
  itemIndex: Map<number, HeuristicItem>,
): EnemyDamageSummary {
  let apItems = 0
  let adItems = 0
  for (const rawId of enemyItemIds) {
    const id = toItemId(rawId)
    if (id == null) continue
    const tags = tagItem(itemIndex.get(id))
    if (tags.includes('AP')) apItems += 1
    if (tags.includes('AD') || tags.includes('CRIT')) adItems += 1
  }
  const total = apItems + adItems
  let dominant: EnemyDamageSummary['dominant'] = null
  if (total >= 4) {
    if (apItems / total >= 0.65) dominant = 'AP'
    else if (adItems / total >= 0.65) dominant = 'AD'
  }
  return { apItems, adItems, dominant }
}

// ---------------------------------------------------------------------------
// 主流程

function tagScore(itemIds: number[], itemIndex: Map<number, HeuristicItem>, weights: Partial<Record<StatTag, number>>) {
  let score = 0
  const matched = new Set<StatTag>()
  for (const id of itemIds) {
    for (const tag of tagItem(itemIndex.get(id))) {
      const weight = weights[tag] ?? 0
      if (weight > 0) {
        score += weight
        matched.add(tag)
      }
    }
  }
  return { score: itemIds.length ? score / itemIds.length : 0, matched: [...matched] }
}

function describeTags(tags: StatTag[]): string {
  return tags.map((tag) => STAT_TAG_LABELS[tag]).join('/')
}

function augmentsForTags(
  tags: StatTag[],
  augmentTags: BuildRecommendation['augmentTags'],
): string[] {
  return augmentTags
    .filter((entry) => entry.referencedItemIds.length === 0 && entry.tags.some((tag) => tags.includes(tag)))
    .map((entry) => entry.augmentName)
}

function formatRate(rate: number | null | undefined): string {
  const value = Number(rate)
  if (!Number.isFinite(value) || value <= 0) return ''
  return `${(value > 1 ? value : value * 100).toFixed(1)}%`
}

export function recommendBuildForAugments(input: BuildRecommendationInput): BuildRecommendation {
  const itemIndex = buildItemIndex(input.items)
  const builds = Array.isArray(input.builds) ? input.builds : []
  const maxItems = input.maxItems ?? 8
  const owned = new Set((input.ownedItemIds ?? []).map(toItemId).filter((id): id is number => id != null))
  const notes: string[] = []

  // 1) 海克斯标签与装备引用
  const augmentTags = (input.pickedAugments ?? []).map((augment) => ({
    augmentName: String(augment?.name || augment?.id || '未知海克斯'),
    tags: tagAugment(augment),
    referencedItemIds: findReferencedItems(augment, itemIndex),
  }))
  const tagWeights: Partial<Record<StatTag, number>> = {}
  for (const entry of augmentTags) {
    // 「升级：某装备」这类针对具体装备的海克斯，描述里的属性词描述的是该装备，不代表出装倾向
    if (entry.referencedItemIds.length > 0) continue
    for (const tag of entry.tags) {
      tagWeights[tag] = (tagWeights[tag] ?? 0) + 1
    }
  }

  // 2) 在英雄已有路线中选标签最匹配的核心/完整出装
  const routes: ChosenRoute[] = []
  builds.forEach((build, buildIndex) => {
    ;(['core', 'full'] as const).forEach((kind) => {
      const records = (kind === 'core' ? build.coreItems : build.fullItems) ?? []
      records.forEach((record, recordIndex) => {
        const itemIds = recordItemIds(record)
        if (!itemIds.length) return
        const { score, matched } = tagScore(itemIds, itemIndex, tagWeights)
        routes.push({
          buildIndex,
          kind,
          recordIndex,
          itemIds,
          games: Number(record.games) || 0,
          winRate: Number.isFinite(Number(record.winRate)) ? Number(record.winRate) : null,
          tagScore: score,
          matchedTags: matched,
        })
      })
    })
  })

  // 无海克斯时保持数据源原顺序（最常见路线在前）；有海克斯时按匹配度排序，平局保持原顺序。
  const route = routes.length
    ? routes
      .map((candidate, order) => ({ candidate, order }))
      .sort((a, b) => (b.candidate.tagScore - a.candidate.tagScore) || (a.order - b.order))[0].candidate
    : null

  if (!route) {
    notes.push('该英雄没有可用的出装路线数据')
  }

  // 3) 组装推荐序列
  const result: RecommendedItem[] = []
  const seen = new Set<number>()
  const push = (itemId: number, source: RecommendationSource, reasons: string[]) => {
    if (seen.has(itemId)) {
      const existing = result.find((entry) => entry.itemId === itemId)
      if (existing) {
        for (const reason of reasons) {
          if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
        }
      }
      return
    }
    seen.add(itemId)
    const item = itemIndex.get(itemId)
    result.push({
      itemId,
      name: itemName(item) || `装备 ${itemId}`,
      iconUrl: (item?.iconUrl ?? item?.iconPath ?? null) || null,
      source,
      reasons,
      owned: owned.has(itemId),
      isNext: false,
      tags: tagItem(item),
    })
  }

  // (a) 海克斯直接提到的装备
  for (const entry of augmentTags) {
    for (const itemId of entry.referencedItemIds) {
      push(itemId, 'augment-reference', [`因为选了「${entry.augmentName}」，描述直接提到「${itemName(itemIndex.get(itemId)) || itemId}」`])
    }
  }

  // (b) 核心路线
  if (route) {
    const build = builds[route.buildIndex]
    const routeStats = [route.games ? `${route.games} 场` : '', formatRate(route.winRate) ? `胜率 ${formatRate(route.winRate)}` : '']
      .filter(Boolean).join('，')
    const routeLabel = `${route.kind === 'core' ? '核心' : '完整'}路线${routeStats ? `（${routeStats}）` : ''}`
    for (const itemId of route.itemIds) {
      const itemTags = tagItem(itemIndex.get(itemId)).filter((tag) => (tagWeights[tag] ?? 0) > 0)
      const reasons = [routeLabel]
      if (itemTags.length) {
        const from = augmentsForTags(itemTags, augmentTags)
        reasons.push(`因为选了「${from.join('」「')}」，契合 ${describeTags(itemTags)}`)
      }
      push(itemId, 'core-route', reasons)
    }

    // itemExtensions：核心装之后的后续装，只取与当前核心一致的
    // 数据源里 itemExtensions.coreItemIds 是排序后的集合，按集合比较
    const coreKey = [...route.itemIds].sort((a, b) => a - b).join('-')
    const extensions = (build?.itemExtensions ?? [])
      .filter((record) => {
        const core = (record.coreItemIds ?? []).map(toItemId).filter((id): id is number => id != null)
        return core.length === 0 || [...core].sort((a, b) => a - b).join('-') === coreKey
      })
      .flatMap((record) => recordItemIds(record).map((itemId) => ({ itemId, record })))
      .map(({ itemId, record }) => ({
        itemId,
        record,
        ...tagScore([itemId], itemIndex, tagWeights),
      }))
      .sort((a, b) => (b.score - a.score) || ((Number(b.record.games) || 0) - (Number(a.record.games) || 0)))
      .filter((entry, index, list) => list.findIndex((other) => other.itemId === entry.itemId) === index)

    for (const { itemId, record, matched } of extensions.slice(0, 3)) {
      const reasons = [`后续装${record.games ? `（${record.games} 场）` : ''}`]
      if (matched.length) {
        reasons.push(`因为选了「${augmentsForTags(matched, augmentTags).join('」「')}」，契合 ${describeTags(matched)}`)
      }
      push(itemId, 'extension', reasons)
    }

    // situationalItems：只有和海克斯标签匹配时才上提
    const situational = (build?.situationalItems ?? [])
      .flatMap((record) => recordItemIds(record).slice(0, 1).map((itemId) => ({ itemId, record })))
      .map(({ itemId, record }) => ({ itemId, record, ...tagScore([itemId], itemIndex, tagWeights) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => (b.score - a.score) || ((Number(b.record.pickRate) || 0) - (Number(a.record.pickRate) || 0)))

    for (const { itemId, matched } of situational.filter((entry) => !seen.has(entry.itemId)).slice(0, 2)) {
      push(itemId, 'situational', [`因为选了「${augmentsForTags(matched, augmentTags).join('」「')}」，契合 ${describeTags(matched)}（可选装）`])
    }
  }

  // (c) 防御装：敌方伤害类型明显偏向一边时补一件
  let defenseItemId: number | null = null
  const enemy = input.enemyDamage
  if (enemy?.dominant) {
    const wanted: StatTag = enemy.dominant === 'AP' ? 'MR' : 'ARMOR'
    const pool = route
      ? (builds[route.buildIndex]?.situationalItems ?? []).flatMap((record) => recordItemIds(record).slice(0, 1))
      : []
    const fromPool = pool.find((itemId) => tagItem(itemIndex.get(itemId)).includes(wanted))
    const alreadyCovered = result.some((entry) => entry.tags.includes(wanted)) ||
      [...owned].some((itemId) => tagItem(itemIndex.get(itemId)).includes(wanted))
    if (fromPool && !alreadyCovered) {
      defenseItemId = fromPool
      push(fromPool, 'defense', [
        `敌方 ${enemy.apItems} 件法强装 / ${enemy.adItems} 件物理装，偏${enemy.dominant === 'AP' ? '法术' : '物理'}伤害，补${STAT_TAG_LABELS[wanted]}`,
      ])
    } else if (!fromPool && !alreadyCovered) {
      notes.push(`敌方偏${enemy.dominant === 'AP' ? '法术' : '物理'}伤害，但该英雄可选装里没有${STAT_TAG_LABELS[wanted]}装`)
    }
  }

  // 防御装不受条数上限挤掉：先截断其余推荐，再把防御装放在最后
  const defenseEntry = defenseItemId != null
    ? result.find((entry) => entry.itemId === defenseItemId && entry.source === 'defense') ?? null
    : null
  const items = defenseEntry
    ? [...result.filter((entry) => entry !== defenseEntry).slice(0, Math.max(0, maxItems - 1)), defenseEntry]
    : result.slice(0, maxItems)
  const next = items.find((entry) => !entry.owned) ?? null
  if (next) next.isNext = true

  if (augmentTags.length === 0) {
    notes.push('还没有选择海克斯：显示该英雄最常见的出装路线')
  } else if (Object.keys(tagWeights).length === 0 && augmentTags.every((entry) => entry.referencedItemIds.length === 0)) {
    notes.push('已选海克斯没有识别到属性倾向，出装保持默认路线')
  }

  return {
    augmentTags,
    tagWeights,
    route,
    items,
    nextItemId: next?.itemId ?? null,
    notes,
  }
}
