import logger from './logger.ts'
import {
    BrowserWindow,
    screen,
    app,
    type Event,
    type Rectangle,
    type WebPreferences,
} from 'electron'
import { createServer } from 'http'
import { createReadStream, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
    isTrustedRendererUrl,
    registerTrustedRendererOrigin,
} from '../security/renderer-origin.ts'
import store from './app-store.ts'
import {
    anchoredResize,
    fitWindowPositionToWorkArea,
    parseWindowPosition,
} from './window-position.ts'
import { shouldRaiseOverlayWindow } from './overlay-window-state.ts'
import { createWindowLoader } from './lazy-window.ts'
import { waitForRendererReady } from './renderer-ready.ts'
import {
    shouldHideChampionInsightOnGameStart,
    shouldKeepChampionInsightOnTop,
    shouldShowChampionDetails,
} from './user-preferences.ts'
import type { GameflowPhase } from '../../shared/ipc-contract.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const OPEN_OVERLAY_DEVTOOLS = process.env.ARAMGG_OPEN_OVERLAY_DEVTOOLS === '1'
const RENDERER_CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self' https://www.googletagmanager.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws://localhost:* ws://127.0.0.1:* https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com https://*.googleapis.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ')

let mainWindow: BrowserWindow | null = null
let popupWindow: BrowserWindow | null = null
let popupGameflowPhase: GameflowPhase | null = null
let manualOverlayWindow: BrowserWindow | null = null
let mainWindowCloseAllowed = false
let rendererServerPromise: Promise<string> | null = null

const MAIN_WINDOW_SIZE = { width: 472, height: 752 }
const POPUP_WINDOW_SIZE = { width: 360, height: 640 }
const POPUP_WINDOW_POSITION_KEY = 'windows.championInsightPosition'
const MANUAL_OVERLAY_WINDOW_SIZE = { width: 340, height: 560 }
const MANUAL_OVERLAY_WINDOW_POSITION_KEY = 'windows.manualOverlayPosition'
const OVERLAY_ALWAYS_ON_TOP_LEVEL = process.platform === 'win32' ? 'screen-saver' : 'floating'
const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
}

function getMainWindowBounds(): Rectangle {
    const display = screen.getPrimaryDisplay()
    const area = display.workArea || display.bounds
    const width = Math.min(MAIN_WINDOW_SIZE.width, area.width)
    const height = Math.min(MAIN_WINDOW_SIZE.height, area.height)
    const rightAlignedX = area.x + area.width - width - 20

    return {
        width,
        height,
        x: Math.max(area.x + 20, rightAlignedX),
        y: area.y + Math.max(20, Math.round((area.height - height) / 2)),
    }
}

function getDisplayForMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        const [x, y] = mainWindow.getPosition()
        return screen.getDisplayNearestPoint({ x, y })
    }

    return screen.getPrimaryDisplay()
}

function getPopupBounds(): Rectangle {
    const savedPosition = parseWindowPosition(store.get(POPUP_WINDOW_POSITION_KEY))
    const display = savedPosition
        ? screen.getDisplayNearestPoint(savedPosition)
        : getDisplayForMainWindow()
    const area = display.workArea || display.bounds
    const width = Math.min(POPUP_WINDOW_SIZE.width, area.width)
    const height = Math.min(POPUP_WINDOW_SIZE.height, area.height)
    const rightAlignedX = area.x + area.width - width - 140
    const defaultPosition = {
        x: Math.max(area.x + 20, rightAlignedX),
        y: area.y + Math.max(20, Math.round((area.height - height) / 2)),
    }
    const position = fitWindowPositionToWorkArea(
        savedPosition || defaultPosition,
        { width, height },
        area,
    )

    return {
        width,
        height,
        ...position,
    }
}

function savePopupWindowPosition(): void {
    if (!popupWindow || popupWindow.isDestroyed()) {
        return
    }

    const [x, y] = popupWindow.getPosition()
    store.set(POPUP_WINDOW_POSITION_KEY, { x, y })
}



