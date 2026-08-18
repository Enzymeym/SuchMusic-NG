import { BrowserWindow, screen, nativeImage, app } from 'electron'
import { join } from 'path'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { promisify } from 'util'
import { is } from '@electron-toolkit/utils'

const execFileAsync = promisify(execFile)

function getIconPath(): string {
  if (is.dev) {
    return join(__dirname, '../../resources/icon.png')
  }
  return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'icon.png')
}

function getTaskbarAreaScriptPath(): string {
  if (is.dev) {
    return join(__dirname, '../../resources/taskbar-area.ps1')
  }
  return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'taskbar-area.ps1')
}

function getWatchScriptPath(): string {
  if (is.dev) {
    return join(__dirname, '../../resources/taskbar-area-watch.ps1')
  }
  return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'taskbar-area-watch.ps1')
}

let taskbarControlWindow: BrowserWindow | undefined

// 模块级窗口配置状态
let currentWidthMode: 'auto' | 'custom' = 'auto'
let customWidth = 480
let height = 60

// 通过 UI Automation 动态测得的任务栏空白区域（像素坐标）
let cachedBlankArea: { x: number; y: number; width: number; height: number } | null = null

// 长驻监视进程：任务栏内容变化时推送新的空白区域测量值
let areaWatcher: ChildProcessWithoutNullStreams | null = null

/**
 * 运行 PowerShell 脚本动态测量任务栏空白区域，并缓存结果。
 * 测量失败时清空缓存（getAutoLayout 会回退到估算值）。
 */
export async function refreshTaskbarBlankArea(): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', getTaskbarAreaScriptPath()],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }
    )
    console.log('[taskbar-area] raw stdout:', JSON.stringify(stdout.trim()))
    if (stderr?.trim()) console.warn('[taskbar-area] stderr:', stderr.trim())
    const parsed = JSON.parse(stdout.trim())
    if (parsed && typeof parsed.width === 'number' && parsed.width > 0) {
      cachedBlankArea = {
        x: parsed.x,
        y: parsed.y,
        width: parsed.width,
        height: parsed.height
      }
      console.log('[taskbar-area] measured:', JSON.stringify(cachedBlankArea))
    } else {
      cachedBlankArea = null
      console.log('[taskbar-area] invalid data')
    }
  } catch (e) {
    cachedBlankArea = null
    console.error('[taskbar-area] measurement failed:', e)
  }
}

/**
 * 启动长驻监视进程。该脚本在任务栏内容变化（打开/关闭应用、固定/取消固定等）时
 * 向 stdout 逐行输出新的空白区域 JSON，实时更新窗口尺寸。
 */
function startAreaWatcher(): void {
  if (areaWatcher) return

  const watcher = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', getWatchScriptPath()],
    { windowsHide: true }
  )
  areaWatcher = watcher

  let buffer = ''
  watcher.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed.width === 'number' && parsed.width > 0) {
          cachedBlankArea = {
            x: parsed.x,
            y: parsed.y,
            width: parsed.width,
            height: parsed.height
          }
          console.log('[taskbar-area] watch updated:', JSON.stringify(cachedBlankArea))
          applyBounds()
        }
      } catch (e) {
        console.error('[taskbar-area] watch parse error:', e)
      }
    }
  })

  watcher.stderr.on('data', (chunk: Buffer) => {
    const txt = chunk.toString().trim()
    if (txt) console.warn('[taskbar-area] watch stderr:', txt)
  })

  watcher.on('error', (e) => {
    console.error('[taskbar-area] watcher error:', e)
  })

  watcher.on('exit', (code) => {
    console.log('[taskbar-area] watcher exited, code =', code)
    if (areaWatcher === watcher) areaWatcher = null
  })
}

function stopAreaWatcher(): void {
  if (areaWatcher) {
    areaWatcher.kill()
    areaWatcher = null
  }
}

