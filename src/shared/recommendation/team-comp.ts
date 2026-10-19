/**
 * 对局阵容分析（纯函数）：双方英雄画像 + 2999 实时装备 → 敌我阵容特征、出装需求、中文「阵容判断」。
 *
 * - 英雄画像：data/champion-profiles.json（DDragon 标签/评分推断 + ARAM 常见英雄人工整理），是模型。
 * - 敌方伤害构成 = 英雄画像 与 已出装备 加权混合（装备越多越信装备）；击杀多的敌人权重更高、坦克的伤害权重更低。
 * - 输出 needs（0–1）：魔抗 / 护甲 / 重伤 / 破盾 / 穿透&百分比 / 韧性&解控 / 保命 / 补前排 / 补输出。
 *   出装引擎只把 needs 当成一个有上限的加分项，不会盖过英雄本身的统计。
 * 诚实声明：没有「阵容 × 装备」的胜率统计，这里是规则模型。
 */

import championProfileData from './data/champion-profiles.json'
import type { ItemProfile } from './profiles.ts'

export type ChampionRole = 'tank' | 'fighter' | 'mage' | 'assassin' | 'marksman' | 'enchanter'

export interface ChampionProfile {
  id: number
  /** DDragon id，例如 MonkeyKing */
  key: string
  /** 常用中文名（安妮） */
  name: string
  /** 称号（黑暗之女） */
  title: string
  roles: ChampionRole[]
  damage: { ap: number; ad: number; true: number }
  frontline: number
  sustain: number
  shield: number
  /** ≈ 硬控个数 */
  cc: number
  burst: number
  dps: number
  dive: number
  poke: number
  percentHp: number
  range: number
  ranged: boolean
  source: 'curated' | 'ddragon-tags'
  confidence: number
}

interface ChampionProfileFile {
  meta: { version: number; ddragonVersion?: string | null; note?: string }
  champions: ChampionProfile[]
}

const profileFile = championProfileData as unknown as ChampionProfileFile
export const CHAMPION_PROFILE_META = profileFile.meta
export const CHAMPION_PROFILES: ChampionProfile[] = profileFile.champions

