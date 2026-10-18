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

/**
 * 手动刷新用的单次截图：截**整个屏幕**（与原项目自动模式默认的 preferScreenCapture 一致）。
 *
 * 不再枚举 window 源：Windows 上 desktopCapturer 为窗口生成缩略图会走 WGC，
 * 遇到不可捕获的窗口（"Source is not capturable"）时会让主进程 ACCESS_VIOLATION 崩溃（实机复现）。
 * 游戏使用无边框窗口时，整屏就是游戏画面，OCR / 图标的按比例裁剪不受影响。
 * 浮窗本身通过 setContentProtection 排除在截图之外，截图时不需要隐藏浮窗。
 *
 * raw=true 时直接返回 RGBA 像素（不做 PNG 编码/解码）；环境变量 ARAMGG_MANUAL_CAPTURE_PNG=1 可强制走 PNG。
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
    const useRaw = raw && process.env.ARAMGG_MANUAL_CAPTURE_PNG !== '1'

    try {
        const enumerateStartedAt = performance.now()
        const sources = await withTimeout(
            desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize,
                fetchWindowIcons: false,
            }),
            timeoutMs,
            'desktopCapturer.getSources(screen)'
        )
        const enumerateMs = Math.round(performance.now() - enumerateStartedAt)
        const screenSource = findScreenSource(sources)
        if (!screenSource || !screenSource.thumbnail || screenSource.thumbnail.isEmpty()) {
            throw new Error('无法获取屏幕截图')
        }

        const size = screenSource.thumbnail.getSize()
        const convertStartedAt = performance.now()
        let rawImage: RawCaptureImage | null = null
        if (useRaw) {
            try {
                rawImage = await nativeImageToRawRgba(screenSource.thumbnail)
            } catch (error) {
                logger.warn('Manual capture: raw bitmap conversion failed, using PNG', error)
            }
        }
        const buffer = rawImage ? undefined : screenSource.thumbnail.toPNG()
        const convertMs = Math.round(performance.now() - convertStartedAt)
        const sourceKey = `${screenSource.id}:${size.width}x${size.height}:${rawImage ? 'raw' : 'png'}`
        if (cachedGameWindowSource?.id !== sourceKey) {
            cachedGameWindowSource = { id: sourceKey, name: screenSource.name }
            logger.info(`Manual capture: screen "${screenSource.name}" ${size.width}x${size.height} (${rawImage ? 'raw' : 'png'})`)
        }
        return {
            success: true,
            buffer,
            raw: rawImage ?? undefined,
            timestamp,
            captureMode: 'screen' as const,
            windowName: screenSource.name,
            width: size.width,
            height: size.height,
            enumerateMs,
            convertMs,
            sourceCount: sources.length,
            /** 调试用：保存截图 */
            debugPng: process.env.ARAMGG_MANUAL_CAPTURE_DEBUG === '1' ? () => screenSource.thumbnail.toPNG() : undefined,
        }
    } catch (error) {
        logger.error('Manual capture failed:', error)
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}
