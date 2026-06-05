/*
 * Copyright (c) 2025. 时迁酱 Inc. All rights reserved.
 *
 * This software is the confidential and proprietary information of 时迁酱.
 * Unauthorized copying of this file, via any medium is strictly prohibited.
 *
 * @author 时迁酱，无聊的霜霜，Star
 * @since 2025-9-19
 * @version 1.0
 */

import * as vm from 'vm'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { pluginLog } from '../logger'
import { transformSnowdropPlugin } from '../utils/snowdrop-transform'
import { getMainWindow } from '../../main/windows/mainWindow'
import { sendUpdateNotificationToRenderer } from './pluginNotifier'
import {
  PluginInfo,
  PluginSource,
  MusicInfo,
  SuchMusicPlugin,
  SuchPluginNew
} from '../types'

// 模拟事件通知
function sendPluginNotice(data: any, pluginName: string) {
  pluginLog.info(`[PluginNotice] ${pluginName}:`, data)
  
  if (data.type === 'update') {
    sendUpdateNotificationToRenderer(pluginName, data.data)
    return
  }

  try {
    const win = getMainWindow()
    if (win) {
      win.webContents.send('plugin:notice', {
        pluginName,
        type: data.type,
        data: data.data
      })
    }
  } catch (err) {
    pluginLog.error('Failed to send plugin notice IPC:', err)
  }
}

// ==================== 常量定义 ====================
const CONSTANTS = {
  DEFAULT_TIMEOUT: 15000, // 15秒超时（音乐直链获取）
  API_VERSION: '1.0.3',
  ENVIRONMENT: 'nodejs',
  NOTICE_DELAY: 100, // 通知延迟时间
  LOG_PREFIX: '[SuchMusic]'
} as const

