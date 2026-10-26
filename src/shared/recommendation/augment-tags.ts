/**
 * 海克斯「属性标签」：给阵容契合度用的粗粒度标签（魔抗/护甲/重伤/回复/护盾/坦度/攻速/暴击/法强/攻击力/控制/保命/移速/急速/伤害）。
 *
 * 与 weights（出装价值）不同：标签只回答「这张卡给不给你这类东西」，用于「对面 5 法师 → 魔抗类卡加分」这类判断。
 * 来源：中文描述关键词规则 + 已解析的 grants/weights/mechanics + 人工复核覆盖（overrides.tags / removeTags）。
 * 纯函数，生成脚本与运行时共用。
 */
import type { AugmentProfile } from './profiles.ts'

export const AUGMENT_TAGS = [
  'MR', 'ARMOR', 'ANTI_HEAL', 'HEAL', 'SHIELD', 'TANK', 'AS', 'CRIT', 'AP', 'AD', 'CC', 'SURVIVE', 'MS', 'HASTE', 'DAMAGE',
] as const
export type AugmentTag = typeof AUGMENT_TAGS[number]

export const AUGMENT_TAG_LABELS: Record<AugmentTag, string> = {
  MR: '魔抗', ARMOR: '护甲', ANTI_HEAL: '重伤', HEAL: '回复', SHIELD: '护盾', TANK: '坦度', AS: '攻速', CRIT: '暴击',
  AP: '法强', AD: '攻击力', CC: '控制', SURVIVE: '保命', MS: '移速', HASTE: '急速', DAMAGE: '伤害',
}

/** 「对方的」属性不算给你的（例如「目标最大生命值」「敌人护甲」） */
const TARGET_BEFORE = /(目标|敌人|敌方|其|对方|他们)(?:的)?\s*(?:最大|当前|额外)?\s*$/

const TEXT_RULES: Array<[RegExp, AugmentTag[]]> = [
  [/魔法抗性|魔抗/g, ['MR']],
  [/护甲(?!穿透)/g, ['ARMOR']],
  [/双抗|全抗性|(?<!减速|魔法)抗性(?!.{0,2}穿透)/g, ['MR', 'ARMOR']],
  [/重伤|治疗效果降低|降低.{0,6}治疗/g, ['ANTI_HEAL']],
  [/治疗|回复.{0,6}生命|恢复.{0,6}生命|全能吸血|生命偷取|吸血|回血/g, ['HEAL']],
  [/护盾/g, ['SHIELD']],
  [/(?:最大|额外)?生命值(?!.{0,2}以下)|伤害减免|减少.{0,8}受到的伤害|承受.{0,4}伤害降低|韧性|体型(?:变大|提升)|坚韧/g, ['TANK']],
  [/攻击速度|攻速/g, ['AS']],
  [/暴击/g, ['CRIT']],
  [/法术强度|法强/g, ['AP']],
  [/攻击力/g, ['AD']],
  [/适应之力/g, ['AP', 'AD']],
  [/眩晕|定身|击飞|禁锢|减速(?!抗性)|嘲讽|恐惧|魅惑|缚地|沉默|击退/g, ['CC']],
  [/免疫伤害|无敌|凝滞|不可被选取|复活|免于一死|不会阵亡|无法被杀死|停滞/g, ['SURVIVE']],
  [/移动速度|移速/g, ['MS']],
  [/技能急速|冷却时间|重置.{0,6}冷却/g, ['HASTE']],
  [/真实伤害|魔法伤害|物理伤害|额外伤害|多造成|伤害提升|伤害增幅|爆炸/g, ['DAMAGE']],
]

