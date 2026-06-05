import axios from 'axios'
import fs from 'fs/promises'
import { pluginLog } from '../logger'
import { getMainWindow } from '../../main/windows/mainWindow'
import { getPluginConfig } from '../../main/services/pluginConfig'

// 记录在当前应用生命周期中已经提示过更新的插件版本，格式为 "pluginName@version"
const notifiedUpdates = new Set<string>()

/**
 * 通过 IPC 将更新通知发送到渲染进程
 * 渲染进程使用 NaiveUI Notification 组件展示通知及操作按钮
 *
 * @param pluginName 插件名称
 * @param data 更新数据（version、content、url）
 */
export function sendUpdateNotificationToRenderer(
  pluginName: string,
  data: any
): void {
  const version = data.version || 'unknown'
  const updateKey = `${pluginName}@${version}`

  if (notifiedUpdates.has(updateKey)) {
    pluginLog.info(`[PluginNotifier] Update for ${updateKey} already notified. Skipping.`)
    return
  }

  notifiedUpdates.add(updateKey)

  const win = getMainWindow()
  if (win) {
    win.webContents.send('plugin:notice', {
      pluginName,
      type: 'update',
      data: {
        version,
        content: data.content || data.log || data.title || '发现新版本可用',
        url: data.url
      }
    })
    pluginLog.info(`[PluginNotifier] Sent update notification IPC for ${pluginName}`)
  }
}

/**
 * 执行插件热更新：下载最新 JS 文件并覆盖本地文件
 *
 * @param pluginName 插件名称
 * @param updateUrl 更新下载地址
 */
export async function executeHotUpdate(
  pluginName: string,
  updateUrl: string
): Promise<void> {
  pluginLog.info(`[PluginNotifier] Starting hot update for ${pluginName} from ${updateUrl}`)

  const config = await getPluginConfig()
  const activePath = config.activePluginPath

  if (!activePath) {
    pluginLog.warn('[PluginNotifier] Cannot hot update: No active plugin path found.')
    return
  }

  const response = await axios.get(updateUrl, {
    responseType: 'text',
    timeout: 30000,
    headers: {
      'User-Agent': 'SuchMusic/HotUpdate'
    }
  })

  if (response.status !== 200 || !response.data) {
    throw new Error(`Invalid response from update URL: HTTP ${response.status}`)
  }

  await fs.writeFile(activePath, response.data, 'utf-8')
  pluginLog.info(`[PluginNotifier] Successfully hot updated plugin ${pluginName}`)

  const win = getMainWindow()
  if (win) {
    win.webContents.send('plugin:hot-updated', { pluginName, path: activePath })
  }
}
