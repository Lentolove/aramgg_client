/**
 * arammeta（Lanternko/ARAM-Mayhem-Database，MIT）数据适配：把它发布的 JSON 归一化成本项目用的精简结构。
 *
 * 数据：ARAM 海克斯大乱斗（Mayhem，queue 2400），作者通过 LCU 收集对局后聚合；
 *   docs/api/champions/{id}.json   每个英雄：海克斯（池内全部 + 按稀有度排好的 top/bot）、单件/两件装备、鞋、出装路线（itemClusters）、海克斯类型
 *   docs/api/tier-list.json        全局：版本、样本量、英雄基线胜率与阵容特征（comp）、阵容表（recommendation_composition）
 * 纯函数，主进程与渲染进程共用。
 */

export const ARAMMETA_ATTRIBUTION = '数据来自 arammeta / Lanternko，MIT'
export const ARAMMETA_REPO = 'https://github.com/Lanternko/ARAM-Mayhem-Database'
export const ARAMMETA_SCHEMA_VERSION = 1

export type ArammetaRarity = 'kPrismatic' | 'kGold' | 'kSilver'

export interface ArammetaAugmentStat {
  id: number
  /** 场次 */
  g: number
  /** 后验平均胜率（向英雄基线收缩后，arammeta 的展示值） */
  wr: number
  /** 被提供时的选取率 */
  pick: number
  rarity: ArammetaRarity | null
  /** 以下只有 top/bot 榜单里的才有（arammeta 自己算的） */
  lift: number | null
  /** 保守下界（10% 分位）− 基线 */
  lcb: number | null
  /** arammeta 排序分 = lcb + 0.003 × 选取率提升 */
  score: number | null
}

export interface ArammetaItemStat {
  ids: number[]
  g: number
  wr: number
  lift: number
  pick: number
  score: number
}

export interface ArammetaRouteOption {
  id: number
  g: number
  wr: number
  lift: number
  lcb: number
  pick: number
  lane: string
}

export interface ArammetaRoute {
  /** 简体标签，例如「坦克/心之钢」 */
  label: string
  labelEn: string
  core: number[]
  g: number
  wr: number
  lift: number
  pick: number
  options: ArammetaRouteOption[]
  tail: number[]
  completion: number[]
  completionGames: number
  boot: { id: number; g: number; wr: number; pick: number } | null
}

export interface ArammetaChampion {
  schema: number
  championId: number
  /** 英雄基线胜率（= 海克斯 wr − lift） */
  baselineWr: number | null
  augments: ArammetaAugmentStat[]
  singles: ArammetaItemStat[]
  pairs: ArammetaItemStat[]
  boots: ArammetaItemStat[]
  /** 出场多但胜率低的装备 */
  traps: ArammetaItemStat[]
  routes: ArammetaRoute[]
}

export interface ArammetaChampMeta {
  wr: number
  g: number
  tags: string[]
  /** arammeta 的英雄阵容特征：物理/魔法/真实伤害（局均）与 front/damage/engage/wave/poke/sustain/cc */
  comp: Record<string, number> | null
}

export interface ArammetaCompositionConfig {
  weight: number
  clamp: number
  lack_thresholds: Record<string, number>
  table_weights: Record<string, number>
  tables: Record<string, Record<string, number>>
  damage_mix?: { target_ad_share?: number; weight?: number; clamp?: number }
  trained_patch?: string
  trained_games?: number
}

export interface ArammetaMeta {
  schema: number
  queue: number
  patch: string | null
  baselinePatch: string | null
  /** 当前版本对局数 */
  games: number | null
  detailVersion: string | null
  ddragonVersion: string | null
  /** 样本里最晚一局（team_score 时间切分的 test_end_ms） */
  sampleEndMs: number | null
  /** 数据发布时间（HTTP Last-Modified / 快照时间） */
  updatedAt: string | null
  minChampAugGames: number | null
  /** 发布的元数据里没有服务器字段；作者脚本默认 --platform TW2 */
  regionNote: string
  champs: Record<string, ArammetaChampMeta>
  /** 海克斯 id → 稀有度（用于池中未进榜单的海克斯做稀有度内比较） */
  augRarity: Record<string, ArammetaRarity>
  composition: ArammetaCompositionConfig | null
}