export type TaskbarEdge = 'top' | 'bottom' | 'left' | 'right'

export function getTaskbarControlWindow(): BrowserWindow | undefined {
  return taskbarControlWindow
}

/**
 * 探测 Windows 任务栏所在边（比较显示区域 bounds 与工作区 workArea）。
 * 兜底返回 'bottom'。
 */
export function detectTaskbarEdge(): TaskbarEdge {
  const { bounds, workArea } = screen.getPrimaryDisplay()
  if (workArea.x > bounds.x) return 'left'
  if (workArea.y > bounds.y) return 'top'
  if (workArea.width < bounds.width && workArea.x === bounds.x) return 'right'
  if (workArea.height < bounds.height) return 'bottom'
  return 'bottom'
}

/**
 * 计算任务栏厚度（当前任务栏所在边方向上的高度/宽度，像素）。
 * 用于让播控窗口高度与任务栏对齐。
 */
export function getTaskbarThickness(): number {
  const { bounds, workArea } = screen.getPrimaryDisplay()
  const edge = detectTaskbarEdge()
  switch (edge) {
    case 'top':
      return workArea.y - bounds.y
    case 'bottom':
      return bounds.y + bounds.height - (workArea.y + workArea.height)
    case 'left':
      return workArea.x - bounds.x
    case 'right':
      return bounds.x + bounds.width - (workArea.x + workArea.width)
    default:
      return 40
  }
}

/**
 * 主屏 DPI 缩放系数。UI Automation 返回的是物理像素，而 Electron 窗口坐标是
 * 设备无关像素（DIP），布局前需按此系数换算。
 */
function getPrimaryScaleFactor(): number {
  return screen.getPrimaryDisplay().scaleFactor || 1
}

/**
 * 播控窗口高度：优先使用实测的任务栏高度（换算为 DIP），使其与任务栏对齐；
 * 实测失败时回退为「用户设定高度上限」与任务栏厚度的较小值。
 */
export function getTaskbarControlHeight(): number {
  if (cachedBlankArea) {
    return Math.max(1, Math.round(cachedBlankArea.height / getPrimaryScaleFactor()))
  }
  return Math.min(height, getTaskbarThickness())
}

/**
 * 自适应模式：播控窗口动态占据任务栏的无内容空白区域（由 UI Automation 实测）。
 * 实测失败时回退到估算值，避免窗口不可见。
 */
export function getAutoLayout(): { x: number; y: number; width: number } {
  const { bounds } = screen.getPrimaryDisplay()
  const edge = detectTaskbarEdge()
  const winHeight = getTaskbarControlHeight()

  if (cachedBlankArea) {
    // 物理像素 → DIP 换算，确保窗口落在主屏可见区域
    const scale = getPrimaryScaleFactor()
    return {
      x: Math.round(cachedBlankArea.x / scale),
      y: Math.round(cachedBlankArea.y / scale),
      width: Math.max(120, Math.round(cachedBlankArea.width / scale))
    }
  }

  // 回退估算：仅用于实测失败时的兜底，不再使用固定预留值
  const padding = 8
  if (edge === 'top' || edge === 'bottom') {
    const x = bounds.x + padding
    const width = Math.max(200, bounds.width - padding * 2)
    const y = edge === 'top' ? bounds.y + padding : bounds.y + bounds.height - winHeight - padding
    return { x, y, width }
  }

  // 左右垂直任务栏：垂直方向的空白区域，使用固定宽度兜底
  const width = 320
  const pos = computeDockPosition(edge, width, winHeight)
  return { x: pos.x, y: pos.y, width }
}

/**
 * 按边计算窗口吸附位置（留边距）。
 */
