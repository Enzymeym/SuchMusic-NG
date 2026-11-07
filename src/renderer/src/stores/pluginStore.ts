/**
 * 插件管理 Store（v2）
 *
 * 只负责管理面：安装 / 启停 / 移除 / 设置 / 日志。数据面（解析播放地址、搜索）
 * 走 `source:*`，由 `utils/pluginSource.ts` 与 `sourcePluginStore` 处理。
 *
 * 与洛雪/澜音的插件共用一个「设置模态框」：打开哪个插件的设置由
 * `settingsTarget` 决定，`kind` 决定模态框渲染声明的表单还是音乐源开关。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { usePlaylistStore } from './playlistStore'
import type { SettingField, V2PluginSummary } from '../../../shared/plugin/types'

export type PluginKind = 'v2' | 'lx' | 'ceru'

/** 设置模态框的目标 */
export interface SettingsTarget {
  pluginId: string
  kind: PluginKind
}

export const usePluginStore = defineStore('plugin', () => {
  // ========== 状态 ==========
  const plugins = ref<V2PluginSummary[]>([])
  const loading = ref(false)
  const notification = ref<{ type: string; message: string } | null>(null)
  const settingsTarget = ref<SettingsTarget | null>(null)

  const pendingBatchConfirm = ref<{
    pluginId: string
    pluginName: string
    operations: { opId: string; operation: string; detail: string }[]
    requestId: string
  } | null>(null)

  // ========== 计算属性 ==========
  const runningPlugins = computed(() => plugins.value.filter((p) => p.state === 'running'))

  // ========== 管理 ==========

  async function refresh(): Promise<void> {
    try {
      const res = await window.api.plugins.list()
      if (res.success && res.plugins) plugins.value = res.plugins
    } catch (err) {
      console.error('[PluginStore] 刷新插件列表失败:', err)
    }
  }

  /** 从文件导入（自动识别 v2 / 洛雪 / 澜音） */
  async function importFromFile(filePath: string): Promise<{ ok: boolean; kind?: string }> {
    loading.value = true
    try {
      const res = await window.api.plugins.importFile(filePath)
      if (!res.success) {
        notification.value = { type: 'error', message: res.error || '导入失败' }
        return { ok: false }
      }
      if (res.kind === 'v2' && res.plugin) {
        const idx = plugins.value.findIndex((p) => p.id === res.plugin!.id)
        if (idx >= 0) plugins.value[idx] = res.plugin
        else plugins.value.push(res.plugin)
      }
      return { ok: true, kind: res.kind }
    } catch (err: any) {
      notification.value = { type: 'error', message: err?.message || '导入失败' }
      return { ok: false }
    } finally {
      loading.value = false
    }
  }

  /** 弹文件选择框并导入 */
  async function selectAndImport(): Promise<{ ok: boolean; canceled?: boolean }> {
    const picked = await window.api.plugins.selectFile()
    if (!picked.success || !picked.filePath) return { ok: false, canceled: !!picked.canceled }
    const res = await importFromFile(picked.filePath)
    return { ok: res.ok }
  }

  async function remove(pluginId: string): Promise<boolean> {
    try {
      const res = await window.api.plugins.remove(pluginId)
      if (!res.success) {
        notification.value = { type: 'error', message: res.error || '移除失败' }
        return false
      }
      plugins.value = plugins.value.filter((p) => p.id !== pluginId)
      if (settingsTarget.value?.pluginId === pluginId) settingsTarget.value = null
      return true
    } catch (err: any) {
      notification.value = { type: 'error', message: err?.message || '移除失败' }
      return false
    }
  }

  async function setEnabled(pluginId: string, enabled: boolean): Promise<boolean> {
    try {
      const res = await window.api.plugins.setEnabled(pluginId, enabled)
      if (!res.success || !res.plugin) {
        notification.value = { type: 'error', message: res.error || '操作失败' }
        return false
      }
      const idx = plugins.value.findIndex((p) => p.id === pluginId)
      if (idx >= 0) plugins.value[idx] = res.plugin
      return true
    } catch (err: any) {
      notification.value = { type: 'error', message: err?.message || '操作失败' }
      return false
    }
  }

  async function reload(pluginId: string): Promise<boolean> {
    try {
      const res = await window.api.plugins.reload(pluginId)
      if (!res.success || !res.plugin) {
        notification.value = { type: 'error', message: res.error || '重载失败' }
        return false
      }
      const idx = plugins.value.findIndex((p) => p.id === pluginId)
      if (idx >= 0) plugins.value[idx] = res.plugin
      return true
    } catch (err: any) {
      notification.value = { type: 'error', message: err?.message || '重载失败' }
      return false
    }
  }

  async function checkUpdate(pluginId: string): Promise<{
    hasNew: boolean
    version?: string
    changelog?: string
  }> {
    try {
      const res = await window.api.plugins.checkUpdate(pluginId)
      if (!res.success || !res.result) {
        notification.value = { type: 'error', message: res.error || '检查更新失败' }
        return { hasNew: false }
      }
      return res.result
    } catch (err: any) {
      notification.value = { type: 'error', message: err?.message || '检查更新失败' }
      return { hasNew: false }
    }
  }

  // ========== 设置模态框 ==========

  function openSettings(pluginId: string, kind: PluginKind): void {
    settingsTarget.value = { pluginId, kind }
  }

  function closeSettings(): void {
    settingsTarget.value = null
  }

  // ========== 事件 ==========

  let listenersInitialized = false

  function initListeners(): void {
    if (listenersInitialized) return
    listenersInitialized = true

    window.api.plugins.onNotice((data: any) => {
      if (data.type === 'loaded') {
        notification.value = {
          type: 'success',
          message: `插件「${data.pluginName || data.pluginId}」v${data.version ?? ''} 已加载`
        }
        void refresh()
      } else if (data.type === 'removed' || data.type === 'enabled' || data.type === 'disabled') {
        void refresh()
      } else if (data.type === 'notify') {
        notification.value = {
          type: data.notifyType || 'info',
          message: data.message || ''
        }
      } else if (data.type === 'error') {
        notification.value = { type: 'error', message: data.message || '插件错误' }
        void refresh()
      }
    })

    window.api.plugins.onBatchConfirmRequest((request: any) => {
      pendingBatchConfirm.value = request
    })

    // 插件发起的歌单操作 → 交给 playlistStore 执行
    window.api.plugins.onPlaylistOp(async (request: any) => {
      const playlistStore = usePlaylistStore()
      let result: any = null
      let error: string | undefined

      try {
        switch (request.action) {
          case 'createPlaylist': {
            const { name, tracks } = request.params
            const playlist = playlistStore.createPlaylistFromTracks(name, normalizeTracks(tracks || []))
            result = playlist
            break
          }
          case 'addToPlaylist': {
            const { playlistId, tracks } = request.params
            const pl = playlistStore.playlists.find((p: any) => p.id === playlistId)
            if (!pl) {
              error = `歌单 "${playlistId}" 不存在`
              break
            }
            pl.tracks.push(...normalizeTracks(tracks || []))
            playlistStore.updatePlaylist(pl)
            result = pl
            break
          }
          case 'updatePlaylistSettings': {
            const { playlistId, ...settings } = request.params
            const pl = playlistStore.playlists.find((p: any) => p.id === playlistId)
            if (!pl) {
              error = `歌单 "${playlistId}" 不存在`
              break
            }
            Object.assign(pl, settings)
            playlistStore.updatePlaylist(pl)
            result = pl
            break
          }
          case 'listPlaylists': {
            result = playlistStore.playlists.map((p: any) => ({
              id: p.id,
              name: p.name,
              trackCount: p.tracks?.length || 0,
              createdAt: p.createdAt,
              updatedAt: p.updatedAt
            }))
            break
          }
          default:
            error = `未知的歌单操作: ${request.action}`
        }
      } catch (err: any) {
        error = err.message
      }

      await window.api.plugins.respondPlaylistOp({
        requestId: request.requestId,
        success: !error,
        error,
        result
      })
    })
  }

  async function respondBatchConfirm(
    confirmed: boolean,
    rejectedOpIds: string[] = [],
    skipSession = false
  ): Promise<void> {
    if (!pendingBatchConfirm.value) return
    await window.api.plugins.respondBatchConfirm({
      requestId: pendingBatchConfirm.value.requestId,
      confirmed,
      rejectedOpIds,
      skipSession
    })
    pendingBatchConfirm.value = null
  }

  function clearNotification(): void {
    notification.value = null
  }

  // ========== 曲目归一化（插件可直接传文件路径或对象） ==========

  function normalizeTracks(tracks: any[]): any[] {
    return tracks.map((track: any, index: number) => {
      if (typeof track === 'string') {
        const { title, artist } = parseFileName(track)
        return {
          id: `plg-${Date.now()}-${index}`,
          title,
          artist,
          filePath: track
        }
      }
      const hasPath = track.filePath || track.path || track.url
      const title = track.title || track.name || (hasPath ? parseFileName(hasPath).title : '未知歌曲')
      const artist = track.artist || (hasPath ? parseFileName(hasPath).artist : '未知歌手')
      return {
        id: track.id || `plg-${Date.now()}-${index}`,
        title,
        artist,
        album: track.album,
        cover: track.cover,
        filePath: hasPath || '',
        durationMs: track.durationMs || track.duration,
        source: track.source,
        sourceSongId: track.sourceSongId
      }
    })
  }

  function parseFileName(filePath: string): { title: string; artist: string } {
    const fileName = filePath.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '')
    const match = fileName.match(/^(.+?)\s*[-–—]\s*(.+)$/)
    if (match) return { artist: match[1].trim(), title: match[2].trim() }
    return { title: fileName, artist: '未知歌手' }
  }

  return {
    // 状态
    plugins,
    loading,
    notification,
    settingsTarget,
    pendingBatchConfirm,
    // 计算
    runningPlugins,
    // 管理
    refresh,
    importFromFile,
    selectAndImport,
    remove,
    setEnabled,
    reload,
    checkUpdate,
    // 设置模态框
    openSettings,
    closeSettings,
    // 事件
    initListeners,
    respondBatchConfirm,
    clearNotification
  }
})

/** 设置表单的类型别名，供组件复用到 store 外部 */
export type { SettingField }
