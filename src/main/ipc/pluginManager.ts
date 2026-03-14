import { ipcMain, dialog, app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import axios from 'axios'
import SuchMusicPluginHost from '../../plugin/manager/SuchMusicPluginHost'
import Logger from '../../plugin/logger'
import {
  transformSnowdropPlugin
} from '../../plugin/utils/snowdrop-transform'
import type { Plugin, PluginInfo, PluginSource, PluginConfigItem } from '../../renderer/src/types/plugin'

/**
 * 插件管理器 IPC 处理器
 * 处理插件的导入、验证、配置和激活
 * @author SuchMusic Plugin System
 */

// 插件存储目录
const getPluginsDir = () => path.join(app.getPath('userData'), 'plugins')

// 插件配置存储目录
const getPluginConfigDir = () => path.join(app.getPath('userData'), 'plugin-configs')

// 已加载的插件实例缓存
const pluginInstances = new Map<string, SuchMusicPluginHost>()

/**
 * 生成插件ID
 */
const generatePluginId = (): string => {
  return crypto.randomUUID().replace(/-/g, '')
}

/**
 * 保存插件文件
 */
const savePluginFile = async (pluginId: string, code: string): Promise<string> => {
  const pluginsDir = getPluginsDir()
  await fs.mkdir(pluginsDir, { recursive: true })

  const filePath = path.join(pluginsDir, `${pluginId}.js`)
  await fs.writeFile(filePath, code, 'utf-8')

  return filePath
}

/**
 * 加载插件代码
 */
const loadPluginCode = async (pluginId: string): Promise<string> => {
  const filePath = path.join(getPluginsDir(), `${pluginId}.js`)
  return await fs.readFile(filePath, 'utf-8')
}

/**
 * 解析插件信息
 */
const parsePlugin = (code: string): {
  info: PluginInfo
  sources: PluginSource[]
  configUI: PluginConfigItem[]
} => {
  const host = new SuchMusicPluginHost(code)

  const rawInfo = host.getPluginInfo()
  // 只提取可序列化的字段
  const info: PluginInfo = {
    name: rawInfo.name,
    version: rawInfo.version,
    author: rawInfo.author,
    description: rawInfo.description,
    homepage: rawInfo.homepage
  }
  
  // 获取音源信息，支持对象格式 { kw: {...}, wy: {...} } 或数组格式
  const rawSources = host.getSupportedSources()
  let sources: PluginSource[] = []
  
  if (Array.isArray(rawSources)) {
    // 如果是数组格式
    sources = rawSources.map((s: any) => ({
      id: s.id || s.name,
      name: s.name,
      qualities: s.qualities || []
    }))
  } else if (typeof rawSources === 'object' && rawSources !== null) {
    // 如果是对象格式 { kw: {...}, wy: {...} }
    sources = Object.entries(rawSources).map(([id, s]: [string, any]) => ({
      id,
      name: s.name || id,
      qualities: s.qualities || s.qualitys || []
    }))
  }

  // 尝试获取 configUI（如果插件有导出）
  let configUI: PluginConfigItem[] = []
  try {
    // 创建沙箱环境执行插件代码获取 configUI
    const sandbox: any = {
      module: { exports: {} },
      suchmusic: {},
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Buffer,
      JSON,
      require: () => ({}),
      process: { env: {} }
    }
    sandbox.global = sandbox
    sandbox.globalThis = sandbox

    const vm = require('vm')
    vm.createContext(sandbox)
    vm.runInContext(code, sandbox)

    const exports = sandbox.module.exports
    if (exports.configUI && Array.isArray(exports.configUI)) {
      // 深拷贝 configUI 以确保可序列化
      configUI = JSON.parse(JSON.stringify(exports.configUI))
    }
  } catch (e) {
    // 插件可能没有 configUI，忽略错误
  }

  return { info, sources, configUI }
}

/**
 * 保存插件配置
 */
const savePluginConfigToFile = async (
  pluginId: string,
  config: Record<string, any>
): Promise<void> => {
  const configDir = getPluginConfigDir()
  await fs.mkdir(configDir, { recursive: true })

  const configPath = path.join(configDir, `${pluginId}.json`)
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

/**
 * 加载插件配置
 */
const loadPluginConfigFromFile = async (
  pluginId: string
): Promise<Record<string, any>> => {
  try {
    const configPath = path.join(getPluginConfigDir(), `${pluginId}.json`)
    const data = await fs.readFile(configPath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return {}
  }
}

/**
 * 获取插件状态
 */
const getPluginStatus = async (pluginId: string): Promise<Plugin['status']> => {
  try {
    const config = await loadPluginConfigFromFile(pluginId)
    return config._status || 'uninitialized'
  } catch {
    return 'uninitialized'
  }
}

/**
 * 注册插件管理器 IPC 处理器
 */
export function registerPluginManagerHandlers(): void {

  /**
   * 从本地文件导入插件
   */
  ipcMain.handle('plugin:import:file', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '选择插件文件',
        filters: [
          { name: 'JavaScript 文件', extensions: ['js'] },
          { name: '所有文件', extensions: ['*'] }
        ],
        properties: ['openFile']
      })

      if (result.canceled || !result.filePaths.length) {
        return { canceled: true }
      }

      const filePath = result.filePaths[0]
      const code = await fs.readFile(filePath, 'utf-8')

      // 转换 LX 格式插件
      let processedCode = code
      if (code.toLowerCase().includes('lx') && !code.includes('module.exports')) {
        const transformResult = transformSnowdropPlugin(code, { sourceType: 'lx' })
        processedCode = transformResult.transformedCode
      }

      // 解析插件信息
      const { info, sources, configUI } = parsePlugin(processedCode)

      // 生成插件ID并保存
      const pluginId = generatePluginId()
      await savePluginFile(pluginId, processedCode)

      // 保存初始配置
      await savePluginConfigToFile(pluginId, {
        _status: 'uninitialized',
        _originalName: info.name
      })

      // 只返回可序列化的数据
      const plugin = {
        id: pluginId,
        info,
        sources,
        configUI,
        status: 'uninitialized'
      }

      return { plugin }
    } catch (error: any) {
      console.error('导入插件失败:', error)
      return { error: error.message || '导入插件失败' }
    }
  })

  /**
   * 从 URL 导入插件
   */
  ipcMain.handle('plugin:import:url', async (_event, url: string) => {
    try {
      const response = await axios.get(url, {
        timeout: 30000,
        responseType: 'text',
        headers: {
          'User-Agent': 'SuchMusic/PluginManager'
        }
      })

      if (response.status !== 200 || !response.data) {
        return { error: '下载插件失败' }
      }

      const code = response.data

      // 转换 LX 格式插件
      let processedCode = code
      if (code.toLowerCase().includes('lx') && !code.includes('module.exports')) {
        const transformResult = transformSnowdropPlugin(code, { sourceType: 'lx' })
        processedCode = transformResult.transformedCode
      }

      // 解析插件信息
      const { info, sources, configUI } = parsePlugin(processedCode)

      // 生成插件ID并保存
      const pluginId = generatePluginId()
      await savePluginFile(pluginId, processedCode)

      // 保存初始配置
      await savePluginConfigToFile(pluginId, {
        _status: 'uninitialized',
        _originalName: info.name
      })

      // 只返回可序列化的数据
      const plugin = {
        id: pluginId,
        info,
        sources,
        configUI,
        status: 'uninitialized'
      }

      return { plugin }
    } catch (error: any) {
      console.error('从 URL 导入插件失败:', error)
      return { error: error.message || '从 URL 导入插件失败' }
    }
  })

  /**
   * 验证插件
   */
  ipcMain.handle('plugin:validate', async (_event, _pluginId: string, code: string) => {
    try {
      const host = new SuchMusicPluginHost(code)
      const info = host.getPluginInfo()
      const rawSources = host.getSupportedSources()

      // 验证必需字段
      if (!info.name || !info.version || !info.author) {
        return {
          valid: false,
          error: '插件信息不完整，必须包含名称、版本和作者'
        }
      }

      // 处理音源格式（支持对象或数组）
      let sources: any[] = []
      if (Array.isArray(rawSources)) {
        sources = rawSources
      } else if (typeof rawSources === 'object' && rawSources !== null) {
        sources = Object.entries(rawSources).map(([id, s]: [string, any]) => ({
          id,
          name: s.name || id,
          qualities: s.qualities || s.qualitys || []
        }))
      }

      if (!sources || sources.length === 0) {
        return {
          valid: false,
          error: '插件未定义任何音源'
        }
      }

      return {
        valid: true,
        info,
        sources
      }
    } catch (error: any) {
      return {
        valid: false,
        error: error.message || '插件验证失败'
      }
    }
  })

  /**
   * 保存插件配置
   */
  ipcMain.handle('plugin:config:save', async (_event, pluginId: string, config: Record<string, any>) => {
    try {
      await savePluginConfigToFile(pluginId, config)
      return { success: true }
    } catch (error: any) {
      return { error: error.message || '保存配置失败' }
    }
  })

  /**
   * 获取插件配置
   */
  ipcMain.handle('plugin:config:get', async (_event, pluginId: string) => {
    try {
      const config = await loadPluginConfigFromFile(pluginId)
      return { config }
    } catch (error: any) {
      return { error: error.message || '获取配置失败' }
    }
  })

  /**
   * 激活插件
   */
  ipcMain.handle('plugin:activate', async (_event, pluginId: string) => {
    try {
      const code = await loadPluginCode(pluginId)
      const logger = new Logger(pluginId)

      const host = new SuchMusicPluginHost()
      await host.loadPlugin(code, logger)

      // 缓存插件实例
      pluginInstances.set(pluginId, host)

      // 更新配置状态
      const config = await loadPluginConfigFromFile(pluginId)
      config._status = 'active'
      await savePluginConfigToFile(pluginId, config)

      return { success: true }
    } catch (error: any) {
      return { error: error.message || '激活插件失败' }
    }
  })

  /**
   * 停用插件
   */
  ipcMain.handle('plugin:deactivate', async (_event, pluginId: string) => {
    try {
      // 移除插件实例
      pluginInstances.delete(pluginId)

      // 更新配置状态
      const config = await loadPluginConfigFromFile(pluginId)
      config._status = 'inactive'
      await savePluginConfigToFile(pluginId, config)

      return { success: true }
    } catch (error: any) {
      return { error: error.message || '停用插件失败' }
    }
  })

  /**
   * 卸载插件
   */
  ipcMain.handle('plugin:uninstall', async (_event, pluginId: string) => {
    try {
      // 移除插件实例
      pluginInstances.delete(pluginId)

      // 删除插件文件
      const pluginPath = path.join(getPluginsDir(), `${pluginId}.js`)
      try {
        await fs.unlink(pluginPath)
      } catch {
        // 文件可能不存在，忽略错误
      }

      // 删除配置文件
      const configPath = path.join(getPluginConfigDir(), `${pluginId}.json`)
      try {
        await fs.unlink(configPath)
      } catch {
        // 文件可能不存在，忽略错误
      }

      return { success: true }
    } catch (error: any) {
      return { error: error.message || '卸载插件失败' }
    }
  })

  /**
   * 获取单个插件
   */
  ipcMain.handle('plugin:get', async (_event, pluginId: string) => {
    try {
      const code = await loadPluginCode(pluginId)
      const { info, sources, configUI } = parsePlugin(code)
      const status = await getPluginStatus(pluginId)
      const config = await loadPluginConfigFromFile(pluginId)

      // 只返回可序列化的数据
      const plugin = {
        id: pluginId,
        info,
        sources,
        configUI,
        status,
        config
      }

      return { plugin }
    } catch (error: any) {
      return { error: error.message || '获取插件失败' }
    }
  })

  /**
   * 获取未初始化的插件列表
   */
  ipcMain.handle('plugin:list:uninitialized', async () => {
    try {
      const pluginsDir = getPluginsDir()
      await fs.mkdir(pluginsDir, { recursive: true })

      const files = await fs.readdir(pluginsDir)
      const plugins: any[] = []

      for (const file of files) {
        if (!file.endsWith('.js')) continue

        const pluginId = file.replace('.js', '')
        const status = await getPluginStatus(pluginId)

        if (status === 'uninitialized') {
          try {
            const code = await loadPluginCode(pluginId)
            const { info, sources, configUI } = parsePlugin(code)

            // 只返回可序列化的数据
            plugins.push({
              id: pluginId,
              info,
              sources,
              configUI,
              status
            })
          } catch (e) {
            console.error(`加载插件 ${pluginId} 失败:`, e)
          }
        }
      }

      return { plugins }
    } catch (error: any) {
      return { error: error.message || '获取未初始化插件列表失败' }
    }
  })

  /**
   * 获取所有插件
   */
  ipcMain.handle('plugin:list:all', async () => {
    try {
      const pluginsDir = getPluginsDir()
      await fs.mkdir(pluginsDir, { recursive: true })

      const files = await fs.readdir(pluginsDir)
      const plugins: any[] = []
      let activePluginId: string | null = null

      for (const file of files) {
        if (!file.endsWith('.js')) continue

        const pluginId = file.replace('.js', '')

        try {
          const code = await loadPluginCode(pluginId)
          const { info, sources, configUI } = parsePlugin(code)
          const status = await getPluginStatus(pluginId)
          const config = await loadPluginConfigFromFile(pluginId)

          if (status === 'active') {
            activePluginId = pluginId
          }

          // 只返回可序列化的数据
          plugins.push({
            id: pluginId,
            info,
            sources,
            configUI,
            status,
            config
          })
        } catch (e) {
          console.error(`加载插件 ${pluginId} 失败:`, e)
        }
      }

      return { plugins, activePluginId }
    } catch (error: any) {
      return { error: error.message || '获取插件列表失败' }
    }
  })

  /**
   * 调用插件方法
   */
  ipcMain.handle('plugin:call', async (_event, pluginId: string, method: string, ...args: any[]) => {
    try {
      let host = pluginInstances.get(pluginId)

      if (!host) {
        // 尝试加载插件
        const code = await loadPluginCode(pluginId)
        const logger = new Logger(pluginId)
        host = new SuchMusicPluginHost()
        await host.loadPlugin(code, logger)
        pluginInstances.set(pluginId, host)
      }

      // 调用方法
      let result: any
      switch (method) {
        case 'musicUrl':
          result = await host.getMusicUrl(args[0], args[1], args[2])
          break
        case 'getPic':
          result = await host.getPic(args[0], args[1])
          break
        case 'getLyric':
          result = await host.getLyric(args[0], args[1])
          break
        default:
          // 尝试调用自定义方法
          const plugin = host as any
          if (typeof plugin[method] === 'function') {
            result = await plugin[method](...args)
          } else {
            throw new Error(`插件方法 ${method} 不存在`)
          }
      }

      return { result: method === 'musicUrl' ? { url: result } : result }
    } catch (error: any) {
      return { error: error.message || '调用插件方法失败' }
    }
  })
}
