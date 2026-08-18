import { ipcMain, app, dialog } from 'electron'
import { promises as fs, createWriteStream } from 'fs'
import path from 'path'
import axios from 'axios'
import { mainMemoryMonitor } from '../utils/memoryMonitor'
import { getActiveNeteaseCookie } from '../services/neteaseService'

export function registerSystemHandlers(): void {
  // 获取主进程内存统计报告（用于验证内存优化效果）
  ipcMain.handle('memory:get-report', () => mainMemoryMonitor.getReport())

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
    const targetDir = dir || app.getPath('music')
    // 目标目录可能不存在（自定义目录被删除 / 新装系统默认音乐目录未创建），先确保存在
    await fs.mkdir(targetDir, { recursive: true })

    // 目标文件若已存在（同名旧文件 / 之前下载的半成品）可能被占用、只读或被杀软锁定，直接写入会触发 EPERM。
    // 因此先写入带随机后缀的临时文件，写完后删除旧文件并重命名，规避 Windows 文件锁定问题。
    const targetPath = path.join(targetDir, filename)
    const ext = path.extname(filename)
    const tempPath = path.join(
      targetDir,
      `${path.basename(filename, ext)}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.part${ext}`
    )

    try {
      const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        maxRedirects: 5,
        // 附加登录态，保证登录后获取的高音质 CDN 地址可正常下载
        headers: {
          Cookie: getActiveNeteaseCookie() || undefined,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Referer: 'https://music.163.com'
        }
      })

      const writer = createWriteStream(tempPath)
      response.data.pipe(writer)

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', () => resolve())
        writer.on('error', (err) => {
          // 下载中断时清理半成品文件，避免残留损坏文件
          fs.unlink(tempPath).catch(() => {})
          reject(err)
        })
      })

      // 写入完成：先尽力删除旧文件，再重命名；若目标仍被占用导致失败，再删一次后重试
      await fs.unlink(targetPath).catch(() => {})
      try {
        await fs.rename(tempPath, targetPath)
      } catch {
        await fs.unlink(targetPath).catch(() => {})
        await fs.rename(tempPath, targetPath)
      }
      return targetPath
    } catch (error) {
      // 网络/流/重命名错误时同样清理临时文件
      fs.unlink(tempPath).catch(() => {})
      console.error('下载音乐失败:', error)
      throw error
    }
  })
}
