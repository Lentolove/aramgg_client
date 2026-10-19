import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ADAPTED_LABEL,
  CHAMPION_PROFILES,
  STORED_ITEM_PROFILES,
  adviseTeamComp,
  analyzeTeamComp,
  buildItemProfileIndex,
  championRouteFlex,
  findChampionProfile,
  generateBuildPlans,
  getStoredAugmentProfile,
  recommendBuild,
  scoreCardSynergy,
  type AugmentProfile,
  type TeamPlayerInput,
} from '../../src/shared/recommendation/index.ts'
import { parseLiveClientPlayers } from '../../src/shared/augment-build-heuristic.ts'

const builds = (id: number) => JSON.parse(readFileSync(new URL(`../fixtures/recommendation/champion-${id}.json`, import.meta.url), 'utf8')).builds
const itemIndex = buildItemProfileIndex(STORED_ITEM_PROFILES)
const players = (keys: string[], self?: string): TeamPlayerInput[] => keys.map((key) => ({ championKey: key, isSelf: key === self }))
const comp = (self: string, allies: string[], enemies: string[]) => analyzeTeamComp({ allies: players([self, ...allies], self), enemies: players(enemies), itemIndex })
const ids = (result: { items: Array<{ itemId: number }> }) => result.items.map((item) => item.itemId)

const MALPHITE_ALLIES = ['Lux', 'Ezreal', 'Jinx', 'Xerath'] // 缺前排
const AP_HEALERS = ['Soraka', 'Vladimir', 'Swain', 'Brand', 'Jinx']
const AD_HEAVY = ['Zed', 'Draven', 'Darius', 'Caitlyn', 'Lux']

describe('champion profiles', () => {
  it('covers every champion with versioned, sourced entries', () => {
    expect(CHAMPION_PROFILES.length).toBeGreaterThanOrEqual(170)
    expect(CHAMPION_PROFILES.filter((profile) => profile.source === 'curated').length).toBeGreaterThanOrEqual(60)
    for (const profile of CHAMPION_PROFILES) {
      expect(profile.damage.ap + profile.damage.ad + profile.damage.true).toBeCloseTo(1, 1)
      expect(profile.confidence).toBeGreaterThan(0)
    }
  })

  it('finds champions by id, DDragon key, 2999 rawChampionName and localized names', () => {
    expect(findChampionProfile({ championId: 54 })?.key).toBe('Malphite')
    expect(findChampionProfile({ rawChampionName: 'game_character_displayname_MonkeyKing' })?.key).toBe('MonkeyKing')
    expect(findChampionProfile({ championName: 'Wukong' })?.key).toBe('MonkeyKing')
    expect(findChampionProfile({ championName: "Cho'Gath" })?.key).toBe('Chogath')
    expect(findChampionProfile({ championName: '安妮' })?.key).toBe('Annie')
    expect(findChampionProfile({ championName: '不存在' })).toBeNull()
  })
})

