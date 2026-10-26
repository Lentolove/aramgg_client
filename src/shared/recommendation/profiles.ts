/**
 * 海克斯 / 装备「画像」：把文本描述与数值字段确定性地解析成结构化属性权重与机制标签。
 *
 * - 纯函数，无 Electron / DOM 依赖；生成脚本（scripts/build-recommendation-data.mjs）与运行时共用同一套解析，
 *   运行时遇到数据表里没有的新海克斯/装备也能现场解析。
 * - 这是「模型」，不是统计：权重表达「持有该海克斯后，这项属性/机制在装备上变得多有价值」，
 *   而不是测得的胜率。
 */

import { deriveAugmentTags, type AugmentTag } from './augment-tags.ts'

export const STAT_KEYS = [
  'AP', 'AD', 'AS', 'CRIT', 'LETHALITY', 'ARMOR_PEN', 'MAGIC_PEN', 'HASTE', 'HP', 'ARMOR', 'MR',
  'HSP', 'OMNIVAMP', 'LIFESTEAL', 'MS', 'MANA',
] as const
export type StatKey = typeof STAT_KEYS[number]

/** 适应之力：按英雄主伤害类型映射到 AD 或 AP（评分时处理） */
export type WeightKey = StatKey | 'ADAPTIVE'

export const STAT_LABELS: Record<WeightKey, string> = {
  AP: '法强',
  AD: '攻击力',
  AS: '攻速',
  CRIT: '暴击',
  LETHALITY: '穿甲',
  ARMOR_PEN: '护甲穿透',
  MAGIC_PEN: '法穿',
  HASTE: '技能急速',
  HP: '生命值',
  ARMOR: '护甲',
  MR: '魔抗',
  HSP: '治疗/护盾强度',
  OMNIVAMP: '全能吸血',
  LIFESTEAL: '生命偷取',
  MS: '移速',
  MANA: '法力',
  ADAPTIVE: '适应之力',
}

export const MECHANICS = [
  'on-hit', 'crit', 'auto-attack', 'ability', 'ultimate', 'tank', 'heal-shield', 'max-hp-damage',
  'burn', 'true-damage', 'stacks', 'gold', 'prismatic-item', 'item-upgrade', 'item-active', 'boots',
  'summoner-spell', 'dash', 'cc', 'melee', 'ranged', 'mana', 'spellblade', 'anti-heal', 'stasis',
] as const
export type Mechanic = typeof MECHANICS[number]

export const MECHANIC_LABELS: Record<Mechanic, string> = {
  'on-hit': '攻击特效',
  crit: '暴击',
  'auto-attack': '普攻',
  ability: '技能伤害',
  ultimate: '大招',
  tank: '坦度',
  'heal-shield': '治疗/护盾',
  'max-hp-damage': '最大生命值伤害',
  burn: '持续伤害',
  'true-damage': '真实伤害',
  stacks: '叠层',
  gold: '金币',
  'prismatic-item': '棱彩装备',
  'item-upgrade': '装备升级',
  'item-active': '装备主动',
  boots: '鞋子',
  'summoner-spell': '召唤师技能',
  dash: '位移',
  cc: '控制',
  melee: '近战',
  ranged: '远程',
  mana: '法力',
  spellblade: '咒刃',
  'anti-heal': '重伤',
  stasis: '凝滞',
}

export type WeightMap = Partial<Record<WeightKey, number>>

export interface AugmentProfile {
  id: number
  key?: string | null
  name: string
  rarity?: string | null
  /** 持有后各属性在装备上的额外价值（约 -1 ~ 1.5） */
  weights: WeightMap
  /** 海克斯直接给的属性（信息用，不直接参与装备评分） */
  grants: WeightMap
  mechanics: Mechanic[]
  /** 海克斯直接点名/强化的装备 */
  itemIds: number[]
  /** 对 itemIds 的额外加分（升级类海克斯较高） */
  itemBoost: number
  /** 与该海克斯冲突的装备机制（例如「回归基本功」封印大招 → 大招类装备减分） */
  antiMechanics: Mechanic[]
  /** 来源：parsed=自动解析；reviewed=人工复核修正 */
  source: 'parsed' | 'reviewed'
  /** 0~1：解析可信度（人工复核为 0.9） */
  confidence: number
  notes?: string
  /** 解析依据（便于审阅） */
  evidence?: string[]
  /** 属性标签（魔抗/护甲/重伤…），阵容契合用；见 augment-tags.ts */
  tags?: AugmentTag[]
}

