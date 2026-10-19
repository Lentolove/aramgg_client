import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  STORED_ITEM_PROFILES,
  applySwap,
  generateBuildPlans,
  getStoredAugmentProfile,
  planDifference,
  planSignature,
  recommendBuild,
  resolvePlan,
  type AugmentProfile,
} from '../../src/shared/recommendation/index.ts'

const builds = (id: number) => JSON.parse(readFileSync(new URL(`../fixtures/recommendation/champion-${id}.json`, import.meta.url), 'utf8')).builds
const profile = (id: number) => getStoredAugmentProfile(id) as AugmentProfile
const input = (championId: number, augmentIds: number[] = []) => ({
  builds: builds(championId),
  items: STORED_ITEM_PROFILES,
  augments: augmentIds.map(profile),
})

describe('generateBuildPlans', () => {
  it('without augments offers 主流 first and a data-only 高胜率 plan', () => {
    const plans = generateBuildPlans(input(54))
    expect(plans.map((plan) => plan.key)).toEqual(['popular', 'winrate'])
    expect(plans[0].routeLabel).toBe('法强')
    expect(plans[1].routeLabel).toBe('坦克') // 坦克路线收缩胜率更高
    expect(plans.every((plan) => !plan.usesAugments)).toBe(true)
  })

  it('adds 局势适配 first and an alternate-route plan when augments switch the archetype', () => {
    const plans = generateBuildPlans(input(54, [1013, 1152]))
    expect(plans[0].key).toBe('adapted')
    expect(plans[0].routeLabel).toBe('坦克')
    const alternate = plans.find((plan) => plan.key === 'alternate')
    expect(alternate?.label).toBe('法强流')
    expect(alternate?.routeLabel).toBe('法强')
    expect(alternate?.usesAugments).toBe(true)
  })

  it('does not add an alternate plan when the archetype stays the same', () => {
    const plans = generateBuildPlans(input(1, [1048, 1415]))
    expect(plans.some((plan) => plan.key === 'alternate')).toBe(false)
    expect(plans[0].key).toBe('adapted')
  })

  it('merges identical plans and keeps the merged label as an alias', () => {
    const plans = generateBuildPlans(input(157)) // 亚索：主流路线本身就是胜率最高的
    const signatures = plans.map((plan) => planSignature(plan.result))
    expect(new Set(signatures).size).toBe(signatures.length)
    const popular = plans.find((plan) => plan.key === 'popular')!
    if (plans.length === 1) expect(popular.aliases).toContain('高胜率')
  })

  it('the 高胜率 plan only uses its own route (no off-route boots)', () => {
    const winrate = generateBuildPlans(input(54)).find((plan) => plan.key === 'winrate')!
    expect(winrate.result.items.filter((item) => item.boots)).toHaveLength(1)
    expect(winrate.result.items.some((item) => item.name === '法师之靴')).toBe(false)
  })

  it('resolvePlan falls back to the plan a merged label went into, then to the first plan', () => {
    const plans = generateBuildPlans(input(157))
    expect(resolvePlan(plans, 'winrate')?.key).toBe(plans.find((plan) => plan.key === 'winrate' || plan.aliases.includes('高胜率'))!.key)
    expect(resolvePlan(plans, 'alternate')?.key).toBe(plans[0].key)
    expect(resolvePlan([], 'adapted')).toBeNull()
  })

  it('planDifference counts items that differ regardless of order', () => {
    const plans = generateBuildPlans(input(54, [1013, 1152]))
    const adapted = plans.find((plan) => plan.key === 'adapted')!
    const popular = plans.find((plan) => plan.key === 'popular')!
    expect(planDifference(adapted.result, adapted.result)).toBe(0)
    expect(planDifference(popular.result, adapted.result)).toBeGreaterThanOrEqual(3)
  })
})

describe('slot alternatives and swaps', () => {
  it('lists compatible alternatives per slot (same boots-ness, not already in the build)', () => {
    const result = recommendBuild(input(1, [1048]))
    for (const item of result.items) {
      expect(item.alternatives.length).toBeGreaterThan(0)
      for (const alt of item.alternatives) {
        expect(result.items.some((other) => other.itemId === alt.itemId)).toBe(false)
        const profileOf = STORED_ITEM_PROFILES.find((entry) => entry.id === alt.itemId)!
        expect(profileOf.boots).toBe(item.boots)
        expect(alt.reason.length).toBeGreaterThan(0)
      }
    }
  })

  it('swaps in place, keeps other slots, and moves next-item when the next slot is swapped', () => {
    const base = recommendBuild(input(1, [1048]))
    const target = base.items[0]
    const alt = target.alternatives[0]
    const swapped = recommendBuild({ ...input(1, [1048]), swaps: [{ from: target.itemId, to: alt.itemId }] })
    expect(swapped.items[0].itemId).toBe(alt.itemId)
    expect(swapped.items[0].swappedFrom).toBe(target.itemId)
    expect(swapped.items[0].reasons[0]).toContain('手动换上')
    expect(swapped.items.slice(1).map((item) => item.itemId)).toEqual(base.items.slice(1).map((item) => item.itemId))
    expect(swapped.nextItemId).toBe(alt.itemId)
    // 换过的格：原推荐排第一，方便换回
    expect(swapped.items[0].alternatives[0].itemId).toBe(target.itemId)
  })

  it('ignores invalid swaps (boots for non-boots, owned items, items already in the build)', () => {
    const base = recommendBuild(input(1))
    const boots = base.items.find((item) => item.boots)!
    const other = base.items.find((item) => !item.boots)!
    const order = (result: ReturnType<typeof recommendBuild>) => result.items.map((item) => item.itemId)
    expect(order(recommendBuild({ ...input(1), swaps: [{ from: other.itemId, to: boots.alternatives[0].itemId }] }))).toEqual(order(base))
    expect(order(recommendBuild({ ...input(1), swaps: [{ from: other.itemId, to: base.items[5].itemId }] }))).toEqual(order(base))
    const owned = recommendBuild({ ...input(1), ownedItemIds: [other.itemId], swaps: [{ from: other.itemId, to: other.alternatives[0].itemId }] })
    expect(owned.items.some((item) => item.itemId === other.itemId && item.owned)).toBe(true)
  })

  it('applySwap updates the same slot and removes the swap when swapping back', () => {
    let swaps = applySwap([], 100, null, 200)
    expect(swaps).toEqual([{ from: 100, to: 200 }])
    swaps = applySwap(swaps, 200, 100, 300)
    expect(swaps).toEqual([{ from: 100, to: 300 }])
    swaps = applySwap(swaps, 300, 100, 100)
    expect(swaps).toEqual([])
  })

  it('swaps are per plan', () => {
    const plain = generateBuildPlans(input(54, [1013, 1152]))
    const adapted = plain.find((plan) => plan.key === 'adapted')!
    const slot = adapted.result.items[2]
    const plans = generateBuildPlans(input(54, [1013, 1152]), { swaps: { adapted: [{ from: slot.itemId, to: slot.alternatives[0].itemId }] } })
    expect(plans.find((plan) => plan.key === 'adapted')!.result.items[2].itemId).toBe(slot.alternatives[0].itemId)
    expect(planSignature(plans.find((plan) => plan.key === 'popular')!.result)).toBe(planSignature(plain.find((plan) => plan.key === 'popular')!.result))
  })
})
