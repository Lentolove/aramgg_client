import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSources: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  desktopCapturer: {
    getSources: mocks.getSources,
  },
}))

vi.mock('../../src/main/modules/logger.ts', () => ({
  default: mocks.logger,
}))

const createThumbnail = (width = 1280, height = 720) => ({
  isEmpty: () => false,
  toPNG: () => Buffer.from('png'),
  getSize: () => ({ width, height }),
})

describe('captureScreenshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prefers the LoL game window by default', async () => {
    mocks.getSources.mockResolvedValue([
      {
        id: 'window:1:0',
        name: 'League of Legends',
        thumbnail: createThumbnail(1600, 900),
      },
      {
        id: 'screen:0:0',
        name: 'Entire Screen',
        thumbnail: createThumbnail(),
      },
    ])

    const { captureScreenshot } = await import('../../src/main/screenshot.ts')
    const result = await captureScreenshot()

    expect(result.success).toBe(true)
    expect(result.captureMode).toBe('window')
    expect(result.hasLolWindow).toBe(true)
    expect(result.windowName).toBe('League of Legends')
    expect(result.width).toBe(1600)
    expect(result.height).toBe(900)
    expect(mocks.getSources).toHaveBeenCalledWith({
      types: ['window', 'screen'],
      thumbnailSize: { width: 1280, height: 720 },
    })
  })

  it('accepts a smaller thumbnail only when the caller requests it', async () => {
    mocks.getSources.mockResolvedValue([
      {
        id: 'screen:0:0',
        name: 'Entire Screen',
        thumbnail: createThumbnail(1024, 576),
      },
    ])

    const { captureScreenshot } = await import('../../src/main/screenshot.ts')
    const result = await captureScreenshot({
      preferScreen: true,
      thumbnailSize: { width: 1024, height: 576 },
    })

    expect(result.success).toBe(true)
    expect(mocks.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 1024, height: 576 },
    })
  })
})

describe('captureGameWindowOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('captures only window sources and picks the in-game window', async () => {
    mocks.getSources.mockResolvedValue([
      { id: 'window:1:0', name: 'League of Legends', thumbnail: createThumbnail(1280, 720) },
      { id: 'window:2:0', name: 'League of Legends (TM) Client', thumbnail: createThumbnail(1920, 1080) },
    ])

    const { captureGameWindowOnce } = await import('../../src/main/screenshot.ts')
    const result = await captureGameWindowOnce()

    expect(result.success).toBe(true)
    expect(result.captureMode).toBe('window')
    expect(result.windowName).toBe('League of Legends (TM) Client')
    expect(result.width).toBe(1920)
    expect(mocks.getSources).toHaveBeenCalledTimes(1)
    expect(mocks.getSources).toHaveBeenCalledWith({
      types: ['window'],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false,
    })
  })

  it('falls back to a screen capture when no game window exists', async () => {
    mocks.getSources
      .mockResolvedValueOnce([{ id: 'window:9:0', name: 'Notepad', thumbnail: createThumbnail() }])
      .mockResolvedValueOnce([{ id: 'screen:0:0', name: 'Entire Screen', thumbnail: createThumbnail() }])

    const { captureGameWindowOnce } = await import('../../src/main/screenshot.ts')
    const result = await captureGameWindowOnce()

    expect(result.success).toBe(true)
    expect(result.hasLolWindow).toBe(false)
    expect(result.captureMode).toBe('screen')
    expect(mocks.getSources).toHaveBeenLastCalledWith(expect.objectContaining({ types: ['screen'] }))
  })
})

describe('captureGameWindowOnce raw capture', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { resetDetectedBitmapOrder, resetCachedGameWindowSource } = await import('../../src/main/screenshot.ts')
    resetDetectedBitmapOrder()
    resetCachedGameWindowSource()
  })

  async function createBitmapThumbnail(bgra: [number, number, number, number], pngRgb: [number, number, number]) {
    const sharp = (await import('sharp')).default
    const pixelPng = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: pngRgb[0], g: pngRgb[1], b: pngRgb[2] } },
    }).png().toBuffer()
    const width = 4
    const height = 4
    const bitmap = Buffer.alloc(width * height * 4)
    for (let i = 0; i < width * height; i++) bitmap.set(bgra, i * 4)
    return {
      isEmpty: () => false,
      toPNG: vi.fn(() => Buffer.from('png')),
      toBitmap: () => Buffer.from(bitmap),
      crop: () => ({ toPNG: () => pixelPng }),
      getSize: () => ({ width, height }),
    }
  }

  it('returns RGBA pixels converted from a BGRA bitmap without PNG encoding', async () => {
    // 真实颜色 R=20 G=10 B=200，位图按 BGRA 存储
    const thumbnail = await createBitmapThumbnail([200, 10, 20, 255], [20, 10, 200])
    mocks.getSources.mockResolvedValue([
      { id: 'window:2:0', name: 'League of Legends (TM) Client', thumbnail },
    ])
    const { captureGameWindowOnce } = await import('../../src/main/screenshot.ts')
    const result = await captureGameWindowOnce({ raw: true })
    expect(result.success).toBe(true)
    expect(result.raw).toMatchObject({ width: 4, height: 4, channels: 4 })
    expect([...result.raw!.buffer.subarray(0, 4)]).toEqual([20, 10, 200, 255])
    expect(result.buffer).toBeUndefined()
    expect(thumbnail.toPNG).not.toHaveBeenCalled()
  })

  it('keeps the byte order when the bitmap is already RGBA', async () => {
    const thumbnail = await createBitmapThumbnail([200, 10, 20, 255], [200, 10, 20])
    mocks.getSources.mockResolvedValue([
      { id: 'window:2:0', name: 'League of Legends (TM) Client', thumbnail },
    ])
    const { captureGameWindowOnce } = await import('../../src/main/screenshot.ts')
    const result = await captureGameWindowOnce({ raw: true })
    expect([...result.raw!.buffer.subarray(0, 4)]).toEqual([200, 10, 20, 255])
  })

  it('reuses the cached in-game window id when several candidates exist', async () => {
    mocks.getSources.mockResolvedValueOnce([
      { id: 'window:2:0', name: 'League of Legends (TM) Client', thumbnail: createThumbnail(1920, 1080) },
    ])
    const { captureGameWindowOnce } = await import('../../src/main/screenshot.ts')
    await captureGameWindowOnce()
    mocks.getSources.mockResolvedValueOnce([
      { id: 'window:3:0', name: 'League of Legends (TM) Client', thumbnail: createThumbnail(1280, 720) },
      { id: 'window:2:0', name: 'League of Legends (TM) Client', thumbnail: createThumbnail(1600, 900) },
    ])
    const second = await captureGameWindowOnce()
    expect(second.width).toBe(1600)
  })

  it('swapRedBlueInPlace swaps R and B channels', async () => {
    const { swapRedBlueInPlace } = await import('../../src/main/screenshot.ts')
    expect([...swapRedBlueInPlace(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))]).toEqual([3, 2, 1, 4, 7, 6, 5, 8])
  })
})
