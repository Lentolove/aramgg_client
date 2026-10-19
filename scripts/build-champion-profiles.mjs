#!/usr/bin/env node
/**
 * 生成阵容分析用的英雄画像表（确定性，可重复运行）：
 *   src/shared/recommendation/data/champion-profiles.json
 *
 * 输入（离线快照，路径可用环境变量覆盖）：
 *   ARAMGG_DDRAGON_CHAMPIONS_JSON  DDragon zh_CN champion.json（tags、info.attack/magic/defense、攻击距离）
 *   ARAMGG_CDRAGON_SUMMARY_JSON    CommunityDragon champion-summary.json（roles）
 *   人工整理：src/shared/recommendation/data/champion-profile-overrides.json（ARAM 常见英雄，覆盖自动推断）
 *
 * 数值都是 0–1 的相对强度（cc = 大致硬控个数），是模型，不是统计。
 * 用法：node scripts/build-champion-profiles.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(root, 'src/shared/recommendation/data')
const apidata = process.env.ARAMGG_APIDATA_DIR || '/workspace/apidata'
const ddragonFile = process.env.ARAMGG_DDRAGON_CHAMPIONS_JSON || path.join(apidata, 'ddragon-champion.zh_CN.json')
const summaryFile = process.env.ARAMGG_CDRAGON_SUMMARY_JSON || path.join(apidata, 'cdragon-champion-summary.json')
const overridesFile = path.join(dataDir, 'champion-profile-overrides.json')

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
const ddragon = await readJson(ddragonFile)
const summary = existsSync(summaryFile) ? await readJson(summaryFile) : []
const overrides = existsSync(overridesFile) ? (await readJson(overridesFile)).champions ?? {} : {}
const rolesById = new Map(summary.map((entry) => [Number(entry.id), entry.roles ?? []]))

const round2 = (value) => Math.round(value * 100) / 100
const clamp01 = (value) => Math.max(0, Math.min(1, value))

const ROLE_MAP = { Tank: 'tank', Fighter: 'fighter', Mage: 'mage', Assassin: 'assassin', Marksman: 'marksman', Support: 'enchanter' }

/** 只有 DDragon 标签/评分时的推断（置信度低） */
function inferProfile(champion) {
  const tags = champion.tags ?? []
  const info = champion.info ?? {}
  const has = (tag) => tags.includes(tag)
  const magic = Number(info.magic) || 0
  const attack = Number(info.attack) || 0
  const defense = Number(info.defense) || 0
  let ap = magic + attack > 0 ? magic / (magic + attack) : 0.5
  if (has('Marksman') && !has('Mage')) ap = Math.min(ap, 0.2)
  ap = round2(ap >= 0.8 ? 1 : ap <= 0.2 ? 0 : ap)
  const frontline = has('Tank') ? 0.85 : has('Fighter') ? 0.45 + Math.max(0, defense - 5) * 0.05 : defense / 20
  return {
    damage: { ap, ad: round2(1 - ap), true: 0 },
    frontline: round2(clamp01(frontline)),
    sustain: 0.1,
    shield: has('Support') ? 0.4 : 0.1,
    cc: has('Tank') ? 2 : has('Support') ? 1.5 : has('Mage') ? 1 : 0.5,
    burst: has('Assassin') ? 0.8 : has('Mage') ? 0.5 : 0.3,
    dps: has('Marksman') ? 0.8 : has('Fighter') ? 0.5 : 0.3,
    dive: has('Assassin') ? 0.8 : has('Fighter') ? 0.4 : has('Tank') ? 0.4 : 0,
    poke: has('Mage') || has('Marksman') ? 0.4 : 0,
    percentHp: 0,
    roles: tags.map((tag) => ROLE_MAP[tag]).filter(Boolean),
  }
}

const champions = []
for (const champion of Object.values(ddragon.data ?? {})) {
  const id = Number(champion.key)
  const curated = overrides[champion.id]
  const base = curated ?? inferProfile(champion)
  const range = Number(champion.stats?.attackrange) || 0
  champions.push({
    id,
    key: champion.id,
    // DDragon zh_CN 的 name 是称号（「黑暗之女」），title 才是常用名（「安妮」）
    name: champion.title || champion.name,
    title: champion.name,
    roles: base.roles?.length ? base.roles : (rolesById.get(id) ?? []).map((role) => (role === 'support' ? 'enchanter' : role)),
    damage: base.damage,
    frontline: base.frontline,
    sustain: base.sustain,
    shield: base.shield,
    cc: base.cc,
    burst: base.burst,
    dps: base.dps,
    dive: base.dive,
    poke: base.poke,
    percentHp: base.percentHp,
    range,
    ranged: range >= 300,
    source: curated ? 'curated' : 'ddragon-tags',
    confidence: curated ? 0.8 : 0.4,
  })
}
champions.sort((a, b) => a.id - b.id)
const meta = {
  version: 1,
  ddragonVersion: ddragon.version ?? null,
  generatedFrom: {
    ddragon: `DDragon ${ddragon.version ?? '?'} zh_CN champion.json（tags / info / attackrange）`,
    roles: 'CommunityDragon champion-summary.json（roles，兜底）',
    curated: `champion-profile-overrides.json（${Object.keys(overrides).length} 个 ARAM 常见英雄，人工整理）`,
  },
  note: '0–1 相对强度（cc≈硬控个数）；curated 置信度 0.8，按标签推断 0.4。模型，不是统计。',
}
await writeFile(path.join(dataDir, 'champion-profiles.json'), `${JSON.stringify({ meta, champions }, null, 1)}\n`)
console.log(`champion-profiles.json: ${champions.length} champions (${champions.filter((c) => c.source === 'curated').length} curated)`)
