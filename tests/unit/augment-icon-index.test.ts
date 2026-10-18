import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import sharp from 'sharp'
import {
  AugmentIconIndex,
  isAllowedIconUrl,
} from '../../src/main/services/manual-overlay/augment-icon-index.ts'

const ICONS = path.resolve(__dirname, '../fixtures/augment-icons')
const SHOT = path.resolve(__dirname, '../fixtures/augment-ocr/full-three-cards.png')

function createFetch() {
  return vi.fn(async (url: string) => {
    const id = url.match(/\/(\d+)\.png$/)?.[1]
    if (!id) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    const file = readFileSync(path.join(ICONS, `${id}.png`))
    return { ok: true, status: 200, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) }
  })
}

const augments = [1390, 1129, 1332, 1054, 1204].map((id) => ({
  id,
  name: `aug${id}`,
  rarity: 1,
  iconUrl: `https://cdn.dtodo.cn/hextech/augment-icons/${id}.png`,
}))

describe('AugmentIconIndex', () => {
  it('only allows https icons from the known CDNs', () => {
    expect(isAllowedIconUrl('https://cdn.dtodo.cn/a.png')).toBe(true)
    expect(isAllowedIconUrl('https://raw.communitydragon.org/x.png')).toBe(true)
    expect(isAllowedIconUrl('http://cdn.dtodo.cn/a.png')).toBe(false)
    expect(isAllowedIconUrl('https://evil.example.com/a.png')).toBe(false)
    expect(isAllowedIconUrl('file:///etc/passwd')).toBe(false)
  })

  it('downloads, caches and matches icons; a second build reuses the cache', async () => {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'icon-index-'))
    const fetch = createFetch()
    const loadAugments = vi.fn(async () => [
      ...augments,
      { id: 1, name: 'blocked', iconUrl: 'https://evil.example.com/1.png' },
      { id: 2, name: 'missing', iconUrl: 'https://cdn.dtodo.cn/hextech/none.png' },
    ])
    const index = new AugmentIconIndex({ loadAugments, fetch, cacheDir })
    await index.ensureBuilt()
    expect(index.status()).toEqual({ ready: true, count: 5, error: null })
    expect(fetch).toHaveBeenCalledTimes(6) // 5 个图标 + 1 个 404；白名单外的不请求
    expect(fetch.mock.calls.some(([url]) => String(url).includes('evil'))).toBe(false)
    expect(existsSync(path.join(cacheDir, 'descriptors.json'))).toBe(true)

    const { data, info } = await sharp(SHOT).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const matches = await index.matchImage({ buffer: data, width: info.width, height: info.height, channels: info.channels })
    expect(matches[1][0].id).toBe(1390)
    expect(matches[2][0].id).toBe(1129)
    // PNG 输入走 sharp 解码，结果一致
    const fromPng = await index.matchImage(readFileSync(SHOT))
    expect(fromPng[1][0].id).toBe(1390)

    const fetch2 = createFetch()
    const second = new AugmentIconIndex({ loadAugments, fetch: fetch2, cacheDir })
    await second.ensureBuilt()
    expect(second.status().count).toBe(5)
    expect(fetch2).toHaveBeenCalledTimes(1) // 只有之前失败的那个会重试
  })

  it('rejects non-PNG downloads', async () => {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'icon-index-'))
    const fetch = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('<html>').buffer }))
    const index = new AugmentIconIndex({ loadAugments: async () => augments.slice(0, 1), fetch, cacheDir })
    await index.ensureBuilt()
    expect(index.status().ready).toBe(false)
    expect(index.status().error).toBeTruthy()
    expect(await index.matchImage(readFileSync(SHOT))).toEqual([[], [], []])
  })
})
