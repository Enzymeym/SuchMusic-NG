import { Tray, Menu, app, nativeImage } from 'electron'
import { getMainWindow } from './windows/mainWindow'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

let tray: Tray | null = null

function getTrayIconPath(): string {
  // 在开发环境中使用相对路径，在生产环境中使用 asarUnpack 的实际路径
  if (is.dev) {
    return join(__dirname, '../../resources/icon.png')
  }
  // 打包后 resources/ 通过 asarUnpack 解压到 app.asar.unpacked/resources/
  return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'icon.png')
}

export function createTray(): void {
  if (tray) return

  try {
    const icon = nativeImage.createFromPath(getTrayIconPath())
    tray = new Tray(icon)
  } catch (e) {
    console.error('创建托盘失败:', e)
    ;(app as any).hasTray = false
    return
  }
  tray.setToolTip(app.name)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        const mainWindow = getMainWindow()
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    { type: 'separator' },
    {
      label: '播放 / 暂停',
      click: () => {
        const mainWindow = getMainWindow()
        if (mainWindow) {
          mainWindow.webContents.send('player:control', 'toggle')
        }
      }
    },
    {
      label: '上一首',
      click: () => {
        const mainWindow = getMainWindow()
        if (mainWindow) {
          mainWindow.webContents.send('player:control', 'prev')
        }
      }
    },
    {
      label: '下一首',
      click: () => {
        const mainWindow = getMainWindow()
        if (mainWindow) {
          mainWindow.webContents.send('player:control', 'next')
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    const mainWindow = getMainWindow()
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        if (mainWindow.isFocused()) {
          mainWindow.hide()
        } else {
          mainWindow.focus()
        }
      } else {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    }
  })
}

export function hasTray(): boolean {
  return tray !== null
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
