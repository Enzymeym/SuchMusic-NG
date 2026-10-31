/**
 * 曲库 IPC 边界。
 *
 * 约定沿用项目既有风格：`registerXxxHandlers()` 统一注册、参数用扁平位置参数、
 * 查询类失败返回空值、写操作类抛错让渲染层 `catch` 出提示。
 */
import { app, ipcMain, shell } from 'electron'
import { LIBRARY_CHANNELS } from '../../shared/library/channels'
import type { FolderPatch, FolderTracksQuery } from '../../shared/library/types'
import { getLibraryDb } from '../services/library/db'
import { listChildFolders, rebuildFolders, updateFolder } from '../services/library/folderRepository'
import { listTracksByPaths, upsertTracks } from '../services/library/trackRepository'
import {
  bootstrapLibrary,
  cancelScan,
  getScanSnapshot,
  listFolderTracks,
  startScan
} from '../services/library/scanService'
import { resolveAudioMeta } from '../services/audioMetaResolver'
import { getNativeTagReader } from '../services/tagReaderService'
import { writeCoverFile } from '../services/library/scanner/coverWriter'
import { buildTrackFromResolved } from '../services/library/scanner/trackBuilder'
import { getCoversDir } from '../services/library/coverStore'
import type { ScannedTrack } from '../../shared/library/types'

export function registerLibraryHandlers(): void {
  ipcMain.handle(LIBRARY_CHANNELS.bootstrap, () => bootstrapLibrary())

  ipcMain.handle(LIBRARY_CHANNELS.scan, (_event, roots?: unknown) => {
    const dirs = Array.isArray(roots)
      ? roots.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : []
    const finalRoots = dirs.length > 0 ? dirs : [app.getPath('music')]
    return startScan(finalRoots)
  })

  ipcMain.handle(LIBRARY_CHANNELS.scanCancel, () => {
    cancelScan()
    return getScanSnapshot()
  })

  ipcMain.handle(LIBRARY_CHANNELS.folderTracks, (_event, folderId: unknown, options?: unknown) => {
    const id = Number(folderId)
    if (!Number.isFinite(id) || id <= 0) return []
    const query = (options ?? {}) as Partial<FolderTracksQuery>
    return listFolderTracks(id, {
      includeSubfolders: !!query.includeSubfolders,
      limit: query.limit,
      offset: query.offset
    })
  })

  ipcMain.handle(LIBRARY_CHANNELS.folderChildren, (_event, parentPath: unknown) => {
    const conn = getLibraryDb()
    if (!conn || typeof parentPath !== 'string') return []
    return listChildFolders(conn, parentPath)
  })

  ipcMain.handle(LIBRARY_CHANNELS.folderUpdate, (_event, folderId: unknown, patch?: unknown) => {
    const conn = getLibraryDb()
    const id = Number(folderId)
    if (!conn || !Number.isFinite(id) || id <= 0) return null
    const safePatch = (patch ?? {}) as FolderPatch
    return updateFolder(
      conn,
      id,
      {
        alias: typeof safePatch.alias === 'string' || safePatch.alias === null ? safePatch.alias : undefined,
        pinned: typeof safePatch.pinned === 'boolean' ? safePatch.pinned : undefined,
        hidden: typeof safePatch.hidden === 'boolean' ? safePatch.hidden : undefined,
        sortOrder: typeof safePatch.sortOrder === 'number' ? safePatch.sortOrder : undefined
      },
      Date.now()
    )
  })

  /**
   * 标签编辑后重新读取指定文件并刷新库里对应的行。
   * 只重读传进来的路径，不触发整库扫描。
   */
  ipcMain.handle(LIBRARY_CHANNELS.reloadTracks, async (_event, filePaths: unknown) => {
    const conn = getLibraryDb()
    if (!conn || !Array.isArray(filePaths)) return { updated: 0 }
    const paths = filePaths.filter((p): p is string => typeof p === 'string' && !!p)
    if (paths.length === 0) return { updated: 0 }

    const existing = listTracksByPaths(conn, paths)
    if (existing.length === 0) return { updated: 0 }

    const coversDir = getCoversDir()
    const reader = getNativeTagReader()
    const rebuilt: ScannedTrack[] = []

    for (const track of existing) {
      try {
        const meta = await resolveAudioMeta(track.filePath, {
          includeCover: true,
          coverFormat: 'raw',
          reader
        })
        const cover = meta.coverData ? await writeCoverFile(coversDir, meta.coverData.data) : null
        rebuilt.push(
          buildTrackFromResolved(
            {
              filePath: track.filePath,
              fileName: track.fileName,
              folderPath: track.folderPath,
              rootPath: track.rootPath,
              relDir: track.relDir,
              size: track.size,
              mtimeMs: track.mtimeMs
            },
            meta,
            cover
          )
        )
      } catch (error) {
        console.warn('[library] 重读标签失败:', track.filePath, error)
      }
    }

    if (rebuilt.length === 0) return { updated: 0 }
    const now = Date.now()
    const write = conn.transaction(() => {
      upsertTracks(conn, rebuilt, now)
      rebuildFolders(conn, now)
    })
    write()
    return { updated: rebuilt.length }
  })

  ipcMain.handle(LIBRARY_CHANNELS.reveal, (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !filePath) return false
    shell.showItemInFolder(filePath)
    return true
  })
}
