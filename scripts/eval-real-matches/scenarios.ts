/** 场景构造：同一英雄在不同敌方阵容 / 已选海克斯下，海克斯排序与出装是否变化。 */
import { playerContext } from './eval.ts'
import { rankAugmentChoicesArammeta } from '../../src/shared/arammeta/augment-ranking.ts'
import { applyCardSynergy, generateBuildPlans, recommendBuild, scoreCardSynergy } from '../../src/shared/recommendation/index.ts'

export const LINEUPS: Record<string, number[]> = {
  AP重: [99, 63, 115, 101, 8],
  AD重: [22, 51, 119, 202, 110],
  回复坦: [36, 31, 50, 106, 16],
}
const ALLIES = [412, 25, 86, 222]

export function scenario(inputs: any, cid: number, enemyIds: number[], heldIds: number[], allyIds = ALLIES) {
  const mk = (id: number, team: number) => ({ championId: id, teamId: team, items: [], augments: [], kills: 0, deaths: 0, assists: 0 })
  const me = mk(cid, 100)
  const game = { gameId: 0, participants: [me, ...allyIds.map((id) => mk(id, 100)), ...enemyIds.map((id) => mk(id, 200))] }
  const ctx = playerContext(inputs, game, me)
  const held = heldIds.map(ctx.profileOf)
  const engineNow = recommendBuild(ctx.engineInput(heldIds) as any)
  const out: Record<string, string[]> = {}
  for (const rarity of ['kSilver', 'kGold', 'kPrismatic']) {
    const pool = (ctx.champ?.augments ?? []).filter((a: any) => (a.rarity ?? ctx.rarityOf(a.id)) === rarity && !heldIds.includes(a.id))
    const base = rankAugmentChoicesArammeta(pool.map((a: any, i: number) => ctx.toCard(a.id, i)), ctx.champ, { fallbackStats: ctx.statList, rarityOf: ctx.rarityOf })
    const ranked: any = applyCardSynergy(base as any, (card: any) => scoreCardSynergy(ctx.profileOf(card.id), held, engineNow.context, { trios: ctx.detail.augmentTrios || [], baselineWinRate: base.baselineWinRate }))
    out[rarity] = ranked.choices.slice(0, 3).map((c: any) => `${c.card.name}${c.tier ? `[${c.tier}]` : ''}`)
  }
  const plans = generateBuildPlans(ctx.engineInput(heldIds) as any)
  const adapted = plans.find((p: any) => p.key === 'adapted') ?? plans[0]
  return { augs: out, build: adapted.result.items.map((i: any) => ctx.iname(i.itemId)), notes: adapted.result.items.map((i: any) => `${ctx.iname(i.itemId)}:${i.plainReason}`), advice: ctx.advice.summary }
}

// ---- 三选一翻转：找「契合度能改变结果」的真实三卡组合
export function trioRanking(inputs: any, cid: number, ids: number[], enemyIds: number[], heldIds: number[]) {
  const mk = (id: number, team: number) => ({ championId: id, teamId: team, items: [], augments: [], kills: 0, deaths: 0, assists: 0 })
  const me = mk(cid, 100)
  const game = { gameId: 0, participants: [me, ...ALLIES.map((id) => mk(id, 100)), ...enemyIds.map((id) => mk(id, 200))] }
  const ctx = playerContext(inputs, game, me)
  const held = heldIds.map(ctx.profileOf)
  const engineNow = recommendBuild(ctx.engineInput(heldIds) as any)
  const base = rankAugmentChoicesArammeta(ids.map((id, i) => ctx.toCard(id, i)), ctx.champ, { fallbackStats: ctx.statList, rarityOf: ctx.rarityOf })
  const ranked: any = applyCardSynergy(base as any, (card: any) => scoreCardSynergy(ctx.profileOf(card.id), held, engineNow.context, { trios: ctx.detail.augmentTrios || [], baselineWinRate: base.baselineWinRate }))
  return ranked.choices as any[]
}
export function trio(inputs: any, cid: number, ids: number[], enemyIds: number[], heldIds: number[]) {
  return trioRanking(inputs, cid, ids, enemyIds, heldIds).map((c: any) => `${c.card.name}[${c.tier ?? '-'} ${c.tierLabel ?? ''} 数据${c.dataPoints} 契合${c.adjustPoints}] ${c.plainReason}`)
}
