/**
 * 真实对局评测（docs/samples 3 局 queue 2400）发现的问题，每条一个回归测试。
 * 数据：随包 arammeta 快照（16.20）+ tests/fixtures/real-matches/dtodo-detail.json（dtodo 快照）。
 */
import { describe, expect, it } from 'vitest'
import { loadEvalInputs, playerContext } from '../../scripts/eval-real-matches/eval.ts'
import { rankAugmentChoicesArammeta } from '../../src/shared/arammeta/augment-ranking.ts'
import {
  ENGINE_PARAMS,
  STORED_ITEM_PROFILES,
  TEAM_PARAMS,
  adviseTeamComp,
  analyzeTeamComp,
  applyCardSynergy,
  bootsDamageClass,
  buildItemProfileIndex,
  generateBuildPlans,
  isMixedBuild,
  itemDamageClass,
  recommendBuild,
  resolvePlan,
  scoreCardSynergy,
  type TeamPlayerInput,
} from '../../src/shared/recommendation/index.ts'

const inputs = loadEvalInputs()
const game803 = inputs.matches.find((game) => game.gameId === 600925790803)
const game630 = inputs.matches.find((game) => game.gameId === 600925866630)
const ctxOf = (game: any, championId: number) => playerContext(inputs, game, game.participants.find((p: any) => p.championId === championId))
const augsOf = (game: any, championId: number): number[] => game.participants.find((p: any) => p.championId === championId).augments
const SION_AUGS = augsOf(game803, 14)
const shaco = ctxOf(game803, 35)
const syndra = ctxOf(game803, 134)
const sion = ctxOf(game803, 14)
const index = shaco.index
const SORC = 3020
const BERSERKER = 3006

const freshClasses = (items: Array<{ itemId: number; owned: boolean }>) => items.filter((item) => !item.owned).map((item) => itemDamageClass(index.get(item.itemId)))

describe('1. 已有装备锁流派', () => {
  it('萨科已有狂妄 + 收集者：所有方案都不接法强装，主伤害类型 = AD', () => {
    const plans = generateBuildPlans(shaco.engineInput(augsOf(game803, 35).slice(0, 2), [126697, 6676]) as any)
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans) {
      expect(plan.result.ownedDamage).toBe('AD')
      expect(freshClasses(plan.result.items)).not.toContain('AP')
    }
  })

  it('辛德拉已有卢登 + 影焰：不推物理装', () => {
    for (const plan of generateBuildPlans(syndra.engineInput([1025], [6655, 4645]) as any)) {
      expect(freshClasses(plan.result.items)).not.toContain('AD')
    }
  })

  it('没有已有装备时，原路线 + 海克斯 组出混搭（升级：无尽之刃 塞进 AP 路线）的方案不展示', () => {
    const mf = ctxOf(game630, 21)
    const plans = generateBuildPlans(mf.engineInput(augsOf(game630, 21)) as any)
    for (const plan of plans) expect(isMixedBuild(mf.engineInput([]) as any, plan.result)).toBe(false)
  })
})

describe('2. 鞋子按路线主属性白名单 + 出场门槛', () => {
  it('鞋子分类：法师之靴 = AP，狂战士胫甲 = AD，水银之靴 = 通用', () => {
    expect(bootsDamageClass(index.get(SORC))).toBe('AP')
    expect(bootsDamageClass(index.get(BERSERKER))).toBe('AD')
    expect(bootsDamageClass(index.get(3111))).toBeNull()
  })

  it('暴击萨科不推法师之靴；法强辛德拉不推狂战士胫甲', () => {
    for (const plan of generateBuildPlans(shaco.engineInput([1238], [126697, 6676]) as any)) {
      expect(plan.result.items.map((item) => item.itemId)).not.toContain(SORC)
    }
    for (const plan of generateBuildPlans(syndra.engineInput([1025, 1030]) as any)) {
      expect(plan.result.items.map((item) => item.itemId)).not.toContain(BERSERKER)
    }
  })

  it('路线里出场占比低于门槛的鞋带罚分理由（除非阵容需要）', () => {
    const result = recommendBuild({ ...shaco.engineInput([]), archetype: 'winrate', priorMode: 'winrate', team: null } as any)
    const boots = result.items.find((item) => item.boots)
    if (boots && (boots.priorGames ?? 0) / Math.max(1, result.archetype?.games ?? 1) < ENGINE_PARAMS.bootsMinShare) {
      expect(boots.reasons.join('|')).toContain('出这双鞋')
    }
  })
})

