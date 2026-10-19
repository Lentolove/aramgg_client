import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.3.0' } }))
vi.mock('../../src/main/data-loader.ts', () => ({
  loadDataApiConfig: vi.fn(async () => ({})),
  getActiveDataStatus: vi.fn(async () => null),
}))
vi.mock('../../src/main/modules/logger.ts', () => ({ default: { info: vi.fn(), warn: vi.fn() } }))

import {
  FORK_LATEST_RELEASE_API_URL,
  FORK_RELEASES_URL,
  isTrustedForkReleaseUrl,
} from '../../src/main/security/update-trust.ts'
import { fetchForkLatestRelease, parseForkRelease } from '../../src/main/version-checker.ts'

describe('fork update source', () => {
  it('points at Lentolove/aramgg_client', () => {
    expect(FORK_LATEST_RELEASE_API_URL).toBe('https://api.github.com/repos/Lentolove/aramgg_client/releases/latest')
    expect(FORK_RELEASES_URL).toBe('https://github.com/Lentolove/aramgg_client/releases')
  })

  it('trusts only fork release URLs', () => {
    expect(isTrustedForkReleaseUrl('https://github.com/Lentolove/aramgg_client/releases/tag/v0.3.0')).toBe(true)
    expect(isTrustedForkReleaseUrl('https://github.com/valkia/aramgg_client/releases/tag/v0.2.18')).toBe(false)
    expect(isTrustedForkReleaseUrl('http://github.com/Lentolove/aramgg_client/releases')).toBe(false)
    expect(isTrustedForkReleaseUrl('https://cdn.dtodo.cn/latest.yml')).toBe(false)
  })

  it('parses a release payload and falls back on untrusted links', () => {
    expect(parseForkRelease({ tag_name: 'v0.3.1', html_url: 'https://evil.example/x', body: '- a' })).toMatchObject({
      version: '0.3.1',
      htmlUrl: FORK_RELEASES_URL,
    })
    expect(parseForkRelease({ tag_name: 'v0.3.1', prerelease: true })).toBeNull()
    expect(parseForkRelease({ tag_name: 'nightly' })).toBeNull()
  })

  it('fails quietly when offline or no release exists', async () => {
    const offline = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await fetchForkLatestRelease(offline)).toBeNull()
    const missing = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch
    expect(await fetchForkLatestRelease(missing)).toBeNull()
  })
})
