/**
 * 跑全部 30 名玩家，输出 JSON（供前后对比）与可读摘要。
 * 用法：node scripts/eval-real-matches/run.mjs report [输出 JSON 路径]
 */
import { writeFileSync } from 'node:fs'
import { evaluateAll, summarize } from './eval.ts'

const out = process.argv[3] || process.env.EVAL_OUT || 'eval-real-matches.json'
const players = evaluateAll()
const metrics = summarize(players)
writeFileSync(out, JSON.stringify({ metrics, players }, null, 1))
console.log(JSON.stringify(metrics, null, 1))
for (const p of players) {
  const flags = [
    ...p.plans.filter((plan) => plan.mixed).map((plan) => `混搭:${plan.label}`),
    ...p.ownedPlans.filter((plan) => plan.mixed).map((plan) => `已有装混搭:${plan.label}`),
    ...[...p.plans, ...p.ownedPlans].filter((plan) => plan.bootsIssue).map((plan) => `鞋:${plan.bootsIssue}`),
    ...[...p.plans, ...p.ownedPlans].flatMap((plan) => plan.illegal),
    p.adviceStasisForTank ? '坦克保命建议' : '',
  ].filter(Boolean)
  console.log(`${p.gameId % 1000} ${p.name}(${p.role}) 敌AP输出${p.enemyApDealers}/AD输出${p.enemyAdDealers} mr=${p.needs.mr} armor=${p.needs.armor} | ${p.plans.map((plan) => `${plan.label}[${Math.round(plan.overlap * 100)}%]`).join(' ')} | ${flags.join('；') || 'OK'}`)
}
