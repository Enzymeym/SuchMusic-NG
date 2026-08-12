import { shell, BrowserWindow, app, nativeImage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

function getIconPath(): string {
  // 在开发环境中使用相对路径，在生产环境中使用 asarUnpack 的实际路径
  if (is.dev) {
    return join(__dirname, '../../../resources/icon.png')
  }
  // 打包后 resources/ 通过 asarUnpack 解压到 app.asar.unpacked/resources/
  return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'icon.png')
}

let mainWindow: BrowserWindow | undefined

export function getMainWindow(): BrowserWindow | undefined {
  return mainWindow
}

export function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    icon: nativeImage.createFromPath(getIconPath()),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false
    },
    frame: false,
    // Windows/Linux 隐藏系统标题栏并关闭系统按钮覆盖层（AppHeader 自绘控制按钮）
    // macOS 不设置 titleBarStyle，保持纯无边框，避免出现系统红绿灯
    ...(process.platform !== 'darwin' ? { titleBarStyle: 'hidden', titleBarOverlay: false } : {}),
    // 减小窗口的最小尺寸限制
    minWidth: 800,
    minHeight: 600
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.on('resize', () => {
    if (!mainWindow) return
    const isMax = mainWindow.isMaximized()
    if (isMax) {
      mainWindow.webContents.send('winSizeChange', { size: 'max' })
    } else {
      mainWindow.webContents.send('winSizeChange', { size: 'min' })
    }
  })

  mainWindow.on('close', (event) => {
    // 如果不是真的要退出，并且用户设置了最小化到托盘，就隐藏窗口
    // 但如果托盘未创建，则不允许隐藏窗口（否则无法恢复或退出）
    if (!(app as any).isQuiting) {
      const closeAction = (app as any).closeAction || 'minimize'
      if (closeAction === 'minimize' && (app as any).hasTray !== false) {
        event.preventDefault()
        mainWindow?.hide()
      }
    }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