export interface ItemProfile {
  id: number
  name: string
  priceTotal: number
  /** 原始属性值（攻击力 75、暴击 25 …；百分比属性以百分数计） */
  stats: Partial<Record<StatKey, number>>
  /** 各属性按金币价值折算后的占比（和为 1） */
  shares: Partial<Record<StatKey, number>>
  /** 金币价值（属性部分） */
  statGold: number
  tags: Mechanic[]
  /** 唯一被动名（同名被动互斥，例如「咒刃」） */
  uniquePassives: string[]
  boots: boolean
  completed: boolean
  /** 合成路径（直接组件） */
  from: number[]
}

// ---------------------------------------------------------------------------
// 文本

export function stripTags(value: unknown): string {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/%i:[a-zA-Z]+%/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function localized(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const candidate = record.zh_cn ?? record.zh_CN ?? record['zh-CN'] ?? record.en_us ?? Object.values(record).find((entry) => typeof entry === 'string')
    return typeof candidate === 'string' ? candidate : ''
  }
  return String(value)
}

const round2 = (value: number) => Math.round(value * 100) / 100

// ---------------------------------------------------------------------------
// 装备

/** 标准金币价值（每 1 点 / 每 1%），用于把属性折算成可比较的占比 */
export const STAT_GOLD_VALUE: Record<StatKey, number> = {
  AD: 35,
  AP: 20,
  AS: 25,
  CRIT: 40,
  LETHALITY: 30,
  ARMOR_PEN: 42,
  MAGIC_PEN: 32,
  HASTE: 27,
  HP: 2.67,
  ARMOR: 20,
  MR: 18,
  HSP: 55,
  OMNIVAMP: 40,
  LIFESTEAL: 37.5,
  MS: 12,
  MANA: 1.4,
}

/** <stats> 区里的属性名 → StatKey（顺序：长名在前） */
const ITEM_STAT_NAMES: Array<[RegExp, StatKey, number?]> = [
  [/暴击几率/, 'CRIT'],
  [/暴击伤害/, 'CRIT', 0.5],
  [/攻击速度/, 'AS'],
  [/攻击力/, 'AD'],
  [/法术强度/, 'AP'],
  [/穿甲/, 'LETHALITY'],
  [/护甲穿透/, 'ARMOR_PEN'],
  [/法术穿透|法穿/, 'MAGIC_PEN'],
  [/技能急速/, 'HASTE'],
  [/治疗和护盾强度|治疗与护盾强度/, 'HSP'],
  [/全能吸血/, 'OMNIVAMP'],
  [/生命偷取/, 'LIFESTEAL'],
  [/基础生命回复|基础法力回复|生命回复|法力回复|韧性|减速抗性/, 'HP', 0],
  [/生命值/, 'HP'],
  [/魔法抗性/, 'MR'],
  [/护甲/, 'ARMOR'],
  [/移动速度/, 'MS'],
  [/法力/, 'MANA'],
]

const ITEM_TAG_RULES: Array<[RegExp, Mechanic]> = [
  [/攻击特效|OnHit/, 'on-hit'],
  [/咒刃/, 'spellblade'],
  [/重伤/, 'anti-heal'],
  [/凝滞/, 'stasis'],
  [/灼烧|持续伤害|流血|献祭/, 'burn'],
  [/(?:你的|额外|最大)生命值的|基于你的(?:最大|额外)生命值|每有.{0,4}最大生命值/, 'tank'],
  [/治疗|护盾/, 'heal-shield'],
  [/终极技能/, 'ultimate'],
  [/技能(?:造成|命中|伤害)|伤害型技能|施放技能/, 'ability'],
  [/(?:普攻|攻击(?:命中|造成|一个|一位)|你的攻击)/, 'auto-attack'],
  [/(?:目标|敌人|其)(?:的)?(?:最大|当前)生命值/, 'max-hp-damage'],
  [/真实伤害/, 'true-damage'],
  [/层/, 'stacks'],
  [/减速|眩晕|定身|禁锢|击飞/, 'cc'],
]

export interface RawItemLike {
  id: number | string
  name?: unknown
  description?: unknown
  priceTotal?: number
  categories?: string[]
  from?: Array<number | string>
  to?: Array<number | string>
  inStore?: boolean
  requiredChampion?: string
}

