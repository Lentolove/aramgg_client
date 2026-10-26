import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  STORED_ITEM_PROFILES,
  applyCardSynergy,
  getStoredAugmentProfile,
  recommendBuild,
  resolveAugmentProfile,
  scoreCardSynergy,
  type AugmentProfile,
} from '../../src/shared/recommendation/index.ts'
import { parseAugmentProfile, parseItemProfile } from '../../src/shared/recommendation/profiles.ts'
import { rankAugmentChoices } from '../../src/shared/augment-choice-ranking.ts'

const fixture = (id: number) => JSON.parse(readFileSync(new URL(`../fixtures/recommendation/champion-${id}.json`, import.meta.url), 'utf8'))
const profile = (id: number) => getStoredAugmentProfile(id) as AugmentProfile
const build = (championId: number, augmentIds: number[], extra: Record<string, unknown> = {}) => recommendBuild({
  builds: fixture(championId).builds,
  items: STORED_ITEM_PROFILES,
  augments: augmentIds.map(profile),
  ...extra,
})
const names = (result: ReturnType<typeof recommendBuild>) => result.items.map((item) => item.name)

describe('profile parsing', () => {
  it('reads native percent stats as stats, not scaling', () => {
    const parsed = parseAugmentProfile({ id: 1, name: '测试', description: '获得60%攻击速度。' })
    expect(parsed.grants.AS ?? 0).toBeGreaterThan(0)
    expect(parsed.source).toBe('parsed')
    expect(parsed.confidence).toBeLessThanOrEqual(0.7)
  })

  it('links upgrade augments to the named item', () => {
    const items = STORED_ITEM_PROFILES.map((item) => ({ id: item.id, name: item.name, priceTotal: item.priceTotal }))
    const parsed = parseAugmentProfile({ id: 2, name: '升级：中娅', description: '你的【中娅沙漏】获得强化。' }, items)
    expect(parsed.itemIds).toContain(3157)
    expect(parsed.itemBoost).toBeGreaterThan(0)
  })

  it('parses item stats and boots from the stats block', () => {
    const boots = STORED_ITEM_PROFILES.find((item) => item.id === 3006)!
    expect(boots.boots).toBe(true)
    const parsed = parseItemProfile({ id: 99, name: 'X', description: '<mainText><stats>40 法术强度<br>200 生命值</stats></mainText>', priceTotal: 2800 } as any)
    expect(parsed.stats.AP).toBe(40)
    expect(parsed.stats.HP).toBe(200)
  })

  it('every stored profile carries source and confidence; the top augments are reviewed', () => {
    const reviewed = [1048, 1318, 1004, 1152, 1013, 1007].map(profile)
    for (const entry of reviewed) {
      expect(entry.source).toBe('reviewed')
      expect(entry.confidence).toBeGreaterThan(0)
    }
  })

  it('falls back to runtime parsing for augments missing from the table', () => {
    const resolved = resolveAugmentProfile({ id: 987654, name: '新海克斯' }, { id: 987654, name: '新海克斯', description: '获得30法术强度。' })
    expect(resolved.source).toBe('parsed')
    expect(Object.keys(resolved.weights).length + Object.keys(resolved.grants).length).toBeGreaterThan(0)
  })
})

describe('recommendBuild', () => {
  it('reproduces the champion prior with no augments (6 items, one boots, no duplicates)', () => {
    const result = build(1, [])
    expect(result.items).toHaveLength(6)
    expect(result.items.filter((item) => item.boots)).toHaveLength(1)
    expect(new Set(result.items.map((item) => item.itemId)).size).toBe(6)
    expect(result.archetype?.label).toBe('AP')
    expect(result.items.every((item) => item.change == null)).toBe(true)
  })

  it('upgrade augments put the named item into the build with a visible change', () => {
    const result = build(1, [1318]) // 升级：中娅
    const zhonya = result.items.find((item) => item.itemId === 3157)
    expect(zhonya).toBeDefined()
    expect(zhonya!.change).toBe('new')
    expect(zhonya!.drivers.join()).toContain('中娅')
    expect(result.items.indexOf(zhonya!)).toBeLessThan(3)
  })

  it('tank augments flip a Malphite AP build to the tank route', () => {
    expect(build(54, []).archetype?.label).not.toBe('Tank')
    const tank = build(54, [1013, 1152]) // 星界躯体 + 钢化你心
    expect(tank.archetype?.label).toBe('Tank')
    expect(tank.items.map((item) => item.itemId)).toContain(3084)
  })

  it('crit augments change an Annie build without turning it into an ADC build', () => {
    const base = names(build(1, []))
    const crit = build(1, [1048])
    expect(names(crit)).not.toEqual(base)
    expect(crit.items.some((item) => item.change === 'new')).toBe(true)
    // 仍然是法师装为主
    const apItems = crit.items.filter((item) => (item.score.prior > 0))
    expect(apItems.length).toBeGreaterThanOrEqual(4)
  })

  it('respects constraints when augments push many similar items', () => {
    const result = build(157, [1022, 1007, 1048])
    expect(result.items.filter((item) => item.boots)).toHaveLength(1)
    expect(new Set(result.items.map((item) => item.itemId)).size).toBe(result.items.length)
  })

  it('marks owned items and recommends the next unowned item', () => {
    const base = build(1, [])
    const first = base.items[0].itemId
    const result = build(1, [], { ownedItemIds: [first] })
    expect(result.items.find((item) => item.itemId === first)?.owned).toBe(true)
    const next = result.items.find((item) => item.isNext)
    expect(next).toBeDefined()
    expect(next!.owned).toBe(false)
    expect(result.nextItemId).toBe(next!.itemId)
  })

  it('explains every item with reasons and a score breakdown', () => {
    for (const item of build(22, [1022, 1007]).items) {
      expect(item.reasons.length).toBeGreaterThan(0)
      expect(Math.abs(item.score.total - (item.score.prior + item.score.synergy + item.score.progress + item.score.enemy))).toBeLessThanOrEqual(0.21)
    }
  })
})

describe('card synergy', () => {
  it('adjusts the win-rate ranking within the ±5pp cap and explains it', () => {
    const engine = build(54, [1013])
    const cards = [
      { id: 1152, name: '钢化你心', slot: 0, detectedSlot: 0, winRate: 0.5, games: 2000, wins: 1000 },
      { id: 1007, name: '大力', slot: 1, detectedSlot: 1, winRate: 0.502, games: 2000, wins: 1004 },
    ]
    const base = rankAugmentChoices(cards as any, [], { alpha: 300 })
    const ranked = applyCardSynergy(base, (card: any) => scoreCardSynergy(profile(Number(card.id)), [profile(1013)], engine.context))
    const heart = ranked.choices.find((choice) => choice.card.id === 1152)!
    const strength = ranked.choices.find((choice) => choice.card.id === 1007)!
    expect(heart.synergy!.score).toBeGreaterThan(strength.synergy!.score)
    for (const choice of ranked.choices) {
      expect(Math.abs((choice.combinedWinRate ?? 0) - (choice.shrunkWinRate ?? 0))).toBeLessThanOrEqual(0.05 + 1e-9)
      expect(choice.plainReason.length).toBeGreaterThan(0)
      expect(['S', 'A', 'B', 'C']).toContain(choice.tier)
    }
    // 胜率几乎一样时，契合更高的卡排第一
    expect(ranked.choices[0].card.id).toBe(1152)
  })
})
