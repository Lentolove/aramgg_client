/**
 * 海克斯官方图标库：下载（仅限白名单 CDN）→ 本地缓存 → 计算描述子 → 对截图三张卡做图标匹配。
 *
 * 图标文件缓存在 <appData>/cache/augment-icons/<urlhash>.png，描述子缓存在 descriptors.json，
 * 第二次启动无需重新下载或计算。所有依赖可注入，便于测试。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import {
  CARD_ICON_BACKGROUND,
  computeDescriptor,
  createIconRegions,
  describeSlotVariants,
  matchIconVariants,
  regionHasContent,
  sampleRegion,
  type IconDescriptor,
  type IconIndexEntry,
  type IconMatch,
  type RawImage,
} from '../../../shared/augment-icon-match.ts'

/** 描述子算法变更时递增，使旧缓存失效 */
export const ICON_DESCRIPTOR_VERSION = 1
export const ALLOWED_ICON_HOSTS = ['cdn.dtodo.cn', 'raw.communitydragon.org']
const MAX_ICON_BYTES = 2 * 1024 * 1024
const DOWNLOAD_CONCURRENCY = 6
const DOWNLOAD_TIMEOUT_MS = 10000

export interface AugmentBaseLike {
  id: number | string
  name: string
  rarity?: number | string | null
  iconUrl?: string | null
  iconPath?: string | null
}

export interface AugmentIconIndexDeps {
  loadAugments: () => Promise<AugmentBaseLike[]>
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer> }>
  cacheDir: string
  logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; debug: (...args: any[]) => void }
}

export interface RawImageInputLike {
  buffer: Buffer
  width: number
  height: number
  channels: number
}

export function isAllowedIconUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ALLOWED_ICON_HOSTS.includes(url.hostname)
  } catch {
    return false
  }
}

export function iconCacheFileName(url: string): string {
  return `${createHash('sha1').update(url).digest('hex').slice(0, 20)}.png`
}

function isPng(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47
}

export async function describeIconImage(input: Buffer): Promise<IconDescriptor> {
  const { data, info } = await sharp(input)
    .flatten({ background: CARD_ICON_BACKGROUND })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const image: RawImage = { data, width: info.width, height: info.height, channels: info.channels }
  return computeDescriptor(sampleRegion(image, { left: 0, top: 0, width: info.width, height: info.height }))
}

export async function toRawImage(input: Buffer | RawImageInputLike): Promise<RawImage> {
  if (!Buffer.isBuffer(input)) {
    return { data: input.buffer, width: input.width, height: input.height, channels: input.channels }
  }
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

async function mapWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      await worker(item)
    }
  })
  await Promise.all(runners)
}

export class AugmentIconIndex {
  private readonly deps: AugmentIconIndexDeps
  private entries: IconIndexEntry[] = []
  private buildPromise: Promise<void> | null = null
  private lastError: string | null = null

  constructor(deps: AugmentIconIndexDeps) {
    this.deps = deps
  }

  get ready(): boolean {
    return this.entries.length > 0
  }

  status() {
    return { ready: this.ready, count: this.entries.length, error: this.lastError }
  }

  getEntries(): IconIndexEntry[] {
    return this.entries
  }

  /** 构建（或复用正在进行的构建）；失败不抛出，只记录 error */
  ensureBuilt(): Promise<void> {
    if (this.ready) return Promise.resolve()
    this.buildPromise ??= this.build().finally(() => {
      this.buildPromise = null
    })
    return this.buildPromise
  }

  private descriptorCachePath(): string {
    return path.join(this.deps.cacheDir, 'descriptors.json')
  }

  private readDescriptorCache(): Record<string, IconDescriptor> {
    try {
      const raw = JSON.parse(readFileSync(this.descriptorCachePath(), 'utf8'))
      if (raw?.version === ICON_DESCRIPTOR_VERSION && raw.descriptors && typeof raw.descriptors === 'object') {
        return raw.descriptors
      }
    } catch {
      // 没有缓存或已损坏
    }
    return {}
  }

  private async downloadIcon(url: string, filePath: string): Promise<Buffer | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    try {
      const response = await this.deps.fetch(url, { signal: controller.signal })
      if (!response.ok) {
        this.deps.logger?.debug(`[icon-index] download failed ${response.status}: ${url}`)
        return null
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length === 0 || buffer.length > MAX_ICON_BYTES || !isPng(buffer)) {
        this.deps.logger?.debug(`[icon-index] rejected non-PNG or oversized icon: ${url}`)
        return null
      }
      writeFileSync(filePath, buffer)
      return buffer
    } catch (error) {
      this.deps.logger?.debug(`[icon-index] download error: ${url}`, error)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private async build(): Promise<void> {
    const startedAt = performance.now()
    try {
      mkdirSync(this.deps.cacheDir, { recursive: true })
      const augments = (await this.deps.loadAugments()).filter((augment) =>
        augment && augment.id != null && isAllowedIconUrl(augment.iconUrl ?? augment.iconPath))
      const cache = this.readDescriptorCache()
      const nextCache: Record<string, IconDescriptor> = {}
      const entries: IconIndexEntry[] = []
      let downloaded = 0
      let failed = 0

      await mapWithConcurrency(augments, DOWNLOAD_CONCURRENCY, async (augment) => {
        const url = String(augment.iconUrl ?? augment.iconPath)
        let descriptor = cache[url]
        if (!descriptor) {
          const filePath = path.join(this.deps.cacheDir, iconCacheFileName(url))
          let buffer: Buffer | null = null
          if (existsSync(filePath)) {
            buffer = readFileSync(filePath)
          } else {
            buffer = await this.downloadIcon(url, filePath)
            if (buffer) downloaded++
          }
          if (!buffer) {
            failed++
            return
          }
          try {
            descriptor = await describeIconImage(buffer)
          } catch (error) {
            failed++
            this.deps.logger?.debug(`[icon-index] decode failed: ${url}`, error)
            return
          }
        }
        nextCache[url] = descriptor
        entries.push({
          id: augment.id,
          name: augment.name,
          rarity: augment.rarity ?? null,
          iconPath: url,
          descriptor,
        })
      })

      entries.sort((a, b) => String(a.id).localeCompare(String(b.id)))
      this.entries = entries
      this.lastError = entries.length === 0 ? '没有可用的海克斯图标（下载失败？）' : null
      try {
        writeFileSync(this.descriptorCachePath(), JSON.stringify({ version: ICON_DESCRIPTOR_VERSION, descriptors: nextCache }))
      } catch (error) {
        this.deps.logger?.warn('[icon-index] failed to write descriptor cache', error)
      }
      this.deps.logger?.info('[icon-index] built', {
        entries: entries.length,
        downloaded,
        failed,
        ms: Math.round(performance.now() - startedAt),
      })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.deps.logger?.warn('[icon-index] build failed', error)
    }
  }

  /** 对整张截图的三个卡位做图标匹配；每个卡位返回前 topN（空卡位返回 []） */
  async matchImage(input: Buffer | RawImageInputLike, topN = 5): Promise<IconMatch[][]> {
    if (!this.ready) return [[], [], []]
    const image = await toRawImage(input)
    return createIconRegions(image.width, image.height).map((rect) => {
      if (!regionHasContent(image, rect)) return []
      return matchIconVariants(describeSlotVariants(image, rect), this.entries, topN)
    })
  }
}