function getManualOverlayBounds(): Rectangle {
    const savedPosition = parseWindowPosition(store.get(MANUAL_OVERLAY_WINDOW_POSITION_KEY))
    const display = savedPosition
        ? screen.getDisplayNearestPoint(savedPosition)
        : screen.getPrimaryDisplay()
    const area = display.workArea || display.bounds
    const width = Math.min(MANUAL_OVERLAY_WINDOW_SIZE.width, area.width)
    const height = Math.min(MANUAL_OVERLAY_WINDOW_SIZE.height, area.height)
    // 默认放在左侧中部：避开顶部计分板、底部技能栏和三选一卡片区域
    const defaultPosition = {
        x: area.x + 16,
        y: area.y + Math.max(16, Math.round((area.height - height) / 2)),
    }
    const position = fitWindowPositionToWorkArea(
        savedPosition || defaultPosition,
        { width, height },
        area,
    )

    return { width, height, ...position }
}

function saveManualOverlayWindowPosition(): void {
    if (!manualOverlayWindow || manualOverlayWindow.isDestroyed()) {
        return
    }

    const [x, y] = manualOverlayWindow.getPosition()
    store.set(MANUAL_OVERLAY_WINDOW_POSITION_KEY, { x, y })
}

export function applyPopupWindowLayout() {
    if (popupWindow && !popupWindow.isDestroyed()) {
        if (popupWindow.isVisible()) {
            return
        }
        popupWindow.setBounds(getPopupBounds())
    }
}



export function applyPopupWindowPreferences(phase: GameflowPhase | null = popupGameflowPhase): void {
    popupGameflowPhase = phase
    if (!popupWindow || popupWindow.isDestroyed()) {
        return
    }

    setOverlayAlwaysOnTop(popupWindow, shouldKeepChampionInsightOnTop(), 'popup')
    const inGame = phase === 'GameStart' || phase === 'InProgress'
    if ((!shouldShowChampionDetails() || (inGame && shouldHideChampionInsightOnGameStart())) &&
        popupWindow.isVisible()) {
        popupWindow.hide()
    }
}

function setOverlayAlwaysOnTop(
    window: BrowserWindow | null,
    alwaysOnTop: boolean = true,
    name: string = 'overlay'
): void {
    if (!window || window.isDestroyed()) {
        return
    }

    try {
        window.setAlwaysOnTop(Boolean(alwaysOnTop), OVERLAY_ALWAYS_ON_TOP_LEVEL)
    } catch (error) {
        logger.debug(
            `[window:${name}] failed to apply high always-on-top level:`,
            error instanceof Error ? error.message : String(error)
        )
        window.setAlwaysOnTop(Boolean(alwaysOnTop))
    }
}

export function raiseOverlayWindow(
    window: BrowserWindow | null,
    name: string = 'overlay'
): void {
    if (!window || window.isDestroyed() || !shouldRaiseOverlayWindow(window)) {
        return
    }

    setOverlayAlwaysOnTop(window, true, name)

    if (window.isMinimized()) {
        window.restore()
    }

    if (typeof window.showInactive === 'function') {
        window.showInactive()
    } else {
        window.show()
    }

    if (typeof window.moveTop === 'function') {
        window.moveTop()
    }
}

/**
 * 获取正确的 preload 脚本路径
 */
function getPreloadPath(isDev: boolean): string {
    // 使用 app.getAppPath() 获取应用根目录
    const appPath = app.getAppPath()

    if (isDev) {
        // 开发模式：从应用根目录查找 dist-electron/preload.cjs
        return path.join(appPath, 'dist-electron', 'preload.cjs')
    } else {
        // 生产模式：preload.cjs 在 dist-electron 目录中
        return path.join(appPath, 'dist-electron', 'preload.cjs')
    }
}

function getRendererIndexPath(): string {
    return path.join(__dirname, '../dist/index.html')
}

function getRendererDistPath(): string {
    return path.dirname(getRendererIndexPath())
}

function resolveRendererAssetPath(requestUrl: string): string | null {
    const url = new URL(requestUrl, 'http://127.0.0.1')
    const requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const rendererDistPath = path.resolve(getRendererDistPath())
    const filePath = path.resolve(rendererDistPath, requestedPath)
    const isInsideRendererDist =
        filePath === rendererDistPath || filePath.startsWith(`${rendererDistPath}${path.sep}`)

    return isInsideRendererDist ? filePath : null
}

