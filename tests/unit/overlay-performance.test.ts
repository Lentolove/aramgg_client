import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { shouldRaiseOverlayWindow } from '../../src/main/modules/overlay-window-state.ts'

describe('augment overlay performance safeguards', () => {
  it('raises an overlay only while it is hidden', () => {
    expect(shouldRaiseOverlayWindow({ isVisible: () => false })).toBe(true)
    expect(shouldRaiseOverlayWindow({ isVisible: () => true })).toBe(false)
  })

  it('keeps overlay rendering free of persistent blur and pulse effects', async () => {
    const sidePanelOverlay = await readFile(
      new URL('../../src/renderer/components/AugmentWinrateOverlay.vue', import.meta.url),
      'utf8',
    )

    expect(sidePanelOverlay).not.toContain('backdrop-filter')
  })

  it('displays rank-backed recommendations while preserving client win rates', async () => {
    const championDetailOverlay = await readFile(
      new URL('../../src/renderer/components/AugmentWinrateOverlay.vue', import.meta.url),
      'utf8',
    )

    expect(championDetailOverlay).toContain('formatAugmentWinRate(augment.winRate)')
    expect(championDetailOverlay).toContain("t('augment.winRate')")
    expect(championDetailOverlay).toContain('class="augment-tier"')
    expect(championDetailOverlay).toContain('formatAugmentTier(augment.tier)')
    expect(championDetailOverlay).toContain('rank: toNullableNumber(stats.rank)')
    expect(championDetailOverlay).toContain('return rankAugmentRecommendations(rows)')
    expect(championDetailOverlay).not.toContain('winRate * 0.6 + pickRate * 0.2')
  })

  it('uses Electron background throttling defaults and guards every overlay raise path', async () => {
    const windowManager = await readFile(
      new URL('../../src/main/modules/window-manager.ts', import.meta.url),
      'utf8',
    )

    expect(windowManager).not.toContain('backgroundThrottling')
    expect(windowManager).toContain('!shouldRaiseOverlayWindow(window)')
  })
})
