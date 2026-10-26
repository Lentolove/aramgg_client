// 组合真实数据（augmentTrios）前后对比：≥3 个英雄，已选 1–2 张海克斯
import { loadEvalInputs } from './eval.ts'
import { LINEUPS, trioRanking } from './scenarios.ts'
const inputs = loadEvalInputs()
const cases: Array<[string, number, number[], number[]]> = [
  ['墨菲特 已选 1152+1181，三选一含 1353（命中完整三组合）', 54, [1353, 2102, 1413], [1152, 1181]],
  ['墨菲特 已选 1152，三选一含 1181/1353（部分命中）', 54, [1181, 1353, 2102], [1152]],
  ['亚索 已选 1058+1077，三选一含 1356/1080', 157, [1356, 1080, 1007], [1058, 1077]],
  ['塔姆 已选 1041，三选一含 1152/1029', 223, [1152, 1029, 1007], [1041]],
  ['卡兹克 已选 1019+1214，三选一含 2083/1068', 141, [2083, 1068, 1098], [1019, 1214]],
]
for (const [name, cid, roll, held] of cases) {
  const r = trioRanking(inputs, cid, roll, LINEUPS['AP重'] ?? [], held)
  console.log(`\n=== ${name}`)
  for (const c of r) console.log(`  ${c.card.name}(${c.card.id}) [${c.tier}] 总${c.points} 数据${c.dataPoints} 契合${c.adjustPoints} | ${c.plainReason}${c.synergy?.trioDetail ? ` | ${c.synergy.trioDetail} 组合${c.synergy.trio.points}` : ''}`)
}