export function computeDockPosition(
  edge: TaskbarEdge,
  width: number,
  height: number
): { x: number; y: number } {
  const { bounds } = screen.getPrimaryDisplay()
  const padding = 8
  switch (edge) {
    case 'top':
      return { x: bounds.x + 10, y: bounds.y + padding }
    case 'left':
      return { x: bounds.x + padding, y: bounds.y + bounds.height - height - padding }
    case 'right':
      return { x: bounds.x + bounds.width - width - padding, y: bounds.y + bounds.height - height - padding }
    case 'bottom':
    default:
      return { x: bounds.x + 10, y: bounds.y + bounds.height - height - padding }
  }
}

// 窗口边界过渡动画定时器
let boundsAnimTimer: NodeJS.Timeout | null = null

/** 三次缓出，让动画在开始时流畅加速、结束时柔和停下 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * 将窗口平滑过渡到指定边界（毫秒级插值），避免 setBounds 一步到位造成生硬跳变。
 * 若在过渡中收到新目标，会取消当前动画并从中途继续，保证实时跟随且连续流畅。
 */
function animateWindowTo(
  target: { x: number; y: number; width: number; height: number },
  duration = 420
): void {
  const win = taskbarControlWindow
  if (!win || win.isDestroyed()) return

  if (boundsAnimTimer) {
    clearInterval(boundsAnimTimer)
    boundsAnimTimer = null
  }

  const start = win.getBounds()
  const startTime = Date.now()

  boundsAnimTimer = setInterval(() => {
    if (!taskbarControlWindow || taskbarControlWindow.isDestroyed()) {
      if (boundsAnimTimer) clearInterval(boundsAnimTimer)
      boundsAnimTimer = null
      return
    }
    let p = (Date.now() - startTime) / duration
    let finished = false
    if (p >= 1) {
      p = 1
      finished = true
      if (boundsAnimTimer) clearInterval(boundsAnimTimer)
      boundsAnimTimer = null
    }
    const ease = finished ? 1 : easeOutCubic(p)
    const rect = {
      x: Math.round(start.x + (target.x - start.x) * ease),
      y: Math.round(start.y + (target.y - start.y) * ease),
      width: Math.round(start.width + (target.width - start.width) * ease),
      height: Math.round(start.height + (target.height - start.height) * ease)
    }
    try {
      taskbarControlWindow?.setBounds(rect, false)
    } catch {
      // 忽略动画期间的偶发边界设置错误
    }
  }, 25)
}

/**
 * 根据当前宽度模式 / edge 重新布局窗口（跟随任务栏位置变化）。
 * 使用平滑过渡动画，并在需要时置顶/恢复显示，避免透明无边框窗口
 * 在运行时缩放时被隐藏，从而实现无需重启的实时窗口变换。
 */
function applyBounds(): void {
  if (!taskbarControlWindow || taskbarControlWindow.isDestroyed()) return
  try {
    let rect: { x: number; y: number; width: number; height: number }
    if (currentWidthMode === 'auto') {
      const layout = getAutoLayout()
      rect = { x: layout.x, y: layout.y, width: layout.width, height: getTaskbarControlHeight() }
    } else {
      const [width, height] = taskbarControlWindow.getSize()
      rect = {
        ...computeDockPosition(detectTaskbarEdge(), width, height),
        width,
        height
      }
    }

    // 仅在实际变化超过 1px 时才触发动画，避免高频无意义操作
    const cur = taskbarControlWindow.getBounds()
    const changed =
      Math.abs(cur.x - rect.x) > 1 ||
      Math.abs(cur.y - rect.y) > 1 ||
      Math.abs(cur.width - rect.width) > 1 ||
      Math.abs(cur.height - rect.height) > 1
    if (!changed) return

    // 置顶并确保可见，防止被系统隐藏
    taskbarControlWindow.setAlwaysOnTop(true, 'screen-saver')
    if (!taskbarControlWindow.isVisible()) taskbarControlWindow.show()

    animateWindowTo(rect)
  } catch (e) {
    console.error('[taskbar-control] applyBounds failed:', e)
  }
}

