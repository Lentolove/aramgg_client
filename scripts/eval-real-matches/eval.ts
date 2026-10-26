/**
 * 真实对局评测（离线、可复现）：把浮窗用的同一套共享函数跑在 docs/samples 里的 3 局真实海克斯大乱斗（queue 2400）上，
 * 对全部 30 名玩家计算「合理性」指标。被 tests/unit/real-match-regression.test.ts 与 report.ts 共用。
 *
 * 数据：
 *   - 对局：docs/samples/match-history-upload.real-sanitized.json（国服 GZ100，16.15，已脱敏）
 *   - arammeta：resources/arammeta（随包快照，16.20）
 *   - dtodo：tests/fixtures/real-matches/dtodo-detail.json（collect.ts 抓的快照）
 *
 * 注意：对局是 16.15、统计是 16.20，「与实际出装重合度」只作参考；优化目标是合理性规则（不混搭、鞋子对路、抗性响应阵容），不是重合度。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rankAugmentChoicesArammeta } from '../../src/shared/arammeta/augment-ranking.ts'
import { arammetaToBuilds } from '../../src/shared/arammeta/builds.ts'
import { frontlineSignal, measuredDamageSplit } from '../../src/shared/arammeta/composition.ts'
import {
  adviseTeamComp, analyzeTeamComp, applyCardSynergy, buildItemProfileIndex, championRouteFlex, generateBuildPlans,
  recommendBuild, resolveAugmentProfile, scoreCardSynergy,
} from '../../src/shared/recommendation/index.ts'
import type { ItemProfile } from '../../src/shared/recommendation/profiles.ts'

export interface EvalInputs {
  matches: any[]
  meta: any
  arammeta: (id: number) => any | null
  dtodo: any
}

export function loadEvalInputs(root = process.cwd()): EvalInputs {
  const sample = JSON.parse(readFileSync(join(root, 'docs/samples/match-history-upload.real-sanitized.json'), 'utf8'))
  const meta = JSON.parse(readFileSync(join(root, 'resources/arammeta/meta.json'), 'utf8'))
  const dtodo = JSON.parse(readFileSync(join(root, 'tests/fixtures/real-matches/dtodo-detail.json'), 'utf8'))
  const cache = new Map<number, any>()
  const arammeta = (id: number) => {
    if (!cache.has(id)) {
      try {
        cache.set(id, JSON.parse(readFileSync(join(root, 'resources/arammeta/champions', `${id}.json`), 'utf8')))
      } catch {
        cache.set(id, null)
      }
    }
    return cache.get(id)
  }
  return { matches: sample.samples.map((s: any) => s.game), meta, arammeta, dtodo }
}

// ---------------------------------------------------------------- 评判用的装备分类（独立于引擎，避免「自己判自己」）
const AD_KEYS = ['AD', 'CRIT', 'AS', 'LETHALITY', 'ARMOR_PEN'] as const
export function damageClass(item: ItemProfile | undefined): 'AP' | 'AD' | null {
  if (!item) return null
  const s = item.shares
  const ap = (s.AP ?? 0) + (s.MAGIC_PEN ?? 0)
  const ad = AD_KEYS.reduce((sum, key) => sum + (s[key] ?? 0), 0)
  if (ap >= 0.3 && ap > ad * 2) return 'AP'
  if (ad >= 0.3 && ad > ap * 2) return 'AD'
  return null
}
/** 鞋子只看伤害属性：法穿鞋 = AP，攻速/穿甲鞋 = AD，其余中性 */
export function bootsClass(item: ItemProfile | undefined): 'AP' | 'AD' | null {
  if (!item?.boots) return null
  const s = item.shares
  if ((s.MAGIC_PEN ?? 0) + (s.AP ?? 0) >= 0.2) return 'AP'
  if ((s.AS ?? 0) + (s.LETHALITY ?? 0) + (s.ARMOR_PEN ?? 0) + (s.AD ?? 0) >= 0.2) return 'AD'
  return null
}
/** 抗性装（不算鞋：水银鞋/铁板靴单独看） */
const resist = (item: ItemProfile | undefined, key: 'MR' | 'ARMOR') => !item?.boots && (item?.shares[key] ?? 0) >= 0.15

