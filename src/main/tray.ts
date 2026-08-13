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
    const image = nativeImage.createFromPath(getTrayIconPath())
    let icon = image
    if (process.platform === 'darwin') {
      // macOS 菜单栏图标标准尺寸为 16x16pt。
      // 注意：不要对全彩图标调用 setTemplateImage(true) —— 模板图像必须是「黑色+透明度」两通道图，
      // 系统只按 alpha 蒙版着色；全彩图标被强制模板化后会渲染成纯白/纯黑块。
      // 这里直接使用彩色图标，深浅色菜单栏下都清晰可见。
      icon = image.resize({ width: 16, height: 16 })
    }
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