describe('analyzeTeamComp', () => {
  it('reads an AP-heavy, healing enemy team and a frontline-less ally team', () => {
    const analysis = comp('Malphite', MALPHITE_ALLIES, AP_HEALERS)
    expect(analysis.enemy.apChampions).toBe(4)
    expect(analysis.enemy.adChampions).toBe(1)
    expect(analysis.enemy.healers).toBeGreaterThanOrEqual(2)
    expect(analysis.needs.mr).toBeGreaterThan(0.8)
    expect(analysis.needs.armor).toBe(0)
    expect(analysis.needs.antiHeal).toBeGreaterThan(0.6)
    expect(analysis.needs.frontline).toBeGreaterThan(0.6)
    const advice = adviseTeamComp(analysis, championRouteFlex({ builds: builds(54), items: STORED_ITEM_PROFILES }))
    expect(advice.lean).toBe('tank')
    expect(advice.summary).toContain('对面 4 法系 1 物理')
    expect(advice.summary).toContain('我方缺前排 → 建议偏肉')
    expect(advice.summary).toMatch(/魔抗/)
    expect(advice.summary).toMatch(/重伤/)
  })

  it('blends actual items into the enemy damage split', () => {
    const fromChampion = analyzeTeamComp({ allies: [], enemies: [{ championKey: 'Ezreal' }], itemIndex })
    const fromItems = analyzeTeamComp({ allies: [], enemies: [{ championKey: 'Ezreal', itemIds: [3089, 6655, 3135, 3157] }], itemIndex })
    expect(fromItems.enemy.ap).toBeGreaterThan(fromChampion.enemy.ap + 0.3)
  })

  it('does not tell a champion without a tank route to go tank', () => {
    const analysis = comp('Annie', ['Lux', 'Ezreal', 'Jinx', 'Xerath'], ['Zed', 'Katarina', 'Fizz', 'Khazix', 'Nautilus'])
    const advice = adviseTeamComp(analysis, championRouteFlex({ builds: builds(1), items: STORED_ITEM_PROFILES }))
    expect(advice.lean).toBeNull()
    expect(advice.summary).not.toContain('缺前排')
    expect(analysis.needs.stasis).toBeGreaterThan(0.6)
    expect(advice.priorities[0]).toContain('保命')
  })

  it('champ select (allies only) produces no enemy needs', () => {
    const analysis = analyzeTeamComp({ allies: [{ championId: 54, isSelf: true }, { championId: 99 }, { championId: 81 }], enemies: [], source: 'champ-select' })
    expect(analysis.source).toBe('champ-select')
    expect(analysis.needs.mr).toBe(0)
    expect(analysis.needs.frontline).toBeGreaterThan(0)
    expect(adviseTeamComp(analysis, { canTank: true, canDamage: true }).summary).toContain('选人阶段看不到对面')
  })
})

