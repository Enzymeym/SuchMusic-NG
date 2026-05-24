import { Notification as ElectronNotification, shell, app } from 'electron'
import axios from 'axios'
import fs from 'fs/promises'
import { pluginLog } from '../logger'
import { getMainWindow } from '../../main/windows/mainWindow'
import { getPluginConfig } from '../../main/services/pluginConfig'

// 记录在当前应用生命周期中已经提示过更新的插件版本，格式为 "pluginName@version"
const notifiedUpdates = new Set<string>()

export async function handlePluginUpdate(pluginName: string, updateData: any) {
  try {
    const version = updateData.version || 'unknown'
    const updateKey = `${pluginName}@${version}`

    // 检查是否已经提示过该版本的更新
    if (notifiedUpdates.has(updateKey)) {
      pluginLog.info(`[PluginNotifier] Update for ${updateKey} has already been notified. Skipping.`)
      return
    }

    notifiedUpdates.add(updateKey)

    const title = `插件更新: ${pluginName}`
    const body = updateData.content || updateData.title || '发现新版本可用'
    const updateUrl = updateData.url

    // 降级使用 Electron 默认的 Notification
    if (!ElectronNotification.isSupported()) {
      pluginLog.warn('[PluginNotifier] Notifications are not supported on this system.')
      return
    }

    const notificationOptions: Electron.NotificationConstructorOptions = {
      title,
      body,
    }

    if (process.platform === 'win32') {
      const appName = app.name || 'SuchMusic'
      // 在 Windows 上，即使使用 toastXml，也可以同时提供 actions 数组
      // 这能保证 Electron 内部正确解析 action 的 index 映射
      notificationOptions.actions = [
        { type: 'button', text: '立即更新' },
        { type: 'button', text: '忽略' }
      ]
      notificationOptions.toastXml = `
<toast launch="app-defined-string"> 
  <visual>
    <binding template="ToastGeneric"> 
      <text>${appName}</text>
      <text>${title}</text>
      <text>${body}</text>
    </binding>
  </visual>
  <actions>
    <action content="立即更新" arguments="update_now" activationType="background"/> 
    <action content="忽略" arguments="dismiss" activationType="background"/> 
  </actions>
</toast>`
    } else {
      notificationOptions.actions = [
        { type: 'button', text: '立即更新' },
        { type: 'button', text: '忽略' }
      ]
    }

    const notification = new ElectronNotification(notificationOptions)

    // Electron 的 Notification 对于 macOS 支持 actions 选项，对于 Windows 可以监听 action 事件
    notification.on('action', async (_event, index) => {
      pluginLog.info(`[PluginNotifier] User clicked action ${index} on update notification for ${pluginName}`)
      
      // index 通常是我们在 macOS 传入 actions 数组的索引。在 Windows 上，如果没有传入 actions 数组，index 可能对应 toastXml 中定义的顺序。
      // 我们在 toastXml 中定义了两个 action: 第一个是 立即更新，第二个是 忽略。所以 index 0 对应立即更新。
      if (index === 0) {
        if (!updateUrl) {
          pluginLog.warn('[PluginNotifier] No update URL provided for hot update.')
          return
        }
        await executeHotUpdate(pluginName, updateUrl)
      }
    })

    notification.on('click', () => {
      if (updateUrl) {
        shell.openExternal(updateUrl)
      }
    })

    notification.show()
  } catch (error) {
    pluginLog.error('[PluginNotifier] Failed to handle plugin update:', error)
  }
}

async function executeHotUpdate(pluginName: string, updateUrl: string) {
  try {
    pluginLog.info(`[PluginNotifier] Starting hot update for ${pluginName} from ${updateUrl}`)
    
    const config = await getPluginConfig()
    const activePath = config.activePluginPath

    if (!activePath) {
      pluginLog.warn('[PluginNotifier] Cannot hot update: No active plugin path found.')
      return
    }

    // 下载 JS 文件并覆盖
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

    // 通知前端插件已更新
    const win = getMainWindow()
    if (win) {
      win.webContents.send('plugin:hot-updated', { pluginName, path: activePath })
    }

  } catch (error) {
    pluginLog.error(`[PluginNotifier] Hot update failed for ${pluginName}:`, error)
  }
}