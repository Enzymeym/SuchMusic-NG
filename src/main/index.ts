import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { monitorEvent } from './monitorEvent'
import { createWindow } from './windows/mainWindow'
import { getMainWindow } from './windows/mainWindow'
import { registerAudioHandlers } from './ipc/audio'
import { registerVolumeBalanceHandlers } from './ipc/volumeBalance'
import { registerLocalMusicHandlers } from './ipc/localMusic'
import { registerSystemHandlers } from './ipc/system'
import { registerDesktopLyricHandlers } from './ipc/desktopLyric'
import { registerTaskbarControlHandlers } from './ipc/taskbarControl'
import { createTray } from './tray'
import { registerAudioEngineHandlers } from './services/audioEngineService'
import { registerWasapiHandlers } from './services/wasapiService'
import { registerUpdateHandlers } from './ipc/update'
import { checkForUpdate } from './services/updateService'
import { sendAutoUpdateResult } from './ipc/update'
import { registerPluginHandlers } from './ipc/pluginManager'
import { loadAllSavedPlugins } from './ipc/pluginManager'
import { registerLyricHandlers } from './services/lyricService'
import { registerNeteaseHandlers } from './services/neteaseService'
import { mainMemoryMonitor } from './utils/memoryMonitor'
import {
  initMediaControl,
  destroyMediaControl,
  dispatchMediaCommand
} from './services/mediaControlService'

// ====== 修复 Windows 控制台中文乱码 ======
// 两层保障：
// 1) chcp 65001 将当前 conhost 代码页切为 UTF-8，终端按 UTF-8 解码后续输出；
// 2) stdout/stderr 非 TTY（被 npm/electron-vite 以管道转发）时，Node 默认按系统
//    ANSI 编码写出中文，终端按 GBK 解码即乱码——这里强制将字符串转 UTF-8 字节写出。
//    TTY 场景 Node 原生走 WriteConsoleW(UTF-16) 不会乱码，故无需补丁。
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' })
  } catch (e) {
    // 忽略错误
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const forceUtf8 = (stream: NodeJS.WriteStream & { _utf8Patched?: boolean }): void => {
    if (!stream || stream._utf8Patched) return
    stream._utf8Patched = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = stream.write.bind(stream)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream.write = ((chunk: any, encoding?: any, cb?: any): boolean => {
      if (typeof chunk === 'string') {
        return original(Buffer.from(chunk, 'utf8'), typeof encoding === 'function' ? encoding : cb)
      }
      return original(chunk, encoding, cb)
    }) as typeof stream.write
  }
  if (!process.stdout.isTTY) forceUtf8(process.stdout)
  if (!process.stderr.isTTY) forceUtf8(process.stderr)
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.

// 启用 WebNN（Web Machine Learning）实验特性
// 用于在支持的环境中通过 NPU/GPU 加速音频特征推理；不支持的平台会自动降级为 CPU，不影响正常使用
// WebNNOnnxRuntime 启用 ONNX Runtime 后端（GPU/NPU 推理依赖 DirectML）
app.commandLine.appendSwitch(
  'enable-features',
  'WebMachineLearningNeuralNetwork,WebNNOnnxRuntime'
)

// 关闭 WebNN 的 DirectML NPU 硬件黑名单（Chromium 默认对部分 NPU 设备启用）
// --disable_webnn_for_npu=0 是微软官方文档提供的关闭该黑名单的方式（Edge/Chromium 通用）。
// 使用 appendArgument 替代 appendSwitch，确保下划线格式的 flag 被正确传递。
// 注意：若本机 NPU 驱动不稳定，DirectML 可能异常；届时移除本行即可恢复默认行为。
app.commandLine.appendArgument('--disable_webnn_for_npu=0')

// 限制 Chromium 磁盘缓存（默认上限 1GB，其内存映射页会计入任务管理器 Working Set，
// 对音乐应用这类以本地文件为主的产品贡献有限却虚增占用）。128MB 足以缓存封面等网络资源。
app.commandLine.appendSwitch('disk-cache-size', '134217728')

// 设置应用名称，解决 SMTC（系统媒体传输控制）中显示未知应用或 electron 的问题
app.name = 'Such Music'
app.setAppUserModelId('com.mym.suchmusic')

// 单实例锁：防止应用重复启动
// 第二次启动时主动退出当前实例，并让已存在的实例聚焦主窗口
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      // 主窗口可能处于最小化或隐藏到托盘状态，恢复并聚焦
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    } else {
      createWindow()
    }
  })
}

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
    destroyMediaControl()
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // 系统媒体键兜底：仅 Linux 通过 globalShortcut 注册（Windows/macOS 由原生会话接管），
  // 经 dispatchMediaCommand 走 200ms 去重，避免与 MPRIS 双触发。
  const registerMediaKeyShortcuts = () => {
    if (process.platform !== 'linux') return
    try {
      globalShortcut.register('MediaPlayPause', () => dispatchMediaCommand('toggle'))
      globalShortcut.register('MediaNextTrack', () => dispatchMediaCommand('next'))
      globalShortcut.register('MediaPreviousTrack', () => dispatchMediaCommand('prev'))
    } catch (err) {
      console.warn('媒体键注册失败:', err)
    }
  }
  registerMediaKeyShortcuts()
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })

  // Register IPC handlers
  registerAudioHandlers()
  registerVolumeBalanceHandlers()
  registerLocalMusicHandlers()
  registerSystemHandlers()
  registerDesktopLyricHandlers()
  registerTaskbarControlHandlers()
  registerAudioEngineHandlers()
  registerWasapiHandlers()
  registerUpdateHandlers()
  registerLyricHandlers()
  registerNeteaseHandlers()

  createWindow()
  initMediaControl()
  createTray()
  monitorEvent()

  // 启动主进程内存监控（用于验证内存优化效果）
  mainMemoryMonitor.start(10000)
  if (!app.isPackaged) {
    setInterval(() => {
      const report = mainMemoryMonitor.getReport()
      const s = report.current
      if (!s) return

      // 按进程类型聚合 RSS，输出全应用内存分布（定位 1300MB 的构成）
      // getAppMetrics 已包含主进程（type: 'Browser'），此处只统计子进程
      const byType = new Map<string, { count: number; rss: number }>()
      let childrenRss = 0
      for (const p of s.processes) {
        if (p.type === 'Browser') continue
        childrenRss += p.rss
        const key = p.type || 'unknown'
        const agg = byType.get(key) ?? { count: 0, rss: 0 }
        agg.count++
        agg.rss += p.rss
        byType.set(key, agg)
      }
      const parts = [...byType.entries()]
        .sort((a, b) => b[1].rss - a[1].rss)
        .map(([type, agg]) => `${type}×${agg.count}=${mainMemoryMonitor.toMB(agg.rss)}`)
        .join(' ')

      console.log(
        `[内存监控] 主进程 rss=${mainMemoryMonitor.toMB(s.rss)} heapUsed=${mainMemoryMonitor.toMB(
          s.heapUsed
        )} | 子进程: ${parts || '无'} | 合计=${mainMemoryMonitor.toMB(s.rss + childrenRss)}`
      )
    }, 30000)
  }

  // 注册插件系统处理器（需在窗口创建后）
  registerPluginHandlers(getMainWindow() || null)

  // 自动加载已保存的插件
  loadAllSavedPlugins()

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

