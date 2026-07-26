/**
 * Such 插件宿主运行时
 * 负责插件沙箱创建、suchmusic API 注入、权限校验、敏感操作确认、生命周期管理
 */
import { BrowserWindow, ipcMain } from 'electron'
import { execFile, exec } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { app } from 'electron'
import type {
  SuchPluginManifest,
  SuchPluginInstance,
  PluginPermission,
  ConfirmRequest,
  ConfirmResponse,
  BatchConfirmRequest,
  BatchConfirmResponse,
  FileOperation,
  PlaylistOpRequest,
  PlaylistOpResponse
} from '../types'
import { PluginState as State } from '../types'
import { writeAudioMeta } from '../../main/utils/musicMetaWriter'

// ==================== 确认请求管理 ====================

/** 单个待确认的操作 */
interface PendingConfirmOp {
  opId: string
  operation: ConfirmRequest['operation']
  detail: string
  resolve: (response: ConfirmResponse) => void
  timeout: NodeJS.Timeout
}

/** 等待中的确认请求（单个，保留兼容） */
const pendingConfirms = new Map<string, {
  resolve: (response: ConfirmResponse) => void
  timeout: NodeJS.Timeout
}>()

/** 批量确认：等待中的操作队列 */
let batchQueue: PendingConfirmOp[] = []
let batchTimer: NodeJS.Timeout | null = null
/** 批量确认：等待中的批次数据 */
const pendingBatchOps = new Map<string, PendingConfirmOp[]>()

const BATCH_DEBOUNCE_MS = 100

/**
 * 将单个确认请求加入批量队列
 */
function enqueueConfirm(
  mainWindow: BrowserWindow | null,
  pluginId: string,
  pluginName: string,
  operation: ConfirmRequest['operation'],
  detail: string
): Promise<ConfirmResponse> {
  return new Promise((resolve) => {
    const opId = randomUUID()

    const timeout = setTimeout(() => {
      // 超时自动拒绝
      const idx = batchQueue.findIndex((o) => o.opId === opId)
      if (idx >= 0) batchQueue.splice(idx, 1)
      resolve({ requestId: opId, confirmed: false, skipSession: false })
    }, 30000)

    batchQueue.push({ opId, operation, detail, resolve, timeout })

    // 清除旧定时器，启动新的防抖
    if (batchTimer) clearTimeout(batchTimer)
    batchTimer = setTimeout(() => {
      flushBatchQueue(mainWindow, pluginId, pluginName)
    }, BATCH_DEBOUNCE_MS)
  })
}

/**
 * 将队列中的操作打包发送到渲染进程
 */
function flushBatchQueue(
  mainWindow: BrowserWindow | null,
  pluginId: string,
  pluginName: string
): void {
  const ops = batchQueue.splice(0)
  batchTimer = null

  if (ops.length === 0) return

  if (!mainWindow || mainWindow.isDestroyed()) {
    // 无渲染窗口时全部拒绝
    for (const op of ops) {
      clearTimeout(op.timeout)
      op.resolve({ requestId: op.opId, confirmed: false, skipSession: false })
    }
    return
  }

  const batchRequestId = randomUUID()
  const request: BatchConfirmRequest = {
    pluginId,
    pluginName,
    requestId: batchRequestId,
    operations: ops.map((o) => ({
      opId: o.opId,
      operation: o.operation,
      detail: o.detail
    }))
  }

  pendingBatchOps.set(batchRequestId, ops)
  mainWindow.webContents.send('plugin:request-batch-confirm', request)
}

/**
 * 解析批量确认响应
 */
function resolveBatchConfirmResponse(response: BatchConfirmResponse): void {
  const ops = pendingBatchOps.get(response.requestId)
  if (!ops) return

  pendingBatchOps.delete(response.requestId)

  for (const op of ops) {
    clearTimeout(op.timeout)
    const rejected = response.rejectedOpIds?.includes(op.opId)
    op.resolve({
      requestId: op.opId,
      confirmed: response.confirmed && !rejected,
      skipSession: response.skipSession
    })
  }
}

// ==================== 歌单操作请求管理 ====================

