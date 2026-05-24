import { Tray, Menu, app } from 'electron'
import { getMainWindow } from './windows/mainWindow'
import icon from '../../resources/icon.png?asset'

let tray: Tray | null = null

export function createTray(): void {
  if (tray) return

  tray = new Tray(icon)
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

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
