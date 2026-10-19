/**
 * arammeta 出装路线（itemClusters）→ 出装引擎用的 ChampionBuildLike（与 dtodo builds 同一形状，引擎不用区分来源）。
 *
 *   核心 2 件（core）   → coreItems（该路线全部场次都有）
 *   搭配选项（options） → situationalItems（每件都有「本路线里出了这件」的场次与胜率）
 *   路线鞋（routeBoot） → situationalItems
 *   英雄级鞋子统计      → situationalItems（场次按路线占比折算）
 *   常见尾件（tail）    → situationalItems（arammeta 没给场次：记为路线 3% 场次、路线平均胜率）
 */

import type { ChampionBuildLike } from '../recommendation/build-engine.ts'
import type { ArammetaChampion, ArammetaItemStat } from './normalize.ts'

export interface ArammetaBuild extends ChampionBuildLike {
  source: 'arammeta'
  routeIndex: number
}

export function arammetaToBuilds(champion: ArammetaChampion | null, itemName: (id: number) => string | undefined = () => undefined): ArammetaBuild[] {
  if (!champion?.routes.length) return []
  const labelCount = new Map<string, number>()
  for (const route of champion.routes) labelCount.set(route.label, (labelCount.get(route.label) ?? 0) + 1)
  return champion.routes.map((route, routeIndex) => {
    const wins = route.wr * route.g
    const seen = new Set<number>(route.core)
    const situational: Array<{ itemId: number; games: number; wins: number; estimated?: boolean }> = []
    const push = (itemId: number, games: number, winRate: number, estimated = false) => {
      if (seen.has(itemId) || games <= 0) return
      seen.add(itemId)
      situational.push({ itemId, games: Math.round(games), wins: Math.round(winRate * games), ...(estimated ? { estimated: true } : {}) })
    }
    for (const option of route.options) push(option.id, option.g, option.wr)
    if (route.boot) push(route.boot.id, route.boot.g, route.boot.wr)
    for (const boot of champion.boots as ArammetaItemStat[]) push(boot.ids[0], boot.g * route.pick, boot.wr, true)
    for (const id of route.completion) push(id, route.completionGames, route.wr, true)
    for (const id of route.tail) push(id, route.g * 0.03, route.wr, true)
    // 同名路线（例如两条「AP爆发/AP燃烧」）用核心装备区分
    const coreNames = route.core.map((id) => itemName(id)).filter(Boolean).join('+')
    const label = (labelCount.get(route.label) ?? 0) > 1 && coreNames ? `${route.label}（${coreNames}）` : route.label
    return {
      source: 'arammeta' as const,
      routeIndex,
      buildTags: label,
      games: route.g,
      wins,
      winRate: route.wr,
      // 鞋：该英雄各鞋子出场率之和（路线鞋的选取率只是「出鞋的局里选这双」）
      bootsShare: Math.min(1, (champion.boots as ArammetaItemStat[]).reduce((sum, boot) => sum + boot.pick, 0)),
      coreItems: [{ itemIds: route.core, games: route.g, wins }],
      situationalItems: situational,
    }
  })
}
