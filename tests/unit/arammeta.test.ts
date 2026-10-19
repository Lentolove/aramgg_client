import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeArammetaChampion, normalizeArammetaMeta, localizeRouteLabel, ARAMMETA_SCHEMA_VERSION } from '../../src/shared/arammeta/normalize.ts'
import { lcbLiftOf, rankAugmentChoicesArammeta, shrinkToBaseline } from '../../src/shared/arammeta/augment-ranking.ts'
import { arammetaToBuilds } from '../../src/shared/arammeta/builds.ts'
import { arammetaTeamComposition, frontlineSignal, measuredDamageSplit } from '../../src/shared/arammeta/composition.ts'
import { applyCardSynergy, analyzeTeamComp, buildItemProfileIndex, generateBuildPlans, recommendBuild, STORED_ITEM_PROFILES } from '../../src/shared/recommendation/index.ts'
import { ArammetaService } from '../../src/main/services/arammeta/arammeta-service.ts'

// 真实数据：Lanternko/ARAM-Mayhem-Database（MIT），detailVersion 20261019-6b3bbf67d2b7
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/arammeta', name), 'utf8'))
const META = normalizeArammetaMeta(fixture('tier-list.slim.json'), '2026-10-18T18:11:51.000Z')!
const champ = (id: number) => normalizeArammetaChampion(fixture(`${id}.json`), id)!
const ITEMS = STORED_ITEM_PROFILES as any
const INDEX = buildItemProfileIndex(ITEMS)
const rarityOf = (id: number) => META.augRarity[String(id)] ?? null

describe('arammeta normalize（真实数据）', () => {
  it('解析全局元数据：版本、样本量、阵容表、海克斯稀有度', () => {
    expect(META.patch).toBe('16.20')
    expect(META.baselinePatch).toBe('16.19')
    expect(META.games).toBe(552574)
    expect(META.queue).toBe(2400)
    expect(META.detailVersion).toBe('20261019-6b3bbf67d2b7')
    expect(META.sampleEndMs).toBe(1792342568569)
    expect(Object.keys(META.augRarity)).toHaveLength(211)
    expect(META.composition?.tables.ad_front).toBeTruthy()
    expect(META.champs['54'].wr).toBeCloseTo(0.4735, 3)
    expect(META.champs['54'].comp?.magic).toBeGreaterThan(META.champs['54'].comp!.phys)
  })

  it('解析英雄文件：基线、海克斯池、路线、组合、鞋', () => {
    const malphite = champ(54)
    expect(malphite.schema).toBe(ARAMMETA_SCHEMA_VERSION)
    expect(malphite.baselineWr).toBeCloseTo(0.4735, 3)
    expect(malphite.augments.length).toBeGreaterThanOrEqual(136)
    expect(malphite.routes.map((route) => route.label)).toEqual(['AP爆发/AP燃烧', 'AP爆发/AP燃烧', '坦克/心之钢'])
    expect(malphite.routes[2].g).toBe(7655)
    expect(malphite.routes[2].wr).toBeCloseTo(0.5193, 4)
    expect(malphite.routes[0].options.length).toBeGreaterThan(3)
    expect(malphite.pairs.length).toBe(13)
    expect(malphite.boots.length).toBeGreaterThan(2)
    for (const id of [1, 22, 157]) expect(champ(id).routes.length).toBeGreaterThan(0)
  })

  it('路线名映射成简体，坏数据返回 null', () => {
    expect(localizeRouteLabel('Tank / Heartsteel')).toBe('坦克/心之钢')
    expect(localizeRouteLabel('Lethality assassin')).toBe('穿甲刺客')
    expect(normalizeArammetaChampion(null, 1)).toBeNull()
    expect(normalizeArammetaChampion({ foo: 1 }, 1)?.augments ?? []).toEqual([])
    expect(normalizeArammetaMeta({})).toBeNull()
  })
})