export interface PlanEval {
  key: string
  label: string
  route: string
  items: Array<{ id: number; name: string }>
  overlap: number
  mixed: boolean
  illegal: string[]
  bootsIssue: string | null
  mr: boolean
  armor: boolean
  /** 主流方案：选的鞋是不是该路线出场最多的鞋（其他方案为 null） */
  popularBootsTop: boolean | null
}

export interface PlayerEval {
  gameId: number
  championId: number
  name: string
  win: boolean
  role: 'tank' | 'AP' | 'AD' | 'mixed'
  actual: Array<{ id: number; name: string }>
  augments: Array<{ id: number; name: string; rarity: string | null; rank: number | null; total: number }>
  enemyAp: number
  enemyAd: number
  /** 评判口径（独立于引擎）：对面按最终成装是明确法强 / 物理输出位的人数（≥3 件同类输出装、另一类 ≤1 件） */
  enemyApDealers: number
  enemyAdDealers: number
  needs: { mr: number; armor: number; stasis: number }
  advice: string
  adviceStasisForTank: boolean
  plans: PlanEval[]
  /** 已有实际前两件核心装时的方案 */
  ownedPlans: PlanEval[]
  owned: number[]
  trioNoDataMislabeled: number
  trioCards: number
}

const NON_ITEMS = new Set([2052, 2022, 2020, 220013])

function enemyDealers(enemies: any[], index: Map<number, ItemProfile>) {
  let ap = 0
  let ad = 0
  for (const enemy of enemies) {
    // 只看成装；「明确的输出位」= ≥3 件同类输出装且另一类 ≤1 件（半 AP 半 AD 的混合出装不算）
    const classes = (enemy.items as number[]).map((id) => index.get(id)).filter((item) => item?.completed && !item.boots).map(damageClass)
    const a = classes.filter((c) => c === 'AP').length
    const d = classes.filter((c) => c === 'AD').length
    if (a >= 3 && d <= 1) ap += 1
    else if (d >= 3 && a <= 1) ad += 1
  }
  return { enemyApDealers: ap, enemyAdDealers: ad }
}

/** 与浮窗相同的输入组装：arammeta 路线 → builds、2999 风格阵容（双方 10 人 + 最终装备）、海克斯画像 */
export function playerContext(inputs: EvalInputs, game: any, participant: any) {
  const { meta, dtodo } = inputs
  const cid = Number(participant.championId)
  const champ = inputs.arammeta(cid)
  const detail = dtodo.champions[cid] ?? { augmentIds: [], augmentStats: {}, augmentTrios: [], builds: [] }
  const items = dtodo.items
  const index = buildItemProfileIndex(items)
  const iname = (id: number) => index.get(id)?.name ?? `#${id}`
  const augBase = (id: number) => dtodo.augments[id] ?? null
  const aname = (id: number) => augBase(id)?.name ?? `#${id}`
  const profileOf = (id: number) => resolveAugmentProfile({ id, name: aname(id) }, augBase(id), items)
  const rarityOf = (id: number) => meta.augRarity?.[String(id)] ?? null
  const statList = Object.values<any>(detail.augmentStats || {}).map((s) => ({ winRate: s?.win_rate ?? null, games: s?.num_games ?? null, wins: s?.num_win_games ?? null }))
  const toCard = (id: number, slot: number) => {
    const s = detail.augmentStats?.[String(id)] || {}
    return { id, name: aname(id), slot, detectedSlot: slot, winRate: s.win_rate ?? null, games: s.num_games ?? null, wins: s.num_win_games ?? null, rank: s.rank ?? null, tier: s.tier ?? null, pickRate: s.pick_rate ?? null }
  }

  const toInput = (p: any) => ({ championId: p.championId, championName: String(p.championId), itemIds: p.items, kills: p.kills, deaths: p.deaths, assists: p.assists, isSelf: p === participant })
  const allies = game.participants.filter((p: any) => p.teamId === participant.teamId).map(toInput)
  const enemies = game.participants.filter((p: any) => p.teamId !== participant.teamId).map(toInput)
  const measuredDamage = (id: number) => measuredDamageSplit(meta, id)
  const run = (mf: any) => analyzeTeamComp({ allies, enemies, source: 'live', itemIndex: index, measuredDamage, measuredFrontline: mf } as any)
  let team = run(null)
  const signal = frontlineSignal(meta, allies.map((a: any) => a.championId), cid)
  if (signal) team = run({ delta: signal.delta })

  const builds = champ ? arammetaToBuilds(champ, (id) => index.get(id)?.name) : []
  const engineBuilds = builds.length ? builds : detail.builds || []
  const flex = championRouteFlex({ builds: engineBuilds, items })
  const advice = adviseTeamComp(team, flex)
  const engineInput = (augmentIds: number[], ownedItemIds: number[] = []) => ({
    builds: engineBuilds, itemPairs: champ?.pairs ?? [], itemSingles: champ?.singles ?? [], items, augments: augmentIds.map(profileOf), ownedItemIds, enemyItemIds: [] as number[], team,
  })
  return { cid, champ, detail, items, index, iname, aname, profileOf, rarityOf, statList, toCard, team, signal, builds, engineBuilds, flex, advice, engineInput }
}

