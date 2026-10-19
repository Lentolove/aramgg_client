/**
 * arammeta 数据（Lanternko/ARAM-Mayhem-Database，MIT）运行时获取。
 *
 * 查找顺序：内存 → 磁盘缓存（未过期）→ 镜像依次请求（同一镜像带 If-None-Match，304 视为未变）
 *          → 过期缓存 → 打包快照（resources/arammeta）→ 无。
 * 镜像顺序：raw.githubusercontent.com → cdn.jsdelivr.net → fastly.jsdelivr.net → arammeta.com
 * 缓存保存的是规整后的数据（normalize.ts），不是原始 JSON。
 */

import fs from 'fs-extra'
import path from 'path'
import {
  ARAMMETA_SCHEMA_VERSION,
  normalizeArammetaChampion,
  normalizeArammetaMeta,
  type ArammetaChampion,
  type ArammetaMeta,
} from '../../../shared/arammeta/normalize.ts'

export const ARAMMETA_MIRRORS: ReadonlyArray<{ name: string; base: string }> = [
  { name: 'raw.githubusercontent.com', base: 'https://raw.githubusercontent.com/Lanternko/ARAM-Mayhem-Database/main/docs/api/' },
  { name: 'cdn.jsdelivr.net', base: 'https://cdn.jsdelivr.net/gh/Lanternko/ARAM-Mayhem-Database@main/docs/api/' },
  { name: 'fastly.jsdelivr.net', base: 'https://fastly.jsdelivr.net/gh/Lanternko/ARAM-Mayhem-Database@main/docs/api/' },
  { name: 'arammeta.com', base: 'https://arammeta.com/api/' },
]

export type ArammetaSource = 'memory' | 'cache' | 'network' | 'revalidated' | 'stale-cache' | 'bundled' | 'none'

interface CacheEntry<T> {
  schema: number
  etag: string | null
  lastModified: string | null
  mirror: string | null
  fetchedAt: number
  detailVersion: string | null
  data: T
}

export interface ArammetaFetchResult<T> {
  data: T | null
  source: ArammetaSource
  mirror: string | null
  fetchedAt: number | null
  error: string | null
}

export interface ArammetaServiceOptions {
  cacheDir: string
  bundledDirs: string[]
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
  championTtlMs?: number
  metaTtlMs?: number
  mirrors?: ReadonlyArray<{ name: string; base: string }>
}

export class ArammetaService {
  private readonly memory = new Map<string, CacheEntry<unknown>>()
  private readonly inflight = new Map<string, Promise<ArammetaFetchResult<unknown>>>()
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly championTtlMs: number
  private readonly metaTtlMs: number
  private readonly mirrors: ReadonlyArray<{ name: string; base: string }>

  constructor(private readonly options: ArammetaServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? 6000
    this.championTtlMs = options.championTtlMs ?? 6 * 3600_000
    this.metaTtlMs = options.metaTtlMs ?? 12 * 3600_000
    this.mirrors = options.mirrors ?? ARAMMETA_MIRRORS
  }

  async getMeta(): Promise<ArammetaFetchResult<ArammetaMeta>> {
    const result = await this.load<ArammetaMeta>('meta', 'tier-list.json', 'meta.json', this.metaTtlMs, null,
      (raw, lastModified) => normalizeArammetaMeta(raw, lastModified))
    // raw.githubusercontent.com / jsDelivr 不给 Last-Modified：向 arammeta.com 补一次 HEAD 拿发布时间
    if (result.data && !result.data.updatedAt && result.source === 'network') {
      const updatedAt = await this.headLastModified('https://arammeta.com/api/tier-list.json')
      if (updatedAt) {
        result.data.updatedAt = updatedAt
        const entry = this.memory.get('meta')
        if (entry) await this.writeCache(path.join(this.options.cacheDir, 'meta.json'), entry)
      }
    }
    return result
  }