const RARITIES: ArammetaRarity[] = ['kPrismatic', 'kGold', 'kSilver']

/** 路线名只有十几个词：直接映射成简体 */
const ROUTE_TOKENS: Record<string, string> = {
  'AP burst': 'AP爆发',
  'AP burn': 'AP燃烧',
  Crit: '暴击',
  Tank: '坦克',
  Heartsteel: '心之钢',
  AS: '攻速',
  'on-hit': '攻击特效',
  'AD bruiser': 'AD战士',
  'AP bruiser': '法坦',
  'Hybrid on-hit': '混伤攻击特效',
  'Lethality assassin': '穿甲刺客',
  Support: '辅助',
  'AD poke': 'AD消耗',
}

export function localizeRouteLabel(nameEn: string, nameZh?: string): string {
  const parts = String(nameEn || '').split(' / ').filter(Boolean)
  if (!parts.length) return nameZh || '出装路线'
  return parts.map((part) => ROUTE_TOKENS[part] ?? part).join('/')
}

const num = (value: unknown, fallback = 0): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const numOrNull = (value: unknown): number | null => {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const idOf = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}
const idsOf = (list: unknown): number[] => (Array.isArray(list)
  ? list.map((entry) => idOf(entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : entry)).filter((id): id is number => id != null)
  : [])
const asList = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') as Record<string, unknown>[] : [])

function itemStat(row: Record<string, unknown>): ArammetaItemStat | null {
  const ids = idsOf(row.items)
  if (!ids.length) return null
  return { ids, g: num(row.g), wr: num(row.wr), lift: num(row.lift), pick: num(row.pick), score: num(row.score) }
}

/** champions/{id}.json → ArammetaChampion。字段缺失时尽量容错，完全不像该格式时返回 null。 */
export function normalizeArammetaChampion(raw: unknown, championId: number): ArammetaChampion | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, any>
  if (!Array.isArray(data.poolAugments) && !data.top && !data.itemClusters) return null

  // 稀有度与 arammeta 自己的排序分：来自 top/bot 榜单
  const ranked = new Map<number, { rarity: ArammetaRarity; lift: number | null; lcb: number | null; score: number | null; g: number; wr: number; pick: number }>()
  const baselines: number[] = []
  for (const bucket of [data.top, data.bot]) {
    if (!bucket || typeof bucket !== 'object') continue
    for (const rarity of RARITIES) {
      for (const row of asList(bucket[rarity])) {
        const id = idOf(row.id)
        if (id == null || ranked.has(id)) continue
        const lift = numOrNull(row.lift)
        const wr = num(row.wr)
        if (lift != null && wr > 0) baselines.push(wr - lift)
        ranked.set(id, { rarity, lift, lcb: numOrNull(row.lcb), score: numOrNull(row.score), g: num(row.g), wr, pick: num(row.pick) })
      }
    }
  }
  baselines.sort((a, b) => a - b)
  const baselineWr = baselines.length ? Math.round(baselines[Math.floor(baselines.length / 2)] * 10000) / 10000 : null

  const augments = new Map<number, ArammetaAugmentStat>()
  for (const row of asList(data.poolAugments)) {
    const id = idOf(row.id)
    if (id == null) continue
    const extra = ranked.get(id)
    augments.set(id, {
      id,
      g: num(row.g),
      wr: num(row.wr),
      pick: num(row.pick),
      rarity: extra?.rarity ?? null,
      lift: extra?.lift ?? (baselineWr != null && num(row.wr) > 0 ? Math.round((num(row.wr) - baselineWr) * 10000) / 10000 : null),
      lcb: extra?.lcb ?? null,
      score: extra?.score ?? null,
    })
  }
  for (const [id, extra] of ranked) {
    if (!augments.has(id)) augments.set(id, { id, g: extra.g, wr: extra.wr, pick: extra.pick, rarity: extra.rarity, lift: extra.lift, lcb: extra.lcb, score: extra.score })
  }

  const dedupe = (list: ArammetaItemStat[]) => list.filter((entry, index) => list.findIndex((other) => other.ids.join(',') === entry.ids.join(',')) === index)
  const stats = (section: unknown, key: string) => asList((section as Record<string, unknown> | undefined)?.[key]).map(itemStat).filter((entry): entry is ArammetaItemStat => entry != null)
  const routes: ArammetaRoute[] = asList(data.itemClusters?.groups).map((group) => {
    const boot = group.routeBoot && typeof group.routeBoot === 'object' ? group.routeBoot as Record<string, unknown> : null
    return {
      label: localizeRouteLabel(String(group.name_en ?? ''), String(group.name_zh ?? '')),
      labelEn: String(group.name_en ?? ''),
      core: idsOf(group.core),
      g: num(group.g),
      wr: num(group.wr),
      lift: num(group.lift),
      pick: num(group.pick),
      options: asList(group.options).map((option) => ({
        id: idOf(option.id) ?? 0, g: num(option.g), wr: num(option.wr), lift: num(option.lift), lcb: num(option.lcb), pick: num(option.pick), lane: String(option.lane ?? ''),
      })).filter((option) => option.id > 0),
      tail: idsOf(group.tail),
      completion: idsOf(group.completion),
      completionGames: num(group.completionGames),
      boot: boot && idOf(boot.id) ? { id: idOf(boot.id)!, g: num(boot.g), wr: num(boot.wr), pick: num(boot.pick) } : null,
    }
  }).filter((route) => route.core.length > 0 && route.g > 0)

  return {
    schema: ARAMMETA_SCHEMA_VERSION,
    championId,
    baselineWr,
    augments: [...augments.values()],
    singles: dedupe([...stats(data.singleItems, 'top'), ...stats(data.singleItems, 'bot'), ...stats(data.singleItems, 'popularBad')]),
    pairs: dedupe([...stats(data.items, 'top'), ...stats(data.items, 'bot')]),
    boots: [...stats(data.boots, 'top'), ...stats(data.boots, 'bot')].filter((entry, index, list) => list.findIndex((other) => other.ids[0] === entry.ids[0]) === index),
    traps: [...stats(data.singleItems, 'bot'), ...stats(data.singleItems, 'popularBad')],
    routes,
  }
}