export function evaluatePlayer(inputs: EvalInputs, game: any, participant: any): PlayerEval {
  const { meta } = inputs
  const { cid, champ, detail, items, index, iname, aname, profileOf, rarityOf, statList, toCard, team, engineBuilds, advice } = playerContext(inputs, game, participant)
  void meta

  // 实际出装与角色
  const actualIds = (participant.items as number[]).filter((id) => !NON_ITEMS.has(id) && index.has(id))
  const actualCompleted = actualIds.filter((id) => !index.get(id)!.boots)
  const classes = actualCompleted.map((id) => damageClass(index.get(id)))
  const tankCount = actualCompleted.filter((id) => { const s = index.get(id)!.shares; return (s.HP ?? 0) + (s.ARMOR ?? 0) + (s.MR ?? 0) >= 0.5 }).length
  const apCount = classes.filter((c) => c === 'AP').length
  const adCount = classes.filter((c) => c === 'AD').length
  const role: PlayerEval['role'] = tankCount >= 3 ? 'tank' : apCount >= 2 && apCount > adCount ? 'AP' : adCount >= 2 && adCount > apCount ? 'AD' : 'mixed'

  // 海克斯：逐个模拟三选一（实际选的 + 同稀有度 25%/60% 分位两张）
  const picks = (participant.augments as number[]) ?? []
  const held: number[] = []
  let trioNoDataMislabeled = 0
  let trioCards = 0
  const augments: PlayerEval['augments'] = []
  for (const id of picks) {
    const rarity = rarityOf(id)
    const same = (champ?.augments ?? []).filter((a: any) => (a.rarity ?? rarityOf(a.id)) === rarity).sort((a: any, b: any) => b.score - a.score)
    const rankIndex = same.findIndex((a: any) => a.id === id)
    augments.push({ id, name: aname(id), rarity, rank: rankIndex >= 0 ? rankIndex + 1 : null, total: same.length })
    if (champ) {
      const pool = same.filter((a: any) => a.id !== id)
      const others = [pool[Math.floor(pool.length * 0.25)], pool[Math.floor(pool.length * 0.6)]].filter(Boolean).map((a: any) => a.id)
      const trio = [others[0], id, others[1]].filter((x) => x != null)
      const engineNow = recommendBuild({ builds: engineBuilds, itemPairs: champ.pairs, itemSingles: champ.singles, items, augments: held.map(profileOf), team } as any)
      const base = rankAugmentChoicesArammeta(trio.map(toCard), champ, { fallbackStats: statList, rarityOf })
      const ranked = applyCardSynergy(base as any, (card: any) => scoreCardSynergy(profileOf(card.id), held.map(profileOf), engineNow.context, { trios: detail.augmentTrios || [], baselineWinRate: base.baselineWinRate }), { profileOf: (card: any) => profileOf(card.id) })
      for (const choice of ranked.choices as any[]) {
        trioCards += 1
        const noData = choice.sortWinRate == null && choice.shrunkWinRate == null
        if (noData && choice.relativeLabel && choice.relativeLabel !== '无数据') trioNoDataMislabeled += 1
      }
    }
    held.push(id)
  }

  const ownedClass = (list: number[]) => {
    const classes = list.map((id) => damageClass(index.get(id)))
    const ap = classes.filter((c) => c === 'AP').length
    const ad = classes.filter((c) => c === 'AD').length
    return ap > ad ? 'AP' : ad > ap ? 'AD' : null
  }
  const evalPlans = (plans: any[], ownedIds: number[] = []): PlanEval[] => plans.map((plan) => {
    const ownedSet = new Set(ownedIds)
    const ids = plan.result.items.map((item: any) => item.itemId as number)
    const profiles = ids.map((id: number) => index.get(id))
    const nonBoots = profiles.filter((p: any) => p && !p.boots)
    const illegal: string[] = []
    if (profiles.filter((p: any) => p?.boots).length > 1) illegal.push('两双鞋')
    if (new Set(ids).size !== ids.length) illegal.push('重复装备')
    const passives = new Map<string, number>()
    for (const p of profiles) for (const name of p?.uniquePassives ?? []) passives.set(name, (passives.get(name) ?? 0) + 1)
    for (const [name, count] of passives) if (count > 1) illegal.push(`唯一被动重复：${name}`)
    // 方案主伤害类型：非鞋装备多数；「混搭」只看引擎新推荐的（已有装备本身混搭不算引擎的错）
    const apItems = nonBoots.filter((p: any) => damageClass(p) === 'AP').length
    const adItems = nonBoots.filter((p: any) => damageClass(p) === 'AD').length
    const fresh = nonBoots.filter((p: any) => !ownedSet.has(p.id))
    const freshAp = fresh.filter((p: any) => damageClass(p) === 'AP').length
    const freshAd = fresh.filter((p: any) => damageClass(p) === 'AD').length
    const ownedType = ownedClass(ownedIds)
    const ownedConflict = ownedType != null && (ownedType === 'AP' ? freshAd : freshAp) > 0
    const planType = apItems > adItems ? 'AP' : adItems > apItems ? 'AD' : null
    const boots = profiles.find((p: any) => p?.boots)
    let bootsIssue: string | null = null
    const bc = bootsClass(boots)
    if (boots && bc && planType && bc !== planType) bootsIssue = `${boots.name} 与${planType === 'AP' ? '法强' : '物理'}方案不搭`
    let popularBootsTop: boolean | null = null
    if (plan.key === 'popular' && boots) {
      const build = engineBuilds[plan.result.archetype?.index ?? -1]
      // 只和「伤害取向不冲突」的鞋比（法强路线里的攻速鞋本来就不该推）
      const bootRecords = (build?.situationalItems ?? []).filter((r: any) => {
        const item = index.get(Number(r.itemId))
        const cls = bootsClass(item)
        return item?.boots && (!cls || !planType || cls === planType)
      })
      const top = bootRecords.sort((a: any, b: any) => b.games - a.games)[0]
      popularBootsTop = top ? Number(top.itemId) === boots.id : null
    }
    const actualSet = new Set(actualIds)
    const overlap = ids.filter((id: number) => actualSet.has(id)).length / Math.max(1, Math.min(6, actualIds.length))
    return {
      key: plan.key, label: plan.label, route: plan.routeLabel,
      items: ids.map((id: number) => ({ id, name: iname(id) })),
      // 混搭：法强装与物理装各 ≥2 件（一件跨类装，例如攻击特效英雄的纳什，不算）
      // 数据里本身就是混伤路线（例如 16.21 沃利贝尔「混伤攻击特效」）时，物法混出是该路线的真实出法，不算混搭
      overlap, mixed: (Math.min(freshAp, freshAd) >= 2 && !/混伤/.test(plan.routeLabel ?? '')) || ownedConflict, illegal, bootsIssue,
      mr: profiles.some((p: any) => resist(p, 'MR')), armor: profiles.some((p: any) => resist(p, 'ARMOR')),
      popularBootsTop,
    }
  })

  const finalInput = { builds: engineBuilds, itemPairs: champ?.pairs ?? [], itemSingles: champ?.singles ?? [], items, augments: held.map(profileOf), ownedItemIds: [] as number[], enemyItemIds: [], team }
  const plans = evalPlans(generateBuildPlans(finalInput as any))
  const owned = actualCompleted.slice(0, 2)
  const ownedPlans = evalPlans(generateBuildPlans({ ...finalInput, augments: held.slice(0, 2).map(profileOf), ownedItemIds: owned } as any), owned)

  return {
    gameId: game.gameId, championId: cid, name: detail.championName?.nameCN ?? String(cid), win: Boolean(participant.win), role,
    actual: actualIds.map((id) => ({ id, name: iname(id) })), augments,
    enemyAp: team.enemy.apChampions, enemyAd: team.enemy.adChampions,
    ...enemyDealers(game.participants.filter((p: any) => p.teamId !== participant.teamId), index),
    needs: { mr: team.needs.mr, armor: team.needs.armor, stasis: team.needs.stasis },
    advice: advice.summary,
    adviceStasisForTank: role === 'tank' && /中娅|女妖|保命/.test(advice.summary),
    plans, ownedPlans, owned, trioNoDataMislabeled, trioCards,
  }
}

