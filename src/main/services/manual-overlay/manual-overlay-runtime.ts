/**
 * 把 ManualOverlayService 接到真实的 Electron / OCR / LCU 依赖上（单例）。
 */
import { appendFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { globalShortcut, net } from 'electron'
import logger from '../../modules/logger.ts'
import store from '../../modules/app-store.ts'
import {
    ensureManualOverlayWindow,
    hideManualOverlayWindow,
    notifyAllWindows,
    showManualOverlayWindow,
} from '../../modules/window-manager.ts'
import { captureGameWindowOnce } from '../../screenshot.ts'
import { analyzeScreenshot, warmupImageAnalyzer } from '../../image-analyzer.ts'
import { getLCUServiceInstance } from '../lcu/lcu-service.ts'
import { ManualOverlayService } from './manual-overlay-service.ts'
import { AugmentIconIndex } from './augment-icon-index.ts'
import { getDataLocale, loadAugmentBase } from '../../data-loader.ts'
import { getAppDataDir, getLogDir } from '../../modules/app-paths.ts'

let instance: ManualOverlayService | null = null
let iconIndex: AugmentIconIndex | null = null

function getIconIndex(): AugmentIconIndex {
    iconIndex ??= new AugmentIconIndex({
        loadAugments: () => loadAugmentBase(getDataLocale()),
        fetch: (url, init) => net.fetch(url, init),
        cacheDir: path.join(getAppDataDir(), 'cache', 'augment-icons'),
        logger,
    })
    return iconIndex
}

/** 刷新日志：<logs>/manual-refresh.jsonl，一行一条，用于校准提醒时机 */
let logQueue: Promise<void> = Promise.resolve()
function appendRefreshLog(record: Record<string, unknown>): void {
    const line = `${JSON.stringify(record)}\n`
    const file = path.join(getLogDir(), 'manual-refresh.jsonl')
    logQueue = logQueue
        .then(() => appendFile(file, line, 'utf8'))
        .catch((error) => logger.debug('[manual-overlay] write refresh log failed', error))
}

export function getManualOverlayService(): ManualOverlayService {
    instance ??= new ManualOverlayService({
        capture: async () => {
            const result = await captureGameWindowOnce({ raw: true })
            if (result.success && 'debugPng' in result && result.debugPng) {
                // ARAMGG_MANUAL_CAPTURE_DEBUG=1：保存最近一次截图，便于核对裁剪区域
                void writeFile(path.join(getLogDir(), 'manual-capture-last.png'), result.debugPng())
                    .catch((error) => logger.debug('[manual-overlay] save debug capture failed', error))
            }
            return result
        },
        analyze: (image) => analyzeScreenshot(image),
        warmup: () => warmupImageAnalyzer(),
        matchIcons: async (image) => {
            const index = getIconIndex()
            if (!index.ready) {
                // 第一次刷新时图标库可能还没准备好：不等待，只用 OCR，后台继续构建
                void index.ensureBuilt()
                return [[], [], []]
            }
            return index.matchImage(image)
        },
        iconIndexStatus: () => getIconIndex().status(),
        ensureIconIndex: () => getIconIndex().ensureBuilt(),
        listAugments: async () => (await loadAugmentBase(getDataLocale())).map((augment: any) => ({
            id: augment.id,
            name: augment.name,
            rarity: augment.rarity ?? null,
            iconPath: augment.iconUrl ?? augment.iconPath ?? null,
        })),
        appendLog: appendRefreshLog,
        getLiveClientAllGameData: () => getLCUServiceInstance().getLiveClientAllGameData(),
        getChampSelectTeam: async () => {
            const snapshot = await getLCUServiceInstance().getChampSelectSnapshot()
            if (!snapshot?.isInChampSelect) return null
            const allyChampionIds = (snapshot.myTeam ?? [])
                .map((member) => Number(member.championId || member.championPickIntent))
                .filter((id) => Number.isInteger(id) && id > 0)
            return { selfChampionId: snapshot.selfChampionId ?? null, allyChampionIds }
        },
        store: {
            get: (key) => store.get(key),
            set: (key, value) => store.set(key, value),
        },
        shortcuts: {
            register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
            unregister: (accelerator) => globalShortcut.unregister(accelerator),
            isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
        },
        showWindow: async (reason) => {
            const window = await ensureManualOverlayWindow()
            showManualOverlayWindow(window, reason)
        },
        hideWindow: (reason) => hideManualOverlayWindow(reason),
        broadcast: (state) => notifyAllWindows('manual-overlay-state', state),
        logger,
    })
    return instance
}
