/**
 * arammeta 阵容表（tier-list.json → recommendation_composition）的移植：
 *   按英雄 comp 特征把一队归类（前排个数 × 物理伤害占比、消耗/清线/开团是否缺失…），查实测的胜率修正表。
 * 这里用它回答「我去当前排，队伍的实测胜率修正变多少」→ 代替规则版的「我方缺前排」。
 * 表是队伍层面的（不是装备层面），所以只影响「偏肉/偏输出」，装备映射仍然是规则。
 */

import type { ArammetaMeta } from './normalize.ts'

const COMP_KEYS = ['phys', 'magic', 'true', 'wave', 'cc', 'engage', 'damage', 'poke', 'sustain', 'front'] as const

function adBin(adShare: number) {
  if (adShare < 0.35) return '<35% AD'
  if (adShare < 0.45) return '35-45% AD'
  if (adShare < 0.55) return '45-55% AD'
  if (adShare < 0.65) return '55-65% AD'
  return '>=65% AD'
}
function countGroup(count: number) {
  if (count < 0.5) return '0'
  if (count < 1.5) return '1'
  return '2+'
}

export interface TeamCompositionSummary {
  adShare: number
  frontCount: number
  frontGroup: string
  adBin: string
  lacks: Record<string, boolean>
  score: number
}

/** 与 arammeta site.js teamComposition + teamCompositionScore 一致 */
export function arammetaTeamComposition(meta: ArammetaMeta, ids: number[], overrides: Record<number, Partial<Record<string, number>>> = {}): TeamCompositionSummary | null {
  const config = meta.composition
  if (!config || !ids.length) return null
  const sums: Record<string, number> = Object.fromEntries(COMP_KEYS.map((key) => [key, 0]))
  const roles = { Mage: 0, Marksman: 0 }
  let frontCount = 0
  let known = 0
  for (const id of ids) {
    const info = meta.champs[String(id)]
    if (!info) continue
    known += 1
    const comp = { ...(info.comp ?? {}), ...(overrides[id] ?? {}) }
    for (const key of COMP_KEYS) sums[key] += Number(comp[key] ?? 0)
    if (Number(comp.front ?? 0) >= 2.0) frontCount += 1
    for (const tag of info.tags) if (tag === 'Mage' || tag === 'Marksman') roles[tag] += 1
  }
  if (!known) return null
  const size = Math.max(1, ids.length)
  const projection = 5 / size
  const thresholdScale = size / 5
  const adDen = sums.phys + sums.magic
  const adShare = adDen > 0 ? sums.phys / adDen : 0.5
  const lacks: Record<string, boolean> = {}
  for (const key of ['wave', 'cc', 'engage', 'damage', 'poke', 'sustain', 'front']) {
    const threshold = Number(config.lack_thresholds?.[key] ?? 0)
    lacks[key] = threshold > 0 && sums[key] < threshold * thresholdScale
  }
  const allLacks = Object.values(lacks).filter(Boolean).length
  const frontGroup = `${countGroup(frontCount * projection)} front`
  const bin = adBin(adShare)
  const table = (name: string, key: string) => Number(config.tables?.[name]?.[key] ?? 0) || 0
  const w = config.table_weights ?? {}
  let score = 0
  score += (w.ad_front ?? 0) * table('ad_front', `${frontGroup}|${bin}`)
  score += (w.poke_front ?? 0) * table('poke_front', `${frontGroup}|${lacks.poke ? 'poke lack' : 'poke ok'}`)
  score += (w.wave_engage ?? 0) * table('wave_engage', `${lacks.wave ? 'wave lack' : 'wave ok'}|${lacks.engage ? 'engage lack' : 'engage ok'}`)
  score += (w.all_lacks ?? 0) * table('all_lacks', countGroup(allLacks * projection))
  score += (w.mage_ad ?? 0) * table('mage_ad', `${countGroup(roles.Mage * projection)}|${bin}`)
  score += (w.marksman_ad ?? 0) * table('marksman_ad', `${countGroup(roles.Marksman * projection)}|${bin}`)
  const clamp = Number(config.clamp ?? 0.05)
  const sizeWeight = Math.min(1, Math.max(0, (ids.length - 1) / 4))
  return { adShare, frontCount, frontGroup, adBin: bin, lacks, score: Math.max(-clamp, Math.min(clamp, score)) * sizeWeight }
}

export interface FrontlineSignal {
  /** 我按肉装玩（front ≥ 2）时的阵容修正 − 我按原样玩时 */
  delta: number
  asFront: TeamCompositionSummary
  asIs: TeamCompositionSummary
  selfIsFront: boolean
}

/** 实测阵容表：我当前排对队伍胜率修正的影响（只有我方阵容，不看对面） */
export function frontlineSignal(meta: ArammetaMeta | null, allyIds: number[], selfId: number | null): FrontlineSignal | null {
  if (!meta || selfId == null || !allyIds.includes(selfId)) return null
  const asIs = arammetaTeamComposition(meta, allyIds)
  const selfComp = meta.champs[String(selfId)]?.comp
  if (!asIs || !selfComp) return null
  const asFront = arammetaTeamComposition(meta, allyIds, { [selfId]: { front: Math.max(2.2, Number(selfComp.front ?? 0) + 0.8) } })
  if (!asFront) return null
  return { delta: asFront.score - asIs.score, asFront, asIs, selfIsFront: Number(selfComp.front ?? 0) >= 2 }
}

/** arammeta 英雄 comp 的物理/魔法/真实伤害（局均实测）→ 占比 */
export function measuredDamageSplit(meta: ArammetaMeta | null, championId: number | null): { ap: number; ad: number; true: number } | null {
  if (!meta || championId == null) return null
  const comp = meta.champs[String(championId)]?.comp
  if (!comp) return null
  const phys = Number(comp.phys ?? 0)
  const magic = Number(comp.magic ?? 0)
  const trueDmg = Number(comp.true ?? 0)
  const total = phys + magic + trueDmg
  if (total <= 0) return null
  return { ap: magic / total, ad: phys / total, true: trueDmg / total }
}
