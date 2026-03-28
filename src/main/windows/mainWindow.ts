import { shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'

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
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    },
    frame: false,
    titleBarStyle: 'hidden',
    minWidth: 1100,
    minHeight: 670,
    // expose window controls in Windows/Linux
    ...(process.platform !== 'darwin' ? { titleBarOverlay: false } : {})
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

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