describe('arammeta 三选一排序', () => {
  const malphite = champ(54)
  const top = (rarity: string) => malphite.augments.filter((a) => a.rarity === rarity && a.score != null).sort((a, b) => b.score! - a.score!)

  it('保守下界与 arammeta 发布的 lcb 基本一致（正态近似；只用于榜单外的池内海克斯）', () => {
    const errors = malphite.augments.filter((a) => a.lcb != null)
      .map((stat) => Math.abs(lcbLiftOf(stat.wr, stat.g, malphite.baselineWr!) - stat.lcb!))
      .sort((a, b) => a - b)
    expect(errors[Math.floor(errors.length / 2)]).toBeLessThan(0.001)
    expect(errors[Math.floor(errors.length * 0.9)]).toBeLessThan(0.003)
    expect(shrinkToBaseline(0.6, 50, 0.5)).toBeCloseTo(0.5125, 4)
  })

  it('按 arammeta score 排序并给出同稀有度名次与样本量', () => {
    const list = top('kPrismatic')
    const cards = [list[5], list[0], list[2]].map((stat, slot) => ({ id: stat.id, name: `A${stat.id}`, detectedSlot: slot }))
    const ranking = rankAugmentChoicesArammeta(cards, malphite, { rarityOf })
    expect(ranking.source).toBe('arammeta')
    expect(ranking.choices.map((choice) => choice.card.id)).toEqual([list[0].id, list[2].id, list[5].id])
    expect(ranking.choices[0].rarityRank?.rank).toBe(1)
    expect(ranking.choices[0].games).toBe(list[0].g)
    expect(ranking.choices[0].shrunkWinRate).toBeCloseTo(list[0].wr, 6)
    expect(ranking.choices[0].note).toContain('实测·arammeta')
    expect(ranking.baselineWinRate).toBeCloseTo(0.4735, 3)
  })

  it('arammeta 没有的卡逐张退回 dtodo；都没有时无数据', () => {
    const best = top('kGold')[0]
    const cards = [
      { id: best.id, name: 'known', detectedSlot: 0 },
      { id: 999999, name: 'dtodo-only', detectedSlot: 1, winRate: 0.7, games: 800 },
      { id: 999998, name: 'nothing', detectedSlot: 2 },
    ]
    const ranking = rankAugmentChoicesArammeta(cards, malphite, { fallbackStats: [{ winRate: 0.5, games: 10000 }] })
    expect(ranking.source).toBe('mixed')
    const byName = Object.fromEntries(ranking.choices.map((choice) => [choice.card.name, choice]))
    expect(byName['dtodo-only'].source).toBe('dtodo')
    expect(byName['dtodo-only'].shrunkWinRate).toBeCloseTo(shrinkToBaseline(0.7, 800, 0.5), 6)
    expect(byName.nothing.source).toBe('none')
    expect(ranking.choices[2].card.name).toBe('nothing')
    const none = rankAugmentChoicesArammeta(cards.slice(2), null)
    expect(none.method).toBe('rank-fallback')
  })

  it('契合度在 arammeta 排序分上叠加（sortWinRate）', () => {
    const list = top('kPrismatic')
    const cards = [list[0], list[1]].map((stat, slot) => ({ id: stat.id, name: `A${stat.id}`, detectedSlot: slot }))
    const base = rankAugmentChoicesArammeta(cards, malphite, { rarityOf })
    const boosted = applyCardSynergy(base, (card) => ({ score: card.id === list[1].id ? 100 : 0, reasons: [] } as any))
    expect(boosted.choices[0].combinedWinRate).toBeGreaterThan(boosted.choices[1].combinedWinRate!)
    expect((boosted as any).source).toBe('arammeta')
  })
})

describe('arammeta 出装', () => {
  it('路线 → builds：核心、搭配、鞋、同名路线用核心装区分', () => {
    const builds = arammetaToBuilds(champ(54), (id) => INDEX.get(id)?.name)
    expect(builds).toHaveLength(3)
    expect(builds[0].buildTags).toMatch(/^AP爆发\/AP燃烧（.+）$/)
    expect(builds[2].buildTags).toBe('坦克/心之钢')
    expect(builds[2].coreItems?.[0].itemIds).toEqual(champ(54).routes[2].core)
    expect(builds[0].source).toBe('arammeta')
    expect(builds[0].bootsShare).toBeGreaterThan(0.4)
    expect(arammetaToBuilds(null)).toEqual([])
  })

  it('方案：主流 = 场次最多的路线，高胜率 = 收缩胜率最高的路线；理由标注实测', () => {
    const malphite = champ(54)
    const plans = generateBuildPlans({ builds: arammetaToBuilds(malphite, (id) => INDEX.get(id)?.name), items: ITEMS, augments: [], itemPairs: malphite.pairs, itemSingles: malphite.singles })
    const popular = plans.find((plan) => plan.key === 'popular')!
    const winrate = plans.find((plan) => plan.key === 'winrate')!
    expect(popular.routeLabel).toContain('AP爆发')
    expect(winrate.routeLabel).toBe('坦克/心之钢')
    expect(popular.result.items.some((item) => item.boots)).toBe(true)
    const first = popular.result.items[0]
    expect(first.reasons[0]).toMatch(/^实测·arammeta（n=\d+）/)
  })

  it('两件组合的实测效应进入分数并写理由', () => {
    const yasuo = champ(157)
    const result = recommendBuild({ builds: arammetaToBuilds(yasuo), items: ITEMS, augments: [], itemPairs: yasuo.pairs, itemSingles: yasuo.singles, archetype: 'popular' })
    const withPair = result.items.filter((item) => Math.abs(item.score.pair) > 0)
    expect(withPair.length).toBeGreaterThan(0)
    expect(result.items.flatMap((item) => item.reasons).some((reason) => reason.includes('同出胜率'))).toBe(true)
    const without = recommendBuild({ builds: arammetaToBuilds(yasuo), items: ITEMS, augments: [], archetype: 'popular' })
    expect(without.items.every((item) => item.score.pair === 0)).toBe(true)
  })
})

