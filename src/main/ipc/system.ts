import { ipcMain, app } from 'electron'

export function registerSystemHandlers(): void {
  // 获取系统字体列表
  ipcMain.handle('system:get-fonts', async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { exec } = require('child_process')
      const cmd = `powershell -command "Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families.Name"`
      
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
}
