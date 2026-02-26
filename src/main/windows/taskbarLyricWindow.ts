import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'

let taskbarLyricWindow: BrowserWindow | undefined

export function getTaskbarLyricWindow(): BrowserWindow | undefined {
  return taskbarLyricWindow
}

export function createTaskbarLyricWindow(): void {
  if (taskbarLyricWindow && !taskbarLyricWindow.isDestroyed()) {
    taskbarLyricWindow.show()
    return
  }

  // Calculate position: Bottom left of primary display, above taskbar
  const primaryDisplay = screen.getPrimaryDisplay()
  const { bounds } = primaryDisplay

  // Taskbar height = screen height - work area height (usually)
  // But workArea accounts for taskbar position (top/bottom/left/right)
  // Assuming bottom taskbar for now, or just placing it at the bottom of workArea
  
  const windowHeight = 60 // Fixed height for taskbar lyric
  const windowWidth = 600 // Initial width
  
  // Position at the bottom left of the work area
  // Note: Windows 11 taskbar icons are centered by default, but the left area is usually empty-ish
  // We place it slightly above the bottom of the screen to overlay the taskbar if possible
  // Electron windows cannot easily overlay the taskbar if it's set to "always on top" without specific type.
  // 'toolbar' type might help on Windows.
  
  // Actually, to overlay the taskbar, we need to position it AT the bottom of the screen bounds, 
  // not the workArea.
  
  const x = bounds.x + 10 // Slight padding from left
  // y should be calculated to be inside the taskbar area
  // Taskbar is usually at bounds.height - (bounds.height - workArea.height)
  // Let's try to position it at the bottom of the screen
  const y = bounds.height - windowHeight 

  taskbarLyricWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false, // We handle resizing manually if needed
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    type: 'toolbar', // Helps with staying on top of taskbar
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false
    }
  })

  // Ensure it stays on top even of the taskbar
  taskbarLyricWindow.setAlwaysOnTop(true, 'screen-saver')

  taskbarLyricWindow.on('ready-to-show', () => {
    taskbarLyricWindow?.show()
  })

  taskbarLyricWindow.on('closed', () => {
    taskbarLyricWindow = undefined
  })

  // Load content
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    taskbarLyricWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#/taskbar-lyric`)
  } else {
    taskbarLyricWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: 'taskbar-lyric'
    })
  }
}

export function closeTaskbarLyricWindow(): void {
  if (taskbarLyricWindow && !taskbarLyricWindow.isDestroyed()) {
    taskbarLyricWindow.close()
  }
}

export function setTaskbarLyricLocked(_locked: boolean): void {
  if (!taskbarLyricWindow || taskbarLyricWindow.isDestroyed()) return
  // Taskbar lyric specific locking logic if needed
  // Generally it's always interactive for controls, but maybe we want to disable dragging
}