describe('arammeta 阵容表', () => {
  it('移植 teamComposition：分数受 clamp 限制，墨菲特 + 脆皮队友时当前排有正收益', () => {
    const summary = arammetaTeamComposition(META, [54, 1, 22, 157, 16])!
    expect(Math.abs(summary.score)).toBeLessThanOrEqual(META.composition!.clamp)
    const signal = frontlineSignal(META, [54, 1, 22, 157, 16], 54)!
    expect(signal.delta).toBeGreaterThan(0.01)
    // 队里已经有锤石（front 2.5）：再当前排没有收益
    expect(frontlineSignal(META, [54, 1, 22, 412, 16], 54)!.delta).toBeLessThan(0.005)
    expect(frontlineSignal(META, [54], 54)?.delta ?? 0).toBe(0)
  })

  it('实测伤害构成与实测前排需求进入阵容分析', () => {
    const split = measuredDamageSplit(META, 54)!
    expect(split.ap).toBeGreaterThan(0.6)
    const allies = [54, 1, 22, 157, 16].map((id) => ({ championId: id, isSelf: id === 54 }))
    const measured = analyzeTeamComp({ allies, enemies: [], source: 'champ-select', measuredDamage: (id) => measuredDamageSplit(META, id), measuredFrontline: { delta: frontlineSignal(META, [54, 1, 22, 157, 16], 54)!.delta } })
    expect(measured.frontlineMeasured).toBe(true)
    expect(measured.needs.frontline).toBeGreaterThan(0.9)
    expect(measured.measuredDamageCount).toBe(5)
  })
})

describe('ArammetaService（缓存 / ETag / 镜像 / 快照）', () => {
  const dirs: string[] = []
  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arammeta-test-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })
  const mirrors = [{ name: 'a', base: 'https://a/' }, { name: 'b', base: 'https://b/' }]
  const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers })

  it('镜像依次尝试；缓存命中；过期后带 If-None-Match 收到 304；全部失败用旧缓存', async () => {
    const cacheDir = tmp()
    let now = 1_000_000
    const calls: Array<{ url: string; etag: string | null }> = []
    let mode: 'normal' | 'revalidate' | 'down' = 'normal'
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const etag = (init?.headers as Record<string, string>)?.['If-None-Match'] ?? null
      calls.push({ url, etag })
      if (mode === 'down') throw new Error('offline')
      if (url.startsWith('https://a/')) return new Response('x', { status: 503 })
      if (mode === 'revalidate' && etag) return new Response(null, { status: 304 })
      if (url.endsWith('tier-list.json')) return json(fixture('tier-list.slim.json'), { etag: '"m1"', 'last-modified': 'Sun, 18 Oct 2026 18:11:51 GMT' })
      return json(fixture('54.json'), { etag: '"c1"' })
    }) as typeof fetch
    const make = () => new ArammetaService({ cacheDir, bundledDirs: [], fetchImpl, now: () => now, mirrors })

    const first = await make().getChampion(54)
    expect(first.source).toBe('network')
    expect(first.mirror).toBe('b')
    expect(first.data?.routes).toHaveLength(3)
    expect(first.meta.data?.updatedAt).toBe('2026-10-18T18:11:51.000Z')

    calls.length = 0
    const cached = await make().getChampion(54)
    expect(cached.source).toBe('cache')
    expect(calls).toHaveLength(0)

    now += 13 * 3600_000
    mode = 'revalidate'
    calls.length = 0
    const revalidated = await make().getChampion(54)
    expect(revalidated.source).toBe('revalidated')
    expect(calls.find((call) => call.url === 'https://b/champions/54.json')?.etag).toBe('"c1"')
    // 只对同一镜像发 If-None-Match
    expect(calls.find((call) => call.url === 'https://a/champions/54.json')?.etag).toBeNull()

    now += 13 * 3600_000
    mode = 'down'
    const stale = await make().getChampion(54)
    expect(stale.source).toBe('stale-cache')
    expect(stale.data?.championId).toBe(54)
    expect(stale.error).toContain('offline')
  })

  it('没有缓存且离线：用打包快照；连快照都没有返回 none', async () => {
    const bundled = tmp()
    fs.mkdirSync(path.join(bundled, 'champions'))
    fs.writeFileSync(path.join(bundled, 'meta.json'), JSON.stringify(META))
    fs.writeFileSync(path.join(bundled, 'champions', '54.json'), JSON.stringify(champ(54)))
    const offline = (async () => { throw new Error('offline') }) as typeof fetch
    const service = new ArammetaService({ cacheDir: tmp(), bundledDirs: [path.join(tmp(), 'missing'), bundled], fetchImpl: offline, mirrors })
    const result = await service.getChampion(54)
    expect(result.source).toBe('bundled')
    expect(result.meta.source).toBe('bundled')
    expect(result.data?.baselineWr).toBeCloseTo(0.4735, 3)
    const missing = await service.getChampion(1)
    expect(missing.source).toBe('none')
    expect(missing.data).toBeNull()
  })
})