function getMimeType(filePath: string): string {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function startRendererServer(): Promise<string> {
    if (rendererServerPromise) {
        return rendererServerPromise
    }

    rendererServerPromise = new Promise<string>((resolve, reject) => {
        const server = createServer((request, response) => {
            const filePath = resolveRendererAssetPath(request.url || '/index.html')
            if (!filePath || !existsSync(filePath)) {
                response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
                response.end('Not found')
                return
            }

            const stream = createReadStream(filePath)
            stream.once('open', () => {
                response.writeHead(200, {
                    'content-type': getMimeType(filePath),
                    'cache-control': 'no-store',
                    'content-security-policy': RENDERER_CONTENT_SECURITY_POLICY,
                })
                stream.pipe(response)
            })
            stream.once('error', () => {
                if (!response.headersSent) {
                    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
                    response.end('Not found')
                    return
                }

                response.destroy()
            })
        })

        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
                server.close()
                reject(new Error('Renderer server did not return a TCP address'))
                return
            }

            app.once('will-quit', () => {
                server.close()
            })
            resolve(`http://127.0.0.1:${address.port}`)
        })
    }).catch((error) => {
        rendererServerPromise = null
        throw error
    })

    return rendererServerPromise
}

async function getRendererBaseUrl(isDev: boolean, devServerUrl: string): Promise<string> {
    if (isDev) {
        return devServerUrl
    }

    return startRendererServer()
}

async function loadRendererUrl(
    window: BrowserWindow,
    route: string,
    isDev: boolean,
    devServerUrl: string
): Promise<void> {
    const baseUrl = await getRendererBaseUrl(isDev, devServerUrl)
    registerTrustedRendererOrigin(baseUrl)
    attachRendererNavigationGuards(window)
    await window.loadURL(`${baseUrl}/#${route}`)
}

function attachRendererNavigationGuards(window: BrowserWindow): void {
    const rejectUntrustedNavigation = (event: Event, targetUrl: string) => {
        if (isTrustedRendererUrl(targetUrl)) {
            return
        }

        event.preventDefault()
        logger.warn('[window] blocked untrusted renderer navigation', {
            currentUrl: window.webContents.getURL(),
            targetUrl,
        })
    }

    window.webContents.on('will-navigate', rejectUntrustedNavigation)
    window.webContents.on('will-redirect', rejectUntrustedNavigation)
    window.webContents.setWindowOpenHandler(({ url }) => {
        logger.warn('[window] blocked renderer window.open', {
            currentUrl: window.webContents.getURL(),
            targetUrl: url,
        })
        return { action: 'deny' }
    })
}

function getRendererLogUrl(isDev: boolean, devServerUrl: string): string {
    if (isDev) {
        return devServerUrl
    }

    return 'http://127.0.0.1:<dynamic>'
}

function getRendererLogPath(isDev: boolean): string | undefined {
    if (isDev) {
        return undefined
    }

    return getRendererIndexPath()
}

function getRendererLogPathExists(isDev: boolean): boolean | undefined {
    if (isDev) {
        return undefined
    }

    return existsSync(getRendererIndexPath())
}

function getRendererLogInfo(isDev: boolean, devServerUrl: string) {
    return {
        rendererBaseUrl: getRendererLogUrl(isDev, devServerUrl),
        rendererIndexPath: getRendererLogPath(isDev),
        rendererIndexExists: getRendererLogPathExists(isDev),
    }
}

function attachWindowDiagnostics(name: string, window: BrowserWindow): void {
    const { webContents } = window

    webContents.on('did-finish-load', () => {
        logger.info(`[window:${name}] renderer loaded`, {
            url: webContents.getURL(),
        })
    })

    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        logger.error(`[window:${name}] renderer load failed`, {
            errorCode,
            errorDescription,
            validatedURL,
            isMainFrame,
            currentUrl: webContents.getURL(),
        })
    })

    webContents.on('preload-error', (_event, preloadPath, error) => {
        logger.error(`[window:${name}] preload failed`, {
            preloadPath,
            message: error?.message,
            stack: error?.stack,
        })
    })

    webContents.on('render-process-gone', (_event, details) => {
        logger.error(`[window:${name}] renderer process gone`, {
            reason: details.reason,
            exitCode: details.exitCode,
            url: webContents.getURL(),
        })
    })

    webContents.on('console-message', (_event, level, message, line, sourceId) => {
        if (level < 2) {
            return
        }

        logger.warn(`[window:${name}] renderer console`, {
            level,
            message,
            line,
            sourceId,
            url: webContents.getURL(),
        })
    })
}

