import { execFile } from 'child_process'
import { desktopCapturer, type DesktopCapturerSource, type NativeImage, type Size } from 'electron'
import sharp from 'sharp'
import logger from './modules/logger.ts'

let lastCaptureSourceKey: string | null = null
export const CAPTURE_THUMBNAIL_SIZE = { width: 1280, height: 720 }
const DEFAULT_CAPTURE_TIMEOUT_MS = 4000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) {
        return promise
    }

    let timeoutId: NodeJS.Timeout | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
    })

    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timeoutId) {
            clearTimeout(timeoutId)
        }
    })
}

/**
 * 查找游戏窗口
 * @param {Array} sources - desktopCapturer 返回的源列表
 * @returns {Object|null} 匹配的游戏窗口源，未找到返回 null
 */
const findGameWindow = (sources: DesktopCapturerSource[]): DesktopCapturerSource | null => {
    const candidates = sources.map(source => {
        const name = source.name.toLowerCase()
        const isOwnWindow =
            name.includes('aramgg_client') ||
            name.includes('lol_tips_client') ||
            name.includes('champr')

        if (isOwnWindow) {
            return { source, score: 0 }
        }

        if (name.includes('league of legends') && name.includes('client')) {
            return { source, score: 100 }
        }

        if (name.includes('league of legends') || name.includes('英雄联盟')) {
            return { source, score: 80 }
        }

        if (name.includes('league') && name.includes('client')) {
            return { source, score: 60 }
        }

        return { source, score: 0 }
    })

    candidates.sort((a, b) => b.score - a.score)
    return candidates[0]?.score > 0 ? candidates[0].source : null
}

const isLolGameProcessRunning = (): Promise<boolean | null> => {
    if (process.platform !== 'win32') {
        return Promise.resolve(null)
    }

    return new Promise<boolean>((resolve) => {
        execFile(
            'tasklist',
            ['/FI', 'IMAGENAME eq League of Legends.exe', '/FO', 'CSV', '/NH'],
            { timeout: 3000, windowsHide: true },
            (error, stdout = '') => {
                if (error) {
                    logger.debug('Unable to query LoL game process:', error.message)
                    resolve(false)
                    return
                }

                resolve(stdout.toLowerCase().includes('league of legends.exe'))
            }
        )
    })
}

/**
 * 查找屏幕源（回退方案）
 * @param {Array} sources - desktopCapturer 返回的源列表
 * @returns {Object|null} 主屏幕源，未找到返回 null
 */
const findScreenSource = (sources: DesktopCapturerSource[]): DesktopCapturerSource | null => {
    // 优先使用主显示器（screen:0:0 通常是主屏幕）
    const screens = sources.filter((source) => source.id.startsWith('screen:'))
    return screens.length > 0 ? screens[0] : null
}

/**
 * 尝试通过 desktopCapturer 获取 LoL 游戏窗口 ID
 * @returns {Promise<string|null>} 游戏窗口 ID，未找到返回 null
 */
export const getLolGameWindowId = async () => {
    try {
        const sources = await desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false,
        })
        const gameWindow = findGameWindow(sources)
        return gameWindow ? gameWindow.id : null
    } catch (error) {
        logger.error('获取游戏窗口 ID 失败:', error)
        return null
    }
}