// 绕过 TLS 证书验证，解决部分音源服务器证书链不兼容导致 fetch 失败的问题
// 浏览器对证书链的容忍度高于 Node.js，此设置确保 sandbox 请求行为与浏览器一致
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// 判断是否为洛雪格式插件代码
function isLxStylePluginCode(code: string): boolean {
  const lower = code.toLowerCase()

  if (lower.includes('module.exports') && lower.includes('plugininfo')) {
    return false
  }

  if (
    lower.includes('lx.event_names') ||
    /lx\.on\s*\(\s*['"`]request['"`]/i.test(code) ||
    /lx\.send\s*\(\s*['"`]inited['"`]/i.test(code)
  ) {
    return true
  }

  const hasGlobalLx = /globalThis\.lx/i.test(code) || /global\.lx/i.test(code)
  const hasEventNamesRequest = /EVENT_NAMES\.request/.test(code)
  const hasEventNamesInited = /EVENT_NAMES\.inited/.test(code)
  const hasOnCall = /\bon\s*\(/.test(code)
  const hasSendCall = /\bsend\s*\(/.test(code)

  if (
    hasGlobalLx &&
    hasEventNamesRequest &&
    hasEventNamesInited &&
    hasOnCall &&
    hasSendCall
  ) {
    return true
  }

  if (lower.includes('lx')) {
    return true
  }

  return false
}

// ==================== 类型定义 ====================

interface RequestResult {
  body: any
  statusCode: number
  headers: Record<string, string>
}

interface SuchMusicApiUtils {
  buffer: {
    from: (data: string | Buffer | ArrayBuffer, encoding?: BufferEncoding) => Buffer
    bufToString: (buffer: Buffer, encoding?: BufferEncoding) => string
  }
  crypto: {
    aesEncrypt: (data: any, mode: string, key: string | Buffer, iv?: string | Buffer) => Buffer
    md5: (str: string) => string
    randomBytes: (size: number) => Buffer
    rsaEncrypt: (data: string, key: string) => string
  }
}

interface SuchMusicApi {
  env: string
  version: string
  utils: SuchMusicApiUtils
  request: (
    url: string,
    options?: RequestOptions | RequestCallback,
    callback?: RequestCallback
  ) => Promise<RequestResult> | void
  NoticeCenter: (
    type: 'error' | 'info' | 'success' | 'warn' | 'update',
    data: {
      title: string
      content?: string
      url?: string
      version?: string
      pluginInfo: {
        name?: string // 插件名
        type: 'lx' | 'cr' //插件类型
      }
    }
  ) => void
}

type RequestOptions = {
  method?: string
  headers?: Record<string, string>
  body?: any
  timeout?: number
  [key: string]: any
}

type RequestCallback = (error: Error | null, result: RequestResult | null) => void

type Logger = {
  log: (...args: any[]) => void
  error: (...args: any[]) => void
  warn: (...args: any[]) => void
  info: (...args: any[]) => void
}

type PluginMethodName = 'musicUrl' | 'getPic' | 'getLyric'

// ==================== 错误类定义 ====================
class PluginError extends Error {
  constructor(
    message: string,
    public readonly method?: string
  ) {
    super(message)
    this.name = 'PluginError'
  }
}

/**
 * SuchMusic 插件引擎
 * 负责加载和执行单个插件，并提供一个简洁的API。
 */
class SuchMusicPluginHost {
  private pluginCode: string | null
  private plugin: SuchMusicPlugin | SuchPluginNew | null
  private isNewStyle: boolean = false
  private _pendingUpdateInfo: { version: string; log: string; url?: string } | null = null
  private _updatePromiseResolve: (() => void) | null = null

  /**
   * 创建一个新的插件主机实例
   * @param pluginCode 插件的 JavaScript 代码字符串（可选）
   * @param logger 日志记录器
   */
  constructor(pluginCode: string | null = null, logger: Logger = console) {
    this.pluginCode = pluginCode
    this.plugin = null

    if (pluginCode) {
      this._initialize(logger)
    }
  }

  // ==================== 公共方法 ====================

  /**
   * 从文件加载插件
   * @param pluginPath 插件文件路径
   * @param logger 日志记录器
   */
  async loadPlugin(pluginPath: string, logger: Logger = console): Promise<SuchMusicPlugin | SuchPluginNew> {
    try {
      let code = fs.readFileSync(pluginPath, 'utf-8')

      // 兼容旧版直接使用洛雪插件路径的配置
      if (isLxStylePluginCode(code)) {
        const result = await transformSnowdropPlugin(code, { sourceType: 'lx' })

        if (result.logs.length) {
          logger.log(`${CONSTANTS.LOG_PREFIX} Snowdrop transform logs:`, ...result.logs)
        }
        if (result.warnings.length) {
          logger.warn(
            `${CONSTANTS.LOG_PREFIX} Snowdrop transform warnings:`,
            ...result.warnings
          )
        }
        if (result.errors.length) {
          logger.error(
            `${CONSTANTS.LOG_PREFIX} Snowdrop transform errors:`,
            ...result.errors
          )
        }

        code = result.transformedCode
      }

      this.pluginCode = code
      this._initialize(logger)
      return this.plugin!
    } catch (error: any) {
      throw new PluginError(`无法加载插件 ${pluginPath}: ${error.message}`)
    }
  }

  /**
   * 从代码字符串加载插件
   * @param code 插件代码字符串
   * @param logger 日志记录器
   */
  async loadPluginFromCode(code: string, logger: Logger = console): Promise<SuchMusicPlugin | SuchPluginNew> {
    try {
      // 兼容旧版直接使用洛雪插件路径的配置
      if (isLxStylePluginCode(code)) {
        const result = await transformSnowdropPlugin(code, { sourceType: 'lx' })

        if (result.logs.length) {
          logger.log(`${CONSTANTS.LOG_PREFIX} Snowdrop transform logs:`, ...result.logs)
        }
        if (result.warnings.length) {
          logger.warn(
            `${CONSTANTS.LOG_PREFIX} Snowdrop transform warnings:`,
            ...result.warnings
          )
        }
        if (result.errors.length) {
          logger.error(
            `${CONSTANTS.LOG_PREFIX} Snowdrop transform errors:`,
            ...result.errors
          )
        }

        code = result.transformedCode
      }

      this.pluginCode = code
      this._initialize(logger)
      return this.plugin!
    } catch (error: any) {
      throw new PluginError(`无法加载插件代码: ${error.message}`)
    }
  }

  /**
   * 获取插件信息
   */
  getPluginInfo(): PluginInfo {
    this._ensurePluginInitialized()
    if (this.isNewStyle) {
      const plugin = this.plugin as SuchPluginNew
      return {
        name: plugin.name,
        version: plugin.version,
        author: plugin.author
      }
    }
    return (this.plugin as SuchMusicPlugin).pluginInfo
  }

  /**
   * 获取插件代码
   */
  getPluginCode(): string | null {
    return this.pluginCode
  }

  /**
   * 获取支持的音源和音质信息
   * 支持对象格式 { kw: {...}, wy: {...} } 或数组格式
   */
  getSupportedSources(): PluginSource[] | Record<string, PluginSource> {
    this._ensurePluginInitialized()
    if (this.isNewStyle) {
      const plugin = this.plugin as SuchPluginNew
      return plugin.source.map((s) => ({
        name: s,
        qualities: ['128k', '320k', 'flac'] // 默认支持的音质，如果需要更详细的控制，插件规范可能需要扩展
      }))
    }
    return (this.plugin as SuchMusicPlugin).sources
  }

  /**
   * 调用插件的 getMusicUrl 方法
   * @param source 音源标识
   * @param musicInfoOrId 音乐信息 或 音乐ID
   * @param quality 音质
   */
  async getMusicUrl(source: string, musicInfoOrId: MusicInfo | string, quality: string = '128k'): Promise<string> {
    this._ensurePluginInitialized()
    
    const startTime = Date.now()
    const musicId = typeof musicInfoOrId === 'string' ? musicInfoOrId : musicInfoOrId.id
    
    pluginLog.log(`${CONSTANTS.LOG_PREFIX} 开始调用插件的 getMusicUrl 方法...`)
    pluginLog.log(`${CONSTANTS.LOG_PREFIX} 参数: source=${source}, musicId=${musicId}, quality=${quality}`)

    try {
      let result: string
      if (this.isNewStyle) {
        const plugin = this.plugin as SuchPluginNew
        result = await plugin.getMusicUrl(source, String(musicId), quality)
      } else {
        // 旧版兼容
        let musicInfo: MusicInfo
        if (typeof musicInfoOrId === 'string') {
          musicInfo = { id: musicInfoOrId } as MusicInfo
        } else {
          musicInfo = musicInfoOrId
        }
        result = await this._callPluginMethod('musicUrl', source, musicInfo, quality)
      }
      
      const executionTime = Date.now() - startTime
      pluginLog.log(`${CONSTANTS.LOG_PREFIX} getMusicUrl 方法调用成功`)
      pluginLog.log(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
      pluginLog.log(`${CONSTANTS.LOG_PREFIX} 结果: ${result}`)
      
      return result
    } catch (error: any) {
      const executionTime = Date.now() - startTime
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} getMusicUrl 方法执行失败:`, error.message)
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} 错误堆栈:`, error.stack)
      throw error
    }
  }

  /**
   * 搜索音乐
   * @param source 音源标识
   * @param query 搜索关键词
   * @param page 页码
   * @param limit 每页数量
   */
  async search(source: string, query: string, page: number, limit: number): Promise<any> {
    this._ensurePluginInitialized()
    
    const startTime = Date.now()
    
    pluginLog.log(`${CONSTANTS.LOG_PREFIX} 开始调用插件的 search 方法...`)
    pluginLog.log(`${CONSTANTS.LOG_PREFIX} 参数: source=${source}, query=${query}, page=${page}, limit=${limit}`)

    try {
      let result: any
      if (this.isNewStyle) {
        const plugin = this.plugin as SuchPluginNew
        result = await plugin.search(source, query, page, limit)
        
        const executionTime = Date.now() - startTime
        pluginLog.log(`${CONSTANTS.LOG_PREFIX} search 方法调用成功`)
        pluginLog.log(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
        pluginLog.log(`${CONSTANTS.LOG_PREFIX} 结果类型: ${typeof result}`)
        if (Array.isArray(result)) {
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} 结果数量: ${result.length}`)
        }
      } else {
        throw new PluginError('Search not supported in old style plugin.')
      }
      
      return result
    } catch (error: any) {
      const executionTime = Date.now() - startTime
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} search 方法执行失败:`, error.message)
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} 错误堆栈:`, error.stack)
      throw error
    }
  }

  /**
   * 检查插件更新
   * 优先使用插件自身的 checkUpdate() 返回值，其次等待异步 updateAlert 通知
   * 事件驱动插件通过异步 HTTP 请求获取更新信息，本方法会最多等待 17 秒
   * @returns 更新信息对象（含 version、log、url），或 null 表示当前无可用更新
   */
  async checkUpdate(): Promise<any> {
    this._ensurePluginInitialized()
    
    const startTime = Date.now()
    
    pluginLog.log(`${CONSTANTS.LOG_PREFIX} 开始调用插件的 checkUpdate 方法...`)

    try {
      let result: any = null
      if (this.isNewStyle) {
        const plugin = this.plugin as SuchPluginNew
        if (typeof plugin.checkUpdate === 'function') {
          result = await plugin.checkUpdate()
          const executionTime = Date.now() - startTime
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} checkUpdate 方法调用成功`)
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} 结果:`, result)
        } else {
          const executionTime = Date.now() - startTime
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} checkUpdate 方法不存在`)
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
        }
      }
      
      if (result && result.version) {
        return result
      }
      
      if (this._pendingUpdateInfo) {
        pluginLog.log(`${CONSTANTS.LOG_PREFIX} 返回插件运行时缓存的更新信息`)
        return this._pendingUpdateInfo
      }
      
      // 等待异步 updateAlert 通知（最多等待 17 秒）
      // 沙箱中 suchmusic.request() 默认超时为 15 秒
      // 等待足够长的时间以确保沙箱的 HTTP 请求有机会完成或超时
      pluginLog.log(`${CONSTANTS.LOG_PREFIX} 等待插件异步更新通知（最多 17 秒）...`)
      await Promise.race([
        new Promise<void>(resolve => {
          this._updatePromiseResolve = resolve
        }),
        new Promise<void>(resolve => setTimeout(() => {
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} 等待异步更新通知超时`)
          resolve()
        }, 17000))
      ])
      
      if (this._updatePromiseResolve) {
        this._updatePromiseResolve = null
      }
      
      if (this._pendingUpdateInfo) {
        const executionTime = Date.now() - startTime
        pluginLog.log(`${CONSTANTS.LOG_PREFIX} 异步获取到插件更新信息`)
        pluginLog.log(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
        return this._pendingUpdateInfo
      }
      
      const executionTime = Date.now() - startTime
      pluginLog.log(`${CONSTANTS.LOG_PREFIX} 未检测到可用更新，执行时间: ${executionTime}ms`)
      return null
    } catch (error: any) {
      const executionTime = Date.now() - startTime
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} checkUpdate 方法执行失败:`, error.message)
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} 错误堆栈:`, error.stack)
      throw error
    }
  }

  /**
   * 调用插件的 getPic 方法
   * @param source 音源标识
   * @param musicInfo 音乐信息
   */
  async getPic(source: string, musicInfo: MusicInfo): Promise<string> {
    this._ensurePluginInitialized()
    
    const startTime = Date.now()
    const musicId = musicInfo.id
    
    pluginLog.log(`${CONSTANTS.LOG_PREFIX} 开始调用插件的 getPic 方法...`)
    pluginLog.log(`${CONSTANTS.LOG_PREFIX} 参数: source=${source}, musicId=${musicId}`)

    try {
      let result: string = ''
      if (this.isNewStyle) {
        const plugin = this.plugin as SuchPluginNew
        if (typeof plugin.getPic === 'function') {
          result = await plugin.getPic(source, String(musicId))
          const executionTime = Date.now() - startTime
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} getPic 方法调用成功`)
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} 结果: ${result}`)
        } else {
          const executionTime = Date.now() - startTime
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} getPic 方法不存在，返回空字符串`)
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
        }
      } else {
        result = await this._callPluginMethod('getPic', source, musicInfo)
        const executionTime = Date.now() - startTime
        pluginLog.log(`${CONSTANTS.LOG_PREFIX} getPic 方法调用成功`)
        pluginLog.log(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
        pluginLog.log(`${CONSTANTS.LOG_PREFIX} 结果: ${result}`)
      }
      
      return result
    } catch (error: any) {
      const executionTime = Date.now() - startTime
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} getPic 方法执行失败:`, error.message)
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} 错误堆栈:`, error.stack)
      throw error
    }
  }

  /**
   * 调用插件的 getLyric 方法
   * @param source 音源标识
   * @param musicInfo 音乐信息
   */
  async getLyric(source: string, musicInfo: MusicInfo): Promise<string> {
    this._ensurePluginInitialized()
    
    const startTime = Date.now()
    const musicId = musicInfo.id
    
    pluginLog.log(`${CONSTANTS.LOG_PREFIX} 开始调用插件的 getLyric 方法...`)
    pluginLog.log(`${CONSTANTS.LOG_PREFIX} 参数: source=${source}, musicId=${musicId}`)

    try {
      let result: string = ''
      if (this.isNewStyle) {
        const plugin = this.plugin as SuchPluginNew
        if (typeof plugin.getLyric === 'function') {
          result = await plugin.getLyric(source, String(musicId))
          const executionTime = Date.now() - startTime
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} getLyric 方法调用成功`)
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} 结果长度: ${result.length} 字符`)
        } else {
          const executionTime = Date.now() - startTime
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} getLyric 方法不存在，返回空字符串`)
          pluginLog.log(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
        }
      } else {
        result = await this._callPluginMethod('getLyric', source, musicInfo)
        const executionTime = Date.now() - startTime
        pluginLog.log(`${CONSTANTS.LOG_PREFIX} getLyric 方法调用成功`)
        pluginLog.log(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
        pluginLog.log(`${CONSTANTS.LOG_PREFIX} 结果长度: ${result.length} 字符`)
      }
      
      return result
    } catch (error: any) {
      const executionTime = Date.now() - startTime
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} getLyric 方法执行失败:`, error.message)
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} 错误堆栈:`, error.stack)
      throw error
    }
  }

  /**
   * 判断是否为新版插件
   */
  get isNewStylePlugin(): boolean {
    return this.isNewStyle
  }

  // ==================== 私有方法 ====================

  /**
   * 初始化沙箱环境，加载并验证插件
   * @private
   */
  private _initialize(logger: Logger): void {
    if (!this.pluginCode) {
      throw new PluginError('No plugin code provided.')
    }

    const sandbox = this._createSandbox(logger)

    try {
      vm.createContext(sandbox)
      vm.runInContext(this.pluginCode, sandbox)

      if (sandbox.source) {
        this.plugin = sandbox.source
        this.isNewStyle = true
      } else {
        this.plugin = sandbox.module.exports as SuchMusicPlugin
        this.isNewStyle = false
      }

      this._validatePlugin()

      const name = this.isNewStyle 
        ? (this.plugin as SuchPluginNew).name || 'Unknown'
        : (this.plugin as SuchMusicPlugin).pluginInfo.name

      logger.log(
        `${CONSTANTS.LOG_PREFIX} Plugin "${name}" loaded successfully.`
      )
    } catch (error: any) {
      logger.error(`${CONSTANTS.LOG_PREFIX} Error executing plugin code:`, error)
      throw new PluginError('无法初始化Such插件,可能是插件格式不正确.' + error.message)
    }
  }

  /**
   * 创建沙箱环境
   * @private
   */
  private _createSandbox(logger: Logger): any {
    const sandbox: any = {
      module: { exports: {} },
      suchmusic: this._getSuchmusicApi(),
      console: logger,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Buffer,
      JSON,
      require: () => ({}),
      process: { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } }
    }
    
    // 配置 window 和 notify
    sandbox.global = sandbox
    sandbox.globalThis = sandbox
    sandbox.window = sandbox
    
    // 注入 notify
    sandbox.notify = (title: string, type: string = 'info') => {
       const noticeCenter = this._createNoticeCenter()
       noticeCenter(type as any, { title, pluginInfo: { type: 'lx' } })
    }

    return sandbox
  }

  /**
   * 验证插件结构
   * @private
   */
  private _validatePlugin(): void {
    if (this.isNewStyle) {
      const plugin = this.plugin as SuchPluginNew
      if (typeof plugin !== 'object' || plugin === null) {
        throw new PluginError('Invalid new style plugin: window.source must be an object.')
      }
      if (!Array.isArray(plugin.source)) {
         throw new PluginError('Invalid new style plugin: source must be an array of strings.')
      }
      if (typeof plugin.search !== 'function') {
         throw new PluginError('Invalid new style plugin: search function is missing.')
      }
      if (typeof plugin.getMusicUrl !== 'function') {
         throw new PluginError('Invalid new style plugin: getMusicUrl function is missing.')
      }
    } else {
      const plugin = this.plugin as SuchMusicPlugin
      if (!plugin?.pluginInfo || !plugin.sources || !plugin.musicUrl) {
        throw new PluginError(
          'Invalid plugin structure. Required fields: pluginInfo, sources, musicUrl.'
        )
      }
    }
  }

  /**
   * 确保插件已初始化
   * @private
   */
  private _ensurePluginInitialized(): void {
    if (!this.plugin) {
      throw new PluginError('Plugin not initialized')
    }
  }

  /**
   * 统一的插件方法调用逻辑 (仅用于旧版插件)
   * @private
   */
  private async _callPluginMethod(
    methodName: PluginMethodName,
    ...args: readonly any[]
  ): Promise<string> {
    this._ensurePluginInitialized()
    const method = (this.plugin as SuchMusicPlugin)[methodName] as any
    if (typeof method !== 'function') {
      throw new PluginError(`Action "${methodName}" is not implemented in plugin.`, methodName)
    }
    try {
      pluginLog.log(`${CONSTANTS.LOG_PREFIX} 开始调用插件的 ${methodName} 方法...`)

      const result = await method.call(...[{ suchmusic: this._getSuchmusicApi() }], ...args)

      pluginLog.log(`${CONSTANTS.LOG_PREFIX} 插件 ${methodName} 方法调用成功`)
      return result
    } catch (error: any) {
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} ${methodName} 方法执行失败:`, error.message)
      if (methodName === 'musicUrl') {
        pluginLog.error(`${CONSTANTS.LOG_PREFIX} 错误堆栈:`, error.stack)
      }
      throw new PluginError(`Plugin ${methodName} failed: ${error.message}`, methodName)
    }
  }

  // ==================== 工具方法 ====================

  /**
   * 解析响应体
   * @private
   */
  private async _parseResponseBody(response: any): Promise<any> {
    const contentType = response.headers.get('content-type') || ''

    try {
      if (contentType.includes('application/json')) {
        return await response.json()
      } else if (contentType.includes('text/')) {
        return await response.text()
      } else {
        // 对于其他类型，尝试解析为 JSON，失败则返回文本
        const text = await response.text()
        try {
          return JSON.parse(text)
        } catch {
          return text
        }
      }
    } catch (parseError: any) {
      console.error(`${CONSTANTS.LOG_PREFIX} 解析响应失败: ${parseError.message}`)
      return {
        error: 'Parse failed',
        message: parseError.message,
        statusCode: response.status
      }
    }
  }

  /**
   * 创建错误结果
   * @private
   */
  private _createErrorResult(error: any, url: string): RequestResult {
    const isTimeout = error.name === 'AbortError'
    return {
      body: {
        error: error.name || 'RequestError',
        message: error.message,
        url
      },
      statusCode: isTimeout ? 408 : 500,
      headers: {}
    }
  }

  // ==================== API 构建方法 ====================

  /**
   * 获取 suchmusic API 对象
   * @private
   */
  private _getSuchmusicApi(): SuchMusicApi {
    return {
      env: CONSTANTS.ENVIRONMENT,
      version: CONSTANTS.API_VERSION,
      utils: this._createApiUtils(),
      request: this._createRequestFunction(),
      NoticeCenter: this._createNoticeCenter()
    }
  }

  /**
   * 创建 API 工具对象
   * @private
   */
  private _createApiUtils(): SuchMusicApiUtils {
    // 验证编码格式是否支持
    const validateEncoding = (encoding?: BufferEncoding): BufferEncoding => {
      const supportedEncodings = ['base64', 'hex', 'utf8']
      if (encoding && !supportedEncodings.includes(encoding)) {
        throw new Error(
          `Unsupported encoding: ${encoding}. Only ${supportedEncodings.join(', ')} are supported.`
        )
      }
      return encoding || 'utf8'
    }

    // 验证AES模式是否支持
    const validateAesMode = (mode: string): string => {
      const supportedModes = ['aes-128-cbc', 'aes-128-ecb']
      if (!supportedModes.includes(mode)) {
        throw new Error(
          `Unsupported AES mode: ${mode}. Only ${supportedModes.join(', ')} are supported.`
        )
      }
      return mode
    }

    return {
      buffer: {
        from: (data: string | Buffer | ArrayBuffer, encoding?: BufferEncoding) => {
          if (typeof data === 'string') {
            const validatedEncoding = validateEncoding(encoding)
            return Buffer.from(data, validatedEncoding)
          } else if (data instanceof Buffer) {
            return data
          } else if (data instanceof ArrayBuffer) {
            return Buffer.from(new Uint8Array(data))
          } else {
            return Buffer.from(data as any)
          }
        },
        bufToString: (buffer: Buffer, encoding?: BufferEncoding) => {
          const validatedEncoding = validateEncoding(encoding)
          return buffer.toString(validatedEncoding)
        }
      },
      crypto: {
        aesEncrypt: (data: any, mode: string, key: string | Buffer, iv?: string | Buffer) => {
          // AES 加密实现
          const validatedMode = validateAesMode(mode)
          const cipher = crypto.createCipheriv(
            validatedMode,
            key,
            validatedMode === 'aes-128-ecb' ? Buffer.alloc(0) : iv || Buffer.alloc(0)
          )
          let encrypted
          if (typeof data === 'string') {
            encrypted = cipher.update(data, 'utf8')
          } else if (Buffer.isBuffer(data)) {
            encrypted = cipher.update(data)
          } else {
            encrypted = cipher.update(JSON.stringify(data), 'utf8')
          }
          encrypted = Buffer.concat([encrypted, cipher.final()])
          return encrypted
        },
        md5: (str: string) => {
          // MD5 哈希实现
          return crypto.createHash('md5').update(str).digest('hex')
        },
        randomBytes: (size: number) => {
          // 生成随机字节
          return crypto.randomBytes(size)
        },
        rsaEncrypt: (data: string, key: string) => {
          // RSA 加密实现
          // 注意：这里假设 key 是 PEM 格式的公钥
          const encrypted = crypto.publicEncrypt(
            { key, padding: crypto.constants.RSA_PKCS1_PADDING },
            Buffer.from(data, 'utf8')
          )
          return encrypted.toString('base64')
        }
      }
    }
  }

  /**
   * 创建请求函数
   * @private
   */
  private _createRequestFunction() {
    return (
      url: string,
      options?: RequestOptions | RequestCallback,
      callback?: RequestCallback
    ) => {
      // 支持 Promise 和 callback 两种调用方式
      if (typeof options === 'function') {
        callback = options as RequestCallback
        options = { method: 'GET' }
      }

      const requestOptions = options as RequestOptions
      const makeRequest = () => this._makeHttpRequest(url, requestOptions)

      // 执行请求
      if (callback) {
        makeRequest()
          .then((result) => callback(null, result))
          .catch((error) => {
            const errorResult = this._createErrorResult(error, url)
            callback(error, errorResult)
          })
        return undefined
      } else {
        return makeRequest()
      }
    }
  }

  /**
   * 执行 HTTP 请求
   * @private
   */
  private async _makeHttpRequest(url: string, options: RequestOptions): Promise<RequestResult> {
    const controller = new AbortController()
    const timeout = options.timeout || CONSTANTS.DEFAULT_TIMEOUT
    const startTime = Date.now()
    const method = options.method || 'GET'

    pluginLog.log(`${CONSTANTS.LOG_PREFIX} 发起HTTP请求: ${method} ${url}`)
    pluginLog.log(`${CONSTANTS.LOG_PREFIX} 请求选项:`, {
      timeout,
      headers: options.headers,
      hasBody: !!options.body
    })

    const timeoutId = setTimeout(() => {
      controller.abort()
      pluginLog.warn(`${CONSTANTS.LOG_PREFIX} 请求超时: ${url}`)
    }, timeout)

    try {
      const fetchOptions: Record<string, any> = {
        method: 'GET',
        ...options,
        signal: controller.signal
      }

      const response = await fetch(url, fetchOptions)
      clearTimeout(timeoutId)
      
      const executionTime = Date.now() - startTime
      pluginLog.log(`${CONSTANTS.LOG_PREFIX} 请求响应: ${response.status} ${response.statusText}`)
      pluginLog.log(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)

      const body = await this._parseResponseBody(response)
      const headers = this._extractHeaders(response)

      const result: RequestResult = {
        body,
        statusCode: response.status,
        headers
      }

      pluginLog.log(`${CONSTANTS.LOG_PREFIX} 请求完成:`, {
        url,
        status: response.status,
        bodyType: typeof body
      })

      return result
    } catch (error: any) {
      clearTimeout(timeoutId)
      const executionTime = Date.now() - startTime

      const errorMessage =
        error.name === 'AbortError' ? `请求超时: ${url}` : `请求失败: ${error.message}`

      pluginLog.error(`${CONSTANTS.LOG_PREFIX} ${errorMessage}`)
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} 执行时间: ${executionTime}ms`)
      if (error.cause) {
        pluginLog.error(`${CONSTANTS.LOG_PREFIX} 错误原因:`, error.cause)
      }
      pluginLog.error(`${CONSTANTS.LOG_PREFIX} 错误堆栈:`, error.stack)
      
      return this._createErrorResult(error, url)
    }
  }

  /**
   * 提取响应头
   * @private
   */
  private _extractHeaders(response: any): Record<string, string> {
    const headers: Record<string, string> = {}
    response.headers.forEach((value: string, key: string) => {
      headers[key] = value
    })
    return headers
  }

  /**
   * 创建通知中心
   * 插件通过此 API 发送通知，update 类型通知会被缓存供 checkUpdate() 查询
   * @returns 通知中心函数
   * @private
   */
  private _createNoticeCenter() {
    return (type: string, data: any) => {
      if (type === 'update' && data) {
        this._pendingUpdateInfo = {
          version: data.version,
          log: data.content || data.log,
          url: data.url
        }
        if (this._updatePromiseResolve) {
          this._updatePromiseResolve()
          this._updatePromiseResolve = null
        }
      }

      const sendNotice = () => {
        let pluginName = 'Unknown'
        let version = '0.0.0'
        
        if (this.plugin) {
             const info = this.getPluginInfo()
             pluginName = info.name
             version = info.version
        } else if (data?.pluginInfo?.name) {
             pluginName = data.pluginInfo.name
             version = data.pluginInfo.version || '0.0.0'
        }

        sendPluginNotice(
          { type: type as any, data, currentVersion: version },
          pluginName
        )
      }
      sendNotice()
    }
  }
}

export default SuchMusicPluginHost
