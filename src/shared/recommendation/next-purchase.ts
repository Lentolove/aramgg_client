/**
 * 「下一件买什么」：按已有装备（含散件）和当前金币，把下一件大件拆成「现在能买的那一步」。
 * 金币来自 Live Client Data（2999 activePlayer.currentGold）；没有金币时只给目标大件。纯函数。
 */
import type { ItemProfile } from './profiles.ts'

export interface NextPurchase {
  targetId: number
  /** 现在该买的：targetId 本身（钱够）或其某个组件；null = 钱不够买任何组件 */
  buyId: number | null
  /** 扣掉已有散件后，合成目标还要多少金 */
  remainingCost: number
  /** 当前金币（未知为 null） */
  gold: number | null
  /** 一句话：例如「钱够了，回家买「无尽之刃」」「差 900 金，先买「暴风之剑」」 */
  text: string
}

function treeOf(id: number, index: Map<number, ItemProfile>, depth = 0): number[] {
  const item = index.get(id)
  if (!item || depth > 4) return []
  return item.from.flatMap((child) => [child, ...treeOf(child, index, depth + 1)])
}

export function planNextPurchase(
  targetId: number | null | undefined,
  index: Map<number, ItemProfile>,
  ownedItemIds: number[],
  gold: number | null | undefined,
): NextPurchase | null {
  if (targetId == null) return null
  const target = index.get(targetId)
  if (!target) return null
  const name = (id: number) => index.get(id)?.name ?? String(id)
  // 已有散件按「最大的先抵扣」：大组件包含小组件时不重复计
  const spare = [...ownedItemIds]
  const credited: number[] = []
  const consume = (id: number): boolean => {
    const at = spare.indexOf(id)
    if (at >= 0) { spare.splice(at, 1); credited.push(id); return true }
    return false
  }
  const missingParts: number[] = []
  const walk = (id: number) => {
    for (const child of index.get(id)?.from ?? []) {
      if (!consume(child)) { missingParts.push(child); walk(child) }
    }
  }
  walk(targetId)
  const creditedGold = credited.reduce((sum, id) => sum + (index.get(id)?.priceTotal ?? 0), 0)
  const remainingCost = Math.max(0, target.priceTotal - creditedGold)
  const money = gold != null && Number.isFinite(gold) ? Math.floor(gold) : null
  if (money == null) {
    return { targetId, buyId: null, remainingCost, gold: null, text: `下一件「${target.name}」${credited.length ? `，还差 ${remainingCost} 金` : ''}` }
  }
  if (money >= remainingCost) {
    return { targetId, buyId: targetId, remainingCost, gold: money, text: `钱够了，回家买「${target.name}」` }
  }
  // 买得起的最贵组件（只考虑还没有的）
  const affordable = [...new Set(missingParts.length ? missingParts : treeOf(targetId, index))]
    .map((id) => index.get(id))
    .filter((item): item is ItemProfile => !!item && item.priceTotal > 0 && item.priceTotal <= money)
    .sort((a, b) => b.priceTotal - a.priceTotal)[0]
  const short = remainingCost - money
  return {
    targetId,
    buyId: affordable?.id ?? null,
    remainingCost,
    gold: money,
    text: affordable ? `「${target.name}」差 ${short} 金，先买「${name(affordable.id)}」` : `「${target.name}」差 ${short} 金，先攒钱`,
  }
}
