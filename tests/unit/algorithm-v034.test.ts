/**
 * v0.3.4 算法：海克斯属性标签、按轮相对定档、同路线（已选/同轮备选）、按金币拆「下一件」。
 */
import { describe, expect, it } from 'vitest'
import { deriveAugmentTags, tagsFromText } from '../../src/shared/recommendation/augment-tags.ts'
import { getStoredAugmentProfile } from '../../src/shared/recommendation/index.ts'
import { applyCardSynergy, relativeTiers, scoreCardSynergy, sharedRouteTags } from '../../src/shared/recommendation/augment-synergy.ts'
import { planNextPurchase } from '../../src/shared/recommendation/next-purchase.ts'
import { STORED_ITEM_PROFILES, buildItemProfileIndex } from '../../src/shared/recommendation/index.ts'

describe('A. 海克斯属性标签', () => {
  it('从中文描述识别魔抗/护甲/护盾/控制/保命，忽略「目标的」「击碎」「基于」', () => {
    expect(tagsFromText('你获得12护甲和魔法抗性')).toEqual(expect.arrayContaining(['MR', 'ARMOR']))
    expect(tagsFromText('施加一层护甲和魔法抗性击碎效果')).not.toContain('MR')
    expect(tagsFromText('获得治疗和护盾强度，基于额外护甲和魔抗')).not.toContain('ARMOR')
    expect(tagsFromText('造成相当于目标最大生命值的伤害')).not.toContain('TANK')
    expect(tagsFromText('你和附近的友军们进入免疫伤害状态')).toContain('SURVIVE')
    expect(tagsFromText('获得50移动速度和40%减速抗性')).not.toContain('MR')
    expect(tagsFromText('眩晕附近的敌人')).toContain('CC')
  })
  it('人工复核可补/删标签', () => {
    expect(deriveAugmentTags({ grants: {}, weights: {}, mechanics: [] }, '', { tags: ['TANK'] })).toEqual(['TANK'])
    expect(deriveAugmentTags({ grants: { MR: 1 }, weights: {}, mechanics: [] }, '', { removeTags: ['MR'] })).toEqual([])
  })
  it('打包数据带标签：双抗类卡有 MR+ARMOR，钢化你心是坦度', () => {
    expect(getStoredAugmentProfile(1063)!.tags).toEqual(expect.arrayContaining(['MR', 'ARMOR']))
    expect(getStoredAugmentProfile(1152)!.tags).toContain('TANK')
    expect(getStoredAugmentProfile(1028)!.tags).not.toContain('MR')
  })
})

describe('B. 按这一轮的相对差距定档', () => {
  it('明显领先的第一名升一档，落后的降档', () => {
    expect(relativeTiers([1.9, 0.0, -1.1])).toEqual(['A', 'B', 'B'])
    expect(relativeTiers([3, 2.6, -0.5])).toEqual(['A', 'A', 'B'])
    expect(relativeTiers([1.0, -2.5, -3])).toEqual(['A', 'C', 'C'])
    expect(relativeTiers([5.1, 1.7, 0.7])).toEqual(['S', 'B', 'B'])
  })
  it('三张都差不会全 S，三张都好不会出现 C', () => {
    const bad = relativeTiers([-3, -3.5, -6])
    expect(bad).not.toContain('S')
    expect(bad).toEqual(['C', 'C', 'C'])
    const good = relativeTiers([9, 6.5, 6])
    expect(good).not.toContain('C')
    expect(good[0]).toBe('S')
  })
  it('分数接近时同档；null 保持 null', () => {
    expect(relativeTiers([0.5, 0.3, null])).toEqual(['B', 'B', null])
  })
})

describe('C. 同路线：已选海克斯加分、同轮备选只提示', () => {
  const ctx: any = { ownedItemIds: [], plannedItemIds: [], itemIndex: new Map(), archetypeVector: {}, damageType: 'AD', team: null }
  const mk = (id: number, tags: string[], name = `卡${id}`): any => ({ id, name, weights: {}, grants: {}, mechanics: [], itemIds: [], itemBoost: 0, antiMechanics: [], source: 'parsed', confidence: 0.5, tags })
  it('与已选同为攻速 → 加分并说明；不同路线不加', () => {
    const held = [mk(1, ['AS'], '灵巧')]
    const same = scoreCardSynergy(mk(2, ['AS', 'CRIT']), held, ctx)
    const other = scoreCardSynergy(mk(3, ['AP']), held, ctx)
    expect(same.parts.held).toBeGreaterThan(0)
    expect(same.reasons.join()).toContain('灵巧')
    expect(other.parts.held).toBe(0)
    expect(sharedRouteTags(mk(4, ['AP', 'AD']), mk(5, ['AP', 'AD']))).toEqual(['AP'])
  })
  it('同轮两张同路线：给 rollNote，不改分数', () => {
    const cards = [mk(10, ['AS'], '甲'), mk(11, ['AS'], '乙'), mk(12, ['TANK'], '丙')]
    const ranking: any = {
      method: 'shrunk', baselineWinRate: 0.5, baselineGames: 1000, alpha: 300, topTie: false, summary: '',
      choices: cards.map((card, i) => ({ card, slot: i, method: 'shrunk', shrunkWinRate: 0.52 - i * 0.01, rawWinRate: null, delta: 0, standardError: 0.001, games: 1000, order: i, relativeLabel: null, note: '' })),
    }
    const base = applyCardSynergy(ranking, () => null)
    const withNote = applyCardSynergy(ranking, () => null, { profileOf: (card: any) => card })
    expect(withNote.choices.map((c) => c.points)).toEqual(base.choices.map((c) => c.points))
    expect(withNote.choices.find((c) => c.card.id === 10)!.rollNote).toContain('乙')
    expect(withNote.choices.find((c) => c.card.id === 12)!.rollNote).toBeNull()
  })
})

describe('D. 下一件按金币拆步骤', () => {
  const index = buildItemProfileIndex(STORED_ITEM_PROFILES as any)
  const ie = 3031
  it('钱够直接买；不够先买最贵的买得起的组件；已有散件抵扣', () => {
    const price = index.get(ie)!.priceTotal
    expect(planNextPurchase(ie, index, [], price)!.buyId).toBe(ie)
    const poor = planNextPurchase(ie, index, [], 1400)!
    expect(poor.buyId).not.toBe(ie)
    expect(index.get(poor.buyId!)!.priceTotal).toBeLessThanOrEqual(1400)
    expect(poor.text).toMatch(/差 \d+ 金，先买/)
    const comp = index.get(ie)!.from[0]
    const withPart = planNextPurchase(ie, index, [comp], null)!
    expect(withPart.remainingCost).toBe(price - index.get(comp)!.priceTotal)
    expect(withPart.gold).toBeNull()
  })
})
