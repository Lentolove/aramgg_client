import { loadEvalInputs } from './eval.ts'
import { rankingPoints } from '../../src/shared/augment-choice-ranking.ts'
import { LINEUPS, scenario, trioRanking } from './scenarios.ts'
const inputs = loadEvalInputs()
const show = (t: string, cid: number, ids: number[], ln: string, held: number[]) => {
  const r = trioRanking(inputs, cid, ids, LINEUPS[ln], held)
  console.log(`${t} [敌:${ln} 持有:${held.join(',') || '无'}] ` + r.map((c: any) => `${c.card.name}=${c.tier ? `${c.tier}(${c.plainReason})` : `${c.label ?? c.relativeLabel}`}`).join(' | '))
}
show('卡隐', 141, [1098, 1063, 1038], 'AP重', [])
show('卡隐', 141, [1098, 1063, 1038], 'AD重', [])
show('墨菲特', 54, [2102, 1152, 1353], 'AP重', [])
show('墨菲特', 54, [2102, 1152, 1353], 'AP重', [1413])
show('墨菲特', 54, [2102, 1180, 1149], 'AD重', [])
for (const [n, cid, held] of [['墨菲特', 54, [1413]], ['亚索', 157, []]] as const) for (const ln of ['AP重', 'AD重']) {
  const s = scenario(inputs, cid, LINEUPS[ln], [...held])
  console.log(`${n} 出装 [敌:${ln}] ${(s.notes[0]?.endsWith('undefined') ? s.build : s.notes).join(' > ')}`)
}
