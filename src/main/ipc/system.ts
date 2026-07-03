import { ipcMain, app, dialog } from 'electron'
import { promises as fs, createWriteStream } from 'fs'
import path from 'path'
import axios from 'axios'

export function registerSystemHandlers(): void {
  // 检查文件是否存在
  ipcMain.handle('system:fs-exists', async (_event, filePath: string) => {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  })

  // 获取系统字体列表
  ipcMain.handle('system:get-fonts', async () => {
    try {
      // 平台检测：非 Windows 不使用 PowerShell
      if (process.platform !== 'win32') {
        console.warn('获取系统字体功能暂不支持非 Windows 平台')
        return []
      }

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { exec } = require('child_process')
      // 强制 PowerShell 输出为 UTF-8 编码，避免中文字体名乱码
      const cmd = `powershell -command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families.Name"`
      
      return new Promise((resolve) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
          if (error) {
            console.error('获取字体失败:', error)
            // 失败时返回空数组或默认字体
            resolve([])
            return
          }
          if (stderr) {
            console.warn('获取字体产生警告:', stderr)
          }
          
          const fonts = stdout.split('\r\n').map(f => f.trim()).filter(f => f)
          resolve(fonts)
        })
      })
    } catch (error) {
      console.error('获取系统字体列表异常:', error)
      return []
    }
  })

  ipcMain.handle('system:get-music-dir', () => {
    try {
      return app.getPath('music')
    } catch (error) {
      console.error('获取系统音乐目录异常:', error)
      return ''
    }
  })

  // 增加检测是否为 Mac 的 handler
  ipcMain.handle('system:is-mac', () => {
    return process.platform === 'darwin'
  })

  // 选择目录
  ipcMain.handle('system:choose-dir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0]
    }
    return ''
  })

  /**
   * 选择图片文件
   * 打开系统文件对话框，支持 png/jpg/jpeg/webp/bmp/gif 格式
   * @returns 选中的文件路径，取消时返回空字符串
   */
  ipcMain.handle('system:choose-image', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择封面图片',
      filters: [
        { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }
      ],
      properties: ['openFile']
    })
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0]
    }
    return ''
  })

  /**
   * 读取文件并返回 base64 Data URL
   * @param filePath 文件的绝对路径
   * @returns base64 编码的 Data URL 字符串
   */
  ipcMain.handle('system:read-file-base64', async (_event, filePath: string) => {
    try {
      const buffer = await fs.readFile(filePath)
      const ext = path.extname(filePath).toLowerCase().replace('.', '') || 'png'
      const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        bmp: 'image/bmp',
        gif: 'image/gif'
      }
      const mime = mimeMap[ext] || 'image/png'
      const base64 = buffer.toString('base64')
      return `data:${mime};base64,${base64}`
    } catch (error) {
      console.error('读取文件为 base64 失败:', error)
      return ''
    }
  })

  // 下载音乐文件
  ipcMain.handle('system:download-music', async (_event, { url, filename, dir }: { url: string, filename: string, dir: string }) => {
    try {
      const targetDir = dir || app.getPath('music')
      const targetPath = path.join(targetDir, filename)

      const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
      })

      const writer = createWriteStream(targetPath)
      response.data.pipe(writer)

      return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(targetPath))
        writer.on('error', reject)
      })
    } catch (error) {
      console.error('下载音乐失败:', error)
      throw error
    }
  })
}
