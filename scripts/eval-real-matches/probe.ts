import { loadEvalInputs } from './eval.ts'
import { LINEUPS, scenario, trio } from './scenarios.ts'

const inputs = loadEvalInputs()
const cases: Array<[string, number, number[][]]> = [
  ['墨菲特', 54, [[]]], ['亚索', 157, [[]]], ['卡兹克/卡隐', 141, [[]]],
]
for (const [name, cid] of cases) {
  console.log(`\n=== ${name} (${cid})`)
  const champ = inputs.arammeta(cid)
  const top = (champ?.augments ?? []).filter((a: any) => a.rarity === 'kPrismatic').sort((a: any, b: any) => b.score - a.score)
  const heldSets: Array<[string, number[]]> = [['无', []], ['持有:' + (inputs.dtodo.augments[top[5]?.id]?.name ?? top[5]?.id), top[5] ? [top[5].id] : []]]
  for (const [ln, enemies] of Object.entries(LINEUPS)) for (const [hn, held] of heldSets) {
    const r = scenario(inputs, cid, enemies, held)
    console.log(`[${ln} / ${hn}] 银:${r.augs.kSilver.join(',')} | 金:${r.augs.kGold.join(',')} | 棱:${r.augs.kPrismatic.join(',')}\n   出装:${r.notes.join(' > ')}\n   ${r.advice}`)
  }
}

if (process.env.PROBE_TRIO) {
  for (const cid of [54, 157, 141]) {
    const champ = inputs.arammeta(cid)
    console.log(`\n### 契合度 ${cid}`)
    for (const [ln, enemies] of Object.entries(LINEUPS)) {
      const r = trio(inputs, cid, champ.augments.filter((a: any) => a.rarity === 'kGold').slice(0, 40).map((a: any) => a.id), enemies, [])
      const adj = r.filter((x: string) => !/契合0\]/.test(x))
      console.log(ln, adj.slice(0, 12).join('\n  '))
    }
  }
}
