/**
 * 插件管理 Store
 * 管理插件的加载、移除、调用和更新
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { usePlaylistStore } from './playlistStore'

export interface PluginInfo {
  id: string
  name: string
  version: string
  author: string
  description?: string
  icon?: string
  isUIWidget?: boolean
  permissions?: string[]
  uiSchema?: any
  filePath: string
  state: 'loaded' | 'running' | 'error' | 'unloaded'
  isActive: boolean
}

export const usePluginStore = defineStore('plugin', () => {
  // ========== 状态 ==========
  const plugins = ref<PluginInfo[]>([])
  const loading = ref(false)
  const notification = ref<{ type: string; message: string } | null>(null)
  const pendingConfirm = ref<{
    pluginId: string
    pluginName: string
    operation: string
    detail: string
    requestId: string
  } | null>(null)

  const pendingBatchConfirm = ref<{
    pluginId: string
    pluginName: string
    operations: { opId: string; operation: string; detail: string }[]
    requestId: string
  } | null>(null)

  // ========== 计算属性 ==========
  const activePlugin = computed(() => plugins.value.find((p) => p.isActive) || null)
  const loadedPlugins = computed(() => plugins.value.filter((p) => p.state === 'running'))

  // ========== 操作 ==========

  /** 加载插件 */
  async function loadPlugin(filePath: string): Promise<boolean> {
    loading.value = true
    try {
      const result = await window.api.plugins.load(filePath)
      if (result.success && result.manifest) {
        const pluginInfo: PluginInfo = {
          id: result.manifest.id,
          name: result.manifest.name,
          version: result.manifest.version,
          author: result.manifest.author,
          description: result.manifest.description,
          icon: result.manifest.icon,
          isUIWidget: result.manifest.isUIWidget,
          permissions: result.manifest.permissions || [],
          uiSchema: result.manifest.uiSchema || null,
          filePath,
          state: (result.state as PluginInfo['state']) || 'running',
          isActive: false
        }
        // 去重
        const existingIndex = plugins.value.findIndex((p) => p.id === pluginInfo.id)
        if (existingIndex >= 0) {
          plugins.value[existingIndex] = pluginInfo
        } else {
          plugins.value.push(pluginInfo)
        }
        return true
      }
      return false
    } catch (err: any) {
      console.error('[PluginStore] 加载插件失败:', err)
      return false
    } finally {
      loading.value = false
    }
  }

  /** 移除插件 */
  async function removePlugin(pluginId: string): Promise<boolean> {
    try {
      const result = await window.api.plugins.remove(pluginId)
      if (result.success) {
        plugins.value = plugins.value.filter((p) => p.id !== pluginId)
        return true
      }
      return false
    } catch (err: any) {
      console.error('[PluginStore] 移除插件失败:', err)
      return false
    }
  }

  /** 设置活跃插件 */
  async function setActivePlugin(pluginId: string | null): Promise<boolean> {
    try {
      const result = await window.api.plugins.setActive(pluginId)
      if (result.success) {
        plugins.value.forEach((p) => {
          p.isActive = p.id === pluginId
        })
        return true
      }
      return false
    } catch (err: any) {
      console.error('[PluginStore] 设置活跃插件失败:', err)
      return false
    }
  }

  /** 调用插件方法 */
  async function callPluginMethod(pluginId: string, methodName: string, ...args: any[]): Promise<any> {
    try {
      const result = await window.api.plugins.call(pluginId, methodName, ...args)
      if (result.success) {
        return result.result
      }
      throw new Error(result.error || '调用失败')
    } catch (err: any) {
      console.error(`[PluginStore] 调用插件方法 ${methodName} 失败:`, err)
      throw err
    }
  }

  /** 检查插件更新 */
  async function checkPluginUpdate(pluginId: string): Promise<any> {
    try {
      const result = await window.api.plugins.checkUpdate(pluginId)
      return result.success ? result.result : null
    } catch (err: any) {
      console.error('[PluginStore] 检查更新失败:', err)
      return null
    }
  }

  /** 刷新插件列表 */
  async function refreshPluginList(): Promise<void> {
    try {
      const result = await window.api.plugins.list()
      if (result.success && result.plugins) {
        plugins.value = result.plugins.map((p: any) => ({
          ...p,
          isActive: plugins.value.find((ep) => ep.id === p.id)?.isActive || false
        }))
      }
    } catch (err: any) {
      console.error('[PluginStore] 刷新插件列表失败:', err)
    }
  }

  /** 选择插件文件并加载 */
  async function selectAndLoadPlugin(): Promise<boolean> {
    const result = await window.api.plugins.selectFile()
    if (result.success && result.filePath) {
      return loadPlugin(result.filePath)
    }
    return false
  }

  /** 规范化歌曲数据：支持传入文件路径字符串或完整的曲目对象 */
  function normalizeTracks(tracks: any[]): any[] {
    return tracks.map((track: any, index: number) => {
      // 如果是纯字符串，视为文件路径
      if (typeof track === 'string') {
        const { title, artist } = parseFileName(track)
        return {
          id: `plg-${Date.now()}-${index}`,
          title,
          artist,
          filePath: track
        }
      }
      // 如果有 filePath 但缺少标题，从文件名解析
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

  /** 从文件路径解析歌曲名和歌手 */
  function parseFileName(filePath: string): { title: string; artist: string } {
    // 提取文件名（去掉扩展名）
    const fileName = filePath.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '')
    // 尝试 "歌手 - 歌曲名" 格式
    const match = fileName.match(/^(.+?)\s*[-–—]\s*(.+)$/)
    if (match) {
      return { artist: match[1].trim(), title: match[2].trim() }
    }
    return { title: fileName, artist: '未知歌手' }
  }

  // ========== 初始化事件监听 ==========

  // 事件监听只初始化一次，避免重复注册 IPC 处理器
  let listenersInitialized = false

  function initListeners(): void {
    if (listenersInitialized) return
    listenersInitialized = true

    // 监听插件通知
    window.api.plugins.onNotice((data: any) => {
      if (data.type === 'loaded') {
        notification.value = {
          type: 'success',
          message: `插件 "${data.pluginName}" v${data.version} 已加载`
        }
      } else if (data.type === 'removed') {
        notification.value = {
          type: 'info',
          message: `插件已移除`
        }
        plugins.value = plugins.value.filter((p) => p.id !== data.pluginId)
      } else if (data.type === 'error') {
        notification.value = {
          type: 'error',
          message: data.message || '插件错误'
        }
      }
    })

    // 监听敏感操作确认请求
    window.api.plugins.onConfirmRequest((request: any) => {
      pendingConfirm.value = request
    })

    // 监听批量敏感操作确认请求
    window.api.plugins.onBatchConfirmRequest((request: any) => {
      pendingBatchConfirm.value = request
    })

    // 监听歌单操作请求
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

  /** 响应敏感操作确认 */
  async function respondConfirm(confirmed: boolean, skipSession = false): Promise<void> {
    if (!pendingConfirm.value) return
    await window.api.plugins.respondConfirm({
      requestId: pendingConfirm.value.requestId,
      confirmed,
      skipSession
    })
    pendingConfirm.value = null
  }

  /** 响应批量敏感操作确认 */
  async function respondBatchConfirm(confirmed: boolean, rejectedOpIds: string[] = [], skipSession = false): Promise<void> {
    if (!pendingBatchConfirm.value) return
    await window.api.plugins.respondBatchConfirm({
      requestId: pendingBatchConfirm.value.requestId,
      confirmed,
      rejectedOpIds,
      skipSession
    })
    pendingBatchConfirm.value = null
  }

  /** 清除通知 */
  function clearNotification(): void {
    notification.value = null
  }

  return {
    // 状态
    plugins,
    loading,
    notification,
    pendingConfirm,
    pendingBatchConfirm,
    // 计算
    activePlugin,
    loadedPlugins,
    // 方法
    loadPlugin,
    removePlugin,
    setActivePlugin,
    callPluginMethod,
    checkPluginUpdate,
    refreshPluginList,
    selectAndLoadPlugin,
    initListeners,
    respondConfirm,
    respondBatchConfirm,
    clearNotification
  }
})