describe('3. 主流方案每格按出场率', () => {
  it('辛德拉主流：鞋 = 路线里出场最多的法师之靴（不是 6% 出场的高胜率鞋）', () => {
    const popular = resolvePlan(generateBuildPlans(syndra.engineInput([])), 'popular')! // 与高胜率相同时会合并
    expect(popular.result.items.find((item) => item.boots)?.itemId).toBe(SORC)
  })

  it('主流方案里非核心装按场次从高到低选：选中的每件场次都不低于没选中的同路线装备（唯一被动冲突除外）', () => {
    const popular = resolvePlan(generateBuildPlans(sion.engineInput([])), 'popular')!
    const chosen = popular.result.items.filter((item) => !item.boots && item.priorGames != null)
    const minChosen = Math.min(...chosen.map((item) => item.priorGames!))
    const alternatives = popular.result.items.flatMap((item) => item.alternatives)
    // 备选是次优候选：场次多于已选最少一件的备选只能是因唯一被动冲突被挡下的（这里不应出现）
    const route = shaco.engineBuilds.length ? sion.engineBuilds[popular.result.archetype!.index] : null
    const games = new Map((route?.situationalItems ?? []).map((record: any) => [Number(record.itemId), Number(record.games)]))
    for (const alt of alternatives) {
      const altItem = index.get(alt.itemId)
      if (!altItem || altItem.boots) continue
      expect(games.get(alt.itemId) ?? 0).toBeLessThanOrEqual(minChosen * 1.0001 + (altItem.uniquePassives.length ? Infinity : 0))
    }
  })
})

describe('4. 没数据的海克斯标「无数据」', () => {
  it('不参与首选/次选/末选，排在最后', () => {
    const cards = [{ id: 1238, slot: 0, detectedSlot: 0 }, { id: 999999, slot: 1, detectedSlot: 1, name: '练腿日' }, { id: 1349, slot: 2, detectedSlot: 2 }]
    const base = rankAugmentChoicesArammeta(cards as any, shaco.champ, { rarityOf: shaco.rarityOf })
    const ranked = applyCardSynergy(base as any, () => ({ score: 3, parts: { items: 3, archetype: 0, held: 0, trio: 0, team: 0 }, reasons: [] }))
    const last = ranked.choices[ranked.choices.length - 1]
    expect(last.card.id).toBe(999999)
    expect(last.relativeLabel).toBe('无数据')
    expect(ranked.choices.filter((choice) => choice.relativeLabel === '末选' || choice.relativeLabel === '次选' || choice.relativeLabel === '首选' || choice.relativeLabel === '差不多')).toHaveLength(2)
  })
})

describe('5. 抗性需求', () => {
  it('赛恩对面 3 个全 AP（墨菲特/辛德拉/努努）：魔抗需求 ≥ 0.5，方案里有魔抗装（不算鞋）', () => {
    expect(sion.team.enemy.apChampions).toBeGreaterThanOrEqual(3)
    expect(sion.team.needs.mr).toBeGreaterThanOrEqual(TEAM_PARAMS.resistFloor3)
    const adapted = generateBuildPlans(sion.engineInput(SION_AUGS)).find((plan) => plan.key === 'adapted')!
    expect(adapted.result.items.some((item) => !item.boots && (index.get(item.itemId)?.shares.MR ?? 0) >= 0.15)).toBe(true)
  })

  it('一个超神 AD（30 杀）不会把 3 个 AP 敌人的魔抗需求洗掉；4 个 AP → 0.8', () => {
    const itemIndex = buildItemProfileIndex(STORED_ITEM_PROFILES)
    const enemies: TeamPlayerInput[] = [
      { championKey: 'Syndra' }, { championKey: 'Lux' }, { championKey: 'Brand' },
      { championKey: 'Jinx', kills: 30, deaths: 2 }, { championKey: 'Darius' },
    ]
    const team = analyzeTeamComp({ allies: [{ championKey: 'Ornn', isSelf: true }], enemies, itemIndex })
    expect(team.needs.mr).toBeGreaterThanOrEqual(0.5)
    const four = analyzeTeamComp({ allies: [{ championKey: 'Ornn', isSelf: true }], enemies: [...enemies.slice(0, 3), { championKey: 'Xerath' }, { championKey: 'Darius' }], itemIndex })
    expect(four.needs.mr).toBeGreaterThanOrEqual(TEAM_PARAMS.resistFloor4)
  })
})

