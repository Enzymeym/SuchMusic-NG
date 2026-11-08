/**
 * v2 插件管理面 IPC
 *
 * 通道前缀 `plugin:`。数据面（解析播放地址 / 搜索）走 `source:*`，
 * 由 `pluginSource.ts` + `pluginRouter` 统一处理，两者互不重叠。
 */
import { ipcMain, dialog } from 'electron'
import { readFileSync } from 'node:fs'
import { getMainWindow } from '../windows/mainWindow'
import { toSerializable } from '../services/pluginSource/serialize'
import { sourceRegistry } from '../services/pluginSource'
import { detectPluginKind } from '../services/pluginSource/detect'
import {
  checkPluginUpdate,
  getV2Registry,
  resolveV2Confirm,
  resolveV2PlaylistOp
} from '../services/pluginV2'
import type { BatchConfirmResponse, PlaylistOpResponse } from '../../plugin/types'

export function registerPluginV2Handlers(): void {
  // ========== 列表 ==========
  ipcMain.handle('plugin:list', async () => {
    try {
      return { success: true, plugins: toSerializable(getV2Registry().list()) }
    } catch (err: any) {
      return { success: false, error: err.message, plugins: [] }
    }
  })

  // ========== 选择插件文件 ==========
  ipcMain.handle('plugin:select-file', async () => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return { success: false, error: '无可用窗口' }
    const result = await dialog.showOpenDialog(win, {
      title: '选择插件文件',
      filters: [
        { name: '插件脚本', extensions: ['js', 'mjs'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }
    return { success: true, filePath: result.filePaths[0] }
  })

  // ========== 仅解析插件头（安装前预览） ==========
  ipcMain.handle('plugin:inspect', async (_event, filePath: string) => {
    try {
      const info = await getV2Registry().inspect(filePath)
      return { success: true, ...toSerializable(info) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 安装 / 更新 ==========
  ipcMain.handle('plugin:install', async (_event, filePath: string) => {
    try {
      const plugin = await getV2Registry().install(filePath)
      return { success: true, plugin: toSerializable(plugin) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  /**
   * 统一导入入口：自动识别 v2 / 洛雪 / 澜音，用户不需要先选「这是哪种插件」。
   */
  ipcMain.handle('plugin:import', async (_event, filePath: string) => {
    try {
      const code = readFileSync(filePath, 'utf-8')
      const kind = detectPluginKind(code)

      if (kind === 'such-v2') {
        const plugin = await getV2Registry().install(filePath)
        return { success: true, kind: 'v2', plugin: toSerializable(plugin) }
      }
      if (kind === 'lx' || kind === 'ceru') {
        const info = await sourceRegistry.loadFromFile(filePath)
        return { success: true, kind, info: toSerializable(info) }
      }
      if (kind === 'such') {
        return {
          success: false,
          error: '这是 v1 插件（window.source），新版插件系统已不再支持，请改用 v2 规范重写'
        }
      }
      return { success: false, error: '无法识别的插件文件（缺少 @name/@id/@version/@apiLevel 头）' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 移除 ==========
  ipcMain.handle('plugin:remove', async (_event, pluginId: string) => {
    try {
      await getV2Registry().remove(pluginId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 启用 / 停用 ==========
  ipcMain.handle('plugin:set-enabled', async (_event, pluginId: string, enabled: boolean) => {
    try {
      const plugin = await getV2Registry().setEnabled(pluginId, enabled)
      return { success: true, plugin: toSerializable(plugin) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 重新加载 ==========
  ipcMain.handle('plugin:reload', async (_event, pluginId: string) => {
    try {
      const plugin = await getV2Registry().reload(pluginId)
      return { success: true, plugin: toSerializable(plugin) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 设置 ==========
  ipcMain.handle('plugin:get-settings', async (_event, pluginId: string) => {
    try {
      const res = getV2Registry().getSettings(pluginId)
      return { success: true, schema: toSerializable(res.schema), values: toSerializable(res.values) }
    } catch (err: any) {
      return { success: false, error: err.message, schema: [], values: {} }
    }
  })

  ipcMain.handle('plugin:set-setting', async (_event, pluginId: string, key: string, value: unknown) => {
    try {
      const values = await getV2Registry().setSetting(pluginId, key, value)
      return { success: true, values: toSerializable(values) }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 日志 ==========
  ipcMain.handle('plugin:logs', async (_event, pluginId: string, limit?: number) => {
    try {
      return { success: true, entries: toSerializable(getV2Registry().logs(pluginId, limit)) }
    } catch (err: any) {
      return { success: false, error: err.message, entries: [] }
    }
  })

  ipcMain.handle('plugin:clear-logs', async (_event, pluginId: string) => {
    try {
      getV2Registry().clearLogs(pluginId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 检查更新 ==========
  ipcMain.handle('plugin:check-update', async (_event, pluginId: string) => {
    try {
      const result = await checkPluginUpdate(pluginId)
      return { success: true, result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ========== 确认响应 ==========
  ipcMain.handle('plugin:batch-confirm-response', (_event, response: BatchConfirmResponse) => {
    resolveV2Confirm(response)
  })

  ipcMain.handle('plugin:playlist-op-response', (_event, response: PlaylistOpResponse) => {
    resolveV2PlaylistOp(response)
  })

  console.log('[PluginV2] IPC 处理器已注册')
}
