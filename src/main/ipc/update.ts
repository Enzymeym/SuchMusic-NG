import { ipcMain, BrowserWindow } from 'electron'
import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  getCurrentVersion,
  cleanupUpdateFile
} from '../services/updateService'
import type { UpdateCheckResult } from '../../renderer/src/types/update'

// 记录当前下载的文件路径，用于安装时调用
let downloadedFilePath: string | null = null

/**
 * 注册更新相关 IPC 处理器
 * 提供检查更新、下载更新、安装更新等功能的主进程接口
 */
export function registerUpdateHandlers(): void {
  /**
   * 检查更新
   * @param _event IPC 事件对象
   * @param channel 更新通道，'stable' 或 'beta'
   * @returns 更新检查结果
   */
  ipcMain.handle('update:check', async (_event, channel: 'stable' | 'beta'): Promise<UpdateCheckResult> => {
    try {
      const result = await checkForUpdate(channel)
      return result
    } catch (error: any) {
      console.error('检查更新 IPC 调用失败:', error)
      return {
        hasUpdate: false,
        currentVersion: getCurrentVersion(),
        latestVersion: getCurrentVersion(),
        releaseName: '',
        releaseNotes: '',
        downloadUrl: null,
        publishedAt: '',
        isPrerelease: false,
        error: error.message || '检查更新失败'
      }
    }
  })

  /**
   * 下载更新包
   * @param _event IPC 事件对象
   * @param url 更新包下载链接
   * @returns 下载后的本地文件路径
   */
  ipcMain.handle('update:download', async (_event, url: string): Promise<{ success: boolean; filePath?: string; error?: string }> => {
    try {
      // 如果之前有下载的文件，先清理
      if (downloadedFilePath) {
        await cleanupUpdateFile(downloadedFilePath)
      }

      const filePath = await downloadUpdate(url)
      downloadedFilePath = filePath
      return { success: true, filePath }
    } catch (error: any) {
      console.error('下载更新失败:', error)
      return { success: false, error: error.message || '下载更新失败' }
    }
  })

  /**
   * 安装更新
   * @param _event IPC 事件对象
   * @param filePath 更新包本地路径（可选，默认使用最近一次下载的文件）
   * @returns 安装是否成功
   */
  ipcMain.handle('update:install', async (_event, filePath?: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const targetPath = filePath || downloadedFilePath
      if (!targetPath) {
        return { success: false, error: '未找到下载的更新包' }
      }

      installUpdate(targetPath)
      return { success: true }
    } catch (error: any) {
      console.error('安装更新失败:', error)
      return { success: false, error: error.message || '安装更新失败' }
    }
  })

  /**
   * 获取当前应用版本号
   * @returns 当前版本号字符串
   */
  ipcMain.handle('update:getCurrentVersion', (): string => {
    return getCurrentVersion()
  })

  /**
   * 清理下载的更新包
   * @returns 清理是否成功
   */
  ipcMain.handle('update:cleanup', async (): Promise<{ success: boolean }> => {
    try {
      if (downloadedFilePath) {
        await cleanupUpdateFile(downloadedFilePath)
        downloadedFilePath = null
      }
      return { success: true }
    } catch {
      return { success: false }
    }
  })
}

/**
 * 向渲染进程发送自动更新检查结果
 * @param result 更新检查结果
 */
export function sendAutoUpdateResult(result: UpdateCheckResult): void {
  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (mainWindow) {
    mainWindow.webContents.send('update:autoCheckResult', result)
  }
}
