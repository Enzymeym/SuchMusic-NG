import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  Plugin,
  PluginSource,
  PluginImportResult,
  PluginValidationResult
} from '../types/plugin'

/**
 * 插件状态管理 Store
 * 管理插件的发现、安装、配置和激活
 * @author SuchMusic Plugin System
 */
export const usePluginStore = defineStore('plugin', () => {
  // ============ State ============

  /** 已安装的插件列表 */
  const installedPlugins = ref<Plugin[]>([])

  /** 当前激活的插件ID */
  const activePluginId = ref<string | null>(null)

  /** 加载状态 */
  const loading = ref(false)

  /** 错误信息 */
  const error = ref<string | null>(null)

  // ============ Getters ============

  /**
   * 获取当前激活的插件
   */
  const activePlugin = computed(() => {
    return installedPlugins.value.find(p => p.id === activePluginId.value) || null
  })

  /**
   * 获取所有已激活的插件
   */
  const activePlugins = computed(() => {
    return installedPlugins.value.filter(p => p.status === 'active')
  })

  /**
   * 获取未初始化的插件
   */
  const uninitializedPlugins = computed(() => {
    return installedPlugins.value.filter(p => p.status === 'uninitialized')
  })

  /**
   * 获取所有支持的音源
   */
  const allSources = computed(() => {
    const sources: PluginSource[] = []
    const sourceMap = new Map<string, PluginSource>()

    installedPlugins.value.forEach(plugin => {
      plugin.sources.forEach(source => {
        if (!sourceMap.has(source.id)) {
          sourceMap.set(source.id, source)
          sources.push(source)
        }
      })
    })

    return sources
  })

  // ============ Actions ============

  /**
   * 从本地文件导入插件
   * @returns 导入结果
   */
  const importPluginFromFile = async (): Promise<PluginImportResult> => {
    try {
      const result = await window.electron.ipcRenderer.invoke('plugin:import:file')

      if (result.canceled) {
        return { canceled: true }
      }

      if (result.error) {
        return { error: result.error }
      }

      if (result.plugin) {
        // 检查是否已存在
        const existingIndex = installedPlugins.value.findIndex(p => p.id === result.plugin.id)
        if (existingIndex >= 0) {
          installedPlugins.value[existingIndex] = result.plugin
        } else {
          installedPlugins.value.push(result.plugin)
        }
        return { plugin: result.plugin }
      }

      return { error: '未知错误' }
    } catch (err: any) {
      return { error: err.message || '导入插件失败' }
    }
  }

  /**
   * 从 URL 导入插件
   * @param url 插件 URL
   * @returns 导入结果
   */
  const importPluginFromUrl = async (url: string): Promise<PluginImportResult> => {
    try {
      const result = await window.electron.ipcRenderer.invoke('plugin:import:url', url)

      if (result.error) {
        return { error: result.error }
      }

      if (result.plugin) {
        // 检查是否已存在
        const existingIndex = installedPlugins.value.findIndex(p => p.id === result.plugin.id)
        if (existingIndex >= 0) {
          installedPlugins.value[existingIndex] = result.plugin
        } else {
          installedPlugins.value.push(result.plugin)
        }
        return { plugin: result.plugin }
      }

      return { error: '未知错误' }
    } catch (err: any) {
      return { error: err.message || '从 URL 导入插件失败' }
    }
  }

  /**
   * 验证插件
   * @param pluginId 插件ID
   * @param code 插件代码
   * @returns 验证结果
   */
  const validatePlugin = async (
    pluginId: string,
    code: string
  ): Promise<PluginValidationResult> => {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'plugin:validate',
        pluginId,
        code
      )
      return result
    } catch (err: any) {
      return { valid: false, error: err.message || '验证失败' }
    }
  }

  /**
   * 保存插件配置
   * @param pluginId 插件ID
   * @param config 配置对象
   */
  const savePluginConfig = async (
    pluginId: string,
    config: Record<string, any>
  ): Promise<void> => {
    try {
      await window.electron.ipcRenderer.invoke(
        'plugin:config:save',
        pluginId,
        config
      )

      // 更新本地状态
      const plugin = installedPlugins.value.find(p => p.id === pluginId)
      if (plugin) {
        plugin.config = { ...config }
      }
    } catch (err: any) {
      throw new Error(err.message || '保存配置失败')
    }
  }

  /**
   * 获取插件配置
   * @param pluginId 插件ID
   * @returns 配置对象
   */
  const getPluginConfig = async (pluginId: string): Promise<Record<string, any>> => {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'plugin:config:get',
        pluginId
      )
      return result.config || {}
    } catch (err: any) {
      throw new Error(err.message || '获取配置失败')
    }
  }

  /**
   * 激活插件
   * @param pluginId 插件ID
   */
  const activatePlugin = async (pluginId: string): Promise<void> => {
    try {
      await window.electron.ipcRenderer.invoke('plugin:activate', pluginId)

      // 更新本地状态
      const plugin = installedPlugins.value.find(p => p.id === pluginId)
      if (plugin) {
        plugin.status = 'active'
      }

      // 设置为当前激活插件
      activePluginId.value = pluginId
    } catch (err: any) {
      throw new Error(err.message || '激活插件失败')
    }
  }

  /**
   * 停用插件
   * @param pluginId 插件ID
   */
  const deactivatePlugin = async (pluginId: string): Promise<void> => {
    try {
      await window.electron.ipcRenderer.invoke('plugin:deactivate', pluginId)

      // 更新本地状态
      const plugin = installedPlugins.value.find(p => p.id === pluginId)
      if (plugin) {
        plugin.status = 'inactive'
      }

      // 如果当前激活的是此插件，清空激活状态
      if (activePluginId.value === pluginId) {
        activePluginId.value = null
      }
    } catch (err: any) {
      throw new Error(err.message || '停用插件失败')
    }
  }

  /**
   * 卸载插件
   * @param pluginId 插件ID
   */
  const uninstallPlugin = async (pluginId: string): Promise<void> => {
    try {
      await window.electron.ipcRenderer.invoke('plugin:uninstall', pluginId)

      // 从本地状态中移除
      const index = installedPlugins.value.findIndex(p => p.id === pluginId)
      if (index >= 0) {
        installedPlugins.value.splice(index, 1)
      }

      // 如果当前激活的是此插件，清空激活状态
      if (activePluginId.value === pluginId) {
        activePluginId.value = null
      }
    } catch (err: any) {
      throw new Error(err.message || '卸载插件失败')
    }
  }

  /**
   * 根据ID获取插件
   * @param pluginId 插件ID
   * @returns 插件对象
   */
  const getPluginById = async (pluginId: string): Promise<Plugin | null> => {
    // 先检查本地状态
    const localPlugin = installedPlugins.value.find(p => p.id === pluginId)
    if (localPlugin) {
      return localPlugin
    }

    // 从主进程获取
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'plugin:get',
        pluginId
      )

      if (result.plugin) {
        installedPlugins.value.push(result.plugin)
        return result.plugin
      }

      return null
    } catch (err: any) {
      throw new Error(err.message || '获取插件失败')
    }
  }

  /**
   * 获取未初始化的插件列表
   * @returns 插件列表
   */
  const getUninitializedPlugins = async (): Promise<Plugin[]> => {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'plugin:list:uninitialized'
      )

      return result.plugins || []
    } catch (err: any) {
      throw new Error(err.message || '获取未初始化插件列表失败')
    }
  }

  /**
   * 加载所有插件
   */
  const loadAllPlugins = async (): Promise<void> => {
    loading.value = true
    error.value = null

    try {
      const result = await window.electron.ipcRenderer.invoke('plugin:list:all')

      if (result.plugins) {
        installedPlugins.value = result.plugins
      }

      if (result.activePluginId) {
        activePluginId.value = result.activePluginId
      }
    } catch (err: any) {
      error.value = err.message || '加载插件列表失败'
    } finally {
      loading.value = false
    }
  }

  /**
   * 调用插件方法
   * @param pluginId 插件ID
   * @param method 方法名
   * @param args 参数
   * @returns 调用结果
   */
  const callPluginMethod = async (
    pluginId: string,
    method: string,
    ...args: any[]
  ): Promise<any> => {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'plugin:call',
        pluginId,
        method,
        ...args
      )
      return result
    } catch (err: any) {
      throw new Error(err.message || '调用插件方法失败')
    }
  }

  /**
   * 获取音乐URL
   * @param source 音源ID
   * @param musicInfo 音乐信息
   * @param quality 音质
   * @returns 音乐URL
   */
  const getMusicUrl = async (
    source: string,
    musicInfo: any,
    quality: string
  ): Promise<string> => {
    try {
      // 优先使用当前激活的插件
      if (activePluginId.value) {
        const result = await callPluginMethod(
          activePluginId.value,
          'musicUrl',
          source,
          musicInfo,
          quality
        )
        if (result?.url) {
          return result.url
        }
      }

      // 尝试所有激活的插件
      for (const plugin of activePlugins.value) {
        const sourceExists = plugin.sources.some(s => s.id === source)
        if (sourceExists) {
          const result = await callPluginMethod(
            plugin.id,
            'musicUrl',
            source,
            musicInfo,
            quality
          )
          if (result?.url) {
            return result.url
          }
        }
      }

      throw new Error('无法获取音乐链接')
    } catch (err: any) {
      throw new Error(err.message || '获取音乐链接失败')
    }
  }

  return {
    // State
    installedPlugins,
    activePluginId,
    loading,
    error,

    // Getters
    activePlugin,
    activePlugins,
    uninitializedPlugins,
    allSources,

    // Actions
    importPluginFromFile,
    importPluginFromUrl,
    validatePlugin,
    savePluginConfig,
    getPluginConfig,
    activatePlugin,
    deactivatePlugin,
    uninstallPlugin,
    getPluginById,
    getUninitializedPlugins,
    loadAllPlugins,
    callPluginMethod,
    getMusicUrl
  }
})
