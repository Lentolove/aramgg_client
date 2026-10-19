#!/usr/bin/env node
/**
 * 打包用的 arammeta 快照（运行时取不到网络时的兜底）。
 * 数据来自 arammeta / Lanternko（https://github.com/Lanternko/ARAM-Mayhem-Database），MIT。
 *
 * 来源：ARAMMETA_REPO_DIR=<本地克隆>（读 docs/api），否则按镜像顺序下载
 *       raw.githubusercontent.com → cdn.jsdelivr.net → fastly.jsdelivr.net → arammeta.com
 * 输出：resources/arammeta/meta.json、champions/<id>.json（已规整，与运行时缓存同格式）、snapshot-info.json
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.resolve(process.env.ARAMMETA_SNAPSHOT_OUT || path.join(root, 'resources', 'arammeta'))
const repoDir = process.env.ARAMMETA_REPO_DIR || ''
const MIRRORS = [
  'https://raw.githubusercontent.com/Lanternko/ARAM-Mayhem-Database/main/docs/api/',
  'https://cdn.jsdelivr.net/gh/Lanternko/ARAM-Mayhem-Database@main/docs/api/',
  'https://fastly.jsdelivr.net/gh/Lanternko/ARAM-Mayhem-Database@main/docs/api/',
  'https://arammeta.com/api/',
]

const bundled = path.join(os.tmpdir(), `aramgg-arammeta-normalize-${process.pid}.mjs`)
await build({
  entryPoints: [path.join(root, 'src/shared/arammeta/normalize.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundled,
  logLevel: 'silent',
})
const { normalizeArammetaChampion, normalizeArammetaMeta } = await import(pathToFileURL(bundled).href)
await rm(bundled, { force: true })

async function fetchJson(relative) {
  const errors = []
  for (const base of MIRRORS) {
    try {
      const response = await fetch(base + relative, { signal: AbortSignal.timeout(20000) })
      if (!response.ok) { errors.push(`${base}: HTTP ${response.status}`); continue }
      return { data: await response.json(), lastModified: response.headers.get('last-modified'), mirror: base }
    } catch (error) {
      errors.push(`${base}: ${error?.message || error}`)
    }
  }
  throw new Error(`下载 ${relative} 失败：${errors.join('; ')}`)
}

async function readLocal(relative) {
  const file = path.join(repoDir, 'docs', 'api', relative)
  return JSON.parse(await readFile(file, 'utf8'))
}

function repoUpdatedAt() {
  try {
    return execFileSync('git', ['-C', repoDir, 'log', '-1', '--format=%cI', '--', 'docs/api/tier-list.json'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

async function main() {
  let metaRaw
  let updatedAt = null
  let source
  if (repoDir) {
    metaRaw = await readLocal('tier-list.json')
    updatedAt = repoUpdatedAt() ?? (await stat(path.join(repoDir, 'docs', 'api', 'tier-list.json'))).mtime.toISOString()
    source = `local:${repoDir}`
  } else {
    const result = await fetchJson('tier-list.json')
    metaRaw = result.data
    // raw.githubusercontent.com 不给 Last-Modified：留空（界面改显示数据版本号 + 样本截至时间）
    let lastModified = result.lastModified
    if (!lastModified) {
      try {
        const head = await fetch('https://arammeta.com/api/tier-list.json', { method: 'HEAD', signal: AbortSignal.timeout(8000) })
        lastModified = head.ok ? head.headers.get('last-modified') : null
      } catch {
        lastModified = null
      }
    }
    updatedAt = lastModified ? new Date(lastModified).toISOString() : null
    source = result.mirror
  }
  const meta = normalizeArammetaMeta(metaRaw, updatedAt ? new Date(updatedAt).toISOString() : null)
  if (!meta) throw new Error('tier-list.json 格式无法识别')

  let ids = Object.keys(meta.champs).map(Number).filter((id) => id > 0)
  if (repoDir) {
    const files = await readdir(path.join(repoDir, 'docs', 'api', 'champions'))
    const local = new Set(files.map((file) => Number(file.replace(/\.json$/, ''))).filter((id) => id > 0))
    ids = ids.filter((id) => local.has(id))
  }

  await rm(outDir, { recursive: true, force: true })
  await mkdir(path.join(outDir, 'champions'), { recursive: true })
  await writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta))

  let written = 0
  const failed = []
  const queue = [...ids]
  await Promise.all(Array.from({ length: repoDir ? 4 : 8 }, async () => {
    while (queue.length) {
      const id = queue.shift()
      try {
        const raw = repoDir ? await readLocal(`champions/${id}.json`) : (await fetchJson(`champions/${id}.json`)).data
        const champion = normalizeArammetaChampion(raw, id)
        if (!champion) { failed.push(id); continue }
        await writeFile(path.join(outDir, 'champions', `${id}.json`), JSON.stringify(champion))
        written += 1
      } catch {
        failed.push(id)
      }
    }
  }))
  const info = {
    attribution: '数据来自 arammeta / Lanternko，MIT（https://github.com/Lanternko/ARAM-Mayhem-Database）',
    createdAt: new Date().toISOString(),
    source,
    patch: meta.patch,
    games: meta.games,
    detailVersion: meta.detailVersion,
    updatedAt: meta.updatedAt,
    champions: written,
    failed,
  }
  await writeFile(path.join(outDir, 'snapshot-info.json'), JSON.stringify(info, null, 2))
  console.log(`[arammeta] 快照：${written} 个英雄，版本 ${meta.patch}，${meta.games} 场 → ${path.relative(root, outDir)}${failed.length ? `（失败 ${failed.length}：${failed.slice(0, 10).join(',')}）` : ''}`)
}

main().catch((error) => {
  console.error(`[arammeta] 快照失败：${error?.message || error}`)
  process.exit(1)
})