/** 等待中的歌单操作请求 */
const pendingPlaylistOps = new Map<string, {
  resolve: (response: PlaylistOpResponse) => void
  timeout: NodeJS.Timeout
}>()

/**
 * 向渲染进程发送歌单操作请求并等待响应
 */
function requestPlaylistOp(
  mainWindow: BrowserWindow | null,
  request: PlaylistOpRequest
): Promise<PlaylistOpResponse> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingPlaylistOps.delete(request.requestId)
      resolve({ requestId: request.requestId, success: false, error: '操作超时' })
    }, 15000) // 15 秒超时

    pendingPlaylistOps.set(request.requestId, { resolve, timeout })

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('plugin:playlist-op', request)
    } else {
      clearTimeout(timeout)
      pendingPlaylistOps.delete(request.requestId)
      resolve({ requestId: request.requestId, success: false, error: '渲染进程不可用' })
    }
  })
}

/**
 * 解析歌单操作响应（由 IPC handler 调用）
 */
export function resolvePlaylistOpResponse(response: PlaylistOpResponse): void {
  const pending = pendingPlaylistOps.get(response.requestId)
  if (pending) {
    clearTimeout(pending.timeout)
    pendingPlaylistOps.delete(response.requestId)
    pending.resolve(response)
  }
}

// 注册确认响应的 IPC 监听（只需注册一次）
let confirmListenerRegistered = false
function ensureConfirmListener(): void {
  if (confirmListenerRegistered) return
  confirmListenerRegistered = true

  ipcMain.handle('plugin:confirm-response', (_event, response: ConfirmResponse) => {
    const pending = pendingConfirms.get(response.requestId)
    if (pending) {
      clearTimeout(pending.timeout)
      pendingConfirms.delete(response.requestId)
      pending.resolve(response)
    }
  })

  ipcMain.handle('plugin:batch-confirm-response', (_event, response: BatchConfirmResponse) => {
    resolveBatchConfirmResponse(response)
  })
}

// ==================== 权限校验 ====================

/** 权限与 suchmusic API 的映射 */
const PERMISSION_API_MAP: Record<string, PluginPermission> = {
  execProgram: 'local_program',
  execTerminal: 'local_program',
  fileOp: 'file_system',
  downloadFile: 'file_system',
  writeMeta: 'file_system',
  fetch: 'fetch',
  getSetting: 'app_info',
  createPlaylist: 'playlist',
  addToPlaylist: 'playlist',
  updatePlaylistSettings: 'playlist',
  listPlaylists: 'playlist'
}

/**
 * 校验插件是否拥有指定 API 所需的权限
 */
function checkPermission(manifest: SuchPluginManifest, apiName: string): void {
  const required = PERMISSION_API_MAP[apiName]
  if (!required) return // 无需权限的 API 直接放行

  const permissions = manifest.permissions || []
  if (!permissions.includes(required)) {
    const err = new Error(
      `[Such Plugin] 插件 "${manifest.name}" 未声明权限 "${required}"，无法调用 ${apiName}()`
    )
    throw err
  }
}

// ==================== 敏感操作判断 ====================

/** 需要用户确认的敏感 API */
const SENSITIVE_APIS = new Set(['execProgram', 'execTerminal', 'fileOp', 'downloadFile', 'writeMeta'])

function isSensitiveOperation(apiName: string): boolean {
  return SENSITIVE_APIS.has(apiName)
}

// ==================== 插件宿主 ====================

export class SuchMusicPluginHost {
  /** 插件实例 */
  instance: SuchPluginInstance
  /** 插件清单 */
  manifest: SuchPluginManifest
  /** 主窗口引用（用于确认弹窗） */
  private mainWindow: BrowserWindow | null = null
  /** 已跳过确认的 API（本次会话免确认） */
  private skipConfirmApis = new Set<string>()
  /** emit 监听器 */
  private emitListeners = new Map<string, Set<(...args: any[]) => void>>()