export function parseItemProfile(item: RawItemLike): ItemProfile {
  const description = localized(item.description)
  const statsBlock = /<stats>([\s\S]*?)<\/stats>/i.exec(description)?.[1] ?? ''
  const stats: Partial<Record<StatKey, number>> = {}
  for (const line of statsBlock.split(/<br\s*\/?>/i)) {
    const text = stripTags(line)
    const number = Number(/(-?\d+(?:\.\d+)?)/.exec(text)?.[1])
    if (!Number.isFinite(number)) continue
    for (const [pattern, key, factor] of ITEM_STAT_NAMES) {
      if (pattern.test(text)) {
        const value = number * (factor ?? 1)
        if (value) stats[key] = round2((stats[key] ?? 0) + value)
        break
      }
    }
  }
  let statGold = 0
  for (const [key, value] of Object.entries(stats) as Array<[StatKey, number]>) {
    statGold += value * STAT_GOLD_VALUE[key]
  }
  const shares: Partial<Record<StatKey, number>> = {}
  if (statGold > 0) {
    for (const [key, value] of Object.entries(stats) as Array<[StatKey, number]>) {
      const share = (value * STAT_GOLD_VALUE[key]) / statGold
      if (share >= 0.01) shares[key] = round2(share)
    }
  }

  const passiveText = stripTags(description.replace(/<stats>[\s\S]*?<\/stats>/i, ''))
  const categories = item.categories ?? []
  const tags = new Set<Mechanic>()
  for (const [pattern, tag] of ITEM_TAG_RULES) {
    if (pattern.test(passiveText)) tags.add(tag)
  }
  if (categories.includes('OnHit')) tags.add('on-hit')
  if ((stats.CRIT ?? 0) > 0) tags.add('crit')
  if ((stats.MANA ?? 0) > 0) tags.add('mana')
  if (/<active>/i.test(description) || categories.includes('Active')) tags.add('item-active')
  if ((stats.HP ?? 0) >= 350 && ((stats.ARMOR ?? 0) + (stats.MR ?? 0) > 0 || (stats.HP ?? 0) >= 700)) tags.add('tank')
  if ((stats.HSP ?? 0) > 0) tags.add('heal-shield')

  const uniquePassives = [...description.matchAll(/<passive>([^<]{2,12})<\/passive>/g)]
    .map((match) => match[1].trim())
    .filter((name, index, list) => list.indexOf(name) === index)

  const boots = categories.includes('Boots')
  const priceTotal = Number(item.priceTotal) || 0
  // 鞋子可能还有（模式专属）升级路线，按价格判断即可
  const completed = boots ? priceTotal >= 900 : (item.to ?? []).length === 0 && priceTotal >= 2000

  return {
    id: Number(item.id),
    name: localized(item.name),
    priceTotal,
    stats,
    shares,
    statGold: Math.round(statGold),
    tags: [...tags],
    uniquePassives,
    boots,
    completed,
    from: (item.from ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0),
  }
}

// ---------------------------------------------------------------------------
// 海克斯

/** 海克斯文本中的属性词（按出现位置识别上下文） */
const AUGMENT_STAT_WORDS: Array<[RegExp, WeightKey]> = [
  [/适应之力/g, 'ADAPTIVE'],
  [/法术强度|法强/g, 'AP'],
  [/攻击速度|攻速/g, 'AS'],
  [/暴击几率|暴击伤害|暴击/g, 'CRIT'],
  [/穿甲|护甲穿透/g, 'LETHALITY'],
  [/法术穿透|法穿/g, 'MAGIC_PEN'],
  [/(?<!装备|终极|召唤师)技能急速/g, 'HASTE'],
  [/治疗和护盾强度|治疗效果|护盾效果/g, 'HSP'],
  [/全能吸血/g, 'OMNIVAMP'],
  [/生命偷取/g, 'LIFESTEAL'],
  [/(?<!已损失|当前|低)(?:最大|额外)?生命值/g, 'HP'],
  [/魔法抗性|魔抗/g, 'MR'],
  [/护甲(?!穿透)/g, 'ARMOR'],
  [/移动速度|移速/g, 'MS'],
  [/(?:最大)?法力值?/g, 'MANA'],
  [/攻击力/g, 'AD'],
]