async function loadRendererRoute(
    window: BrowserWindow,
    name: string,
    isDev: boolean,
    devServerUrl: string,
    route: string,
    preloadPath: string | undefined
): Promise<void> {
    logger.info(`[window:${name}] loading renderer route`, {
        route,
        isDev,
        preloadPath,
        preloadExists: preloadPath ? existsSync(preloadPath) : false,
        ...getRendererLogInfo(isDev, devServerUrl),
    })

    if (name === 'main') {
        await loadRendererUrl(window, route, isDev, devServerUrl)
    } else {
        await Promise.all([
            waitForRendererReady(window.webContents),
            loadRendererUrl(window, route, isDev, devServerUrl),
        ])
    }
}

const getWebPreferences = (
    isDev: boolean,
    overrides: Partial<WebPreferences> = {}
): WebPreferences => ({
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    contextIsolation: true,
    sandbox: true,
    preload: getPreloadPath(isDev),
    ...overrides,
})

/**
 * 创建主窗口
 */
export const createMainWindow = async (
    isDev: boolean,
    devServerUrl: string
): Promise<BrowserWindow> => {
    const webPreferences = getWebPreferences(isDev)
    const bounds = getMainWindowBounds()

    mainWindow = new BrowserWindow({
        ...bounds,
        frame: false,
        webPreferences,
        title: `ARAMGG助手 v${app.getVersion()} (Lentolove)`,
    })
    const window = mainWindow
    attachWindowDiagnostics('main', window)

    window.on('close', (event) => {
        if (!mainWindowCloseAllowed) {
            event.preventDefault()
            logger.info('Main window close requested; asking renderer for confirmation')
            if (!window.isVisible()) {
                window.show()
            }
            if (window.isMinimized()) {
                window.restore()
            }
            window.focus()
            window.webContents.send('quit-confirm-requested')
            return
        }

        logger.info('Main window closing...')
        // 关闭主窗口时，同时关闭 popup 窗口和浮动窗口
        if (popupWindow && !popupWindow.isDestroyed()) {
            logger.info('Closing popup window...')
            popupWindow.close()
        }
        if (manualOverlayWindow && !manualOverlayWindow.isDestroyed()) {
            manualOverlayWindow.close()
        }
    })

    window.on('closed', () => {
        logger.info('Main window closed')
        if (mainWindow === window) {
            mainWindow = null
        }
    })

    // 加载应用
    await loadRendererRoute(window, 'main', isDev, devServerUrl, '/display', webPreferences.preload)

    if (isDev) {
        window.webContents.openDevTools()
    }

    return window
}

/**
 * 创建弹出窗口
 */
export const createPopupWindow = async (
    isDev: boolean,
    devServerUrl: string
): Promise<BrowserWindow> => {
    const webPreferences = getWebPreferences(isDev)
    const bounds = getPopupBounds()

    popupWindow = new BrowserWindow({
        show: false,
        frame: false,
        skipTaskbar: true,
        closable: false,
        resizable: isDev || false,
        fullscreenable: false,
        alwaysOnTop: shouldKeepChampionInsightOnTop(),
        ...bounds,
        webPreferences,
    })
    applyPopupWindowPreferences()
    popupWindow.on('show', () => applyPopupWindowPreferences())
    attachWindowDiagnostics('popup', popupWindow)

    if (process.platform === 'linux') {
        popupWindow.on('move', savePopupWindowPosition)
    } else {
        popupWindow.on('moved', savePopupWindowPosition)
    }

    popupWindow.on('closed', () => {
        logger.info('Popup window closed')
        popupWindow = null
    })

    await loadRendererRoute(popupWindow, 'popup', isDev, devServerUrl, '/augment-overlay', webPreferences.preload)

    if (isDev && OPEN_OVERLAY_DEVTOOLS) {
        popupWindow.webContents.openDevTools({ mode: 'detach' })
    }

    logger.info('Popup window loaded', popupWindow.webContents.getURL())

    return popupWindow
}



