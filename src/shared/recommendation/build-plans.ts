/**
 * 可切换的出装方案：
 *   adapted   局势适配：统计先验 + 当前海克斯模型 + 对局阵容（有海克斯或阵容信息时默认）
 *   popular   主流：场次最多的流派、按出场率选装（纯真实数据，不考虑海克斯）
 *   winrate   高胜率：样本足够的流派里收缩胜率最高的，按装备收缩胜率选装（纯真实数据）
 *   alternate 海克斯/阵容把流派切走时，原流派 + 海克斯/阵容模型（例如墨菲特：坦克 vs 法强）
 * 结果完全相同（同一套 6 件）的方案合并，合并后的方案带上别名。
 */

import { localizeArchetype, recommendBuild, type EngineInput, type EngineResult, type ItemSwap } from './build-engine.ts'

export type BuildPlanKey = 'adapted' | 'popular' | 'winrate' | 'alternate'

export interface BuildPlan {
  key: BuildPlanKey
  /** Tab 上的短标签 */
  label: string
  /** 合并进来的其他方案标签（结果相同） */
  aliases: string[]
  description: string
  /** 流派（真实统计） */
  routeLabel: string
  routeGames: number
  routeWinRate: number | null
  /** 是否用了海克斯模型 */
  usesAugments: boolean
  /** 是否用了阵容 */
  usesTeam: boolean
  result: EngineResult
}

export interface BuildPlanOptions {
  swaps?: Partial<Record<BuildPlanKey, ItemSwap[]>>
}

export const ADAPTED_LABEL = '局势适配'

const PLAN_ORDER_WITH_AUGMENTS: BuildPlanKey[] = ['adapted', 'alternate', 'popular', 'winrate']
const PLAN_ORDER_WITHOUT_AUGMENTS: BuildPlanKey[] = ['popular', 'winrate']

export function planSignature(result: EngineResult): string {
  return result.items.map((item) => item.itemId).sort((a, b) => a - b).join(',')
}

export function generateBuildPlans(input: EngineInput, options: BuildPlanOptions = {}): BuildPlan[] {
  const swaps = options.swaps ?? {}
  const hasAugments = (input.augments ?? []).length > 0
  const hasTeam = Boolean(input.team)
  const adaptive = hasAugments || hasTeam
  const raw = new Map<BuildPlanKey, BuildPlan>()
  const make = (key: BuildPlanKey, label: string, description: string, engineInput: EngineInput, usesAugments: boolean) => {
    const result = recommendBuild({ ...engineInput, swaps: swaps[key] ?? [] })
    const route = result.archetype
    raw.set(key, {
      key,
      label,
      aliases: [],
      description,
      routeLabel: route ? localizeArchetype(route.label) : '',
      routeGames: route?.games ?? 0,
      routeWinRate: route?.winRate ?? null,
      usesAugments,
      usesTeam: Boolean(engineInput.team),
      result,
    })
  }

  const pure: EngineInput = { ...input, augments: [], team: null, compareBaseline: false }
  make('popular', '主流', '场次最多的出装路线，按出场率选装（真实数据，不考虑海克斯）', { ...pure, archetype: 'popular' }, false)
  make('winrate', '高胜率', '样本足够的路线里收缩胜率最高的，按装备收缩胜率选装（真实数据，不考虑海克斯）', { ...pure, archetype: 'winrate', priorMode: 'winrate' }, false)

  if (adaptive) {
    const inputs = [hasAugments ? '当前海克斯×装备模型' : '', hasTeam ? '对局阵容' : ''].filter(Boolean).join(' + ')
    make('adapted', ADAPTED_LABEL, `该英雄统计先验 + ${inputs}`, { ...input, archetype: 'auto' }, hasAugments)
    const adapted = raw.get('adapted')!.result
    const baselineRoute = recommendBuild({ ...pure, archetype: 'auto' }).archetype
    if (adapted.archetype && baselineRoute && adapted.archetype.index !== baselineRoute.index) {
      const name = localizeArchetype(baselineRoute.label)
      const by = [hasAugments ? '海克斯' : '', hasTeam ? '阵容' : ''].filter(Boolean).join('/')
      make('alternate', `${name.split('·')[0]}流`, `${by}把流派切到了「${localizeArchetype(adapted.archetype.label)}」；这是原「${name}」路线 + ${inputs}`, { ...input, archetype: baselineRoute.index }, hasAugments)
    }
  }

  // 合并结果相同的方案（保留顺序靠前的）
  const order = adaptive ? PLAN_ORDER_WITH_AUGMENTS : PLAN_ORDER_WITHOUT_AUGMENTS
  const plans: BuildPlan[] = []
  const bySignature = new Map<string, BuildPlan>()
  for (const key of order) {
    const plan = raw.get(key)
    if (!plan || plan.result.items.length === 0) continue
    const signature = planSignature(plan.result)
    const existing = bySignature.get(signature)
    if (existing) {
      existing.aliases.push(plan.label)
      continue
    }
    bySignature.set(signature, plan)
    plans.push(plan)
  }
  return plans
}

/** 用户选的方案被合并/不存在时，退回到第一个（或别名所在的方案） */
export function resolvePlan(plans: BuildPlan[], preferred: BuildPlanKey | null | undefined): BuildPlan | null {
  if (!plans.length) return null
  if (!preferred) return plans[0]
  const direct = plans.find((plan) => plan.key === preferred)
  if (direct) return direct
  const labels: Record<BuildPlanKey, string> = { adapted: ADAPTED_LABEL, popular: '主流', winrate: '高胜率', alternate: '' }
  return plans.find((plan) => labels[preferred] && plan.aliases.includes(labels[preferred])) ?? plans[0]
}

/** 两个方案相差几件（不计顺序） */
export function planDifference(a: EngineResult, b: EngineResult): number {
  const set = new Set(a.items.map((item) => item.itemId))
  return b.items.filter((item) => !set.has(item.itemId)).length
}

/**
 * 记录一次换装：同一格再次更换时更新同一条 swap；换回原推荐时删除。
 * slotItemId = 当前格里显示的装备；original = 若该格已被换过，原推荐。
 */
export function applySwap(swaps: ItemSwap[], slotItemId: number, original: number | null, to: number): ItemSwap[] {
  const from = original ?? slotItemId
  const rest = swaps.filter((swap) => swap.from !== from && swap.to !== slotItemId)
  if (to === from) return rest
  return [...rest, { from, to }]
}
