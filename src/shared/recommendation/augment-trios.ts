/**
 * 三海克斯组合真实胜率（dtodo `augmentTrios`）→ 候选卡的「组合」信号。
 *
 * 数据事实（16.21.2 实测，见 docs/TECHNICAL.md）：
 *  - 每条 = 某英雄「一局结束时持有的那 3 张海克斯」的无序集合（id 升序），wins/games 为该集合的对局数。
 *  - 来源 aramgg-client-upload（WORLD，补丁 16.19–16.21），不是腾讯国服统计。
 *  - 每英雄最多 5 条，且是 ≥150 场里胜率最高的 5 条（有选择偏差：几乎都高于平均）。
 *
 * 算法：
 *  - 期望胜率 E = 英雄基线 + 候选卡自身提升 + 相关已选卡自身提升（单卡提升已在「实测」里算过，
 *    这里只看「组合多出来的部分」，避免重复计算）。
 *  - 收缩：p = (wins + α·E)/(games + α)，α=350（与 arammeta 同量级）；信号 = p − E。
 *  - 完整命中（已选 2 张 + 候选 = 一条三组合）：权重 1。
 *  - 部分命中（候选 + 某 1 张已选 同时出现的所有三组合）：把这些记录的 wins/games 相加。
 *    每局玩家只有一个三卡集合，不同记录是互不重叠的对局，相加不会重复计数；权重 0.6（第三张卡不定）。
 *    已选 2 张但没有完整命中时，分别算两张已选，取场次多的一组（不相加，避免同一局被算两次）。
 *  - 聚合后场次 < 50 → 不用，回退规则。结果封顶 ±3 个百分点。
 */

export interface AugmentTrioLike {
  augmentIds?: Array<number | string>
  games?: number
  wins?: number
  winRate?: number
  stats?: { games?: number; wins?: number; winRate?: number }
}

export const TRIO_PARAMS = {
  minGames: 50,
  alpha: 350,
  fullWeight: 1,
  pairWeight: 0.6,
  capPoints: 3,
} as const

export interface TrioSignal {
  kind: 'full' | 'pair'
  /** 已选里参与组合的卡 id */
  partnerIds: string[]
  games: number
  wins: number
  /** 原始组合胜率 */
  rawWinRate: number
  /** 期望胜率（基线 + 单卡提升） */
  expected: number
  /** 加权、封顶后的百分点（正 = 组合好于预期） */
  points: number
}

function recordNumbers(record: AugmentTrioLike) {
  const games = Number(record.games ?? record.stats?.games) || 0
  const rate = Number(record.winRate ?? record.stats?.winRate)
  const winsRaw = record.wins ?? record.stats?.wins
  const wins = winsRaw != null && Number.isFinite(Number(winsRaw)) ? Number(winsRaw) : (Number.isFinite(rate) ? rate * games : 0)
  return { games, wins }
}

export function trioSignal(
  candidateId: number | string,
  heldIds: Array<number | string>,
  trios: AugmentTrioLike[] | undefined,
  baselineWinRate: number | null | undefined,
  liftOf: (id: string) => number | null = () => null,
): TrioSignal | null {
  if (!trios?.length || baselineWinRate == null || !Number.isFinite(baselineWinRate)) return null
  const cand = String(candidateId)
  const held = [...new Set(heldIds.map(String))].filter((id) => id !== cand)
  if (!held.length) return null
  const sets = trios.map((record) => ({ ids: new Set((record.augmentIds ?? []).map(String)), ...recordNumbers(record) }))
    .filter((record) => record.games > 0 && record.ids.has(cand))
  if (!sets.length) return null
  const lift = (id: string) => liftOf(id) ?? 0

  const evaluate = (kind: 'full' | 'pair', partners: string[], rows: typeof sets): TrioSignal | null => {
    const games = rows.reduce((sum, row) => sum + row.games, 0)
    const wins = rows.reduce((sum, row) => sum + row.wins, 0)
    if (games < TRIO_PARAMS.minGames) return null
    const expected = baselineWinRate + lift(cand) + partners.reduce((sum, id) => sum + lift(id), 0)
    const shrunk = (wins + TRIO_PARAMS.alpha * expected) / (games + TRIO_PARAMS.alpha)
    const weight = kind === 'full' ? TRIO_PARAMS.fullWeight : TRIO_PARAMS.pairWeight
    const raw = (shrunk - expected) * 100 * weight
    const points = Math.max(-TRIO_PARAMS.capPoints, Math.min(TRIO_PARAMS.capPoints, raw))
    return { kind, partnerIds: partners, games, wins, rawWinRate: wins / games, expected, points: Math.round(points * 10) / 10 }
  }

  // 完整命中：已选里任意 2 张 + 候选 = 一条记录（已选 3 张以上时取场次最多的那条）
  if (held.length >= 2) {
    const full = sets.filter((row) => held.filter((id) => row.ids.has(id)).length >= 2)
      .sort((a, b) => b.games - a.games)[0]
    if (full) {
      const partners = held.filter((id) => full.ids.has(id)).slice(0, 2)
      const signal = evaluate('full', partners, [full])
      if (signal) return signal
    }
  }
  // 部分命中：候选 + 1 张已选；多张已选时取场次最多的一组
  let best: TrioSignal | null = null
  for (const id of held) {
    const signal = evaluate('pair', [id], sets.filter((row) => row.ids.has(id)))
    if (signal && (!best || signal.games > best.games)) best = signal
  }
  return best
}

/** 主卡片上的一句话（不带数字） */
export function trioReason(signal: TrioSignal, nameOf: (id: string) => string): string {
  const names = signal.partnerIds.map((id) => `「${nameOf(id)}」`).join('')
  const direction = signal.points >= 0 ? '高于' : '低于'
  return `与你已有的${names}组合，该英雄该组合胜率${direction}平均`
}

/** 详情里的说明（带场次） */
export function trioDetail(signal: TrioSignal): string {
  return `组合实测 ${signal.games} 局（${signal.kind === 'full' ? '三卡完全一致' : '含这两张的所有三卡组合合计'}）`
}

/**
 * 单卡提升：stats 为 id → { win_rate|winRate, num_games|games }（dtodo 本英雄海克斯统计，腾讯国服）。
 * 参照点用这份统计自己的场次加权平均（不与 arammeta 基线混用，避免不同数据源的整体偏移被算成「提升」）。
 */
export function makeLiftOf(statsById: Record<string, any> | undefined, alpha: number = TRIO_PARAMS.alpha): (id: string) => number | null {
  const rows = Object.entries(statsById ?? {}).map(([id, stat]) => ({
    id, games: Number(stat?.num_games ?? stat?.games) || 0, rate: Number(stat?.win_rate ?? stat?.winRate),
  })).filter((row) => row.games > 0 && Number.isFinite(row.rate))
  const total = rows.reduce((sum, row) => sum + row.games, 0)
  if (!total) return () => null
  const reference = rows.reduce((sum, row) => sum + row.rate * row.games, 0) / total
  const byId = new Map(rows.map((row) => [row.id, row]))
  return (id) => {
    const row = byId.get(String(id))
    if (!row) return null
    return (row.rate * row.games + alpha * reference) / (row.games + alpha) - reference
  }
}
