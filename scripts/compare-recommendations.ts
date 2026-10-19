/**
 * 前后对比：旧启发式（augment-build-heuristic）vs 新引擎（recommendation/build-engine）。
 * 用法：npx esbuild scripts/compare-recommendations.ts --bundle --platform=node --format=esm --outfile=/tmp/compare.mjs && node /tmp/compare.mjs
 * 输入：APIDATA_DIR（默认 /workspace/apidata，含 champions/<id>.json 与 items.json）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { recommendBuildForAugments } from '../src/shared/augment-build-heuristic.ts'
import { recommendBuild, getStoredAugmentProfile } from '../src/shared/recommendation/index.ts'

const dir = process.env.APIDATA_DIR || '/workspace/apidata'
const out = process.env.REPORT_PATH || '/workspace/reports/recommendation-comparison.md'
const scenarioOut = process.env.SCENARIO_PATH || '/workspace/reports/scenarios.json'
const itemsFile = JSON.parse(readFileSync(join(dir, 'items.json'), 'utf8'))
const items = itemsFile.data ?? itemsFile

export const SCENARIOS: Array<[number, string, number[][]]> = [
  [1, '安妮', [[1048, 1415], [1318, 1004], [1041, 1013]]],
  [157, '亚索', [[1336, 1328], [1225, 1058], [1041, 1181, 1353]]],
  [22, '艾希', [[1205, 1030], [1022, 1007], [1225, 1220]]],
  [54, '墨菲特', [[1013, 1152], [1097, 1030], [1092, 2128]]],
]

const itemName = (id: number | string) => {
  const entry = (Array.isArray(items) ? items : Object.values(items)).find((item: any) => String(item.id) === String(id)) as any
  const name = entry?.name
  return (typeof name === 'object' ? name?.zh_cn : name) || String(id)
}

const lines: string[] = ['# 出装推荐前后对比', '', '旧 = 原 augment-build-heuristic（关键词标签）；新 = 海克斯画像 × 装备属性评分引擎。标记：🆕 新进、↑ 提前、↓ 推后；「挤掉」= 无海克斯基线中被替换的装备。', '']
const scenarios: any[] = []
for (const [championId, label, combos] of SCENARIOS) {
  const champ = JSON.parse(readFileSync(join(dir, 'champions', `${championId}.json`), 'utf8'))
  const base = new Map<string, any>((champ.augments || []).map((augment: any) => [String(augment.id), augment]))
  const baseline = recommendBuild({ builds: champ.builds, items, augments: [] })
  const oldBaseline = recommendBuildForAugments({ pickedAugments: [], builds: champ.builds, items, ownedItemIds: [], enemyDamage: null, maxItems: 6 })
  lines.push(`## ${label}`, '', `无海克斯基线（${baseline.archetype?.label}）：${baseline.items.map((item) => item.name).join(' → ')}`, '')
  lines.push('| 海克斯 | 旧推荐（前 6） | 新推荐 | 新流派 | 挤掉 |', '|---|---|---|---|---|')
  for (const combo of combos) {
    const profiles = combo.map((id) => getStoredAugmentProfile(id)!).filter(Boolean)
    const comboName = profiles.map((profile) => profile.name).join(' + ')
    const old = recommendBuildForAugments({
      pickedAugments: combo.map((id) => ({ id, name: base.get(String(id))?.name ?? getStoredAugmentProfile(id)?.name, description: base.get(String(id))?.description ?? null, tooltip: base.get(String(id))?.tooltip ?? null })),
      builds: champ.builds, items, ownedItemIds: [], enemyDamage: null, maxItems: 6,
    })
    const result = recommendBuild({ builds: champ.builds, items, augments: profiles })
    const mark = (change: string | null) => (change === 'new' ? '🆕' : change === 'up' ? '↑' : change === 'down' ? '↓' : '')
    const oldNames = old.items.slice(0, 6).map((item: any) => itemName(item.itemId))
    const oldSame = oldNames.join() === oldBaseline.items.slice(0, 6).map((item: any) => itemName(item.itemId)).join()
    lines.push(`| ${comboName} | ${oldNames.join('、')}${oldSame ? '（与无海克斯相同）' : ''} | ${result.items.map((item) => `${mark(item.change)}${item.name}`).join('、')} | ${result.archetype?.label ?? ''} | ${result.removed.map((item) => item.name).join('、') || '—'} |`)
    scenarios.push({ championId, label, combo, comboName, augments: combo.map((id) => ({ id, name: getStoredAugmentProfile(id)?.name, iconPath: base.get(String(id))?.iconUrl ?? null })), result: { archetype: result.archetype?.label, items: result.items.map((item) => ({ name: item.name, change: item.change, reasons: item.reasons, score: item.score })), removed: result.removed } })
  }
  lines.push('')
  const detail = scenarios.filter((entry) => entry.championId === championId)
  for (const entry of detail) {
    lines.push(`<details><summary>${label} · ${entry.comboName} 每件原因</summary>`, '')
    for (const item of entry.result.items) lines.push(`- ${item.name}（${item.score.total}）：${item.reasons.join('；')}`)
    lines.push('', '</details>', '')
  }
}
lines.push('> 诚实声明：数据源没有「海克斯 × 装备」统计。先验（出装路线、装备出场率/胜率）是真实数据；海克斯部分是规则模型，不是测得的胜率。')
mkdirSync(join(out, '..'), { recursive: true })
writeFileSync(out, lines.join('\n'))
writeFileSync(scenarioOut, JSON.stringify(scenarios, null, 1))
console.log(lines.join('\n'))