  constructor(manifest: SuchPluginManifest, filePath: string, mainWindow?: BrowserWindow | null) {
    ensureConfirmListener()

    this.manifest = manifest
    this.mainWindow = mainWindow ?? null

    // 构建插件实例
    const self = this
    this.instance = {
      ...manifest,
      props: {},
      filePath,
      state: State.Loaded,

      // 这些方法会在沙箱中通过 bind 绑定
      setProps(partialProps: Record<string, any>): void {
        Object.assign(self.instance.props, partialProps)
        // 通知渲染进程更新 UI
        if (self.mainWindow && !self.mainWindow.isDestroyed()) {
          self.mainWindow.webContents.send('plugin:props-changed', {
            pluginId: manifest.id,
            props: partialProps
          })
        }
      },

      emit(eventName: string, ...args: any[]): void {
        // 转发事件到渲染进程
        if (self.mainWindow && !self.mainWindow.isDestroyed()) {
          self.mainWindow.webContents.send('plugin:emit', {
            pluginId: manifest.id,
            eventName,
            args
          })
        }
        // 通知本地监听器
        const listeners = self.emitListeners.get(eventName)
        if (listeners) {
          listeners.forEach((fn) => fn(...args))
        }
      },

      render: manifest.render
    }
  }

  /**
   * 获取插件对象（用于设置方法上下文）
   */
  getSource(): SuchPluginInstance {
    return this.instance
  }

  /**
   * 设置主窗口引用
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  /**
   * 构建沙箱 window 对象（注入 notify、console 拦截）
   */
  buildSandboxWindow(): Record<string, any> {
    const pluginId = this.manifest.id
    const pluginName = this.manifest.name
    const host = this

    return {
      // window.notify —— 发送桌面通知
      notify(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
        if (host.mainWindow && !host.mainWindow.isDestroyed()) {
          host.mainWindow.webContents.send('plugin:notice', {
            type: 'notify',
            pluginId,
            pluginName,
            message,
            notifyType: type
          })
        }
        console.log(`[Plugin:${pluginId}] notify [${type}]:`, message)
      },

      // 拦截 console 输出并转发到渲染进程
      console: {
        log: (...args: any[]) => {
          console.log(`[Plugin:${pluginId}]`, ...args)
          if (host.mainWindow && !host.mainWindow.isDestroyed()) {
            host.mainWindow.webContents.send('plugin:log', 'log', `[${pluginId}]`, ...args)
          }
        },
        warn: (...args: any[]) => {
          console.warn(`[Plugin:${pluginId}]`, ...args)
          if (host.mainWindow && !host.mainWindow.isDestroyed()) {
            host.mainWindow.webContents.send('plugin:log', 'warn', `[${pluginId}]`, ...args)
          }
        },
        error: (...args: any[]) => {
          console.error(`[Plugin:${pluginId}]`, ...args)
          if (host.mainWindow && !host.mainWindow.isDestroyed()) {
            host.mainWindow.webContents.send('plugin:log', 'error', `[${pluginId}]`, ...args)
          }
        }
      }
    }
  }

  /**
   * 监听插件 emit 事件
   */
  on(eventName: string, callback: (...args: any[]) => void): void {
    if (!this.emitListeners.has(eventName)) {
      this.emitListeners.set(eventName, new Set())
    }
    this.emitListeners.get(eventName)!.add(callback)
  }

  /**
   * 取消监听插件 emit 事件
   */
  off(eventName: string, callback: (...args: any[]) => void): void {
    this.emitListeners.get(eventName)?.delete(callback)
  }

