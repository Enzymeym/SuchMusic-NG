import { ipcMain } from 'electron'
import { createTaskbarLyricWindow, closeTaskbarLyricWindow, getTaskbarLyricWindow, setTaskbarLyricLocked } from '../windows/taskbarLyricWindow'
import { getMainWindow } from '../windows/mainWindow'

let cachedLyrics: any = null
let cachedSettings: any = null
let cachedIsPlaying: boolean = false
let cachedInfo: any = { title: '', artist: '' }

export function registerTaskbarLyricHandlers(): void {
  ipcMain.handle('taskbar-lyric:open', () => {
    createTaskbarLyricWindow()
  })

  ipcMain.handle('taskbar-lyric:close', () => {
    closeTaskbarLyricWindow()
  })

  ipcMain.handle('taskbar-lyric:toggle', () => {
    const win = getTaskbarLyricWindow()
    if (win && !win.isDestroyed()) {
      closeTaskbarLyricWindow()
    } else {
      createTaskbarLyricWindow()
    }
  })

  ipcMain.handle('taskbar-lyric:is-open', () => {
    const win = getTaskbarLyricWindow()
    return !!(win && !win.isDestroyed())
  })

  // Forward time updates from main window to lyric window
  ipcMain.on('taskbar-lyric:time-update', (_, time: number) => {
    const win = getTaskbarLyricWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('taskbar-lyric:time-update', time)
    }
  })

  // Forward lyrics updates from main window to lyric window
  ipcMain.on('taskbar-lyric:set-lyrics', (_, lyrics: any) => {
    cachedLyrics = lyrics
    const win = getTaskbarLyricWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('taskbar-lyric:set-lyrics', lyrics)
    }
  })

  // Forward settings updates (e.g. font size, color)
  ipcMain.on('taskbar-lyric:set-settings', (_, settings: any) => {
    cachedSettings = settings
    const win = getTaskbarLyricWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('taskbar-lyric:set-settings', settings)
    }
    
    // Handle locked state if needed (though taskbar lyric is usually always interactive or locked in position)
    if (settings && typeof settings.locked === 'boolean') {
      setTaskbarLyricLocked(settings.locked)
    }
  })

  ipcMain.on('taskbar-lyric:set-playing', (_, isPlaying: boolean) => {
    cachedIsPlaying = isPlaying
    const win = getTaskbarLyricWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('taskbar-lyric:set-playing', isPlaying)
    }
  })

  ipcMain.on('taskbar-lyric:set-info', (_, info: any) => {
    cachedInfo = info
    const win = getTaskbarLyricWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('taskbar-lyric:set-info', info)
    }
  })
  
  ipcMain.on('taskbar-lyric:move', (_, delta: { x: number, y: number }) => {
    const win = getTaskbarLyricWindow()
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition()
      // Only allow horizontal movement for taskbar lyric
      win.setPosition(x + delta.x, y)
    }
  })

  // When taskbar lyric window is ready, send cached data
  ipcMain.handle('taskbar-lyric:ready', (event) => {
    if (cachedLyrics) {
      event.sender.send('taskbar-lyric:set-lyrics', cachedLyrics)
    }
    if (cachedSettings) {
      event.sender.send('taskbar-lyric:set-settings', cachedSettings)
    }
    event.sender.send('taskbar-lyric:set-playing', cachedIsPlaying)
    event.sender.send('taskbar-lyric:set-info', cachedInfo)
  })

  ipcMain.on('taskbar-lyric:control', (_, action: string) => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('player:control', action)
    }
  })
}
