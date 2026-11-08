/**
 * 扫描编排：把「子进程产出的批」变成「库里的确定性状态」。
 *
 * 顺序上有两处不能调换：
 * 1. **先写 tracks 再重建 folders**：folders 完全由 tracks 派生，顺序反了会得到空歌单；
 * 2. **先删除差集再重建**：被删掉的曲目还挂在目录上会让 `track_count` 偏大。
 *
 * 事务策略：每批（数百条）一个事务。主进程用的是同步 API，单批插入耗时在
 * 个位数毫秒，既不会明显卡顿，也不会把一万首攒成一次几百毫秒的阻塞。
 */
import { BrowserWindow } from 'electron'
import type {
  LibraryBootstrap,
  LibraryFolder,
  LibraryTrack,
  ScanProgress,
  ScanStats,
  ScannedTrack
} from '../../../shared/library/types'
import { LIBRARY_CHANNELS } from '../../../shared/library/channels'
import { getMeta, getLibraryDb, getLibraryUnavailableReason, setMeta } from './db'
import {
  deleteTracksByIds,
  getKnownFiles,
  listAllTracks,
  listReferencedCoverHashes,
  listTracksInFolder,
  upsertTracks
} from './trackRepository'
import { listFolders, rebuildFolders } from './folderRepository'
import { startScanner, type ScannerHandle } from './scannerClient'
import { gcCovers } from './coverStore'

interface ScanState {
  scanning: boolean
  progress: ScanProgress | null
  lastStats: ScanStats | null
  lastScanAt: number
  jobId: string
}

const state: ScanState = {
  scanning: false,
  progress: null,
  lastStats: null,
  lastScanAt: 0,
  jobId: ''
}

let handle: ScannerHandle | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      /* 窗口正在销毁，忽略 */
    }
  }
}

export function getScanningState(): boolean {
  return state.scanning
}

export function getScanSnapshot(): {
  scanning: boolean
  progress: ScanProgress | null
  lastStats: ScanStats | null
  lastScanAt: number
} {
  return {
    scanning: state.scanning,
    progress: state.progress,
    lastStats: state.lastStats,
    lastScanAt: state.lastScanAt
  }
}

/** 读库 + 目录树 + 上次扫描信息，一次 invoke 交付给渲染层 */
export function bootstrapLibrary(): LibraryBootstrap {
  const conn = getLibraryDb()
  if (!conn) {
    return {
      tracks: [],
      folders: [],
      stats: null,
      scanning: state.scanning,
      lastScanAt: 0,
      unavailableReason: getLibraryUnavailableReason() || '曲库数据库不可用'
    }
  }

  const lastScanAtRaw = getMeta(conn, 'last_scan_at')
  const lastScanAt = Number(lastScanAtRaw) || 0
  if (!state.lastScanAt) state.lastScanAt = lastScanAt

  const statsRaw = getMeta(conn, 'last_scan_stats')
  let stats: ScanStats | null = state.lastStats
  if (!stats && statsRaw) {
    try {
      stats = JSON.parse(statsRaw) as ScanStats
    } catch {
      stats = null
    }
  }

  return {
    tracks: listAllTracks(conn),
    folders: listFolders(conn),
    stats,
    scanning: state.scanning,
    lastScanAt
  }
}

export function listFolderTracks(
  folderId: number,
  options: { includeSubfolders?: boolean; limit?: number; offset?: number } = {}
): LibraryTrack[] {
  const conn = getLibraryDb()
  if (!conn) return []
  const folder = conn.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as
    | { path: string }
    | undefined
  if (!folder) return []
  return listTracksInFolder(conn, folder.path, options)
}

export function listFoldersSnapshot(): LibraryFolder[] {
  const conn = getLibraryDb()
  return conn ? listFolders(conn) : []
}

/**
 * 启动一次扫描。
 * @param roots 扫描根目录（归一化交给子进程）
 * @returns 是否真正启动（已有扫描在跑时返回 false）
 */
