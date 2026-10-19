import { app } from 'electron'
import { getActiveDataStatus, loadDataApiConfig } from './data-loader.ts'
import logger from './modules/logger.ts'
import {
  FORK_LATEST_RELEASE_API_URL,
  FORK_RELEASES_URL,
  isTrustedForkReleaseUrl,
} from './security/update-trust.ts'

export type ForkRelease = {
  version: string
  htmlUrl: string
  body: string
  publishedAt: string
}

export function parseForkRelease(payload: any): ForkRelease | null {
  if (!payload || typeof payload !== 'object' || payload.draft || payload.prerelease) {
    return null
  }
  const version = String(payload.tag_name || '').trim().replace(/^v/i, '')
  if (!VERSION_PATTERN.test(version)) {
    return null
  }
  const htmlUrl = isTrustedForkReleaseUrl(payload.html_url) ? String(payload.html_url) : FORK_RELEASES_URL
  return {
    version,
    htmlUrl,
    body: typeof payload.body === 'string' ? payload.body : '',
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : '',
  }
}

export async function fetchForkLatestRelease(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000
): Promise<ForkRelease | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(FORK_LATEST_RELEASE_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'aramgg_client' },
      signal: controller.signal,
    })
    if (!response.ok) {
      return null
    }
    return parseForkRelease(await response.json())
  } catch (error) {
    logger.info('[update] fork release check skipped:', error instanceof Error ? error.message : String(error))
    return null
  } finally {
    clearTimeout(timer)
  }
}

function releaseChangelog(release: ForkRelease | null) {
  if (!release) return []
  const items = release.body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s*/, '').trim())
    .filter((line) => line && !line.startsWith('#'))
    .slice(0, 20)
  return [{
    version: release.version,
    date: release.publishedAt.slice(0, 10),
    title: `v${release.version}`,
    summary: items[0] || '',
    changes: items.slice(0, 8),
  }]
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/
type VersionSeverity = 'unknown' | 'none' | 'major' | 'minor' | 'patch'

type VersionComparison = {
  severity: VersionSeverity
  shouldPrompt: boolean
  isNewer: boolean
}

function parseVersion(version: unknown): number[] | null {
  const match = VERSION_PATTERN.exec(String(version || '').trim())
  if (!match) {
    return null
  }

  return match.slice(1).map((part) => Number(part))
}

function compareVersion(currentVersion: unknown, latestVersion: unknown): VersionComparison {
  const current = parseVersion(currentVersion)
  const latest = parseVersion(latestVersion)

  if (!current || !latest) {
    return {
      severity: 'unknown',
      shouldPrompt: false,
      isNewer: false,
    }
  }

  const isNewer =
    latest[0] > current[0] ||
    (latest[0] === current[0] && latest[1] > current[1]) ||
    (latest[0] === current[0] && latest[1] === current[1] && latest[2] > current[2])

  if (!isNewer) {
    return {
      severity: 'none',
      shouldPrompt: false,
      isNewer: false,
    }
  }

  if (latest[0] !== current[0]) {
    return {
      severity: 'major',
      shouldPrompt: true,
      isNewer: true,
    }
  }

  if (latest[1] !== current[1]) {
    return {
      severity: 'minor',
      shouldPrompt: true,
      isNewer: true,
    }
  }

  return {
    severity: 'patch',
    shouldPrompt: false,
    isNewer: true,
  }
}

function getSeverityText(severity: VersionSeverity): string {
  if (severity === 'major') {
    return '最好更新'
  }

  if (severity === 'minor') {
    return '建议更新'
  }

  if (severity === 'patch') {
    return '有小版本更新'
  }

  return '已是最新'
}

export async function getVersionInfo() {
  const [config, activeData, release] = await Promise.all([
    loadDataApiConfig().catch(() => null),
    getActiveDataStatus(),
    fetchForkLatestRelease(),
  ])
  const currentVersion = app.getVersion()
  // Version/download info comes only from the fork's GitHub Releases.
  const latestVersion = release?.version || ''
  const comparison = compareVersion(currentVersion, latestVersion)
  // Fork releases are infrequent; prompt for any newer version incl. patch.
  const shouldPrompt = comparison.isNewer

  return {
    currentVersion,
    latestVersion,
    downloadUrl: release?.htmlUrl || FORK_RELEASES_URL,
    autoUpdateEnabled: true,
    updateFeedUrl: `${FORK_RELEASES_URL}/`,
    minimumVersion: '',
    dataVersion: activeData?.dataVersion || config?.dataVersion || '',
    locale: activeData?.locale || config?.locale || '',
    gamePatch: activeData?.gamePatch || config?.gamePatch || '',
    apiRelease: config?.apiRelease ?? null,
    generatedAt: activeData?.generatedAt || config?.generatedAt || '',
    publishedAt: release?.publishedAt || '',
    severity: comparison.severity,
    shouldPrompt,
    isNewer: comparison.isNewer,
    isBelowMinimumVersion: false,
    statusText: getSeverityText(comparison.severity),
    changelog: releaseChangelog(release),
  }
}

export async function checkForClientUpdate() {
  let versionInfo

  try {
    versionInfo = await getVersionInfo()
  } catch (error) {
    logger.warn(
      'Failed to check remote client version:',
      error instanceof Error ? error.message : String(error)
    )
    return null
  }

  if (!versionInfo.shouldPrompt) {
    return versionInfo
  }

  logger.info('[update] client update available', {
    currentVersion: versionInfo.currentVersion,
    latestVersion: versionInfo.latestVersion,
    minimumVersion: versionInfo.minimumVersion || null,
    severity: versionInfo.severity,
    isBelowMinimumVersion: versionInfo.isBelowMinimumVersion,
    hasDownloadUrl: !!versionInfo.downloadUrl,
  })

  return versionInfo
}