export function evaluateAll(inputs = loadEvalInputs()): PlayerEval[] {
  return inputs.matches.flatMap((game) => game.participants.map((p: any) => evaluatePlayer(inputs, game, p)))
}

export interface EvalMetrics {
  players: number
  meanOverlapAdapted: number
  meanOverlapBest: number
  mixedPlans: number
  mixedOwnedPlans: number
  totalPlans: number
  totalOwnedPlans: number
  illegalPlans: number
  bootsIssues: number
  tanksVs3Ap: number
  tanksVs3ApWithMr: number
  tanksVs3Ad: number
  tanksVs3AdWithArmor: number
  stasisAdviceForTanks: number
  playersVs3Ap: number
  playersVs3ApMrNeed: number
  playersVs3Ad: number
  playersVs3AdArmorNeed: number
  popularPlansWithBoots: number
  popularBootsNotTop: number
  trioNoDataMislabeled: number
  trioCards: number
  pickRankPercentile: number
}

export function summarize(players: PlayerEval[]): EvalMetrics {
  const adapted = (p: PlayerEval) => p.plans.find((plan) => plan.key === 'adapted') ?? p.plans[0]
  const all = players.flatMap((p) => p.plans)
  const owned = players.flatMap((p) => p.ownedPlans)
  const tanks = players.filter((p) => p.role === 'tank')
  const ranks = players.flatMap((p) => p.augments).filter((a) => a.rank != null && a.total > 1)
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  return {
    players: players.length,
    meanOverlapAdapted: avg(players.map((p) => adapted(p)?.overlap ?? 0)),
    meanOverlapBest: avg(players.map((p) => Math.max(0, ...p.plans.map((plan) => plan.overlap)))),
    mixedPlans: all.filter((plan) => plan.mixed).length,
    mixedOwnedPlans: owned.filter((plan) => plan.mixed).length,
    totalPlans: all.length,
    totalOwnedPlans: owned.length,
    illegalPlans: [...all, ...owned].filter((plan) => plan.illegal.length).length,
    bootsIssues: [...all, ...owned].filter((plan) => plan.bootsIssue).length,
    tanksVs3Ap: tanks.filter((p) => p.enemyApDealers >= 3).length,
    tanksVs3ApWithMr: tanks.filter((p) => p.enemyApDealers >= 3 && adapted(p)?.mr).length,
    tanksVs3Ad: tanks.filter((p) => p.enemyAdDealers >= 3).length,
    tanksVs3AdWithArmor: tanks.filter((p) => p.enemyAdDealers >= 3 && adapted(p)?.armor).length,
    stasisAdviceForTanks: players.filter((p) => p.adviceStasisForTank).length,
    playersVs3Ap: players.filter((p) => p.enemyApDealers >= 3).length,
    playersVs3ApMrNeed: players.filter((p) => p.enemyApDealers >= 3 && p.needs.mr >= 0.3).length,
    playersVs3Ad: players.filter((p) => p.enemyAdDealers >= 3).length,
    playersVs3AdArmorNeed: players.filter((p) => p.enemyAdDealers >= 3 && p.needs.armor >= 0.3).length,
    popularPlansWithBoots: all.filter((plan) => plan.popularBootsTop != null).length,
    popularBootsNotTop: all.filter((plan) => plan.popularBootsTop === false).length,
    trioNoDataMislabeled: players.reduce((sum, p) => sum + p.trioNoDataMislabeled, 0),
    trioCards: players.reduce((sum, p) => sum + p.trioCards, 0),
    pickRankPercentile: avg(ranks.map((a) => (a.rank! - 1) / (a.total - 1))),
  }
}
