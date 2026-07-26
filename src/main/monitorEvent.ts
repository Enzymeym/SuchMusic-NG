import { ipcMain, type IpcMainEvent, app } from 'electron'
import { getMainWindow } from './windows/mainWindow'
import { getThumbnailIcons } from './utils/thumbnailIcons'

export const monitorEvent = (): void => {
  ipcMain.on('toMain', (_event: IpcMainEvent, data: unknown) => {
    console.log(data)
  })

  // 接收渲染进程的设置
  ipcMain.on('settings:closeAction', (_, action: 'minimize' | 'quit') => {
    ;(app as any).closeAction = action
  })

  ipcMain.on(
    'winAction',
    (_event: IpcMainEvent, data: { type: 'hide' | 'min' | 'max' | 'close' | 'hide-to-tray' }) => {
      const type = data.type
      const mainWindow = getMainWindow()
      if (!mainWindow) return

      if (type === 'hide') {
        mainWindow.minimize()
      } else if (type === 'hide-to-tray') {
        mainWindow.hide()
      } else if (type === 'min') {
        mainWindow.unmaximize()
      } else if (type === 'max') {
        mainWindow.maximize()
      } else if (type === 'close') {
        app.quit()
      }
    }
  )

  // 任务栏播放进度更新
  ipcMain.on(
    'player:taskbarProgress',
    (_event: IpcMainEvent, data: { progress: number }) => {
      const mainWindow = getMainWindow()
      if (!mainWindow) return

      const value = typeof data?.progress === 'number' ? data.progress : -1
      if (value < 0) {
        // 传入负数表示清除任务栏进度
        mainWindow.setProgressBar(-1)
      } else {
        const clamped = Math.max(0, Math.min(value, 1))
        mainWindow.setProgressBar(clamped)
      }
    }
  )

  // 任务栏缩略图工具栏
  ipcMain.on(
    'player:thumbnailToolbar',
    (_event: IpcMainEvent, data: { isPlaying: boolean; canPrev: boolean; canNext: boolean; visible: boolean }) => {
      const mainWindow = getMainWindow()
      if (!mainWindow) return
      if (process.platform !== 'win32') return

      if (!data?.visible) {
        mainWindow.setThumbarButtons([])
        return
      }

      const icons = getThumbnailIcons()
      const playPauseIcon = data.isPlaying ? icons.pause : icons.play

      mainWindow.setThumbarButtons([
        {
          tooltip: '上一曲',
          icon: icons.prev,
          flags: data.canPrev ? undefined : ['disabled'],
          click: () => {
            mainWindow.webContents.send('player:thumbnailAction', { action: 'prev' })
          }
        },
        {
          tooltip: data.isPlaying ? '暂停' : '播放',
          icon: playPauseIcon,
          click: () => {
            mainWindow.webContents.send('player:thumbnailAction', { action: 'togglePlay' })
          }
        },
        {
          tooltip: '下一曲',
          icon: icons.next,
          flags: data.canNext ? undefined : ['disabled'],
          click: () => {
            mainWindow.webContents.send('player:thumbnailAction', { action: 'next' })
          }
        }
      ])
    }
  )

  // 任务栏标题（歌曲信息）
  ipcMain.on(
    'player:taskbarTitle',
    (_event: IpcMainEvent, data: { title: string }) => {
      const mainWindow = getMainWindow()
      if (!mainWindow) return
      mainWindow.setTitle(data?.title || 'Such Music')
    }
  )
}