const SCALING_BEFORE = /(基于|相当于|等同于|转化|按|每\d*点?|[\d?？.]+%(?:的)?|\(\+|（\+|提升你的|增加你的|放大)\s*(?:你的|额外|总)?\s*$/
const PERCENT_NATIVE = new Set<WeightKey>(['AS', 'CRIT', 'MS', 'OMNIVAMP', 'LIFESTEAL', 'LETHALITY', 'MAGIC_PEN', 'HSP'])
const TARGET_BEFORE = /(目标|敌人|敌方|其|对方)(?:的)?\s*(?:最大|当前)?\s*$/

const AUGMENT_MECHANIC_RULES: Array<[RegExp, Mechanic]> = [
  [/攻击特效/, 'on-hit'],
  [/暴击/, 'crit'],
  [/普攻|普通攻击|攻击命中|你的攻击|攻击会|攻击时|每次攻击|攻击距离/, 'auto-attack'],
  [/技能(?:命中|伤害|造成)|施放(?:一个)?技能|释放技能|伤害型技能|技能后/, 'ability'],
  [/终极技能/, 'ultimate'],
  [/双抗|护甲和魔法抗性|伤害减免|减少.{0,6}伤害|承受伤害|受到的伤害/, 'tank'],
  [/治疗|护盾/, 'heal-shield'],
  [/(?:目标|敌人|敌方|其)(?:的)?最大生命值/, 'max-hp-damage'],
  [/灼烧|持续伤害|流血/, 'burn'],
  [/真实伤害/, 'true-damage'],
  [/层数|叠加|永久/, 'stacks'],
  [/金币/, 'gold'],
  [/铁砧|棱彩.{0,4}装备|装备铸造|高级铸造/, 'prismatic-item'],
  [/装备急速|装备(?:主动|技能)/, 'item-active'],
  [/鞋/, 'boots'],
  [/召唤师技能/, 'summoner-spell'],
  [/冲刺|位移|突进|闪现/, 'dash'],
  [/眩晕|定身|击飞|禁锢|减速|嘲讽|恐惧|魅惑/, 'cc'],
  [/近战/, 'melee'],
  [/远程/, 'ranged'],
]

/** 机制 → 隐含的属性偏好（与英雄无关） */
export const MECHANIC_STAT_HINTS: Partial<Record<Mechanic, WeightMap>> = {
  'on-hit': { AS: 0.6 },
  crit: { CRIT: 0.7, AS: 0.2 },
  'auto-attack': { AS: 0.4, AD: 0.2 },
  ability: { HASTE: 0.5, ADAPTIVE: 0.2 },
  ultimate: { HASTE: 0.4 },
  tank: { HP: 0.3, ARMOR: 0.2, MR: 0.2 },
  'heal-shield': { HSP: 0.5 },
}

/** 数值字段名（spellDataValues）→ 属性信号 */
const DATA_VALUE_RULES: Array<[RegExp, WeightKey, 'scale' | 'grant']> = [
  [/^(AP|APRatio|Damage_APRatio|APPercent|APAmp|ShieldRatioAP|CritAPRatio|ASAPRatio|APToHasteConversion)$/i, 'AP', 'scale'],
  [/^(ADRatio|BonusADRatio|bADRatio|ADPercent|ADAmp|bAD)$/i, 'AD', 'scale'],
  [/^(HealthRatio|Damage_HPRatio|HealthScalar|HealthAmp|ShieldRatioBHealth|DamageMaxHP|HealMaxHP|BonusHealthPercentageHeal|MaxHealthPercentageHeal)$/i, 'HP', 'scale'],
  [/^(AFAmp|AdaptiveForce|MaxAdaptivePerStack)$/i, 'ADAPTIVE', 'scale'],
  [/^(CritChance|CrtiChance|BaseCritChance|CritDamage|BonusCritDMG)$/i, 'CRIT', 'grant'],
  [/^(CritChanceToDamage|CritConverRatio|CritToHasteConversion)$/i, 'CRIT', 'scale'],
  [/^(AttackSpeed|BonusAS|ASPerStack|ASBuff)$/i, 'AS', 'grant'],
  [/^(Haste_Per_AS|MSToASConversion)$/i, 'AS', 'scale'],
  [/^(AbilityHaste|Haste|AH|HastePerStack|StartingHaste)$/i, 'HASTE', 'grant'],
  [/^(HealingAmp|ShieldingAmp|HealShieldAmp|HSAmp)$/i, 'HSP', 'scale'],
  [/^(Omnivamp|OmniVamp|MaxOmnivamp)$/i, 'OMNIVAMP', 'grant'],
  [/^(Lifesteal|BonusLifesteal)$/i, 'LIFESTEAL', 'grant'],
  [/^(ManaPercentDamagePercent)$/i, 'MANA', 'scale'],
  [/^(FlatPenConversion|PercentPenConversion|PercentPen)$/i, 'MAGIC_PEN', 'scale'],
  [/^(PercentBonusResists|ResistsPerStack|AdditionalARMR)$/i, 'ARMOR', 'scale'],
]

export interface RawAugmentLike {
  id: number | string
  key?: string | null
  name?: string
  rarityName?: string | null
  description?: string | null
  tooltip?: string | null
  dataValues?: Record<string, unknown> | null
}

export interface ItemNameEntry { id: number; name: string; priceTotal?: number; to?: number[] }

/** 在海克斯文本里找被点名的装备（【装备名】或直接出现的完整装备名，长名优先） */
export function findItemMentions(text: string, items: ItemNameEntry[]): number[] {
  const bracketed = [...text.matchAll(/【([^】]{2,16})】/g)].map((match) => match[1])
  const pool = items
    .filter((item) => item.name && item.name.length >= 2 && (item.priceTotal ?? 0) >= 1000)
    .sort((a, b) => b.name.length - a.name.length)
  const hits: Array<{ id: number; position: number }> = []
  const taken: Array<[number, number]> = []
  for (const item of pool) {
    const inBrackets = bracketed.includes(item.name)
    const position = text.indexOf(item.name)
    if (position < 0 || (!inBrackets && item.name.length < 4)) continue
    const end = position + item.name.length
    if (taken.some(([start, stop]) => position < stop && start < end)) continue
    taken.push([position, end])
    if (!hits.some((hit) => hit.id === item.id)) hits.push({ id: item.id, position })
  }
  return hits.sort((a, b) => a.position - b.position).map((hit) => hit.id)
}

function addWeight(map: WeightMap, key: WeightKey, value: number) {
  map[key] = round2(Math.max(-1.5, Math.min(1.5, (map[key] ?? 0) + value)))
}

export function parseAugmentProfile(augment: RawAugmentLike, items: ItemNameEntry[] = []): AugmentProfile {
  const name = String(augment.name ?? '')
  const raw = `${augment.description ?? ''} ${augment.tooltip ?? ''}`
  const text = stripTags(raw)
  const weights: WeightMap = {}
  const grants: WeightMap = {}
  const evidence: string[] = []
  const mechanics = new Set<Mechanic>()

  // 1) 属性词 + 上下文
  const seen = new Set<string>()
  for (const [pattern, key] of AUGMENT_STAT_WORDS) {
    for (const match of text.matchAll(pattern)) {
      const position = match.index ?? 0
      const before = text.slice(Math.max(0, position - 12), position)
      if (TARGET_BEFORE.test(before)) {
        if (key === 'HP') mechanics.add('max-hp-damage')
        continue
      }
      // 「护甲穿透」「法力」之类被更长的词覆盖时跳过
      const tag = `${key}@${position}`
      if (seen.has(tag)) continue
      seen.add(tag)
      // 攻速/暴击/移速/吸血/穿透本身就以百分比表示：「获得60%攻击速度」是给予，不是缩放
      const percentNative = PERCENT_NATIVE.has(key) && /[\d?？.]+%\s*(?:的)?\s*$/.test(before) && !/(基于|相当于|等同于|转化|每)/.test(before)
      if (!percentNative && SCALING_BEFORE.test(before)) {
        addWeight(weights, key, 0.9)
        evidence.push(`缩放:${match[0]}`)
      } else {
        addWeight(grants, key, 1)
        evidence.push(`给予:${match[0]}`)
      }
    }
  }
  // 给予的属性：轻微协同（暴击/攻速是乘法关系，给得多一点）
  for (const [key, value] of Object.entries(grants) as Array<[WeightKey, number]>) {
    if (value <= 0 || (weights[key] ?? 0) > 0) continue
    const factor = key === 'CRIT' ? 0.5 : key === 'AS' ? 0.25 : key === 'HSP' ? 0.4 : 0.1
    addWeight(weights, key, factor)
  }

  // 2) 数值字段
  for (const field of Object.keys(augment.dataValues ?? {})) {
    for (const [pattern, key, kind] of DATA_VALUE_RULES) {
      if (!pattern.test(field)) continue
      if (kind === 'scale') {
        if ((weights[key] ?? 0) < 0.8) addWeight(weights, key, 0.8 - (weights[key] ?? 0))
      } else if (!grants[key]) {
        addWeight(grants, key, 1)
      }
      evidence.push(`字段:${field}`)
    }
  }

  // 3) 机制
  for (const [pattern, mechanic] of AUGMENT_MECHANIC_RULES) {
    if (pattern.test(text)) mechanics.add(mechanic)
  }
  for (const mechanic of mechanics) {
    for (const [key, value] of Object.entries(MECHANIC_STAT_HINTS[mechanic] ?? {}) as Array<[WeightKey, number]>) {
      if ((weights[key] ?? 0) < value) addWeight(weights, key, value - (weights[key] ?? 0))
    }
  }

  // 4) 点名装备
  const itemIds = findItemMentions(`${name} ${text}`, items)
  const isUpgrade = /^升级[:：]/.test(name) || /^Upgrade/i.test(String(augment.key ?? ''))
  if (isUpgrade) mechanics.add('item-upgrade')
  // 升级类海克斯的属性词描述的是装备本身，不代表出装倾向
  if (isUpgrade) {
    for (const key of Object.keys(weights) as WeightKey[]) weights[key] = round2((weights[key] ?? 0) * 0.3)
  }

  const signal = Object.keys(weights).length + mechanics.size + itemIds.length
  const confidence = round2(Math.min(0.7, 0.25 + signal * 0.07))

  const tags = deriveAugmentTags({ weights, grants, mechanics: [...mechanics] }, text)
  return {
    id: Number(augment.id),
    key: augment.key ?? null,
    name,
    tags,
    rarity: augment.rarityName ?? null,
    weights,
    grants,
    mechanics: [...mechanics],
    itemIds,
    itemBoost: itemIds.length ? (isUpgrade ? 5 : 2) : 0,
    antiMechanics: [],
    source: 'parsed',
    confidence,
    evidence: evidence.slice(0, 12),
  }
}

/** 人工复核的覆盖项：只写需要改的字段 */
export interface AugmentProfileOverride {
  weights?: WeightMap
  /** true：用 weights 完全替换自动解析的权重；否则合并 */
  replaceWeights?: boolean
  mechanics?: Mechanic[]
  replaceMechanics?: boolean
  itemNames?: string[]
  itemIds?: number[]
  itemBoost?: number
  antiMechanics?: Mechanic[]
  notes?: string
  /** 人工补充 / 删除的属性标签 */
  tags?: AugmentTag[]
  removeTags?: AugmentTag[]
}

export function applyAugmentOverride(
  profile: AugmentProfile,
  override: AugmentProfileOverride,
  items: ItemNameEntry[] = [],
): AugmentProfile {
  const mergedTags = profile.tags || override.tags || override.removeTags
    ? [...new Set([...(profile.tags ?? []), ...(override.tags ?? [])])].filter((tag) => !(override.removeTags ?? []).includes(tag))
    : undefined
  // 只复核了标签：不改权重/来源/置信度
  if (Object.keys(override).every((key) => key === 'tags' || key === 'removeTags')) return { ...profile, tags: mergedTags }
  const weights: WeightMap = override.replaceWeights ? {} : { ...profile.weights }
  for (const [key, value] of Object.entries(override.weights ?? {}) as Array<[WeightKey, number]>) {
    if (value === 0) delete weights[key]
    else weights[key] = value
  }
  const mechanics = override.replaceMechanics
    ? [...(override.mechanics ?? [])]
    : [...new Set([...profile.mechanics, ...(override.mechanics ?? [])])]
  const named = (override.itemNames ?? [])
    .map((itemName) => items.find((item) => item.name === itemName)?.id)
    .filter((id): id is number => id != null)
  const itemIds = override.itemIds || override.itemNames
    ? [...new Set([...(override.itemIds ?? []), ...named])]
    : profile.itemIds
  return {
    ...profile,
    weights,
    mechanics,
    itemIds,
    itemBoost: override.itemBoost ?? (itemIds.length ? Math.max(profile.itemBoost, 2) : 0),
    antiMechanics: override.antiMechanics ?? profile.antiMechanics ?? [],
    source: 'reviewed',
    confidence: 0.9,
    notes: override.notes ?? profile.notes,
    tags: mergedTags,
  }
}