export const getLolGameWindowInfo = async () => {
    try {
        const sources = await desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false,
        })
        const gameWindow = findGameWindow(sources)
        return {
            found: !!gameWindow,
            id: gameWindow?.id || null,
            name: gameWindow?.name || null,
        }
    } catch (error) {
        logger.error('Failed to query LoL game window:', error)
        return {
            found: false,
            id: null,
            name: null,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}

export const getLolGameStatus = async () => {
    const [processRunning, windowInfo] = await Promise.all([
        isLolGameProcessRunning(),
        getLolGameWindowInfo(),
    ])

    return {
        ...windowInfo,
        processRunning,
        isGameOpen: windowInfo.found && (processRunning === null || processRunning),
    }
}

/**
 * 截图当前屏幕（优先截取游戏窗口）
 * 截图直接返回内存Buffer，不进行磁盘I/O
 * @param {Object} options - 截图选项
 * @returns {Promise<Object>} 截图结果
 */
type CaptureScreenshotOptions = {
    preferScreen?: boolean
    timeoutMs?: number
    thumbnailSize?: Size
}

export const captureScreenshot = async (options: CaptureScreenshotOptions = {}) => {
    try {
        const {
            preferScreen = false,
            timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
            thumbnailSize = CAPTURE_THUMBNAIL_SIZE,
        } = options || {}
        const timestamp = Date.now()
        const sourceTypes: Array<'screen' | 'window'> = preferScreen
            ? ['screen']
            : ['window', 'screen']

        // 获取所有窗口和屏幕源
        const sources = await withTimeout(
            desktopCapturer.getSources({
                types: sourceTypes,
                thumbnailSize,
            }),
            timeoutMs,
            `desktopCapturer.getSources(${sourceTypes.join(',')})`
        )

        // 查找游戏窗口
        const gameWindow = preferScreen ? null : findGameWindow(sources)

        // 确定截图源：优先游戏窗口，否则使用全屏
        let captureSource: DesktopCapturerSource | null = gameWindow
        let captureMode: 'window' | 'screen' = 'window'

        if (!gameWindow) {
            captureSource = findScreenSource(sources)
            captureMode = 'screen'
        }

        if (!captureSource) {
            throw new Error('无法获取截图源')
        }

        // 获取截图
        const screenshot = captureSource.thumbnail

        if (!screenshot || screenshot.isEmpty()) {
            throw new Error('截图为空')
        }

        // 转换为 PNG Buffer（内存中，不保存到文件）
        const pngBuffer = screenshot.toPNG()
        const hasLolWindow = !!gameWindow
        const size = screenshot.getSize()
        const sourceName = gameWindow?.name || captureSource.name || 'screen'
        const sourceKey = `${captureMode}:${sourceName}:${size.width}x${size.height}`

        if (sourceKey !== lastCaptureSourceKey) {
            lastCaptureSourceKey = sourceKey
            if (preferScreen) {
                logger.info(`Screenshot source changed: screen capture "${sourceName}" (${size.width}x${size.height})`)
            } else if (gameWindow) {
                logger.info(`Screenshot source changed: game window "${gameWindow.name}" (${size.width}x${size.height})`)
            } else {
                logger.warn(`Screenshot source changed: LoL window not found, using ${captureMode} "${sourceName}" (${size.width}x${size.height})`)
            }
        }

        logger.debug(`Screenshot captured: mode=${captureMode}, size=${size.width}x${size.height}, buffer=${(pngBuffer.length / 1024).toFixed(1)}KB`)

        return {
            success: true,
            buffer: pngBuffer,
            timestamp,
            hasLolWindow,
            captureMode,
            windowName: gameWindow?.name,
            width: size.width,
            height: size.height
        }
    } catch (error) {
        logger.error('Screenshot capture failed:', error)
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}

// 截图模块已不再需要文件管理功能
// 所有截图直接保存在内存Buffer中进行OCR识别
// 如需调试保存截图，可在调用方自行处理

// ---------------------------------------------------------------------------
// 手动刷新：只截一次游戏窗口

export const MANUAL_CAPTURE_THUMBNAIL_SIZE = { width: 1920, height: 1080 }
let cachedGameWindowSource: { id: string; name: string } | null = null
let detectedBitmapOrder: 'bgra' | 'rgba' | null = null

export function resetCachedGameWindowSource(): void {
    cachedGameWindowSource = null
}

export function resetDetectedBitmapOrder(): void {
    detectedBitmapOrder = null
}

export interface RawCaptureImage {
    buffer: Buffer
    width: number
    height: number
    channels: 4
}

/** BGRA → RGBA（原地交换 R/B，返回同一个 Buffer） */
export function swapRedBlueInPlace(buffer: Buffer): Buffer {
    for (let i = 0; i + 3 < buffer.length; i += 4) {
        const blue = buffer[i]
        buffer[i] = buffer[i + 2]
        buffer[i + 2] = blue
    }
    return buffer
}

/**
 * NativeImage.toBitmap() 的通道顺序随平台而定（Windows 上通常是 Skia 的 BGRA）。
 * 只判断一次：找一个 R≠B 的像素，裁 1×1 转 PNG 解码后对比，成本可以忽略。
 */
async function detectBitmapOrder(image: NativeImage, bitmap: Buffer, width: number, height: number): Promise<'bgra' | 'rgba'> {
    if (detectedBitmapOrder) return detectedBitmapOrder
    const fallback: 'bgra' | 'rgba' = process.platform === 'win32' ? 'bgra' : 'rgba'
    try {
        const step = Math.max(1, Math.floor(Math.min(width, height) / 16))
        for (let y = Math.floor(step / 2); y < height; y += step) {
            for (let x = Math.floor(step / 2); x < width; x += step) {
                const offset = (y * width + x) * 4
                const c0 = bitmap[offset]
                const c2 = bitmap[offset + 2]
                if (Math.abs(c0 - c2) < 40) continue
                const pixel = image.crop({ x, y, width: 1, height: 1 })
                const { data } = await sharp(pixel.toPNG()).removeAlpha().raw().toBuffer({ resolveWithObject: true })
                const red = data[0]
                detectedBitmapOrder = Math.abs(red - c2) < Math.abs(red - c0) ? 'bgra' : 'rgba'
                logger.info(`Manual capture: bitmap channel order detected as ${detectedBitmapOrder}`)
                return detectedBitmapOrder
            }
        }
    } catch (error) {
        logger.warn('Manual capture: bitmap channel order detection failed, assuming platform default', error)
    }
    return fallback
}

/** 把 thumbnail 转成 RGBA 原始像素，避免 PNG 编码 + 解码；失败返回 null（调用方改用 PNG） */
export async function nativeImageToRawRgba(image: NativeImage): Promise<RawCaptureImage | null> {
    if (typeof image.toBitmap !== 'function') return null
    const { width, height } = image.getSize()
    const bitmap = image.toBitmap()
    if (!bitmap || bitmap.length !== width * height * 4) return null
    const order = await detectBitmapOrder(image, bitmap, width, height)
    const buffer = Buffer.from(bitmap)
    if (order === 'bgra') swapRedBlueInPlace(buffer)
    return { buffer, width, height, channels: 4 }
}

function pickGameWindow(sources: DesktopCapturerSource[]): DesktopCapturerSource | null {
    // 优先复用上次的游戏内窗口（同时开着客户端和游戏时，避免在两者间跳来跳去）
    if (cachedGameWindowSource) {
        const cached = sources.find((source) => source.id === cachedGameWindowSource?.id)
        if (cached) return cached
    }
    return findGameWindow(sources)
}

/**
 * 手动刷新用的单次截图：只枚举 window 源（不截全屏）；找不到游戏窗口时才退回整屏截图。
 * raw=true 时直接返回 RGBA 像素（不做 PNG 编码/解码，省掉 1080p 下约 100ms）。
 * OCR 标题区域与图标区域都按整图比例裁剪，与分辨率无关。
 *
 * 注意：desktopCapturer 每次调用仍会为所有枚举到的窗口生成缩略图，这是 Electron API 的限制
 * （没有「只截某个已知窗口」的主进程接口）；这里缓存游戏窗口 id 只用于在多个候选窗口中稳定选择。
 */
export const captureGameWindowOnce = async (
    options: { timeoutMs?: number; thumbnailSize?: Size; raw?: boolean } = {}
) => {
    const {
        timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
        thumbnailSize = MANUAL_CAPTURE_THUMBNAIL_SIZE,
        raw = false,
    } = options
    const timestamp = Date.now()

    try {
        const enumerateStartedAt = performance.now()
        const sources = await withTimeout(
            desktopCapturer.getSources({
                types: ['window'],
                thumbnailSize,
                fetchWindowIcons: false,
            }),
            timeoutMs,
            'desktopCapturer.getSources(window)'
        )
        const enumerateMs = Math.round(performance.now() - enumerateStartedAt)

        const gameWindow = pickGameWindow(sources)

        if (gameWindow && gameWindow.thumbnail && !gameWindow.thumbnail.isEmpty()) {
            if (cachedGameWindowSource?.id !== gameWindow.id) {
                logger.info(`Manual capture: using game window "${gameWindow.name}"`)
            }
            // 只缓存游戏内窗口（"League of Legends (TM) Client"），不缓存客户端大厅
            cachedGameWindowSource = gameWindow.name.toLowerCase().includes('(tm) client')
                ? { id: gameWindow.id, name: gameWindow.name }
                : null
            const size = gameWindow.thumbnail.getSize()
            const convertStartedAt = performance.now()
            let rawImage: RawCaptureImage | null = null
            if (raw) {
                try {
                    rawImage = await nativeImageToRawRgba(gameWindow.thumbnail)
                } catch (error) {
                    logger.warn('Manual capture: raw bitmap conversion failed, using PNG', error)
                }
            }
            const buffer = rawImage ? undefined : gameWindow.thumbnail.toPNG()
            const convertMs = Math.round(performance.now() - convertStartedAt)
            return {
                success: true,
                buffer,
                raw: rawImage ?? undefined,
                timestamp,
                hasLolWindow: true,
                captureMode: 'window' as const,
                windowName: gameWindow.name,
                width: size.width,
                height: size.height,
                enumerateMs,
                convertMs,
                sourceCount: sources.length,
            }
        }

        cachedGameWindowSource = null
        logger.warn('Manual capture: LoL game window not found, falling back to screen capture')
        const fallback = await captureScreenshot({ preferScreen: true, timeoutMs, thumbnailSize })
        return { ...fallback, hasLolWindow: false, enumerateMs }
    } catch (error) {
        logger.error('Manual capture failed:', error)
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}
