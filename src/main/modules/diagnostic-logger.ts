import { app } from 'electron'
import { getLCUServiceInstance } from '../services/lcu/lcu-service.ts'
import { getVersionInfo } from '../version-checker.ts'
import logger from './logger.ts'
import store from './app-store.ts'
import { getAppDataDir } from './app-paths.ts'

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined
    const timeout = new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => resolve(fallback), timeoutMs)
        timeoutId.unref?.()
    })

    return Promise.race([promise, timeout]).finally(() => {
        if (timeoutId) {
            clearTimeout(timeoutId)
        }
    })
}

function getStoreBoolean(key: string, fallback: boolean | null = null): boolean | null {
    const value = store.get(key)
    return typeof value === 'boolean' ? value : fallback
}

async function collectVersionDiagnostics() {
    type VersionInfo = Awaited<ReturnType<typeof getVersionInfo>>
    type VersionDiagnosticResult =
        | { success: true; versionInfo: VersionInfo }
        | { success: false; error: string }
    const result = await withTimeout<VersionDiagnosticResult>(
        getVersionInfo()
            .then((versionInfo): VersionDiagnosticResult => ({ success: true, versionInfo }))
            .catch((error): VersionDiagnosticResult => ({
                success: false,
                error: error instanceof Error ? error.message : String(error),
            })),
        4000,
        { success: false, error: 'version diagnostics timed out' }
    )

    if (!result.success) {
        return {
            currentVersion: app.getVersion(),
            error: result.error,
        }
    }

    const { versionInfo } = result
    return {
        currentVersion: versionInfo.currentVersion,
        latestVersion: versionInfo.latestVersion || '',
        minimumVersion: versionInfo.minimumVersion || '',
        isNewer: versionInfo.isNewer,
        severity: versionInfo.severity,
        dataVersion: versionInfo.dataVersion || '',
        gamePatch: versionInfo.gamePatch || '',
        generatedAt: versionInfo.generatedAt || '',
        publishedAt: versionInfo.publishedAt || '',
    }
}

async function collectLcuDiagnostics() {
    const service = getLCUServiceInstance()
    const phase = await withTimeout(service.getGameflowPhase(), 3000, null)
    const connected = await withTimeout(service.getLcuStatus(), 1500, false)
    const snapshot = await withTimeout(
        service.getChampSelectSnapshot().catch((error) => ({
            error: error instanceof Error ? error.message : String(error),
        })),
        3000,
        { error: 'champ-select snapshot timed out' }
    )

    return {
        discoveryMode: 'process',
        connected: Boolean(connected || phase),
        gameflowPhase: phase,
        champSelect: 'error' in snapshot
            ? { error: snapshot.error }
            : {
                phase: snapshot.gameflowPhase || null,
                selfChampionId: snapshot.selfChampionId || null,
                benchEnabled: Boolean(snapshot.benchEnabled),
                benchCount: snapshot.benchChampions?.length || 0,
                teamCount: snapshot.myTeam?.length || 0,
            },
    }
}

function collectConfigDiagnostics() {
    return {
        itemSetAutoApplyAram: getStoreBoolean('itemSets.autoApplyAram', true),
        analyticsEnabled: getStoreBoolean('analytics.enabled', null),
        lastSelectedChampionId: store.get('lastSelectedChampionId') || null,
        appDataDir: getAppDataDir(),
        logDir: logger.getLogDir(),
        currentLogFile: logger.getCurrentLogFile(),
    }
}

function collectOcrDiagnostics() {
    // Capture now happens only on manual refresh; see manual-overlay logs.
    return { mode: 'manual-refresh' }
}

export async function collectDiagnosticSnapshot(reason: string = 'manual') {
    const [version, lcu] = await Promise.all([
        collectVersionDiagnostics(),
        collectLcuDiagnostics(),
    ])

    return {
        reason,
        collectedAt: logger.toBeijingISOString(),
        app: {
            name: app.getName(),
            version: app.getVersion(),
            packaged: app.isPackaged,
            platform: process.platform,
            arch: process.arch,
            electron: process.versions.electron,
            node: process.versions.node,
        },
        version,
        lcu,
        config: collectConfigDiagnostics(),
        ocr: collectOcrDiagnostics(),
    }
}

export async function logDiagnosticSnapshot(reason: string = 'manual') {
    const snapshot = await collectDiagnosticSnapshot(reason)
    logger.info('[diagnostics] app diagnostic snapshot', snapshot)
    return snapshot
}