  /**
   * 构建沙箱中的 suchmusic 对象
   */
  buildSuchmusicAPI(): Record<string, any> {
    const host = this
    const manifest = this.manifest

    return {
      // ========== 调用本地程序 ==========
      execProgram: async (programPath: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
        checkPermission(manifest, 'execProgram')
        await host.confirmSensitiveOp('execProgram', `执行程序: ${programPath} ${args.join(' ')}`)
        return new Promise((resolve) => {
          execFile(programPath, args, { timeout: 60000, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) {
              resolve({ code: typeof error.code === 'number' ? error.code : 1, stdout, stderr })
            } else {
              resolve({ code: 0, stdout, stderr })
            }
          })
        })
      },

      // ========== 执行终端命令 ==========
      execTerminal: async (command: string): Promise<string> => {
        checkPermission(manifest, 'execTerminal')
        await host.confirmSensitiveOp('execTerminal', `执行命令: ${command}`)
        return new Promise((resolve, reject) => {
          exec(command, { timeout: 60000, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr || error.message))
            } else {
              resolve(stdout)
            }
          })
        })
      },

      // ========== 文件操作 ==========
      fileOp: async (operation: FileOperation, ...args: string[]): Promise<any> => {
        checkPermission(manifest, 'fileOp')
        await host.confirmSensitiveOp('fileOp', `文件操作: ${operation} ${args.join(' ')}`)

        switch (operation) {
          case 'read':
            return readFileSync(args[0], 'utf-8')
          case 'write': {
            const [filePath, content] = args
            await fs.writeFile(filePath, content, 'utf-8')
            return true
          }
          case 'copy': {
            const [src, dest] = args
            await fs.copyFile(src, dest)
            return true
          }
          case 'delete': {
            await fs.unlink(args[0])
            return true
          }
          case 'exists':
            return existsSync(args[0])
          case 'listDir': {
            const dirPath = args[0] || '.'
            return fs.readdir(dirPath)
          }
          default:
            throw new Error(`未知的文件操作: ${operation}`)
        }
      },

      // ========== 网络请求 ==========
      fetch: async (url: string, options?: RequestInit): Promise<Response> => {
        checkPermission(manifest, 'fetch')
        return fetch(url, options)
      },

      // ========== 下载文件 ==========
      downloadFile: async (url: string, destPath: string): Promise<{ success: boolean; filePath: string }> => {
        checkPermission(manifest, 'fetch')
        checkPermission(manifest, 'fileOp')
        await host.confirmSensitiveOp('downloadFile', '下载文件: ' + url + ' → ' + destPath)
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error('下载失败: HTTP ' + response.status)
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        await fs.writeFile(destPath, buffer)
        return { success: true, filePath: destPath }
      },

      // ========== 写入音乐元数据 ==========
      writeMeta: async (filePath: string, tags: Record<string, any>): Promise<boolean> => {
        checkPermission(manifest, 'writeMeta')
        await host.confirmSensitiveOp('writeMeta', '写入元数据: ' + filePath + ' (' + (tags.title || '未知标题') + ')')
        return writeAudioMeta(filePath, tags)
      },

      // ========== 读取设置 ==========
      getSetting: (key: string): any => {
        checkPermission(manifest, 'getSetting')
        // Such 设置键映射
        switch (key) {
          case 'musicFolder': {
            // 从 settings.json 读取，或使用默认值
            try {
              const settingsPath = join(app.getPath('userData'), 'settings.json')
              const raw = readFileSync(settingsPath, 'utf-8')
              const settings = JSON.parse(raw)
              return settings.musicFolder || join(app.getPath('music'), 'Such')
            } catch {
              return join(app.getPath('music'), 'Such')
            }
          }
          case 'theme': {
            try {
              const settingsPath = join(app.getPath('userData'), 'settings.json')
              const raw = readFileSync(settingsPath, 'utf-8')
              const settings = JSON.parse(raw)
              return settings.theme || 'system'
            } catch {
              return 'system'
            }
          }
          case 'ncmProgramPath':
            return host.instance.props.programPath || ''
          default:
            return null
        }
      },

      // ========== 歌单操作 ==========
      createPlaylist: async (name: string, tracks?: any[]): Promise<any> => {
        checkPermission(manifest, 'createPlaylist')
        const response = await requestPlaylistOp(host.mainWindow, {
          requestId: randomUUID(),
          pluginId: manifest.id,
          pluginName: manifest.name,
          action: 'createPlaylist',
          params: { name, tracks: tracks || [] }
        })
        if (!response.success) throw new Error(response.error || '创建歌单失败')
        return response.result
      },

      addToPlaylist: async (playlistId: string, tracks: any[]): Promise<any> => {
        checkPermission(manifest, 'addToPlaylist')
        const response = await requestPlaylistOp(host.mainWindow, {
          requestId: randomUUID(),
          pluginId: manifest.id,
          pluginName: manifest.name,
          action: 'addToPlaylist',
          params: { playlistId, tracks }
        })
        if (!response.success) throw new Error(response.error || '添加歌曲失败')
        return response.result
      },

      updatePlaylistSettings: async (playlistId: string, settings: Record<string, any>): Promise<any> => {
        checkPermission(manifest, 'updatePlaylistSettings')
        const response = await requestPlaylistOp(host.mainWindow, {
          requestId: randomUUID(),
          pluginId: manifest.id,
          pluginName: manifest.name,
          action: 'updatePlaylistSettings',
          params: { playlistId, ...settings }
        })
        if (!response.success) throw new Error(response.error || '更新歌单设置失败')
        return response.result
      },

      listPlaylists: async (): Promise<any> => {
        checkPermission(manifest, 'listPlaylists')
        const response = await requestPlaylistOp(host.mainWindow, {
          requestId: randomUUID(),
          pluginId: manifest.id,
          pluginName: manifest.name,
          action: 'listPlaylists',
          params: {}
        })
        if (!response.success) throw new Error(response.error || '获取歌单列表失败')
        return response.result
      }
    }
  }

  /**
   * 敏感操作确认：向渲染进程请求用户确认（支持批量合并）
   */
  private async confirmSensitiveOp(apiName: string, detail: string): Promise<void> {
    if (!isSensitiveOperation(apiName)) return

    // 已跳过确认
    if (this.skipConfirmApis.has(apiName)) return

    const response = await enqueueConfirm(
      this.mainWindow,
      this.manifest.id,
      this.manifest.name,
      apiName as ConfirmRequest['operation'],
      detail
    )

    if (!response.confirmed) {
      throw new Error(`用户拒绝了敏感操作: ${apiName}`)
    }

    if (response.skipSession) {
      this.skipConfirmApis.add(apiName)
    }
  }

  /**
   * 执行初始化
   */
  async initialize(): Promise<void> {
    if (this.instance.initialization) {
      try {
        await this.instance.initialization.call(this.instance)
        this.instance.state = State.Running
        console.log(`[Such Plugin] 插件 "${this.manifest.name}" 初始化完成`)
      } catch (err) {
        this.instance.state = State.Error
        console.error(`[Such Plugin] 插件 "${this.manifest.name}" 初始化失败:`, err)
        throw err
      }
    } else {
      this.instance.state = State.Running
    }
  }

  /**
   * 调用插件方法
   */
  async callMethod(methodName: string, ...args: any[]): Promise<any> {
    const method = (this.instance as any)[methodName]
    if (typeof method !== 'function') {
      throw new Error(`插件 "${this.manifest.name}" 没有方法 "${methodName}"`)
    }
    return method.apply(this.instance, args)
  }

  /**
   * 卸载插件
   */
  unload(): void {
    this.instance.state = State.Unloaded
    console.log(`[Such Plugin] 插件 "${this.manifest.name}" 已卸载`)
  }
}

