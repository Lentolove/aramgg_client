/**
 * 一次性抓取真实对局评测要用的 dtodo 英雄数据（联网），写入 tests/fixtures/real-matches/dtodo-detail.json。
 * 之后评测与回归测试只读这个快照（离线、可复现）。
 * 用法：node scripts/eval-real-matches/run.mjs collect
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getChampionDetailData } from '../../src/main/data-loader.ts'

const root = process.cwd()
const sample = JSON.parse(readFileSync(join(root, 'docs/samples/match-history-upload.real-sanitized.json'), 'utf8'))
const championIds = [...new Set<number>(sample.samples.flatMap((s: any) => s.game.participants.map((p: any) => Number(p.championId))))].sort((a, b) => a - b)
const out: any = { createdAt: new Date().toISOString(), source: 'data.dtodo.cn client v1（getChampionDetailData）', items: null, augments: {}, champions: {} }
const zh = (value: any) => (value && typeof value === 'object' ? value.zh_cn ?? value.zh_CN ?? Object.values(value)[0] : value)
const hasArammetaRoutes = (id: number) => {
  try {
    return JSON.parse(readFileSync(join(root, 'resources/arammeta/champions', `${id}.json`), 'utf8')).routes?.length > 0
  } catch {
    return false
  }
}
for (const id of championIds) {
  const detail: any = await getChampionDetailData(id, 'zh-CN')
  if (!out.items) out.items = (detail.items || []).map((item: any) => ({ ...item, name: zh(item.name), description: zh(item.description), plaintext: zh(item.plaintext), iconPath: undefined }))
  for (const a of detail.augmentBase || []) {
    out.augments[a.id] ??= { id: a.id, name: a.name, rarity: a.rarity, rarityName: a.rarityName, description: a.description, tooltip: a.tooltip, iconUrl: a.iconUrl }
  }
  const stats: Record<string, any> = {}
  for (const [key, stat] of Object.entries<any>(detail.augments || {})) {
    stats[key] = { win_rate: stat.win_rate, num_games: stat.num_games, num_win_games: stat.num_win_games, pick_rate: stat.pick_rate, tier: stat.tier, rank: stat.rank }
  }
  out.champions[id] = {
    championName: detail.championName,
    augmentIds: (detail.augmentBase || []).map((a: any) => a.id),
    augmentStats: stats,
    augmentTrios: detail.augmentTrios,
    // 有 arammeta 路线时浮窗不用 dtodo 出装：不存
    builds: hasArammetaRoutes(id) ? [] : detail.builds,
  }
  console.log('collected', id, detail.championName?.nameCN)
}
mkdirSync(join(root, 'tests/fixtures/real-matches'), { recursive: true })
writeFileSync(join(root, 'tests/fixtures/real-matches/dtodo-detail.json'), JSON.stringify(out))
