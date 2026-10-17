/**
 * 音源插件 IPC 处理器
 *
 * 通道前缀 `source:`（与 Such 应用插件的 `plugin:` 区分）。
 */
import { ipcMain, dialog } from 'electron'
import { getMainWindow } from '../windows/mainWindow'
import { sourceRegistry } from '../services/pluginSource'
import { toSerializable } from '../services/pluginSource/serialize'
import { searchQQSong } from '../services/lyricService'
import type {
  LyricRequest,
  PlaylistListRequest,
  QualityId,
  ResolveRequest,
  SearchRequest,
  SourcePreferences,
  SourceTrack
} from '../services/pluginSource/types'

/** 向渲染进程推送音源插件通知 */
function sendNotice(data: Record<string, any>): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('source:notice', data)
  }
}

export function registerPluginSourceHandlers(): void {
  // 注册通知回调（插件加载/移除/更新提示/日志）
  sourceRegistry.setNoticeHandler((notice) => sendNotice(notice))

  // ========== 列表 ==========
  ipcMain.handle('source:list', async () => {
    return { success: true, plugins: sourceRegistry.list() }
  })

  // ========== 选择插件文件 ==========
  ipcMain.handle('source:select-file', async () => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return { success: false, error: '无可用窗口' }
    const result = await dialog.showOpenDialog(win, {
      title: '选择音源插件文件',
      filters: [
        { name: '音源插件', extensions: ['js', 'mjs', 'cjs'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }
    return { success: true, filePath: result.filePaths[0] }
  })

  // ========== 仅解析元信息（校验） ==========
  ipcMain.handle('source:inspect', async (_event, filePath: string) => {
    return sourceRegistry.inspectFile(filePath)
  })

  // ========== 加载插件 ==========
  ipcMain.handle('source:load', async (_event, filePath: string) => {
    try {
      const info = await sourceRegistry.loadFromFile(filePath)
      return { success: true, info }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 移除插件 ==========
  ipcMain.handle('source:remove', async (_event, pluginId: string) => {
    try {
      await sourceRegistry.remove(pluginId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 启用 / 停用 ==========
  ipcMain.handle('source:set-enabled', async (_event, pluginId: string, enabled: boolean) => {
    try {
      await sourceRegistry.setEnabled(pluginId, enabled)
      return { success: true, info: sourceRegistry.get(pluginId) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 单插件偏好（音乐源开关 / 音质） ==========
  ipcMain.handle(
    'source:set-preferences',
    async (
      _event,
      pluginId: string,
      patch: { sources?: string[] | null; quality?: string | null }
    ) => {
      try {
        // 只透传调用方真正给出的字段：省略的字段保持原值，避免「改音质」把音乐源开关重置
        const next: SourcePreferences = {}
        if (patch && 'sources' in patch) {
          next.sources = Array.isArray(patch.sources) ? patch.sources : null
        }
        if (patch && 'quality' in patch) {
          next.quality = (patch.quality as QualityId) ?? null
        }
        const settings = await sourceRegistry.setPreferences(pluginId, next)
        return { success: true, settings, info: sourceRegistry.get(pluginId) }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    }
  )

  // ========== 搜索 ==========
  ipcMain.handle('source:search', async (_event, req: SearchRequest) => {
    try {
      const res = await sourceRegistry.search({
        pluginId: req.pluginId,
        providerId: req.providerId,
        query: req.query,
        limit: req.limit ?? 30,
        cursor: req.cursor
      })
      return {
        success: true,
        items: toSerializable(res.items),
        nextCursor: res.nextCursor
      }
    } catch (err: any) {
      return { success: false, error: err.message, items: [] }
    }
  })

  // ========== 解析播放地址 ==========
  ipcMain.handle('source:resolve-url', async (_event, req: ResolveRequest) => {
    try {
      const result = await sourceRegistry.resolveUrl({
        pluginId: req.pluginId,
        providerId: req.providerId,
        sourceKey: req.sourceKey,
        id: req.id,
        ref: req.ref,
        quality: (req.quality || '320k') as QualityId
      })
      // 插件返回值可能来自 vm 沙箱（Proxy / 类实例），必须收敛为纯数据再回传
      return { success: true, result: toSerializable(result) }
    } catch (err: any) {
      // 带上错误码：渲染层据此区分「没有插件」与「插件解析失败」，
      // 避免所有失败都显示成「未找到音源插件」这种误导性提示
      return { success: false, error: err?.message || String(err), code: err?.code }
    }
  })

  // ========== 歌词 ==========
  ipcMain.handle('source:lyric', async (_event, req: LyricRequest) => {
    try {
      const result = await sourceRegistry.lyric(req)
      return { success: true, result: toSerializable(result) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 封面 ==========
  ipcMain.handle('source:pic', async (_event, req: LyricRequest) => {
    try {
      const result = await sourceRegistry.pic(req)
      return { success: true, result: toSerializable(result) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 歌单（仅澜音 Ceru 插件支持） ==========

  /** 歌单类目 */
  ipcMain.handle('source:playlist-categories', async (_event, pluginId: string) => {
    try {
      const items = await sourceRegistry.playlistCategories(pluginId)
      return { success: true, items }
    } catch (err: any) {
      return { success: false, error: err.message, items: [] }
    }
  })

  /** 歌单搜索 */
  ipcMain.handle('source:playlist-search', async (_event, req: PlaylistListRequest) => {
    try {
      const res = await sourceRegistry.playlistSearch(req)
      return { success: true, items: res.items, nextCursor: res.nextCursor }
    } catch (err: any) {
      return { success: false, error: err.message, items: [] }
    }
  })

  /** 歌单列表（某类目 / 某用户下的歌单） */
  ipcMain.handle('source:playlist-list', async (_event, req: PlaylistListRequest) => {
    try {
      const res = await sourceRegistry.playlistList(req)
      return { success: true, items: res.items, nextCursor: res.nextCursor }
    } catch (err: any) {
      return { success: false, error: err.message, items: [] }
    }
  })

  /** 歌单曲目明细 */
  ipcMain.handle('source:playlist-get', async (_event, req: PlaylistListRequest) => {
    try {
      const res = await sourceRegistry.playlistGet(req)
      return {
        success: true,
        items: toSerializable(res.items),
        nextCursor: res.nextCursor,
        meta: toSerializable(res.meta)
      }
    } catch (err: any) {
      return { success: false, error: err.message, items: [] }
    }
  })

  // ========== QQ 音乐搜索（vkeys API，播放/歌词仍走插件） ==========
  ipcMain.handle(
    'source:qq-search',
    async (_event, payload: { query: string; limit?: number; offset?: number }) => {
      const query = (payload?.query || '').trim()
      const limit = Math.max(1, Math.min(payload?.limit ?? 30, 60))
      const offset = Math.max(0, payload?.offset ?? 0)
      if (!query) return { success: true, items: [], hasMore: false, total: 0 }
      try {
        // vkeys 接口按页返回：根据 offset/limit 换算页码
        const page = Math.floor(offset / limit) + 1
        const songs = await searchQQSong(query, page, limit)
        const items: SourceTrack[] = songs.map((s) => ({
          pluginId: '',
          sourceKey: 'tx',
          id: String(s.mid || s.id),
          ref: {
            id: s.id,
            mid: s.mid,
            song: s.song,
            singer: s.singer,
            album: s.album,
            cover: s.cover
          },
          title: s.song,
          artist: s.singer || '未知歌手',
          album: s.album,
          coverUrl: s.cover,
          playable: true
        }))
        return {
          success: true,
          items,
          hasMore: songs.length >= limit,
          total: offset + songs.length
        }
      } catch (err: any) {
        return { success: false, error: err.message, items: [], hasMore: false, total: 0 }
      }
    }
  )

  console.log('[PluginSource] IPC 处理器已注册')
}