/**
 * 创建「手动刷新」常驻浮窗：可拖动、始终置顶、不抢游戏焦点。
 * focusable:false 时 Windows 下仍可点击按钮（WS_EX_NOACTIVATE），不会把焦点从游戏抢走；
 * 该行为需在真实对局（建议无边框窗口模式）中验证。
 */
export const createManualOverlayWindow = async (
    isDev: boolean,
    devServerUrl: string
): Promise<BrowserWindow> => {
    const webPreferences = getWebPreferences(isDev)
    const bounds = getManualOverlayBounds()

    manualOverlayWindow = new BrowserWindow({
        show: false,
        frame: false,
        // 透明背景：圆角、阴影和可调不透明度由页面绘制；窗口尺寸跟随内容（收起/展开/分区折叠）
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        skipTaskbar: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        focusable: store.get('manualOverlay.settings.focusable') === true,
        ...bounds,
        webPreferences,
    })
    setOverlayAlwaysOnTop(manualOverlayWindow, true, 'manual-overlay')
    // 截图时排除浮窗本身（Windows WDA_EXCLUDEFROMCAPTURE）：整屏截图不会拍到浮窗，也不需要先隐藏浮窗
    manualOverlayWindow.setContentProtection(true)
    attachWindowDiagnostics('manual-overlay', manualOverlayWindow)

    if (process.platform === 'linux') {
        manualOverlayWindow.on('move', saveManualOverlayWindowPosition)
    } else {
        manualOverlayWindow.on('moved', saveManualOverlayWindowPosition)
    }

    manualOverlayWindow.on('closed', () => {
        logger.info('Manual overlay window closed')
        stopManualOverlayKeepOnTop()
        manualOverlayWindow = null
    })

    await loadRendererRoute(
        manualOverlayWindow,
        'manual-overlay',
        isDev,
        devServerUrl,
        '/manual-overlay',
        webPreferences.preload
    )

    if (isDev && OPEN_OVERLAY_DEVTOOLS) {
        manualOverlayWindow.webContents.openDevTools({ mode: 'detach' })
    }

    logger.info('手动刷新浮窗已创建', { ...bounds })
    return manualOverlayWindow
}

const MANUAL_OVERLAY_KEEP_ON_TOP_MS = 1500
let manualOverlayKeepOnTopTimer: ReturnType<typeof setInterval> | null = null

/**
 * 重新把浮窗压到置顶层最上面（不抢焦点）。游戏窗口（无边框模式）获得前台后会盖住
 * 之前置顶的窗口，只在显示时设置一次置顶不够，需要周期性重申。
 */
export function reassertManualOverlayTopmost(window: BrowserWindow | null = manualOverlayWindow): void {
    if (!window || window.isDestroyed() || !window.isVisible()) {
        return
    }
    setOverlayAlwaysOnTop(window, true, 'manual-overlay')
    window.moveTop()
}

function startManualOverlayKeepOnTop(): void {
    if (manualOverlayKeepOnTopTimer) {
        return
    }
    manualOverlayKeepOnTopTimer = setInterval(() => {
        try {
            reassertManualOverlayTopmost()
        } catch (error) {
            logger.debug('[window:manual-overlay] keep-on-top failed', error)
        }
    }, MANUAL_OVERLAY_KEEP_ON_TOP_MS)
}

function stopManualOverlayKeepOnTop(): void {
    if (manualOverlayKeepOnTopTimer) {
        clearInterval(manualOverlayKeepOnTopTimer)
        manualOverlayKeepOnTopTimer = null
    }
}

/** 确保浮窗在当前某个显示器的可见区域内（分辨率/显示器变化后可能跑到屏幕外） */
function ensureManualOverlayOnScreen(window: BrowserWindow): void {
    const bounds = window.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const area = display.workArea || display.bounds
    const width = Math.min(bounds.width, area.width)
    const height = Math.min(bounds.height, area.height)
    const position = fitWindowPositionToWorkArea({ x: bounds.x, y: bounds.y }, { width, height }, area)
    if (position.x !== bounds.x || position.y !== bounds.y || width !== bounds.width || height !== bounds.height) {
        window.setBounds({ ...position, width, height })
        logger.info('[window:manual-overlay] moved back on screen', { from: bounds, to: { ...position, width, height } })
    }
}

