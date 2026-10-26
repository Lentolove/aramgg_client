// 固定三选一：3 英雄 × 3 阵容（+ 已选海克斯），看档位/理由随局面变化
import { loadEvalInputs } from './eval.ts'
import { LINEUPS, trioRanking } from './scenarios.ts'
const inputs = loadEvalInputs()
const cases: Array<[string, number, number[], number[]]> = [
  ['墨菲特', 54, [2102, 1152, 1353], []],
  ['墨菲特 持有「和我一起困在这里」', 54, [2102, 1152, 1353], [1413]],
  ['亚索', 157, [1063, 1225, 1007], []],
  ['亚索 持有「灵巧」', 157, [1063, 1225, 1007], [1022]],
  ['卡兹克', 141, [1098, 1063, 1038], []],
]
for (const [name, cid, roll, held] of cases) {
  console.log(`\n=== ${name}`)
  for (const [ln, enemies] of Object.entries(LINEUPS)) {
    const r = trioRanking(inputs, cid, roll, enemies, held)
    console.log(`[${ln}] ` + r.map((c: any) => `${c.card.name}[${c.tier}] ${c.plainReason}${c.rollNote ? `（${c.rollNote}）` : ''}`).join(' | '))
  }
}
