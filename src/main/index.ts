import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { monitorEvent } from './monitorEvent'
import { createWindow } from './windows/mainWindow'
import { registerAudioHandlers } from './ipc/audio'
import { registerPluginHandlers } from './ipc/plugin'
import { registerLocalMusicHandlers } from './ipc/localMusic'
import { registerSystemHandlers } from './ipc/system'
import { registerDesktopLyricHandlers } from './ipc/desktopLyric'
import { registerTaskbarLyricHandlers } from './ipc/taskbarLyric'
import { registerProxyHandlers } from './ipc/proxy'
import { registerPluginManagerHandlers, checkAllPluginsForUpdates } from './ipc/pluginManager'
import { createTray } from './tray'
import { registerAudioEngineHandlers } from './services/audioEngineService'
import { registerUpdateHandlers } from './ipc/update'
import { checkForUpdate } from './services/updateService'
import { sendAutoUpdateResult } from './ipc/update'

// 修复 PowerShell 中中文显示错误的问题
if (process.platform === 'win32') {
  // 尝试设置控制台代码页为 UTF-8
  try {
    const { execSync } = require('child_process')
    execSync('chcp 65001', { stdio: 'ignore' })
  } catch (e) {
    // 忽略错误
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.

// 设置应用名称，解决 SMTC（系统媒体传输控制）中显示未知应用或 electron 的问题
app.name = 'Such Music'
app.setAppUserModelId('com.mym.suchmusic')

/**
 * 在 Windows 注册表中注册 AppUserModelID，并在开始菜单创建快捷方式，
 * 解决 SMTC 显示"未知应用"的问题。
 *
 * Windows 的 SMTC 通过 AppUserModelID 来识别和显示应用名称。
 * 仅调用 setAppUserModelId() 不足以让 Windows 正确解析名称，
 * 需要同时做两件事：
 *   1. 在注册表 HKCU\Software\Classes\AppUserModelId\{id} 中写入 DisplayName
 *   2. 在开始菜单创建带有相同 AppUserModelID 的快捷方式文件
 *
 * @param appUserModelId - 应用用户模型 ID
 * @param appName - 应用显示名称
 */
const ensureSmcAppIdentity = (appUserModelId: string, appName: string): void => {
  if (process.platform !== 'win32') return

  // 方案一：在注册表中注册 AppUserModelID 显示名称（最关键的一步）
  const regPath = `HKCU\\Software\\Classes\\AppUserModelId\\${appUserModelId}`
  try {
    const existing = execSync(`reg query "${regPath}" /v DisplayName 2>nul`, { encoding: 'utf8' })
    if (!existing.includes(appName)) {
      execSync(`reg add "${regPath}" /v DisplayName /t REG_SZ /d "${appName}" /f`, { stdio: 'ignore' })
      execSync(`reg add "${regPath}" /ve /t REG_SZ /d "${appName}" /f`, { stdio: 'ignore' })
      console.log('已在注册表中注册 SMTC 应用名称:', appName)
    }
  } catch {
    execSync(`reg add "${regPath}" /v DisplayName /t REG_SZ /d "${appName}" /f`, { stdio: 'ignore' })
    execSync(`reg add "${regPath}" /ve /t REG_SZ /d "${appName}" /f`, { stdio: 'ignore' })
    console.log('已在注册表中注册 SMTC 应用名称:', appName)
  }

  // 方案二：在开始菜单创建快捷方式（作为补充保障）
  const startMenuPath = join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs'
  )
  const shortcutPath = join(startMenuPath, `${appName}.lnk`)

  if (existsSync(shortcutPath)) {
    // 快捷方式已存在，更新其 AppUserModelID 属性
    const updated = shell.writeShortcutLink(shortcutPath, 'update', {
      appUserModelId,
      target: process.execPath,
      description: appName
    })
    console.log('快捷方式 AppUserModelID 已更新:', shortcutPath, updated)
    return
  }

  // 快捷方式不存在，创建它
  try {
    if (!existsSync(startMenuPath)) {
      mkdirSync(startMenuPath, { recursive: true })
    }

    // 用 PowerShell COM 对象创建快捷方式（比 Electron API 更可靠）
    const psShortcutPath = shortcutPath.replace(/'/g, "''")
    const psTargetPath = process.execPath.replace(/'/g, "''")
    execSync(
      `powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell;$sc=$ws.CreateShortcut('${psShortcutPath}');$sc.TargetPath='${psTargetPath}';$sc.Description='${appName}';$sc.Save()"`,
      { stdio: 'ignore' }
    )

    // 用 shell.writeShortcutLink 设置 AppUserModelID 属性
    const linked = shell.writeShortcutLink(shortcutPath, 'update', {
      appUserModelId,
      target: process.execPath
    })
    console.log('开始菜单快捷方式已创建:', shortcutPath, linked)
  } catch (e) {
    console.error('创建开始菜单快捷方式失败:', e)
  }
}

app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.mym.suchmusic')

  // 创建开始菜单快捷方式并注册应用身份，确保 SMTC 能正确显示应用名称
  ensureSmcAppIdentity('com.mym.suchmusic', 'Such Music')

  app.on('before-quit', () => {
    ;(app as any).isQuiting = true
  })

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
  registerAudioEngineHandlers()
  registerUpdateHandlers()

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
  createTray()
  monitorEvent()

  // 应用启动后自动检查插件更新
  setTimeout(async () => {
    try {
      // 发送日志到前端
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (mainWindow) {
        mainWindow.webContents.send('plugin:log', 'log', '启动自动插件更新检查...')
      }
      console.log('启动自动插件更新检查...')
      await checkAllPluginsForUpdates()
    } catch (error) {
      // 发送错误日志到前端
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (mainWindow) {
        mainWindow.webContents.send('plugin:log', 'error', '自动检查插件更新失败:', error)
      }
      console.error('自动检查插件更新失败:', error)
    }
  }, 2000)

  // 应用启动后自动检查应用更新（延迟 3 秒执行）
  setTimeout(async () => {
    try {
      console.log('启动自动应用更新检查...')
      const result = await checkForUpdate('stable')
      sendAutoUpdateResult(result)
      if (result.hasUpdate) {
        console.log(`发现新版本: v${result.latestVersion}`)
      } else {
        console.log('当前已是最新版本')
      }
    } catch (error) {
      console.error('自动检查应用更新失败:', error)
    }
  }, 3000)

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

