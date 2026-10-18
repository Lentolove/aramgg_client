import { trustedIpcMain as ipcMain } from '../security/trusted-ipc.ts'
import { getManualOverlayService } from '../services/manual-overlay/manual-overlay-runtime.ts'
import {
    ensureManualOverlayWindow,
    hideManualOverlayWindow,
    showManualOverlayWindow,
} from '../modules/window-manager.ts'

export function registerManualOverlayIpcHandlers(): void {
    const service = () => getManualOverlayService()

    ipcMain.handle('manual-overlay-get-state', () => service().getState())
    ipcMain.handle('manual-overlay-refresh', () => service().refresh('button'))
    ipcMain.handle('manual-overlay-pick', (_event, augment: unknown) => service().pick(augment))
    ipcMain.handle('manual-overlay-unpick', (_event, augmentId: unknown) => service().unpick(augmentId))
    ipcMain.handle('manual-overlay-clear-candidates', () => service().clearCandidates())
    ipcMain.handle('manual-overlay-reset-game', () => service().resetGame())
    ipcMain.handle('manual-overlay-get-live-data', () => service().getLiveData())
    ipcMain.handle('manual-overlay-get-settings', () => service().getSettings())
    ipcMain.handle('manual-overlay-set-settings', (_event, patch: unknown) => service().setSettings(patch))
    ipcMain.on('manual-overlay-show', async () => {
        showManualOverlayWindow(await ensureManualOverlayWindow())
    })
    ipcMain.on('manual-overlay-hide', () => {
        hideManualOverlayWindow()
    })
}
