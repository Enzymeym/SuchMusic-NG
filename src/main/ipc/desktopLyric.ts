import { ipcMain } from 'electron'
import { createDesktopLyricWindow, closeDesktopLyricWindow, getDesktopLyricWindow, setDesktopLyricLocked } from '../windows/desktopLyricWindow'
import { getMainWindow } from '../windows/mainWindow'

let cachedLyrics: any = null
let cachedSettings: any = null
let cachedIsPlaying: boolean = false
let cachedInfo: any = { title: '', artist: '' }

export function registerDesktopLyricHandlers(): void {
  ipcMain.handle('desktop-lyric:open', () => {
    createDesktopLyricWindow()
  })

  ipcMain.handle('desktop-lyric:close', () => {
    closeDesktopLyricWindow()
  })

  ipcMain.handle('desktop-lyric:toggle', () => {
    const win = getDesktopLyricWindow()
    if (win && !win.isDestroyed()) {
      closeDesktopLyricWindow()
    } else {
      createDesktopLyricWindow()
    }
  })

  ipcMain.handle('desktop-lyric:is-open', () => {
    const win = getDesktopLyricWindow()
    return !!(win && !win.isDestroyed())
  })

  // Forward time updates from main window to lyric window
  ipcMain.on('desktop-lyric:time-update', (_, time: number) => {
    const win = getDesktopLyricWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('desktop-lyric:time-update', time)
    }
  })

  // Forward lyrics updates from main window to lyric window
  ipcMain.on('desktop-lyric:set-lyrics', (_, lyrics: any) => {
    cachedLyrics = lyrics
    const win = getDesktopLyricWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('desktop-lyric:set-lyrics', lyrics)
    }
  })

  // Forward settings updates (e.g. font size, color)
  ipcMain.on('desktop-lyric:set-settings', (_, settings: any) => {
    cachedSettings = settings
    const win = getDesktopLyricWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('desktop-lyric:set-settings', settings)
    }
    
    // Handle locked state
    if (settings && typeof settings.locked === 'boolean') {
      setDesktopLyricLocked(settings.locked)
    }
  })

  ipcMain.on('desktop-lyric:set-playing', (_, isPlaying: boolean) => {
    cachedIsPlaying = isPlaying
    const win = getDesktopLyricWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('desktop-lyric:set-playing', isPlaying)
    }
  })

  ipcMain.on('desktop-lyric:set-info', (_, info: any) => {
    cachedInfo = info
    const win = getDesktopLyricWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('desktop-lyric:set-info', info)
    }
  })
  
  ipcMain.on('desktop-lyric:move', (_, delta: { x: number, y: number }) => {
    const win = getDesktopLyricWindow()
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition()
      win.setPosition(x + delta.x, y + delta.y)
    }
  })

  // When desktop lyric window is ready, send cached data
  ipcMain.handle('desktop-lyric:ready', (event) => {
    if (cachedLyrics) {
      event.sender.send('desktop-lyric:set-lyrics', cachedLyrics)
    }
    if (cachedSettings) {
      event.sender.send('desktop-lyric:set-settings', cachedSettings)
      if (typeof cachedSettings.locked === 'boolean') {
        setDesktopLyricLocked(cachedSettings.locked)
      }
    }
    event.sender.send('desktop-lyric:set-playing', cachedIsPlaying)
    event.sender.send('desktop-lyric:set-info', cachedInfo)
  })
  
  // Handle dragging via IPC (if needed, but usually -webkit-app-region works better for electron)
  // However, for frameless transparent window, dragging might need custom logic if clicks pass through.

  ipcMain.on('desktop-lyric:control', (_, action: string) => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('player:control', action)
    }
  })
}
