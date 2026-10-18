/**
 * 把 ManualOverlayService 接到真实的 Electron / OCR / LCU 依赖上（单例）。
 */
import { globalShortcut } from 'electron'
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

let instance: ManualOverlayService | null = null

export function getManualOverlayService(): ManualOverlayService {
    instance ??= new ManualOverlayService({
        capture: () => captureGameWindowOnce(),
        analyze: (buffer) => analyzeScreenshot(buffer),
        warmup: () => warmupImageAnalyzer(),
        getLiveClientAllGameData: () => getLCUServiceInstance().getLiveClientAllGameData(),
        store: {
            get: (key) => store.get(key),
            set: (key, value) => store.set(key, value),
        },
        shortcuts: {
            register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
            unregister: (accelerator) => globalShortcut.unregister(accelerator),
            isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
        },
        showWindow: async () => {
            const window = await ensureManualOverlayWindow()
            showManualOverlayWindow(window)
        },
        hideWindow: () => hideManualOverlayWindow(),
        broadcast: (state) => notifyAllWindows('manual-overlay-state', state),
        logger,
    })
    return instance
}