const normalize = (value: string) => value.toLowerCase().replace(/[\s'’.&_\-·]/g, '')
const ALIASES: Record<string, string> = { wukong: 'MonkeyKing', nunuwillump: 'Nunu', renataglasc: 'Renata' }
const byId = new Map<number, ChampionProfile>()
const byName = new Map<string, ChampionProfile>()
for (const profile of CHAMPION_PROFILES) {
  byId.set(profile.id, profile)
  for (const name of [profile.key, profile.name, profile.title]) if (name) byName.set(normalize(name), profile)
}
for (const [alias, key] of Object.entries(ALIASES)) {
  const profile = byName.get(normalize(key))
  if (profile) byName.set(alias, profile)
}

/** 按英雄 id / DDragon key / 2999 rawChampionName（game_character_displayname_X）/ 中英文名 查画像 */
export function findChampionProfile(ref: { championId?: number | string | null; championKey?: string | null; rawChampionName?: string | null; championName?: string | null }): ChampionProfile | null {
  const id = Number(ref.championId)
  if (Number.isInteger(id) && id > 0 && byId.has(id)) return byId.get(id)!
  const raw = typeof ref.rawChampionName === 'string' ? ref.rawChampionName.replace(/^game_character_displayname_/i, '') : ''
  for (const name of [ref.championKey, raw, ref.championName]) {
    if (typeof name !== 'string' || !name.trim()) continue
    const hit = byName.get(normalize(name))
    if (hit) return hit
  }
  return null
}

// ---------------------------------------------------------------------------

export interface TeamPlayerInput {
  championId?: number | null
  championKey?: string | null
  rawChampionName?: string | null
  championName?: string | null
  itemIds?: Array<number | string>
  level?: number | null
  kills?: number | null
  deaths?: number | null
  assists?: number | null
  isSelf?: boolean
}

export interface TeamCompInput {
  allies: TeamPlayerInput[]
  enemies: TeamPlayerInput[]
  /** 数据来源：live = 2999 对局中；champ-select = 选人阶段（只有我方） */
  source?: 'live' | 'champ-select'
  itemIndex?: Map<number, ItemProfile>
  /** 实测伤害构成（arammeta 英雄 comp 的局均物理/魔法/真实伤害占比）；没有时用整理的画像 */
  measuredDamage?: (championId: number) => { ap: number; ad: number; true: number } | null
  /**
   * 实测阵容表：我去当前排时队伍胜率修正的变化（arammeta recommendation_composition）。
   * 有它时「缺前排」需求由它决定，没有时用规则（队友前排值之和）。
   */
  measuredFrontline?: { delta: number } | null
}

/** 实测阵容表里 +1.5% 的队伍胜率修正视为「完全缺前排」 */
export const MEASURED_FRONTLINE_FULL = 0.015

export interface TeamNeeds {
  mr: number
  armor: number
  antiHeal: number
  antiShield: number
  /** 对面坦：护甲/法术穿透、百分比伤害 */
  penetration: number
  tenacity: number
  /** 对面爆发/突进：中娅、女妖、守护天使 */
  stasis: number
  /** 我方缺前排 */
  frontline: number
  /** 我方缺输出 */
  damage: number
}

export interface TeamPlayerTag {
  championId: number | null
  name: string
  key: string | null
  isSelf: boolean
  tags: string[]
  damage: 'AP' | 'AD' | 'MIX' | null
  known: boolean
}

export interface TeamSideSummary {
  count: number
  known: number
  ap: number
  ad: number
  true: number
  /** 法系 / 物理 英雄个数（按伤害主类型） */
  apChampions: number
  adChampions: number
  frontline: number
  frontliners: number
  healers: number
  shielders: number
  cc: number
  assassins: number
  damageDealers: number
}

export interface TeamAnalysis {
  source: 'live' | 'champ-select'
  enemy: TeamSideSummary
  ally: TeamSideSummary
  needs: TeamNeeds
  allies: TeamPlayerTag[]
  enemies: TeamPlayerTag[]
  /** 0–1：画像覆盖率 × 画像置信度（敌方未知时很低） */
  confidence: number
  /** 一句话：对面 4 法系 1 物理，2 个回复英雄 */
  enemyLine: string
  allyLine: string
  /** 「缺前排」来自 arammeta 实测阵容表 */
  frontlineMeasured?: boolean
  /** 实测阵容表：我当前排的队伍胜率修正变化 */
  frontlineDelta?: number | null
  /** 用了实测伤害构成的英雄数 */
  measuredDamageCount?: number
}

export interface TeamAdvice {
  /** 一行摘要（UI 胶囊）：对面 4 法系 1 物理，2 个回复；我方缺前排 → 建议偏肉，优先魔抗和重伤 */
  summary: string
  /** 倾向：tank 偏肉 / damage 偏输出 / null 不明显 */
  lean: 'tank' | 'damage' | null
  priorities: string[]
  chips: Array<{ label: string; tone: 'ap' | 'ad' | 'warn' | 'info' }>
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
const round2 = (value: number) => Math.round(value * 100) / 100
const toId = (value: unknown): number | null => {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

const HEAL_ITEM_THRESHOLD = 0.12

function itemDamage(itemIds: number[], itemIndex?: Map<number, ItemProfile>) {
  let ap = 0
  let ad = 0
  let tank = 0
  let heal = 0
  let count = 0
  if (!itemIndex) return { ap, ad, tank, heal, count }
  for (const id of itemIds) {
    const item = itemIndex.get(id)
    if (!item || !item.completed || item.boots) continue
    count += 1
    const s = item.shares
    ap += (s.AP ?? 0) + (s.MAGIC_PEN ?? 0)
    ad += (s.AD ?? 0) + (s.CRIT ?? 0) + (s.AS ?? 0) + (s.LETHALITY ?? 0) + (s.ARMOR_PEN ?? 0)
    tank += (s.HP ?? 0) + (s.ARMOR ?? 0) + (s.MR ?? 0)
    if ((s.LIFESTEAL ?? 0) + (s.OMNIVAMP ?? 0) + (s.HSP ?? 0) >= HEAL_ITEM_THRESHOLD) heal += 1
  }
  return { ap, ad, tank, heal, count }
}

interface PlayerModel {
  input: TeamPlayerInput
  profile: ChampionProfile | null
  measured: boolean
  ap: number
  ad: number
  trueDmg: number
  frontline: number
  sustain: number
  shield: number
  cc: number
  burst: number
  dive: number
  dps: number
  /** 威胁权重（击杀多更高，坦克输出权重低） */
  weight: number
}

function modelPlayer(input: TeamPlayerInput, itemIndex?: Map<number, ItemProfile>, measuredDamage?: TeamCompInput['measuredDamage']): PlayerModel {
  const profile = findChampionProfile(input)
  const items = (input.itemIds ?? []).map(toId).filter((id): id is number => id != null)
  const fromItems = itemDamage(items, itemIndex)
  const base = profile ?? null
  const id = profile?.id ?? toId(input.championId)
  const measured = id != null && measuredDamage ? measuredDamage(id) : null
  let ap = measured?.ap ?? base?.damage.ap ?? 0.5
  let ad = measured?.ad ?? base?.damage.ad ?? 0.5
  const trueDmg = measured?.true ?? base?.damage.true ?? 0
  let frontline = base?.frontline ?? 0.3
  let sustain = base?.sustain ?? 0.1
  // 装备越多越信装备（最多 0.7）
  if (fromItems.count > 0) {
    const w = Math.min(0.7, 0.25 * fromItems.count)
    const dmg = fromItems.ap + fromItems.ad
    if (dmg > 0.2) {
      const itemAp = fromItems.ap / dmg
      const scale = 1 - trueDmg
      ap = (1 - w) * ap + w * itemAp * scale
      ad = (1 - w) * ad + w * (1 - itemAp) * scale
    }
    frontline = (1 - w) * frontline + w * clamp01(fromItems.tank / fromItems.count * 1.3)
    sustain = clamp01(sustain + 0.25 * fromItems.heal)
  }
  const kills = Number(input.kills) || 0
  const deaths = Number(input.deaths) || 0
  const feed = Math.max(-0.3, Math.min(0.8, (kills - deaths) * 0.1))
  const weight = Math.max(0.3, (1 + feed) * (1 - 0.5 * frontline))
  return {
    input,
    profile,
    measured: Boolean(measured),
    ap,
    ad,
    trueDmg,
    frontline,
    sustain,
    shield: base?.shield ?? 0.1,
    cc: base?.cc ?? 1,
    burst: base?.burst ?? 0.4,
    dive: base?.dive ?? 0.3,
    dps: base?.dps ?? 0.4,
    weight,
  }
}

function summarize(models: PlayerModel[]): TeamSideSummary {
  const totalWeight = models.reduce((sum, m) => sum + m.weight, 0) || 1
  const ap = models.reduce((sum, m) => sum + m.ap * m.weight, 0) / totalWeight
  const ad = models.reduce((sum, m) => sum + m.ad * m.weight, 0) / totalWeight
  const trueDmg = models.reduce((sum, m) => sum + m.trueDmg * m.weight, 0) / totalWeight
  return {
    count: models.length,
    known: models.filter((m) => m.profile).length,
    ap: round2(ap),
    ad: round2(ad),
    true: round2(trueDmg),
    apChampions: models.filter((m) => m.ap >= 0.6).length,
    adChampions: models.filter((m) => m.ad >= 0.6).length,
    frontline: round2(models.reduce((sum, m) => sum + m.frontline, 0)),
    frontliners: models.filter((m) => m.frontline >= 0.65).length,
    healers: models.filter((m) => m.sustain >= 0.6).length,
    shielders: models.filter((m) => m.shield >= 0.6).length,
    cc: round2(models.reduce((sum, m) => sum + m.cc, 0)),
    assassins: models.filter((m) => m.burst >= 0.7 && m.dive >= 0.7).length,
    damageDealers: models.filter((m) => m.frontline < 0.65 && Math.max(m.burst, m.dps) >= 0.6).length,
  }
}

function playerTags(model: PlayerModel): string[] {
  const tags: string[] = []
  if (model.frontline >= 0.65) tags.push('前排')
  if (model.burst >= 0.7 && model.dive >= 0.7) tags.push('刺客')
  if (model.sustain >= 0.6) tags.push('回复')
  if (model.shield >= 0.6) tags.push('护盾')
  if (model.cc >= 2) tags.push('强控')
  if ((model.profile?.poke ?? 0) >= 0.8) tags.push('消耗')
  if ((model.profile?.percentHp ?? 0) >= 0.6) tags.push('%伤害')
  return tags
}

function tagPlayer(model: PlayerModel): TeamPlayerTag {
  const damage = model.ap >= 0.6 ? 'AP' : model.ad >= 0.6 ? 'AD' : 'MIX'
  return {
    championId: model.profile?.id ?? toId(model.input.championId),
    name: model.profile?.name ?? model.input.championName ?? '?',
    key: model.profile?.key ?? null,
    isSelf: Boolean(model.input.isSelf),
    tags: playerTags(model),
    damage: model.profile || (model.input.itemIds ?? []).length ? damage : null,
    known: Boolean(model.profile),
  }
}

function sideLine(side: TeamSideSummary, prefix: string): string {
  if (!side.count) return ''
  const parts: string[] = []
  const mix = side.count - side.apChampions - side.adChampions
  parts.push(`${prefix} ${side.apChampions} 法系 ${side.adChampions} 物理${mix > 0 ? ` ${mix} 混伤` : ''}`)
  if (side.healers) parts.push(`${side.healers} 个回复`)
  if (side.shielders) parts.push(`${side.shielders} 个护盾`)
  if (side.frontliners >= 2) parts.push(`${side.frontliners} 个前排`)
  if (side.assassins) parts.push(`${side.assassins} 个刺客`)
  return parts.join('，')
}

export function analyzeTeamComp(input: TeamCompInput): TeamAnalysis {
  const allyModels = input.allies.map((player) => modelPlayer(player, input.itemIndex, input.measuredDamage))
  const enemyModels = input.enemies.map((player) => modelPlayer(player, input.itemIndex, input.measuredDamage))
  const enemy = summarize(enemyModels)
  const ally = summarize(allyModels)
  const others = allyModels.filter((m) => !m.input.isSelf)
  const allyOthers = summarize(others)

  const needs: TeamNeeds = {
    mr: 0, armor: 0, antiHeal: 0, antiShield: 0, penetration: 0, tenacity: 0, stasis: 0, frontline: 0, damage: 0,
  }
  if (enemyModels.length) {
    // 敌方是 5 人时按比例；不足 5 人（还没看全）时按已知比例但打折
    const coverage = Math.min(1, enemyModels.length / 5)
    needs.mr = clamp01((enemy.ap - 0.5) / 0.3) * coverage
    needs.armor = clamp01((enemy.ad - 0.5) / 0.3) * coverage
    const healScore = enemyModels.reduce((sum, m) => sum + m.sustain, 0)
    needs.antiHeal = clamp01((healScore - 0.6) / 1.4)
    const shieldScore = enemyModels.reduce((sum, m) => sum + m.shield, 0)
    needs.antiShield = clamp01((shieldScore - 0.8) / 1.5)
    needs.penetration = clamp01((enemy.frontline - 1.2) / 1.6)
    needs.tenacity = clamp01((enemy.cc - 5) / 5)
    const burstThreat = enemyModels.reduce((sum, m) => sum + m.burst * m.dive * m.weight, 0)
    needs.stasis = clamp01((burstThreat - 0.5) / 1.4)
  }
  if (others.length) {
    const coverage = Math.min(1, others.length / 4)
    needs.frontline = clamp01((1.4 - allyOthers.frontline) / 1.4) * coverage
    const damageScore = others.reduce((sum, m) => sum + Math.max(m.burst, m.dps) * (1 - 0.6 * m.frontline), 0)
    needs.damage = clamp01((1.6 - damageScore) / 1.4) * coverage
  }
  const frontlineMeasured = input.measuredFrontline != null && Number.isFinite(input.measuredFrontline.delta)
  if (frontlineMeasured) needs.frontline = clamp01(input.measuredFrontline!.delta / MEASURED_FRONTLINE_FULL)
  for (const key of Object.keys(needs) as Array<keyof TeamNeeds>) needs[key] = round2(needs[key])

  const all = [...allyModels, ...enemyModels]
  const confidence = all.length
    ? round2(all.reduce((sum, m) => sum + (m.profile?.confidence ?? 0), 0) / all.length * (enemyModels.length ? 1 : 0.5))
    : 0

  return {
    source: input.source ?? (enemyModels.length ? 'live' : 'champ-select'),
    enemy,
    ally,
    needs,
    allies: allyModels.map(tagPlayer),
    enemies: enemyModels.map(tagPlayer),
    confidence,
    enemyLine: sideLine(enemy, '对面'),
    allyLine: sideLine(allyOthers, '队友'),
    frontlineMeasured,
    frontlineDelta: frontlineMeasured ? input.measuredFrontline!.delta : null,
    measuredDamageCount: all.filter((m) => m.measured).length,
  }
}

/**
 * 结合「我能不能偏肉/偏输出」（来自该英雄的数据路线）给出建议文字。
 * canTank：该英雄有肉装路线（例如墨菲特、慎）；canDamage：有输出路线。
 */
export function adviseTeamComp(analysis: TeamAnalysis, flex: { canTank: boolean; canDamage: boolean }): TeamAdvice {
  const { needs } = analysis
  const priorities: Array<[number, string]> = []
  if (needs.mr >= 0.3) priorities.push([needs.mr, '魔抗'])
  if (needs.armor >= 0.3) priorities.push([needs.armor, '护甲'])
  if (needs.antiHeal >= 0.35) priorities.push([needs.antiHeal + 0.1, '重伤'])
  if (needs.penetration >= 0.35) priorities.push([needs.penetration, '穿透/百分比伤害'])
  if (needs.stasis >= 0.35) priorities.push([needs.stasis, '保命（中娅/女妖/守护天使）'])
  if (needs.antiShield >= 0.4) priorities.push([needs.antiShield * 0.8, '破盾'])
  if (needs.tenacity >= 0.4) priorities.push([needs.tenacity * 0.7, '韧性/解控'])
  priorities.sort((a, b) => b[0] - a[0])
  const top = priorities.slice(0, 2).map(([, label]) => label)

  let lean: TeamAdvice['lean'] = null
  if (flex.canTank && flex.canDamage) {
    if (needs.frontline >= 0.5 && needs.frontline >= needs.damage) lean = 'tank'
    else if (needs.damage >= 0.5) lean = 'damage'
  }
  const segments: string[] = []
  if (analysis.enemyLine) segments.push(analysis.enemyLine)
  else if (analysis.source === 'champ-select') segments.push('选人阶段看不到对面')
  // 只有自己能补的时候才提我方缺什么（安妮补不了前排）
  const allyNote = needs.frontline >= 0.5 && flex.canTank
    ? (analysis.frontlineMeasured && analysis.frontlineDelta != null ? `我方缺前排（实测阵容表：你当前排 +${(analysis.frontlineDelta * 100).toFixed(1)}%）` : '我方缺前排') : needs.damage >= 0.5 && flex.canDamage && flex.canTank ? '我方缺输出' : ''
  const advice: string[] = []
  if (lean === 'tank') advice.push('建议偏肉')
  else if (lean === 'damage') advice.push('建议偏输出')
  if (top.length) advice.push(`优先${top.join('和')}`)
  let summary = segments.join('；')
  if (allyNote || advice.length) summary += `${summary ? '；' : ''}${allyNote}${advice.length ? `${allyNote ? ' → ' : ''}${advice.join('，')}` : ''}`

  const chips: TeamAdvice['chips'] = []
  if (analysis.enemy.count) {
    if (analysis.enemy.ap >= 0.6) chips.push({ label: `法伤 ${Math.round(analysis.enemy.ap * 100)}%`, tone: 'ap' })
    else if (analysis.enemy.ad >= 0.6) chips.push({ label: `物伤 ${Math.round(analysis.enemy.ad * 100)}%`, tone: 'ad' })
    else chips.push({ label: '伤害均衡', tone: 'info' })
  }
  if (needs.antiHeal >= 0.35) chips.push({ label: '要重伤', tone: 'warn' })
  if (needs.stasis >= 0.35) chips.push({ label: '防爆发', tone: 'warn' })
  if (needs.penetration >= 0.35) chips.push({ label: '对面肉', tone: 'info' })
  if (lean === 'tank') chips.push({ label: '偏肉', tone: 'info' })
  if (lean === 'damage') chips.push({ label: '偏输出', tone: 'info' })
  return { summary: summary || '阵容没有明显倾向', lean, priorities: top, chips }
}
