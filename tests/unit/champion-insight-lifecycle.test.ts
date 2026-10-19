import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('champion insight lifecycle', () => {
  it('starts hidden and applies window preferences during champ select and game recovery', async () => {
    const [windowManager, appConfig] = await Promise.all([
      readFile(new URL('../../src/main/modules/window-manager.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/main/modules/app-config.ts', import.meta.url), 'utf8'),
    ])
    const popupWindowBlock = windowManager.slice(
      windowManager.indexOf('export const createPopupWindow'),
      windowManager.indexOf('export const', windowManager.indexOf('export const createPopupWindow') + 1),
    )
    const inProgressRecoveryBlock = appConfig.slice(
      appConfig.indexOf('async function recoverChampionInsightForInProgress'),
      appConfig.indexOf('async function initGameFlowMonitor'),
    )

    expect(popupWindowBlock).toContain('show: false')
    expect(popupWindowBlock).toContain('closable: false')
    expect(popupWindowBlock).toContain('alwaysOnTop: shouldKeepChampionInsightOnTop()')
    expect(appConfig).not.toContain('setPopupWindowAlwaysOnTop(true)')
    expect(appConfig).toContain("popupWindow.show()")
    expect(inProgressRecoveryBlock).toContain('popupWindow.isVisible()')
    expect(inProgressRecoveryBlock).toContain('if (!canRefreshVisiblePopup)')
    expect(inProgressRecoveryBlock).not.toContain('popupWindow.show()')
    expect(inProgressRecoveryBlock).toContain('applyPopupWindowPreferences()')
  })

  it('leaves champion window visibility to the main process', async () => {
    const [overlaySource, preferences] = await Promise.all([
      readFile(
        new URL('../../src/renderer/components/AugmentWinrateOverlay.vue', import.meta.url),
        'utf8',
      ),
      readFile(new URL('../../src/renderer/components/OverlayPreferences.vue', import.meta.url), 'utf8'),
    ])
    const overlay = overlaySource.replace(/\r\n/g, '\n')

    expect(overlay).toContain('<div class="window-controls">')
    expect(overlay).toContain('<button v-if="isSidePanel" class="window-control"')
    expect(overlay).toContain('<button class="window-control danger" type="button" :aria-label="t(\'common.close\')" @click="closeOverlay(\'manual\')">')
    expect(overlay).toContain("if (isSidePanel.value) {\n      closeOverlay('augment-cleared')")
    expect(overlay).toContain("game-started received; champion insight visibility handled by main process")
    expect(overlay).toContain("game-in-progress received; champion insight visibility handled by main process")
    expect(preferences).toContain('championInsight.hideOnGameStart')
  })

  it('gates all Champion Details show paths after preserving champion state updates', async () => {
    const [appConfig, ipcHandlers, preferenceHandlers, preferenceSource] = await Promise.all([
      readFile(new URL('../../src/main/modules/app-config.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/main/modules/ipc-handlers.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/main/ipc/preferences-handlers.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/main/modules/user-preferences.ts', import.meta.url), 'utf8'),
    ])
    const champSelectShowBlock = appConfig.slice(
      appConfig.indexOf('async function showChampionInsightSnapshot'),
      appConfig.indexOf('async function pollChampSelectSnapshot'),
    )
    const inProgressRecoveryBlock = appConfig.slice(
      appConfig.indexOf('async function recoverChampionInsightForInProgress'),
      appConfig.indexOf('async function autoApplyAramItemSetForChampion'),
    )

    expect(preferenceSource).toContain("showChampionDetails: 'championInsight.showDetails'")
    expect(preferenceSource).toContain('shouldShowChampionDetails(): boolean')
    expect(preferenceHandlers).toContain("'championInsight.showDetails'")
    expect(champSelectShowBlock.indexOf('setChampionMonitorChampion(championId)')).toBeGreaterThan(-1)
    expect(champSelectShowBlock.indexOf('setChampionMonitorChampion(championId)'))
      .toBeLessThan(champSelectShowBlock.indexOf('if (!shouldShowChampionDetails())'))
    expect(inProgressRecoveryBlock.indexOf('setChampionMonitorChampion(championId)')).toBeGreaterThan(-1)
    expect(inProgressRecoveryBlock.indexOf('setChampionMonitorChampion(championId)'))
      .toBeLessThan(inProgressRecoveryBlock.indexOf('if (!canRefreshVisiblePopup)'))
    expect(inProgressRecoveryBlock.indexOf('lastInProgressInsightChampionId = championId'))
      .toBeLessThan(inProgressRecoveryBlock.indexOf('if (!canRefreshVisiblePopup)'))
    expect(ipcHandlers.match(/if \(!shouldShowChampionDetails\(\)\)/g)).toHaveLength(6)
    expect(appConfig).toContain('applyPopupWindowPreferences(phase)')
  })
})
