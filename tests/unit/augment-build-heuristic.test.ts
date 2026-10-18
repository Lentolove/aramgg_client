import { describe, expect, it } from 'vitest'
import {
  buildItemIndex,
  findReferencedItems,
  parseLiveClientPlayers,
  recommendBuildForAugments,
  stripHtml,
  summarizeEnemyDamage,
  tagAugment,
  tagItem,
} from '../../src/shared/augment-build-heuristic.ts'

// 摘自 data.dtodo.cn items.json / augments.json（2026-10，16.20）的真实字段形状
const items = [
  { id: 1001, name: '鞋子', priceTotal: 300, categories: ['Boots'], inStore: true },
  { id: 2003, name: '生命药水', priceTotal: 50, categories: ['Consumable'], inStore: true },
  { id: 3157, name: '中娅沙漏', priceTotal: 3250, categories: ['SpellDamage', 'Armor'], inStore: true },
  { id: 3111, name: '水银之靴', priceTotal: 1250, categories: ['Boots', 'SpellBlock'], inStore: true },
  { id: 3089, name: '灭世者的死亡之帽', priceTotal: 3600, categories: ['SpellDamage'], inStore: true },
  { id: 3118, name: '残疫', priceTotal: 2900, categories: ['SpellDamage', 'AbilityHaste', 'Mana'], inStore: true },
  { id: 3020, name: '法师之靴', priceTotal: 1100, categories: ['Boots', 'MagicPenetration'], inStore: true },
  { id: 4646, name: '风暴狂涌', priceTotal: 2900, categories: ['SpellDamage', 'MagicPenetration'], inStore: true },
  { id: 6653, name: '兰德里的折磨', priceTotal: 3000, categories: ['SpellDamage', 'Health', 'AbilityHaste'], inStore: true },
  { id: 4645, name: '影焰', priceTotal: 3200, categories: ['SpellDamage', 'MagicPenetration'], inStore: true },
  { id: 3065, name: '振奋盔甲', priceTotal: 2700, categories: ['Health', 'SpellBlock', 'AbilityHaste'], inStore: true },
  { id: 3031, name: '无尽之刃', priceTotal: 3450, categories: ['Damage', 'CriticalStrike'], inStore: true },
  { id: 3153, name: '破败王者之刃', priceTotal: 3200, categories: ['Damage', 'AttackSpeed', 'LifeSteal', 'OnHit'], inStore: true },
]

const zhonya = {
  id: 1318,
  name: '升级：中娅',
  description: '<attention>【中娅沙漏】</attention>的冷却时间降低至45秒。你现在可以在<attention>【中娅沙漏】、【探索者的护臂】</attention>或<attention>【沃格勒特的巫师帽】</attention>凝滞状态持续期间移动并获得<speed>移动速度</speed>。<br><br>获得<gold>250金币</gold>。',
}

const builds = [
  {
    coreItems: [
      { itemIds: [3118, 3020, 4646], games: 2443, winRate: 0.503 },
      { itemIds: [3118, 3020, 6653], games: 2242, winRate: 0.555 },
    ],
    fullItems: [],
    itemExtensions: [
      { coreItemIds: [3020, 3118, 4646], step: 1, itemIds: [4645], games: 300 },
      { coreItemIds: [3020, 3118, 6653], step: 1, itemIds: [3089], games: 200 },
    ],
    situationalItems: [
      { id: 4645, games: 12938, pickRate: 0.6 },
      { id: 3089, games: 5995, pickRate: 0.28 },
      { id: 3065, games: 900, pickRate: 0.04 },
      { id: 3157, games: 800, pickRate: 0.03 },
    ],
  },
]

