/**
 * 插件管理 IPC 处理器
 * 注册所有插件相关的 IPC 通道
 */
import { ipcMain, BrowserWindow, dialog } from 'electron'
import { readFileSync } from 'fs'
import {
  getPluginConfig,
  savePluginConfig,
  addPluginPaths,
  removePluginPath
} from '../services/pluginConfig'
import { SuchMusicPluginHost, parsePluginFromCode, resolvePlaylistOpResponse } from '../../plugin/manager/SuchMusicPluginHost'
import type { SuchPluginManifest } from '../../plugin/types'

/** 已加载的插件宿主映射: pluginId → SuchMusicPluginHost */
const loadedPlugins = new Map<string, SuchMusicPluginHost>()

/** 主窗口引用 */
let mainWindow: BrowserWindow | null = null

// ==================== 工具函数 ====================

/**
 * 从文件路径加载插件代码
 */
function loadPluginCode(filePath: string): string {
  return readFileSync(filePath, 'utf-8')
}

/**
 * 发送插件通知到渲染进程
 */
function sendPluginNotice(type: string, data: any): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('plugin:notice', { type, ...data })
  }
}

/**
 * 加载单个插件（内部复用）
 */
async function doLoadPlugin(filePath: string): Promise<{ success: boolean; error?: string }> {
  const code = loadPluginCode(filePath)

  // 第一次解析：获取元数据
  const manifest = parsePluginFromCode(code)
  if (!manifest) {
    return { success: false, error: '无法解析插件：请确保插件正确设置了 window.source' }
  }

  // 创建宿主
  const host = new SuchMusicPluginHost(manifest, filePath, mainWindow)
  loadedPlugins.set(manifest.id, host)

  const suchmusicAPI = host.buildSuchmusicAPI()
  const sandboxWindow = host.buildSandboxWindow()

  const fullSandboxWindow = {
    source: undefined,
    notify: sandboxWindow.notify,
    console: sandboxWindow.console
  }

  // 第二次解析：注入 suchmusic
  const fullManifest = parsePluginFromCode(code, { suchmusic: suchmusicAPI }, fullSandboxWindow)
  if (!fullManifest) {
    loadedPlugins.delete(manifest.id)
    return { success: false, error: '无法重新解析插件（suchmusic 注入失败）' }
  }

  // 替换方法
  for (const key of Object.keys(fullManifest)) {
    if (typeof fullManifest[key] === 'function') {
      ;(host.instance as any)[key] = fullManifest[key]
    }
  }

  // 初始化
  try {
    await host.initialize()
  } catch (initErr: any) {
    loadedPlugins.delete(manifest.id)
    return { success: false, error: `插件初始化失败: ${initErr.message}` }
  }

  console.log(`[Plugin Manager] 插件 "${manifest.name}" 加载成功`)
  return { success: true }
}

/**
 * 加载所有已保存的插件
 */
export async function loadAllSavedPlugins(): Promise<void> {
  const config = await getPluginConfig()
  for (const pluginPath of config.pluginPaths) {
    try {
      await doLoadPlugin(pluginPath)
    } catch (err: any) {
      console.error(`[Plugin Manager] 自动加载插件失败: ${pluginPath}`, err.message)
    }
  }
  console.log(`[Plugin Manager] 已自动加载 ${loadedPlugins.size} 个插件`)
}

// ==================== 注册处理器 ====================