describe('6. 保命建议按自己定位', () => {
  const itemIndex = buildItemProfileIndex(STORED_ITEM_PROFILES)
  const assassins: TeamPlayerInput[] = ['Zed', 'Katarina', 'Fizz', 'Khazix', 'Nautilus'].map((key) => ({ championKey: key, kills: 4 }))
  it('坦克（墨菲特/赛恩）不推中娅/女妖/守护天使', () => {
    for (const self of ['Malphite', 'Sion']) {
      const team = analyzeTeamComp({ allies: [{ championKey: self, isSelf: true }, { championKey: 'Lux' }], enemies: assassins, itemIndex })
      expect(team.needs.stasis).toBeGreaterThanOrEqual(0.35)
      const advice = adviseTeamComp(team, { canTank: true, canDamage: true })
      expect(advice.summary).not.toMatch(/中娅|女妖|守护天使/)
      expect(advice.chips.map((chip) => chip.label)).not.toContain('防爆发')
    }
  })
  it('脆皮（艾希）照常推保命；也可以由调用方显式指定 selfTank', () => {
    const team = analyzeTeamComp({ allies: [{ championKey: 'Ashe', isSelf: true }, { championKey: 'Lux' }], enemies: assassins, itemIndex })
    expect(adviseTeamComp(team, { canTank: false, canDamage: true }).summary).toContain('保命')
    expect(adviseTeamComp(team, { canTank: false, canDamage: true }, { selfTank: true }).summary).not.toContain('保命')
  })
  it('坦克路线的出装不因为保命需求加中娅', () => {
    const result = recommendBuild(sion.engineInput([]) as any)
    for (const item of result.items) expect(item.reasons.join('|')).not.toContain('→ 保命')
  })
})

describe('7. 规则加分不压过实测', () => {
  it('赛恩：样本足够的装备，规则（海克斯）正分 ≤ 实测先验 × ratio；实测为负的不靠规则入选', () => {
    const result = recommendBuild(sion.engineInput(SION_AUGS) as any)
    for (const item of result.items) {
      if ((item.priorGames ?? 0) < ENGINE_PARAMS.ruleCapMinGames) continue
      if (item.reasons.some((reason) => reason.includes('直接强化') || reason.includes('描述点名'))) continue
      const cap = Math.max(ENGINE_PARAMS.ruleCapFloor, ENGINE_PARAMS.ruleCapRatio * Math.max(0, item.score.prior))
      expect(item.score.synergy).toBeLessThanOrEqual(cap + 0.2)
    }
    const hydra = result.items.find((item) => item.itemId === 3748)
    if (hydra) expect(hydra.score.synergy).toBeLessThanOrEqual(ENGINE_PARAMS.ruleCapNegative + 0.2)
  })
})

describe('8. 低优先级', () => {
  it('高胜率方案第一件是样本足够的装备', () => {
    for (const ctx of [shaco, syndra, sion]) {
      const winrate = recommendBuild({ ...ctx.engineInput([]), archetype: 'winrate', priorMode: 'winrate', team: null } as any)
      const first = winrate.items.find((item) => !item.boots && !item.owned)!
      expect(first.priorGames ?? 0).toBeGreaterThanOrEqual(ENGINE_PARAMS.winrateFirstMinGames)
    }
  })

  it('海克斯契合理由按当前路线写（不是「英雄出装」）', () => {
    const result = recommendBuild(shaco.engineInput([], [126697, 6676]) as any)
    expect(result.context.routeLabel).toContain('暴击')
    const synergy = scoreCardSynergy(shaco.profileOf(1349), [], result.context)
    expect(synergy.reasons.join('|')).not.toContain('英雄出装')
  })

  it('流派名里括号列的核心装都在方案里', () => {
    for (const ctx of [shaco, syndra, sion]) {
      for (const owned of [[], [126697, 6676], [6655, 4645]]) {
        for (const plan of generateBuildPlans(ctx.engineInput([], owned) as any)) {
          const match = /（([^）]*)）$/.exec(plan.routeLabel)
          if (!match) continue
          const names = plan.result.items.map((item) => item.name)
          for (const name of match[1].split('+')) expect(names).toContain(name)
        }
      }
    }
  })
})