export function showManualOverlayWindow(
    window: BrowserWindow | null = manualOverlayWindow,
    reason: string = 'show'
): void {
    if (!window || window.isDestroyed()) {
        return
    }
    const wasVisible = window.isVisible()
    ensureManualOverlayOnScreen(window)
    setOverlayAlwaysOnTop(window, true, 'manual-overlay')
    if (window.isMinimized()) {
        window.restore()
    }
    if (!wasVisible) {
        window.showInactive()
    }
    window.moveTop()
    startManualOverlayKeepOnTop()
    if (!wasVisible) {
        logger.info('手动刷新浮窗已显示', { reason, ...window.getBounds(), visible: window.isVisible() })
    }
}

export function hideManualOverlayWindow(reason: string = 'hide'): void {
    stopManualOverlayKeepOnTop()
    if (manualOverlayWindow && !manualOverlayWindow.isDestroyed() && manualOverlayWindow.isVisible()) {
        manualOverlayWindow.hide()
        logger.info('手动刷新浮窗已隐藏', { reason })
    }
}

/**
 * 临时切换浮窗是否可获得焦点：搜索框需要键盘输入时打开，关闭搜索后恢复为不抢焦点
 * （设置里勾选了「可获得焦点」时始终保持可聚焦）。
 */
export function setManualOverlayFocusable(focusable: boolean): boolean {
    const window = manualOverlayWindow
    if (!window || window.isDestroyed()) {
        return false
    }
    const keepFocusable = store.get('manualOverlay.settings.focusable') === true
    if (focusable) {
        window.setFocusable(true)
        window.focus()
        return true
    }
    if (!keepFocusable) {
        window.blur()
        window.setFocusable(false)
    }
    return keepFocusable
}


/**
 * 获取主窗口实例
 */
export const getMainWindow = () => mainWindow

/**
 * 获取弹出窗口实例
 */
export const getPopupWindow = () => popupWindow

export const getManualOverlayWindow = () => manualOverlayWindow

const MANUAL_OVERLAY_MIN_SIZE = { width: 120, height: 40 }

/** 按渲染端测得的内容尺寸调整浮窗（保持锚点，夹在所在屏幕的工作区内） */
export function fitManualOverlayToContent(size: unknown): boolean {
    const window = manualOverlayWindow
    if (!window || window.isDestroyed() || !size || typeof size !== 'object') {
        return false
    }
    const record = size as Record<string, unknown>
    const width = Number(record.width)
    const height = Number(record.height)
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return false
    }
    const current = window.getBounds()
    const display = screen.getDisplayMatching(current)
    const area = display.workArea || display.bounds
    const next = anchoredResize(current, {
        width: Math.max(MANUAL_OVERLAY_MIN_SIZE.width, Math.ceil(width)),
        height: Math.max(MANUAL_OVERLAY_MIN_SIZE.height, Math.ceil(height)),
    }, area)
    if (
        Math.abs(next.width - current.width) <= 1 &&
        Math.abs(next.height - current.height) <= 1 &&
        next.x === current.x && next.y === current.y
    ) {
        return true
    }
    window.setBounds(next)
    store.set(MANUAL_OVERLAY_WINDOW_POSITION_KEY, { x: next.x, y: next.y })
    return true
}

function getRendererRuntime(): [boolean, string] {
    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
    return [isDev, isDev ? process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173' : '']
}

export const ensurePopupWindow = createWindowLoader(
    getPopupWindow,
    () => createPopupWindow(...getRendererRuntime()),
)

export const ensureManualOverlayWindow = createWindowLoader(
    getManualOverlayWindow,
    () => createManualOverlayWindow(...getRendererRuntime()),
)


export function notifyAllWindows(channel: string, data: unknown): void {
    for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) {
            continue
        }

        try {
            window.webContents.send(channel, data)
        } catch (error) {
            logger.warn('[window-manager] failed to notify renderer window:', {
                channel,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
}

export const allowMainWindowClose = () => {
    mainWindowCloseAllowed = true
}

/**
 * 切换主窗口可见性
 */
export const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore()
    }

    mainWindow.show()
    mainWindow.focus()
}

export const hideMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return
    }

    mainWindow.hide()
}

export const toggleMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return
    }

    if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
        hideMainWindow()
        return
    }

    showMainWindow()
}
