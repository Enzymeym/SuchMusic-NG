import { app, BrowserWindow, ipcMain, session } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { monitorEvent } from './monitorEvent'
import { createWindow } from './windows/mainWindow'
import { registerAudioHandlers } from './ipc/audio'
import { registerPluginHandlers } from './ipc/plugin'
import { registerLocalMusicHandlers } from './ipc/localMusic'
import { registerSystemHandlers } from './ipc/system'
import { registerDesktopLyricHandlers } from './ipc/desktopLyric'
import { registerTaskbarLyricHandlers } from './ipc/taskbarLyric'
import { registerProxyHandlers } from './ipc/proxy'
import { registerPluginManagerHandlers } from './ipc/pluginManager'

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Register IPC handlers
  registerAudioHandlers()
  registerPluginHandlers()
  registerPluginManagerHandlers()
  registerLocalMusicHandlers()
  registerSystemHandlers()
  registerDesktopLyricHandlers()
  registerTaskbarLyricHandlers()
  registerProxyHandlers()

  // 配置图片防盗链和跨域
  const filter = {
    urls: [
      '*://*.music.126.net/*',
      '*://*.126.net/*',
      '*://*.qpic.cn/*',
      '*://*.gtimg.cn/*',
      '*://*.qq.com/*',
      '*://*.kugou.com/*',
      '*://*.kuwo.cn/*',
      '*://*.bilibili.com/*',
      '*://*.hdslb.com/*',
      '*://*.migu.cn/*'
    ]
  }

  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const { url } = details
    let referer = ''

    if (url.includes('music.126.net') || url.includes('126.net')) {
      referer = 'https://music.163.com/'
    } else if (url.includes('y.qq.com') || url.includes('qpic.cn') || url.includes('gtimg.cn')) {
      referer = 'https://y.qq.com/'
    } else if (url.includes('kugou.com')) {
      referer = 'https://www.kugou.com/'
    } else if (url.includes('kuwo.cn')) {
      referer = 'https://www.kuwo.cn/'
    } else if (url.includes('bilibili.com') || url.includes('hdslb.com')) {
      referer = 'https://www.bilibili.com/'
    } else if (url.includes('migu.cn')) {
      referer = 'https://music.migu.cn/'
    }

    if (referer) {
      details.requestHeaders['Referer'] = referer
    }

    // 删除 Origin，避免触发严格的同源检查
    delete details.requestHeaders['Origin']

    callback({ cancel: false, requestHeaders: details.requestHeaders })
  })

  // 允许跨域图片加载
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const responseHeaders = details.responseHeaders || {}

    // 允许所有域访问
    responseHeaders['Access-Control-Allow-Origin'] = ['*']
    // 允许所有 Header
    responseHeaders['Access-Control-Allow-Headers'] = ['*']
    // 允许所有方法
    responseHeaders['Access-Control-Allow-Methods'] = ['*']

    // 移除可能阻止 iframe 或 image 加载的 Header
    delete responseHeaders['X-Frame-Options']
    delete responseHeaders['x-frame-options']

    callback({ responseHeaders })
  })

  createWindow()
  monitorEvent()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