describe('augment build heuristic: tagging', () => {
  it('strips html', () => {
    expect(stripHtml('<a>x</a><br>y')).toBe('x y')
  })

  it('tags augments from html scale tags and Chinese keywords', () => {
    expect(tagAugment({ description: '获得<scaleAP>30法术强度</scaleAP>' })).toContain('AP')
    expect(tagAugment({ description: '获得30%攻击速度和20%暴击几率' })).toEqual(expect.arrayContaining(['AS', 'CRIT']))
    expect(tagAugment({ description: '获得<scaleHealth>500生命值</scaleHealth>与<scaleArmor>护甲</scaleArmor>' }))
      .toEqual(expect.arrayContaining(['HEALTH', 'ARMOR']))
    expect(tagAugment({ description: '获得 20 技能急速' })).toEqual(['HASTE'])
    expect(tagAugment({ description: '获得 10% 护甲穿透' })).toEqual(['LETHALITY'])
    expect(tagAugment({ description: '' })).toEqual([])
  })

  it('tags items from categories', () => {
    expect(tagItem(items.find((item) => item.id === 3031))).toEqual(['AD', 'CRIT'])
    expect(tagItem({ id: 1, description: '<stats>40 法术强度</stats>' })).toEqual(['AP'])
  })
})

describe('augment build heuristic: item references', () => {
  it('finds items named in an augment description, ignoring cheap/consumable items', () => {
    const index = buildItemIndex(items)
    expect(findReferencedItems(zhonya, index)).toEqual([3157])
    expect(findReferencedItems({ name: '鞋子大师', description: '购买鞋子和生命药水' }, index)).toEqual([])
  })
})

describe('augment build heuristic: recommendation', () => {
  it('puts the referenced item first with a reason', () => {
    const result = recommendBuildForAugments({ pickedAugments: [zhonya], builds, items })
    expect(result.items[0].itemId).toBe(3157)
    expect(result.items[0].source).toBe('augment-reference')
    expect(result.items[0].reasons[0]).toContain('因为选了「升级：中娅」')
    expect(result.items[0].isNext).toBe(true)
  })

  it('keeps the most common route when no augments are picked', () => {
    const result = recommendBuildForAugments({ pickedAugments: [], builds, items })
    expect(result.route?.itemIds).toEqual([3118, 3020, 4646])
    expect(result.items.slice(0, 3).map((item) => item.itemId)).toEqual([3118, 3020, 4646])
    expect(result.notes.join()).toContain('还没有选择海克斯')
  })

  it('reranks routes by augment stat tags and explains why', () => {
    const result = recommendBuildForAugments({
      pickedAugments: [{ name: '坚如磐石', description: '获得<scaleHealth>600最大生命值</scaleHealth>' }],
      builds,
      items,
    })
    expect(result.route?.itemIds).toEqual([3118, 3020, 6653])
    const liandry = result.items.find((item) => item.itemId === 6653)
    expect(liandry?.reasons.join()).toContain('因为选了「坚如磐石」')
    expect(liandry?.reasons.join()).toContain('生命值')
    // 与 6653 核心对应的后续装
    expect(result.items.some((item) => item.itemId === 3089 && item.source !== 'situational')).toBe(true)
    // 匹配生命值的可选装被上提
    expect(result.items.some((item) => item.itemId === 3065 && item.source === 'situational')).toBe(true)
  })

  it('marks owned items and highlights the first missing one', () => {
    const result = recommendBuildForAugments({ pickedAugments: [], builds, items, ownedItemIds: [3118, '3020'] })
    expect(result.items[0].owned).toBe(true)
    expect(result.items[1].owned).toBe(true)
    expect(result.nextItemId).toBe(4646)
    expect(result.items.filter((item) => item.isNext)).toHaveLength(1)
  })

  it('adds a defensive item when enemies are clearly AP-heavy', () => {
    const index = buildItemIndex(items)
    const enemyDamage = summarizeEnemyDamage([3089, 3089, 4645, 3118, 6653, 3031], index)
    expect(enemyDamage.dominant).toBe('AP')
    const result = recommendBuildForAugments({ pickedAugments: [], builds, items, enemyDamage })
    const defense = result.items.find((item) => item.source === 'defense')
    expect(defense?.itemId).toBe(3065)
    expect(defense?.reasons[0]).toContain('法术伤害')
  })

  it('does not decide on a mixed enemy team', () => {
    const index = buildItemIndex(items)
    expect(summarizeEnemyDamage([3089, 3031, 4645, 3153], index).dominant).toBeNull()
    expect(summarizeEnemyDamage([3089], index).dominant).toBeNull()
  })

  it('handles missing build data', () => {
    const result = recommendBuildForAugments({ pickedAugments: [zhonya], builds: [], items: {} })
    expect(result.items).toEqual([])
    expect(result.route).toBeNull()
    expect(result.notes.join()).toContain('没有可用的出装路线')
  })

  it('accepts renderer-mapped item records with localized names and string ids', () => {
    const mapped = Object.fromEntries(items.map((item) => [String(item.id), {
      ...item,
      id: String(item.id),
      name: { zh_cn: item.name, en_us: item.name },
    }]))
    const result = recommendBuildForAugments({
      pickedAugments: [zhonya],
      builds: [{ coreItems: [{ itemIds: ['3118', '3020', '4646'] }] }],
      items: mapped,
    })
    expect(result.items.map((item) => item.itemId)).toEqual([3157, 3118, 3020, 4646])
    expect(result.items[0].name).toBe('中娅沙漏')
  })
})