/**
 * 更新任务栏播控的尺寸设置（宽度模式 / 自定义宽度 / 高度上限）。
 * auto 模式占据任务栏空白区域；custom 模式应用固定宽度。
 */
export function updateTaskbarControlSettings(settings: {
  widthMode?: 'auto' | 'custom'
  customWidth?: number
  height?: number
}): void {
  if (settings.widthMode !== undefined) currentWidthMode = settings.widthMode
  if (typeof settings.customWidth === 'number' && settings.customWidth > 0) {
    customWidth = settings.customWidth
  }
  if (typeof settings.height === 'number' && settings.height > 0) {
    height = settings.height
  }
  if (!taskbarControlWindow || taskbarControlWindow.isDestroyed()) return

  if (currentWidthMode === 'custom') {
    taskbarControlWindow.setSize(customWidth, getTaskbarControlHeight(), false)
  }
  applyBounds()
}

export async function createTaskbarControlWindow(): Promise<void> {
  if (taskbarControlWindow && !taskbarControlWindow.isDestroyed()) {
    taskbarControlWindow.show()
    return
  }

  // 先动态测量任务栏空白区域，再据此创建窗口
  await refreshTaskbarBlankArea()

  const edge = detectTaskbarEdge()
  const effectiveHeight = getTaskbarControlHeight()
  let initialWidth: number
  let pos: { x: number; y: number }
  if (currentWidthMode === 'auto') {
    const layout = getAutoLayout()
    initialWidth = layout.width
    pos = { x: layout.x, y: layout.y }
  } else {
    initialWidth = customWidth
    pos = computeDockPosition(edge, initialWidth, effectiveHeight)
  }

  taskbarControlWindow = new BrowserWindow({
    width: initialWidth,
    height: effectiveHeight,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    type: 'toolbar',
    icon: nativeImage.createFromPath(getIconPath()),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false,
      // 播控窗口常驻任务栏，即使主窗口隐藏/失焦也保持时钟与动画帧运行，
      // 避免后台节流导致逐字歌词渐变失效（"歌词不动"）
      backgroundThrottling: false
    }
  })

  taskbarControlWindow.setAlwaysOnTop(true, 'screen-saver')
  console.log('[taskbar-control] created at', pos.x, pos.y, initialWidth, effectiveHeight)
  if (cachedBlankArea) {
    console.log('[taskbar-control] blankArea =', JSON.stringify(cachedBlankArea))
  }
  console.log('[taskbar-control] displays =', JSON.stringify(screen.getAllDisplays().map((d) => d.bounds)))

  taskbarControlWindow.on('ready-to-show', () => {
    console.log('[taskbar-control] ready-to-show')
    taskbarControlWindow?.show()
    console.log('[taskbar-control] shown, bounds =', JSON.stringify(taskbarControlWindow?.getBounds()))
  })

  taskbarControlWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[taskbar-control] did-fail-load', code, desc, url)
  })

  taskbarControlWindow.on('closed', () => {
    if (boundsAnimTimer) {
      clearInterval(boundsAnimTimer)
      boundsAnimTimer = null
    }
    taskbarControlWindow = undefined
    stopAreaWatcher()
  })

  // 长驻监视任务栏内容变化，实时调整窗口宽度
  startAreaWatcher()

  // 任务栏位置变化（如系统设置切换任务栏边）时重新测量并吸附
  screen.on('display-metrics-changed', () => {
    void refreshTaskbarBlankArea().then(() => applyBounds())
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    taskbarControlWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#/taskbar-control`)
  } else {
    taskbarControlWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: 'taskbar-control'
    })
  }
}

export function closeTaskbarControlWindow(): void {
  stopAreaWatcher()
  if (taskbarControlWindow && !taskbarControlWindow.isDestroyed()) {
    taskbarControlWindow.close()
  }
}

// 应用退出时确保监视进程被终止，避免残留 PowerShell 进程
app.on('will-quit', () => {
  stopAreaWatcher()
})