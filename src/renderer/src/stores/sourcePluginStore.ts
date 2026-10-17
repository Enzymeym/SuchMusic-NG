/**
 * 音源插件 Store（洛雪 LX / 澜音 Ceru）
 * 负责音源插件的加载、启停、移除与通知监听。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface SourceCapability {
  key: string
  name: string
  actions: string[]
  qualities: string[]
}

export interface SourcePluginSettings {
  /** 启用的音乐源（null / undefined 表示全部启用） */
  sources?: string[] | null
  /** 该插件的首选音质（null 表示跟随全局） */
  quality?: string | null
}

export interface SourcePluginInfo {
  id: string
  kind: 'lx' | 'ceru'
  name: string
  version: string
  author?: string
  description?: string
  homepage?: string
  filePath: string
  enabled: boolean
  state: 'loaded' | 'running' | 'error' | 'disabled'
  capabilities: {
    sources: SourceCapability[]
    providers?: { id: string; name: string; protocols: string[]; qualities: string[] }[]
    canSearch: boolean
    canBrowsePlaylist: boolean
  }
  settings?: SourcePluginSettings
  updateAlert?: { log?: string; updateUrl?: string }
  error?: string
}

export const useSourcePluginStore = defineStore('sourcePlugin', () => {
  const plugins = ref<SourcePluginInfo[]>([])
  const loading = ref(false)
  const notification = ref<{ type: string; message: string } | null>(null)

  /** 刷新插件列表 */
  async function refresh(): Promise<void> {
    try {
      const res = await window.api.sources.list()
      if (res.success && res.plugins) {
        plugins.value = res.plugins as SourcePluginInfo[]
      }
    } catch (err) {
      console.error('[SourcePluginStore] 刷新列表失败:', err)
    }
  }

  /** 从文件加载插件 */
  async function loadFromFile(filePath: string): Promise<boolean> {
    loading.value = true
    try {
      const res = await window.api.sources.load(filePath)
      if (res.success && res.info) {
        const idx = plugins.value.findIndex((p) => p.id === res.info.id)
        if (idx >= 0) plugins.value[idx] = res.info
        else plugins.value.push(res.info)
        return true
      }
      notification.value = { type: 'error', message: res.error || '加载失败' }
      return false
    } catch (err: any) {
      console.error('[SourcePluginStore] 加载失败:', err)
      notification.value = { type: 'error', message: err.message }
      return false
    } finally {
      loading.value = false
    }
  }

  /** 选择文件并加载 */
  async function selectAndLoad(): Promise<{ ok: boolean; canceled?: boolean }> {
    const picked = await window.api.sources.selectFile()
    if (!picked.success || !picked.filePath) {
      return { ok: false, canceled: !!picked.canceled }
    }
    const ok = await loadFromFile(picked.filePath)
    return { ok }
  }

  /** 移除插件 */
  async function remove(pluginId: string): Promise<boolean> {
    try {
      const res = await window.api.sources.remove(pluginId)
      if (res.success) {
        plugins.value = plugins.value.filter((p) => p.id !== pluginId)
        return true
      }
      return false
    } catch (err) {
      console.error('[SourcePluginStore] 移除失败:', err)
      return false
    }
  }

  /** 启用 / 停用 */
  async function setEnabled(pluginId: string, enabled: boolean): Promise<boolean> {
    try {
      const res = await window.api.sources.setEnabled(pluginId, enabled)
      if (res.success && res.info) {
        const idx = plugins.value.findIndex((p) => p.id === pluginId)
        if (idx >= 0) plugins.value[idx] = res.info
        return true
      }
      notification.value = { type: 'error', message: res.error || '操作失败' }
      return false
    } catch (err: any) {
      console.error('[SourcePluginStore] 启停失败:', err)
      notification.value = { type: 'error', message: err.message }
      return false
    }
  }

  /** 清空通知 */
  function clearNotification(): void {
    notification.value = null
  }

  /**
   * 更新单个插件的偏好（音乐源开关 / 音质）。
   * 偏好保存在主进程配置里，每个插件互不影响。
   */
  async function setPreferences(pluginId: string, patch: SourcePluginSettings): Promise<boolean> {
    try {
      const res = await window.api.sources.setPreferences(pluginId, patch)
      if (!res.success) {
        notification.value = { type: 'error', message: res.error || '保存设置失败' }
        return false
      }
      const idx = plugins.value.findIndex((p) => p.id === pluginId)
      if (idx >= 0) {
        plugins.value[idx] = {
          ...plugins.value[idx],
          ...(res.info ?? {}),
          settings: res.settings ?? res.info?.settings ?? plugins.value[idx].settings
        }
      }
      return true
    } catch (err: any) {
      console.error('[SourcePluginStore] 保存偏好失败:', err)
      notification.value = { type: 'error', message: err?.message || '保存设置失败' }
      return false
    }
  }

  // 事件监听只初始化一次
  let listenersInitialized = false
  function initListeners(): void {
    if (listenersInitialized) return
    listenersInitialized = true

    window.api.sources.onNotice((data: any) => {
      if (data.type === 'loaded') {
        notification.value = {
          type: 'success',
          message: `音源插件 "${data.pluginName}" v${data.version} 已加载`
        }
        refresh()
      } else if (
        data.type === 'removed' ||
        data.type === 'enabled' ||
        data.type === 'disabled' ||
        data.type === 'settings'
      ) {
        refresh()
      } else if (data.type === 'error') {
        notification.value = { type: 'error', message: data.message || '音源插件错误' }
        refresh()
      } else if (data.type === 'updateAlert') {
        // 更新提示：刷新列表以展示 updateAlert；同时弹一条提示
        refresh()
        notification.value = { type: 'info', message: data.log || '音源插件有新版本' }
      }
    })
  }

  return {
    plugins,
    loading,
    notification,
    refresh,
    loadFromFile,
    selectAndLoad,
    remove,
    setEnabled,
    setPreferences,
    initListeners,
    clearNotification
  }
})