export function startScan(roots: string[]): { started: boolean; jobId: string } {
  if (state.scanning) return { started: false, jobId: state.jobId }

  const conn = getLibraryDb()
  if (!conn) {
    broadcast(LIBRARY_CHANNELS.scanDone, {
      ok: false,
      error: getLibraryUnavailableReason() || '曲库数据库不可用'
    })
    return { started: false, jobId: '' }
  }

  const jobId = `scan-${Date.now()}`
  state.scanning = true
  state.jobId = jobId
  state.progress = { phase: 'walk', scanned: 0, tagged: 0 }

  const known = getKnownFiles(conn)
  let added = 0
  let updated = 0
  let buffered = 0

  handle = startScanner(
    { roots, known, concurrency: 4, batchSize: 16 },
    {
      onProgress: (progress) => {
        state.progress = progress
        broadcast(LIBRARY_CHANNELS.scanProgress, progress)
      },
      onTracks: (tracks: ScannedTrack[]) => {
        buffered += tracks.length
        try {
          const write = conn.transaction(() => upsertTracks(conn, tracks, Date.now()))
          const result = write()
          added += result.added
          updated += result.updated
        } catch (error) {
          console.error('[library] 写入曲目批失败:', error)
        }
        // 每批只推一次「已入库条数」，渲染层拿它做进度条即可
        broadcast(LIBRARY_CHANNELS.scanProgress, {
          phase: 'tags',
          scanned: state.progress?.scanned ?? 0,
          tagged: buffered
        } satisfies ScanProgress)
      },
      onDone: (payload) => {
        finalizeScan(payload, { added, updated, roots })
      },
      onError: (message) => {
        console.error('[library] 扫描失败:', message)
      }
    }
  )

  void handle.done.then((payload) => {
    // onDone 已在里面做过收尾；这里只负责异常/取消时复位状态
    if (!payload) {
      state.scanning = false
      state.progress = null
      state.jobId = ''
      handle = null
      broadcast(LIBRARY_CHANNELS.scanDone, { ok: false, error: '扫描中断' })
    }
  })

  return { started: true, jobId }
}

function finalizeScan(
  payload: { deletedIds: string[]; scanned: number; unchanged: number; errors: number; durationMs: number },
  context: { added: number; updated: number; roots: string[] }
): void {
  const conn = getLibraryDb()
  const finishedAt = Date.now()

  if (conn) {
    try {
      const commit = conn.transaction(() => {
        if (payload.deletedIds.length > 0) {
          deleteTracksByIds(conn, payload.deletedIds)
        }
        rebuildFolders(conn, finishedAt)
        setMeta(conn, 'last_scan_at', String(finishedAt))
      })
      commit()
    } catch (error) {
      console.error('[library] 扫描收尾失败:', error)
    }

    // 孤儿封面清理放在事务之外，失败也不影响曲库可用性
    void (async () => {
      try {
        const referenced = listReferencedCoverHashes(conn)
        const removed = await gcCovers(referenced)
        if (removed > 0) console.log(`[library] 清理无用封面 ${removed} 个`)
      } catch (error) {
        console.warn('[library] 封面清理失败:', error)
      }
    })()
  }

  const stats: ScanStats = {
    scanned: payload.scanned,
    added: context.added,
    updated: context.updated,
    unchanged: payload.unchanged,
    removed: payload.deletedIds.length,
    errors: payload.errors,
    durationMs: payload.durationMs
  }

  state.lastStats = stats
  state.lastScanAt = finishedAt
  state.scanning = false
  state.progress = null
  state.jobId = ''
  handle = null

  if (conn) {
    try {
      setMeta(conn, 'last_scan_stats', JSON.stringify(stats))
    } catch {
      /* ignore */
    }
  }

  console.log(
    `[library] 扫描完成：${stats.scanned} 个文件，新增 ${stats.added}，更新 ${stats.updated}，` +
      `未变 ${stats.unchanged}，删除 ${stats.removed}，耗时 ${stats.durationMs}ms`
  )

  broadcast(LIBRARY_CHANNELS.scanDone, {
    ok: true,
    stats,
    lastScanAt: finishedAt
  })
}

export function cancelScan(): void {
  handle?.cancel()
}
