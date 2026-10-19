#!/usr/bin/env node
/**
 * 生成出装推荐引擎用的静态数据表（确定性，可重复运行）：
 *   src/shared/recommendation/data/augment-profiles.json  所有海克斯的画像（自动解析 + 人工复核覆盖）
 *   src/shared/recommendation/data/item-profiles.json     装备属性/被动标签表
 *
 * 输入（离线快照，路径可用环境变量覆盖）：
 *   ARAMGG_AUGMENTS_JSON  dtodo augments.json（中文描述/tooltip、全局选取率）
 *   ARAMGG_ITEMS_JSON     CommunityDragon zh_cn items.json（装备属性）
 *   ARAMGG_ARAM_ITEMS_JSON dtodo items.json（ARAM 可用装备 id 集合）
 *   ARAMGG_AUGMENT_VALUES_JSON（可选）Blitz mayhem augments_en_us（spellDataValues 数值字段名，仅作解析信号）
 *   复核覆盖：src/shared/recommendation/data/augment-profile-overrides.json
 *
 * 用法：node scripts/build-recommendation-data.mjs
 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import os from 'node:os'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(root, 'src/shared/recommendation/data')
const apidata = process.env.ARAMGG_APIDATA_DIR || '/workspace/apidata'
const input = {
  augments: process.env.ARAMGG_AUGMENTS_JSON || path.join(apidata, 'aug.json'),
  items: process.env.ARAMGG_ITEMS_JSON || path.join(apidata, 'cdragon-items.zh_cn.json'),
  aramItems: process.env.ARAMGG_ARAM_ITEMS_JSON || path.join(apidata, 'items.json'),
  values: process.env.ARAMGG_AUGMENT_VALUES_JSON || path.join(apidata, 'blitz-mayhem-augments-16.20.en_us.json'),
}

const bundled = path.join(os.tmpdir(), `aramgg-profiles-${process.pid}.mjs`)
await build({
  entryPoints: [path.join(root, 'src/shared/recommendation/profiles.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundled,
  logLevel: 'silent',
})
const { parseAugmentProfile, parseItemProfile, applyAugmentOverride } = await import(pathToFileURL(bundled).href)

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
const listOf = (payload) => (Array.isArray(payload) ? payload : payload?.data ?? [])

const augmentsPayload = await readJson(input.augments)
const augments = listOf(augmentsPayload)
const cdragonItems = listOf(await readJson(input.items))
const aramItems = listOf(await readJson(input.aramItems))
const values = existsSync(input.values) ? await readJson(input.values) : {}
const overridesFile = path.join(dataDir, 'augment-profile-overrides.json')
const overrides = existsSync(overridesFile) ? await readJson(overridesFile) : { augments: {} }

// ---- 装备表：ARAM 可用 id ∩ CDragon 属性（CDragon 缺失时退回 dtodo 描述）
const cdragonById = new Map(cdragonItems.map((item) => [Number(item.id), item]))
const itemProfiles = []
for (const aramItem of aramItems) {
  const id = Number(aramItem.id)
  const source = cdragonById.get(id) ?? aramItem
  if (source.requiredChampion) continue
  const categories = (source.categories?.length ? source.categories : aramItem.categories) ?? []
  if (categories.includes('Consumable') || categories.includes('Trinket')) continue
  const profile = parseItemProfile({ ...aramItem, ...source, categories, name: aramItem.name ?? source.name })
  itemProfiles.push({ ...profile, source: cdragonById.has(id) ? 'cdragon' : 'dtodo' })
}
itemProfiles.sort((a, b) => a.id - b.id)
const itemNames = itemProfiles.map((item) => ({ id: item.id, name: item.name, priceTotal: item.priceTotal }))

// ---- 海克斯表
const missingOverrides = new Set(Object.keys(overrides.augments ?? {}))
const augmentProfiles = augments.map((augment) => {
  const dataValues = values?.[String(augment.id)]?.spellDataValues ?? null
  let profile = parseAugmentProfile({ ...augment, dataValues }, itemNames)
  const override = overrides.augments?.[String(augment.id)]
  if (override) {
    missingOverrides.delete(String(augment.id))
    profile = applyAugmentOverride(profile, override, itemNames)
  }
  return {
    ...profile,
    pickRate: augment.stats?.pickRate ?? null,
    winRate: augment.stats?.winRate ?? null,
    topChampionIds: (augment.topChampions ?? []).map((champion) => champion.id).slice(0, 6),
    dataValueSource: dataValues ? 'blitz-spellDataValues' : null,
  }
}).sort((a, b) => a.id - b.id)

if (missingOverrides.size) {
  console.warn(`overrides for unknown augment ids: ${[...missingOverrides].join(', ')}`)
}

const meta = {
  version: 1,
  generatedFrom: {
    augments: `${augmentsPayload.service ?? 'dtodo'} ${augmentsPayload.dataVersion ?? ''}`.trim(),
    items: 'CommunityDragon latest zh_cn items.json ∩ dtodo items.json',
    dataValues: existsSync(input.values) ? 'Blitz mayhem augments (field names only, as parse signals)' : null,
  },
  gamePatch: augmentsPayload.gamePatch ?? null,
  note: '模型权重，不是测得的海克斯×装备胜率',
}
await mkdir(dataDir, { recursive: true })
await writeFile(path.join(dataDir, 'augment-profiles.json'), `${JSON.stringify({ meta, augments: augmentProfiles }, null, 1)}\n`)
await writeFile(path.join(dataDir, 'item-profiles.json'), `${JSON.stringify({ meta, items: itemProfiles }, null, 1)}\n`)
const reviewed = augmentProfiles.filter((profile) => profile.source === 'reviewed').length
console.log(`augments: ${augmentProfiles.length} (reviewed ${reviewed}), items: ${itemProfiles.length}`)