  private async headLastModified(url: string): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 4000))
    try {
      const response = await this.fetchImpl(url, { method: 'HEAD', signal: controller.signal })
      const value = response.ok ? response.headers.get('last-modified') : null
      const date = value ? new Date(value) : null
      return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async getChampion(championId: number): Promise<ArammetaFetchResult<ArammetaChampion> & { meta: ArammetaFetchResult<ArammetaMeta> }> {
    const meta = await this.getMeta()
    const id = Math.trunc(Number(championId))
    if (!Number.isFinite(id) || id <= 0) {
      return { data: null, source: 'none', mirror: null, fetchedAt: null, error: 'invalid champion id', meta }
    }
    const result = await this.load<ArammetaChampion>(`champion:${id}`, `champions/${id}.json`, `champions/${id}.json`,
      this.championTtlMs, meta.data?.detailVersion ?? null, (raw) => normalizeArammetaChampion(raw, id))
    return { ...result, meta }
  }

  private load<T>(key: string, remotePath: string, localName: string, ttl: number, detailVersion: string | null,
    normalize: (raw: unknown, lastModified: string | null) => T | null): Promise<ArammetaFetchResult<T>> {
    const pending = this.inflight.get(key)
    if (pending) return pending as Promise<ArammetaFetchResult<T>>
    const job = this.loadUncached(key, remotePath, localName, ttl, detailVersion, normalize)
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, job as Promise<ArammetaFetchResult<unknown>>)
    return job
  }

  private isFresh(entry: CacheEntry<unknown>, ttl: number, detailVersion: string | null) {
    if (entry.schema !== ARAMMETA_SCHEMA_VERSION) return false
    if (detailVersion && entry.detailVersion && entry.detailVersion !== detailVersion) return false
    return this.now() - entry.fetchedAt < ttl
  }

  private async loadUncached<T>(key: string, remotePath: string, localName: string, ttl: number, detailVersion: string | null,
    normalize: (raw: unknown, lastModified: string | null) => T | null): Promise<ArammetaFetchResult<T>> {
    const memo = this.memory.get(key) as CacheEntry<T> | undefined
    if (memo && this.isFresh(memo, ttl, detailVersion)) {
      return { data: memo.data, source: 'memory', mirror: memo.mirror, fetchedAt: memo.fetchedAt, error: null }
    }
    const cachePath = path.join(this.options.cacheDir, localName)
    const disk = memo ?? await this.readCache<T>(cachePath)
    if (disk && this.isFresh(disk, ttl, detailVersion)) {
      this.memory.set(key, disk)
      return { data: disk.data, source: 'cache', mirror: disk.mirror, fetchedAt: disk.fetchedAt, error: null }
    }

    const errors: string[] = []
    for (const mirror of this.mirrors) {
      const headers: Record<string, string> = { Accept: 'application/json' }
      const canRevalidate = disk && disk.schema === ARAMMETA_SCHEMA_VERSION && disk.mirror === mirror.name && disk.etag
      if (canRevalidate) headers['If-None-Match'] = disk!.etag!
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchImpl(mirror.base + remotePath, { headers, signal: controller.signal })
        if (response.status === 304 && canRevalidate) {
          const entry: CacheEntry<T> = { ...disk!, fetchedAt: this.now(), detailVersion: detailVersion ?? disk!.detailVersion }
          await this.writeCache(cachePath, entry)
          this.memory.set(key, entry)
          return { data: entry.data, source: 'revalidated', mirror: mirror.name, fetchedAt: entry.fetchedAt, error: null }
        }
        if (!response.ok) {
          errors.push(`${mirror.name}: HTTP ${response.status}`)
          continue
        }
        const lastModified = response.headers.get('last-modified')
        const raw = await response.json()
        const data = normalize(raw, lastModified ? new Date(lastModified).toISOString() : null)
        if (!data) {
          errors.push(`${mirror.name}: 格式无法识别`)
          continue
        }
        const entry: CacheEntry<T> = {
          schema: ARAMMETA_SCHEMA_VERSION,
          etag: response.headers.get('etag'),
          lastModified,
          mirror: mirror.name,
          fetchedAt: this.now(),
          detailVersion: (data as { detailVersion?: string | null }).detailVersion ?? detailVersion,
          data,
        }
        await this.writeCache(cachePath, entry)
        this.memory.set(key, entry)
        return { data, source: 'network', mirror: mirror.name, fetchedAt: entry.fetchedAt, error: null }
      } catch (error) {
        errors.push(`${mirror.name}: ${error instanceof Error ? (error.name === 'AbortError' ? '超时' : error.message) : String(error)}`)
      } finally {
        clearTimeout(timer)
      }
    }
    const error = errors.join('; ') || null
    if (disk && disk.schema === ARAMMETA_SCHEMA_VERSION) {
      this.memory.set(key, disk)
      return { data: disk.data, source: 'stale-cache', mirror: disk.mirror, fetchedAt: disk.fetchedAt, error }
    }
    const bundled = await this.readBundled<T>(localName)
    if (bundled) return { data: bundled, source: 'bundled', mirror: null, fetchedAt: null, error }
    return { data: null, source: 'none', mirror: null, fetchedAt: null, error }
  }

  private async readCache<T>(file: string): Promise<CacheEntry<T> | null> {
    try {
      const entry = await fs.readJson(file) as CacheEntry<T>
      return entry && typeof entry === 'object' && entry.data ? entry : null
    } catch {
      return null
    }
  }

  private async writeCache(file: string, entry: CacheEntry<unknown>) {
    try {
      await fs.ensureDir(path.dirname(file))
      const tmp = `${file}.tmp`
      await fs.writeJson(tmp, entry)
      await fs.move(tmp, file, { overwrite: true })
    } catch {
      // 缓存写失败不影响本次结果
    }
  }

  /** 快照里存的已经是规整后的数据（scripts/build-arammeta-snapshot.mjs） */
  private async readBundled<T>(localName: string): Promise<T | null> {
    for (const dir of this.options.bundledDirs) {
      try {
        const data = await fs.readJson(path.join(dir, localName)) as { schema?: number }
        if (data && data.schema === ARAMMETA_SCHEMA_VERSION) return data as T
      } catch {
        // 下一个候选目录
      }
    }
    return null
  }
}

let instance: ArammetaService | null = null

export async function getArammetaService(): Promise<ArammetaService> {
  if (instance) return instance
  const { getAppDataDir } = await import('../../modules/app-paths.ts')
  const bundledDirs: string[] = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) bundledDirs.push(path.join(process.resourcesPath, 'arammeta'))
  bundledDirs.push(path.join(process.cwd(), 'resources', 'arammeta'))
  instance = new ArammetaService({ cacheDir: path.join(getAppDataDir(), 'cache', 'arammeta'), bundledDirs })
  return instance
}