describe('engine comp term', () => {
  const malphite = (enemies: string[], augments: number[] = []) => ({
    builds: builds(54),
    items: STORED_ITEM_PROFILES,
    augments: augments.map((id) => getStoredAugmentProfile(id) as AugmentProfile),
    team: comp('Malphite', MALPHITE_ALLIES, enemies),
  })

  it('switches Malphite from AP to tank when the team lacks frontline (no augments)', () => {
    const plain = recommendBuild({ ...malphite(AP_HEALERS), team: null })
    const result = recommendBuild(malphite(AP_HEALERS))
    expect(plain.archetype?.label).toBe('AP')
    expect(result.archetype?.label).toBe('Tank')
    expect(result.team?.routeNote).toContain('坦克')
    expect(result.team?.canTank).toBe(true)
  })

  it('AP + healers → MR and anti-heal; AD-heavy → armor', () => {
    const vsAp = recommendBuild(malphite(AP_HEALERS, [1013, 1152]))
    const vsAd = recommendBuild(malphite(AD_HEAVY, [1013, 1152]))
    const mrOf = (result: typeof vsAp) => result.items.reduce((sum, item) => sum + (itemIndex.get(item.itemId)?.shares.MR ?? 0), 0)
    const armorOf = (result: typeof vsAp) => result.items.reduce((sum, item) => sum + (itemIndex.get(item.itemId)?.shares.ARMOR ?? 0), 0)
    expect(mrOf(vsAp)).toBeGreaterThan(mrOf(vsAd) + 0.5)
    expect(armorOf(vsAd)).toBeGreaterThan(armorOf(vsAp) + 0.5)
    expect(vsAp.items.some((item) => itemIndex.get(item.itemId)?.tags.includes('anti-heal'))).toBe(true)
    expect(ids(vsAd)).toContain(3047) // 铁板靴
    expect(ids(vsAp)).not.toContain(3047)
    // 每件装备的阵容项都有上限
    for (const item of [...vsAp.items, ...vsAd.items]) expect(item.score.comp).toBeLessThanOrEqual(3.5)
    expect(vsAp.contributions.comp).toBeGreaterThan(0)
    expect(vsAp.items.some((item) => item.reasons.some((reason) => reason.startsWith('阵容：')))).toBe(true)
  })

  it('only takes one anti-heal item', () => {
    const result = recommendBuild(malphite(AP_HEALERS, [1013, 1152]))
    expect(result.items.filter((item) => itemIndex.get(item.itemId)?.tags.includes('anti-heal')).length).toBe(1)
  })

  it('Ashe vs a tanky comp prefers armor penetration', () => {
    const team = comp('Ashe', ['Xerath', 'Sona', 'Garen', 'Ezreal'], ['Malphite', 'Sion', 'Chogath', 'Zac', 'Lux'])
    expect(team.needs.penetration).toBeGreaterThan(0.6)
    const plain = recommendBuild({ builds: builds(22), items: STORED_ITEM_PROFILES, augments: [] })
    const result = recommendBuild({ builds: builds(22), items: STORED_ITEM_PROFILES, augments: [], team })
    const dominik = (r: typeof result) => ids(r).indexOf(3036)
    expect(dominik(result)).toBeGreaterThanOrEqual(0)
    expect(dominik(result)).toBeLessThan(dominik(plain) < 0 ? 99 : dominik(plain))
  })

  it('Annie vs assassins adds a stasis item', () => {
    const team = comp('Annie', ['Ashe', 'Leona', 'Garen', 'Sona'], ['Zed', 'Katarina', 'Fizz', 'Khazix', 'Nautilus'])
    const result = recommendBuild({ builds: builds(1), items: STORED_ITEM_PROFILES, augments: [], team })
    expect(result.items.some((item) => [3157, 3102].includes(item.itemId))).toBe(true)
    expect(result.team?.canTank).toBe(false)
  })

  it('plans: 局势适配 exists with team only; 主流/高胜率 stay pure data', () => {
    const plans = generateBuildPlans(malphite(AP_HEALERS))
    expect(plans[0].key).toBe('adapted')
    expect(plans[0].label).toBe(ADAPTED_LABEL)
    expect(plans[0].usesTeam).toBe(true)
    for (const plan of plans.filter((entry) => entry.key === 'popular' || entry.key === 'winrate')) {
      expect(plan.usesTeam).toBe(false)
      expect(plan.result.items.every((item) => item.score.comp === 0)).toBe(true)
    }
  })

  it('card synergy rewards tank augments when the team lacks frontline', () => {
    const result = recommendBuild(malphite(AP_HEALERS))
    const tankCard: AugmentProfile = { id: 99001, name: '坦卡', weights: { HP: 1 }, mechanics: ['tank'], itemIds: [], confidence: 1 } as unknown as AugmentProfile
    const withTeam = scoreCardSynergy(tankCard, [], result.context)
    const without = scoreCardSynergy(tankCard, [], { ...result.context, team: null })
    expect(withTeam.parts.team).toBeGreaterThan(0.5)
    expect(without.parts.team).toBe(0)
    expect(withTeam.reasons.some((reason) => reason.includes('缺前排'))).toBe(true)
  })
})

describe('parseLiveClientPlayers players[]', () => {
  it('returns both teams with raw names, items and scores', () => {
    const parsed = parseLiveClientPlayers({ riotId: 'Me#1' }, [
      { riotId: 'Me#1', championName: '墨菲特', rawChampionName: 'game_character_displayname_Malphite', team: 'ORDER', level: 7, scores: { kills: 1, deaths: 2, assists: 3 }, items: [{ itemID: 3068 }] },
      { riotId: 'A#1', championName: '拉克丝', rawChampionName: 'game_character_displayname_Lux', team: 'ORDER', items: [] },
      { riotId: 'E#1', championName: '索拉卡', rawChampionName: 'game_character_displayname_Soraka', team: 'CHAOS', items: [{ itemID: 3107 }] },
    ])
    expect(parsed.players).toHaveLength(3)
    expect(parsed.players[0]).toMatchObject({ isSelf: true, isAlly: true, itemIds: [3068], level: 7, kills: 1, deaths: 2, assists: 3 })
    expect(parsed.players[2]).toMatchObject({ isAlly: false, rawChampionName: 'game_character_displayname_Soraka' })
    expect(findChampionProfile(parsed.players[2])?.key).toBe('Soraka')
  })
})