/** tier-list.json（约 900KB）→ 精简元数据（版本、样本、英雄基线/阵容特征、阵容表） */
export function normalizeArammetaMeta(raw: unknown, updatedAt: string | null = null): ArammetaMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, any>
  if (!data.champs || typeof data.champs !== 'object') return null
  const champs: Record<string, ArammetaChampMeta> = {}
  for (const [id, info] of Object.entries(data.champs as Record<string, any>)) {
    if (!info || typeof info !== 'object') continue
    const comp = info.comp && typeof info.comp === 'object'
      ? Object.fromEntries(Object.entries(info.comp).map(([key, value]) => [key, num(value)]))
      : null
    champs[id] = { wr: num(info.wr), g: num(info.g), tags: Array.isArray(info.tags) ? info.tags.map(String) : [], comp }
  }
  const augRarity: Record<string, ArammetaRarity> = {}
  for (const [id, info] of Object.entries((data.augs ?? {}) as Record<string, any>)) {
    if (RARITIES.includes(info?.rarity)) augRarity[id] = info.rarity
  }
  const changes = data.patchChanges ?? {}
  const composition = data.recommendation_composition && typeof data.recommendation_composition.tables === 'object'
    ? data.recommendation_composition as ArammetaCompositionConfig
    : null
  return {
    schema: ARAMMETA_SCHEMA_VERSION,
    queue: 2400,
    patch: typeof changes.currentPatch === 'string' ? changes.currentPatch : (typeof data.patch_prefix === 'string' ? data.patch_prefix : null),
    baselinePatch: typeof changes.baselinePatch === 'string' ? changes.baselinePatch : null,
    games: numOrNull(changes.currentGames) ?? numOrNull(data.team_score?.trained_games),
    detailVersion: typeof data.detailVersion === 'string' ? data.detailVersion : null,
    ddragonVersion: typeof data.ddv === 'string' ? data.ddv : null,
    sampleEndMs: numOrNull(data.team_score?.split?.test_end_ms),
    updatedAt,
    minChampAugGames: numOrNull(changes.minChampAugGames),
    regionNote: '元数据未标服务器；作者脚本默认 TW2（台服），名称为繁体',
    champs,
    augRarity,
    composition,
  }
}