const STAT_TAGS: Partial<Record<string, AugmentTag[]>> = {
  MR: ['MR'], ARMOR: ['ARMOR'], HP: ['TANK'], AS: ['AS'], CRIT: ['CRIT'], AP: ['AP'], AD: ['AD'], ADAPTIVE: ['AP', 'AD'],
  OMNIVAMP: ['HEAL'], LIFESTEAL: ['HEAL'], HSP: ['HEAL', 'SHIELD'], MS: ['MS'], HASTE: ['HASTE'],
}
const MECHANIC_TAGS: Partial<Record<string, AugmentTag[]>> = {
  tank: ['TANK'], 'heal-shield': ['HEAL'], 'anti-heal': ['ANTI_HEAL'], stasis: ['SURVIVE'], cc: ['CC'],
  crit: ['CRIT'], 'on-hit': ['AS'], 'true-damage': ['DAMAGE'], 'max-hp-damage': ['DAMAGE'], burn: ['DAMAGE'],
}

export function stripMarkup(value: unknown): string {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/%i:[A-Za-z]+%/g, '').replace(/\s+/g, ' ').trim()
}

/** 只看已有的画像字段（grants / 正权重 / 机制），不读文本 */
export function tagsFromProfileFields(profile: Pick<AugmentProfile, 'grants' | 'weights' | 'mechanics'>): AugmentTag[] {
  const tags = new Set<AugmentTag>()
  for (const [key, value] of Object.entries(profile.grants ?? {})) if ((value ?? 0) > 0) STAT_TAGS[key]?.forEach((tag) => tags.add(tag))
  // 权重只说明「这类属性更值钱」，只取进攻向缩放（生命值权重常来自「按目标最大生命值」之类）
  for (const [key, value] of Object.entries(profile.weights ?? {})) {
    if ((value ?? 0) >= 0.5 && ['AP', 'AD', 'AS', 'CRIT', 'HASTE', 'ADAPTIVE'].includes(key)) STAT_TAGS[key]?.forEach((tag) => tags.add(tag))
  }
  for (const mechanic of profile.mechanics ?? []) MECHANIC_TAGS[mechanic]?.forEach((tag) => tags.add(tag))
  return AUGMENT_TAGS.filter((tag) => tags.has(tag))
}

/** 文本关键词 → 标签（跳过「目标的…」这类说对方属性的词） */
export function tagsFromText(text: string): AugmentTag[] {
  const clean = stripMarkup(text)
  const tags = new Set<AugmentTag>()
  for (const [pattern, out] of TEXT_RULES) {
    for (const match of clean.matchAll(pattern)) {
      const position = match.index ?? 0
      const before = clean.slice(Math.max(0, position - 8), position)
      const after = clean.slice(position + match[0].length, position + match[0].length + 6)
      const defensive = out.some((tag) => tag === 'TANK' || tag === 'MR' || tag === 'ARMOR')
      if (defensive && TARGET_BEFORE.test(before)) continue
      // 「护甲和魔法抗性击碎」是削对方；「基于额外护甲和魔抗」是缩放来源，不是给予
      if (defensive && (/^(?:和魔法抗性|和魔抗)?\s*(?:击碎|穿透|削减)/.test(after) || /基于(?:额外|你的)?\s*(?:护甲和)?$/.test(before))) continue
      out.forEach((tag) => tags.add(tag))
    }
  }
  return AUGMENT_TAGS.filter((tag) => tags.has(tag))
}

export interface TagOverride { tags?: AugmentTag[]; removeTags?: AugmentTag[] }

export function deriveAugmentTags(
  profile: Pick<AugmentProfile, 'grants' | 'weights' | 'mechanics'>,
  text = '',
  override?: TagOverride | null,
): AugmentTag[] {
  const tags = new Set<AugmentTag>([...tagsFromProfileFields(profile), ...tagsFromText(text), ...(override?.tags ?? [])])
  for (const tag of override?.removeTags ?? []) tags.delete(tag)
  return AUGMENT_TAGS.filter((tag) => tags.has(tag))
}

/** 运行时取标签：表里有就用，没有就从字段推 */
export function augmentTagsOf(profile: Pick<AugmentProfile, 'grants' | 'weights' | 'mechanics'> & { tags?: AugmentTag[] }): AugmentTag[] {
  return profile.tags ?? tagsFromProfileFields(profile)
}