describe('live client parsing', () => {
  it('finds the active player by riotId and splits own/enemy items', () => {
    const parsed = parseLiveClientPlayers(
      { riotId: 'Me#CN1', summonerName: 'Me#CN1' },
      [
        { riotId: 'Me#CN1', championName: '安妮', team: 'ORDER', items: [{ itemID: 3118 }, { itemID: 1001 }] },
        { riotId: 'Ally#1', team: 'ORDER', items: [{ itemID: 3031 }] },
        { riotId: 'Foe#1', championName: '阿卡丽', team: 'CHAOS', items: [{ itemID: 3089 }] },
      ],
    )
    expect(parsed.found).toBe(true)
    expect(parsed.ownedItemIds).toEqual([3118, 1001])
    expect(parsed.enemyItemIds).toEqual([3089])
    expect(parsed.enemyChampionNames).toEqual(['阿卡丽'])
  })

  it('reports not found when the player is missing', () => {
    expect(parseLiveClientPlayers({ riotId: 'X' }, []).found).toBe(false)
    expect(parseLiveClientPlayers(null, null).found).toBe(false)
  })
})

describe('augment build heuristic: item-specific augments', () => {
  it('does not let an item-upgrade augment skew stat tags, and drops components of referenced items', () => {
    const withComponent = [
      ...items,
      { id: 3191, name: '探索者的护臂', priceTotal: 1100, categories: ['SpellDamage', 'Armor'], inStore: true, to: [3157] },
    ]
    const index = buildItemIndex(withComponent)
    expect(findReferencedItems(zhonya, index)).toEqual([3157])
    const result = recommendBuildForAugments({ pickedAugments: [zhonya], builds, items: withComponent })
    expect(result.tagWeights).toEqual({})
    expect(result.route?.itemIds).toEqual([3118, 3020, 4646])
  })
})

describe('augment build heuristic: limits', () => {
  it('never lets maxItems drop the defensive suggestion', () => {
    const index = buildItemIndex(items)
    const enemyDamage = summarizeEnemyDamage([3089, 3089, 4645, 3118, 6653], index)
    const result = recommendBuildForAugments({ pickedAugments: [], builds, items, enemyDamage, maxItems: 3 })
    expect(result.items).toHaveLength(3)
    expect(result.items[2].source).toBe('defense')
  })

  it('does not repeat the same augment reason for an item from two sources', () => {
    const result = recommendBuildForAugments({
      pickedAugments: [{ name: '坚如磐石', description: '获得<scaleHealth>600最大生命值</scaleHealth>' }],
      builds: [{
        coreItems: [{ itemIds: [3118, 3020, 6653] }],
        itemExtensions: [{ coreItemIds: [3020, 3118, 6653], itemIds: [3065], games: 10 }],
        situationalItems: [{ id: 3065, pickRate: 0.1 }],
      }],
      items,
    })
    const item = result.items.find((entry) => entry.itemId === 3065)
    expect(item?.reasons.filter((reason) => reason.startsWith('因为选了'))).toHaveLength(1)
  })
})
