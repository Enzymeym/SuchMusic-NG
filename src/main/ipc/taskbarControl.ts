import { ipcMain } from 'electron'
import {
  createTaskbarControlWindow,
  closeTaskbarControlWindow,
  getTaskbarControlWindow,
  updateTaskbarControlSettings
} from '../windows/taskbarControlWindow'
import { getMainWindow } from '../windows/mainWindow'

let cachedSettings: any = null
let cachedIsPlaying: boolean = false
let cachedInfo: any = { title: '', artist: '', cover: '' }
let cachedProgress: { positionMs: number; durationMs: number } = { positionMs: 0, durationMs: 0 }
let cachedLyrics: any[] = []

export function registerTaskbarControlHandlers(): void {
  ipcMain.handle('taskbar-control:open', () => {
    createTaskbarControlWindow()
  })

  ipcMain.handle('taskbar-control:close', () => {
    closeTaskbarControlWindow()
  })

  ipcMain.handle('taskbar-control:toggle', () => {
    const win = getTaskbarControlWindow()
    if (win && !win.isDestroyed()) {
      closeTaskbarControlWindow()
    } else {
      createTaskbarControlWindow()
    }
  })

  ipcMain.handle('taskbar-control:is-open', () => {
    const win = getTaskbarControlWindow()
    return !!(win && !win.isDestroyed())
  })

  // 转发歌曲信息（标题 / 歌手 / 封面）到播控窗口
  ipcMain.on('taskbar-control:set-info', (_, info: any) => {
    cachedInfo = info
    const win = getTaskbarControlWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('taskbar-control:set-info', info)
    }
  })

  // 转发播放状态到播控窗口
  ipcMain.on('taskbar-control:set-playing', (_, isPlaying: boolean) => {
    cachedIsPlaying = isPlaying
    const win = getTaskbarControlWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('taskbar-control:set-playing', isPlaying)
    }
  })

  // 转发歌词（含逐字时间戳）到播控窗口
  ipcMain.on('taskbar-control:set-lyrics', (_, lyrics: any[]) => {
    cachedLyrics = Array.isArray(lyrics) ? lyrics : []
    const win = getTaskbarControlWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('taskbar-control:set-lyrics', cachedLyrics)
    }
  })

  // 转发播放进度（位置 + 总时长）到播控窗口，用于进度条与时间显示
  ipcMain.on('taskbar-control:set-progress', (_, progress: any) => {
    cachedProgress = {
      positionMs: typeof progress?.positionMs === 'number' ? progress.positionMs : 0,
      durationMs: typeof progress?.durationMs === 'number' ? progress.durationMs : 0
    }
    const win = getTaskbarControlWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('taskbar-control:set-progress', cachedProgress)
    }
  })

  // 转发设置（宽度模式 / 自定义宽度 / 高度 / 显示项）到播控窗口，并应用尺寸
  ipcMain.on('taskbar-control:set-settings', (_, settings: any) => {
    cachedSettings = settings
    updateTaskbarControlSettings(settings)
    const win = getTaskbarControlWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('taskbar-control:set-settings', settings)
    }
  })

  // 自适应模式：由主进程按任务栏空白区域自动布局，无需渲染进程上报宽度

  // 水平拖动窗口
  ipcMain.on('taskbar-control:move', (_, delta: { x: number; y: number }) => {
    const win = getTaskbarControlWindow()
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition()
      win.setPosition(x + (delta?.x ?? 0), y)
    }
  })

  // 播控窗口就绪后回发缓存数据
  ipcMain.handle('taskbar-control:ready', (event) => {
    if (cachedSettings) {
      event.sender.send('taskbar-control:set-settings', cachedSettings)
    }
    event.sender.send('taskbar-control:set-playing', cachedIsPlaying)
    event.sender.send('taskbar-control:set-info', cachedInfo)
    event.sender.send('taskbar-control:set-progress', cachedProgress)
    event.sender.send('taskbar-control:set-lyrics', cachedLyrics)
  })

  // 播控按钮 / 拖动进度 → 主窗口 player:control（action 为字符串按钮，或 {action:'seek', positionMs}）
  ipcMain.on('taskbar-control:control', (_, action: any) => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('player:control', action)
    }
  })
}