export function registerPluginHandlers(window: BrowserWindow | null): void {
  mainWindow = window

  // ========== 加载插件 ==========
  ipcMain.handle('plugin:load', async (_event, filePath: string) => {
    try {
      const result = await doLoadPlugin(filePath)
      if (!result.success) {
        return result
      }

      // 保存到配置
      await addPluginPaths([filePath])

      // 查找刚加载的 plugin
      let loadedHost: SuchMusicPluginHost | undefined
      for (const h of loadedPlugins.values()) {
        if (h.instance.filePath === filePath) {
          loadedHost = h
          break
        }
      }
      if (!loadedHost) {
        return { success: false, error: '加载后无法找到插件' }
      }

      sendPluginNotice('loaded', {
        pluginId: loadedHost.manifest.id,
        pluginName: loadedHost.manifest.name,
        version: loadedHost.manifest.version
      })

      return {
        success: true,
        manifest: {
          id: loadedHost.manifest.id,
          name: loadedHost.manifest.name,
          version: loadedHost.manifest.version,
          author: loadedHost.manifest.author,
          description: loadedHost.manifest.description,
          icon: loadedHost.manifest.icon,
          isUIWidget: loadedHost.manifest.isUIWidget,
          permissions: loadedHost.manifest.permissions,
          uiSchema: loadedHost.manifest.uiSchema
        },
        state: loadedHost.instance.state
      }
    } catch (err: any) {
      console.error('[Plugin Manager] 加载插件失败:', err)
      return { success: false, error: err.message }
    }
  })

  // ========== 移除插件 ==========
  ipcMain.handle('plugin:remove', async (_event, pluginId: string) => {
    try {
      const host = loadedPlugins.get(pluginId)
      const filePath = host ? host.instance.filePath : ''
      if (host) {
        host.unload()
        loadedPlugins.delete(pluginId)
      }

      if (filePath) {
        await removePluginPath(filePath)
      }

      sendPluginNotice('removed', { pluginId })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 设置活跃插件 ==========
  ipcMain.handle('plugin:set-active', async (_event, pluginId: string | null) => {
    try {
      const config = await getPluginConfig()
      config.activePluginPath = pluginId
      await savePluginConfig(config)

      sendPluginNotice('active-changed', { pluginId })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 调用插件方法 ==========
  ipcMain.handle('plugin:call', async (_event, pluginId: string, methodName: string, ...args: any[]) => {
    try {
      const host = loadedPlugins.get(pluginId)
      if (!host) {
        return { success: false, error: `插件 "${pluginId}" 未加载` }
      }

      const result = await host.callMethod(methodName, ...args)
      return { success: true, result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 检查插件更新 ==========
  ipcMain.handle('plugin:check-update', async (_event, pluginId: string) => {
    try {
      const host = loadedPlugins.get(pluginId)
      if (!host) {
        return { success: false, error: `插件 "${pluginId}" 未加载` }
      }

      // 检查插件是否实现了 checkUpdate 方法
      if (typeof (host.instance as any).checkUpdate === 'function') {
        const result = await host.callMethod('checkUpdate')
        return { success: true, result }
      }

      return { success: true, result: { hasNew: false, version: '', url: '', changelog: '' } }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 获取已加载插件列表 ==========
  ipcMain.handle('plugin:list', async () => {
    const plugins: SuchPluginManifest[] = []
    for (const host of loadedPlugins.values()) {
      plugins.push({
        id: host.manifest.id,
        name: host.manifest.name,
        version: host.manifest.version,
        author: host.manifest.author,
        description: host.manifest.description,
        icon: host.manifest.icon,
        isUIWidget: host.manifest.isUIWidget,
        permissions: host.manifest.permissions,
        uiSchema: host.manifest.uiSchema,
        state: host.instance.state
      })
    }
    return { success: true, plugins }
  })

  // ========== 选择插件文件 ==========
  ipcMain.handle('plugin:select-file', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { success: false, error: '无可用窗口' }
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择插件文件',
      filters: [
        { name: '插件文件', extensions: ['ts', 'js'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }

    return { success: true, filePath: result.filePaths[0] }
  })

  // ========== 选择目录 ==========
  ipcMain.handle('plugin:select-directory', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { success: false, error: '无可用窗口' }
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择目录',
      properties: ['openDirectory']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }

    return { success: true, filePath: result.filePaths[0] }
  })

  // ========== 歌单操作响应 ==========
  ipcMain.handle('plugin:playlist-op-response', (_event, response) => {
    resolvePlaylistOpResponse(response)
  })

  console.log('[Plugin Manager] IPC 处理器已注册')
}

/**
 * 获取已加载的插件宿主
 */
export function getLoadedPlugins(): Map<string, SuchMusicPluginHost> {
  return loadedPlugins
}

/**
 * 更新主窗口引用
 */
export function updateMainWindow(window: BrowserWindow | null): void {
  mainWindow = window
  for (const host of loadedPlugins.values()) {
    host.setMainWindow(window)
  }
}