/**
 * 从 JavaScript 代码字符串加载插件，返回 SuchPluginManifest
 * 使用 VM 沙箱执行插件代码并捕获 window.source
 * @param code 插件 JS 代码
 * @param extraGlobals 注入的额外全局变量（如 suchmusic）
 * @param customWindow 自定义 window 对象（默认 { source: undefined }）
 */
export function parsePluginFromCode(
  code: string,
  extraGlobals?: Record<string, any>,
  customWindow?: Record<string, any>
): SuchPluginManifest | null {
  const sandboxWindow: any = customWindow || { source: undefined }

  // 构建参数列表：window + 额外全局变量
  const paramNames = extraGlobals ? Object.keys(extraGlobals) : []
  const paramValues = extraGlobals ? Object.values(extraGlobals) : []

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('window', ...paramNames, code)
    fn(sandboxWindow, ...paramValues)
  } catch (err) {
    console.error('[Such Plugin] 插件代码执行失败:', err)
    return null
  }

  if (!sandboxWindow.source || typeof sandboxWindow.source !== 'object') {
    console.error('[Such Plugin] 插件未正确设置 window.source')
    return null
  }

  const source = sandboxWindow.source as SuchPluginManifest

  // 校验必填字段
  if (!source.id || !source.name || !source.version || !source.author) {
    console.error('[Such Plugin] 插件缺少必填字段 (id/name/version/author)')
    return null
  }

  return source
}
