/**
 * 洛雪 LX Music v2 desktop 自定义源宿主
 *
 * 负责在沙箱内提供 `globalThis.lx` 运行时，加载插件脚本，
 * 等待 inited 事件获取能力声明，并向插件派发 request 事件
 * （musicUrl / lyric / pic）。
 *
 * 参考：https://lxmusic.toside.cn/desktop/custom-source
 */
import { basename, extname } from 'path'
import { createHash } from 'crypto'
import {
  randomBytes as nodeRandomBytes,
  createCipheriv,
  publicEncrypt,
  constants as cryptoConstants
} from 'crypto'
import zlib from 'zlib'
import { createSandbox, withTimeout, type Sandbox } from './sandbox'
import { parseLxHeader, type LxScriptInfo } from './detect'
import { normalizeQuality } from './quality'
import { expandSourceKeys } from './types'
import type {
  LyricRequest,
  LyricResult,
  PicResult,
  PluginSourceInfo,
  QualityId,
  ResolveRequest,
  ResolveResult,
  SourceCapability,
  SourceHost
} from './types'

/** 洛雪事件名常量 */
const EVENT_NAMES = {
  inited: 'inited',
  request: 'request',
  updateAlert: 'updateAlert'
} as const

/**
 * 洛雪音质标识的完整顺序（低 → 高）。
 * 比宿主 QualityId 多出插件常用的 `192k` / `24bit`，收敛音质时按原始标识回传，
 * 不能再用 normalizeQuality 二次换算，否则会把 192k 抬成 320k 而遭插件拒绝。
 */
const LX_QUALITY_ORDER = [
  '128k',
  '192k',
  '320k',
  'flac',
  'flac24bit',
  '24bit',
  'hires',
  'atmos',
  'atmos_plus',
  'master'
]

/** 单个平台源的能力声明 */
interface LxSourceDecl {
  name?: string
  type?: string
  actions?: string[]
  qualitys?: string[]
}

/** inited 事件载荷 */
interface LxInitedPayload {
  openDevTools?: boolean
  sources?: Record<string, LxSourceDecl>
}

export interface LxHostDeps {
  /** 插件上报通知（updateAlert / log） */
  onNotice?: (notice: { type: string; pluginId: string; [k: string]: any }) => void
  /** 主进程日志 */
  onLog?: (level: 'log' | 'warn' | 'error', args: any[]) => void
}

/** 根据文件路径与头部信息生成稳定插件 id */
function buildPluginId(info: LxScriptInfo, filePath: string): string {
  const raw = info.name?.trim() || basename(filePath, extname(filePath))
  const slug = raw.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 32) || 'source'
  const hash = createHash('md5').update(filePath).digest('hex').slice(0, 6)
  return `lx.${slug}-${hash}`
}

export class LxSourceHost implements SourceHost {
  readonly kind = 'lx' as const
  readonly filePath: string
  readonly scriptInfo: LxScriptInfo
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly author?: string
  readonly homepage?: string

  private code: string
  private deps: LxHostDeps
  private sandbox: Sandbox | null = null
  private handlers: Record<string, (data: any) => Promise<any>> = {}
  private sources: Record<string, LxSourceDecl> = {}
  private updateAlert?: { log?: string; updateUrl?: string }
  private disposed = false
  private initedResolve: (() => void) | null = null

  constructor(filePath: string, code: string, deps: LxHostDeps = {}) {
    this.filePath = filePath
    this.code = code
    this.deps = deps
    this.scriptInfo = parseLxHeader(code)
    this.id = buildPluginId(this.scriptInfo, filePath)
    this.name = this.scriptInfo.name?.trim() || basename(filePath)
    this.version = this.scriptInfo.version?.trim() || '0.0.0'
    this.description = this.scriptInfo.description?.trim() || undefined
    this.author = this.scriptInfo.author?.trim() || undefined
    this.homepage = this.scriptInfo.homepage?.trim() || undefined
  }

  /** 构建 lx 工具集 */
  private buildUtils(): Record<string, any> {
    return {
      buffer: {
        from: (data: any, encoding?: BufferEncoding): Buffer => Buffer.from(data, encoding),
        bufToString: (buf: Buffer, format?: BufferEncoding): string =>
          Buffer.isBuffer(buf) ? buf.toString(format ?? 'utf-8') : String(buf)
      },
      crypto: {
        md5: (str: string): string => createHash('md5').update(str).digest('hex'),
        randomBytes: (size: number): string => nodeRandomBytes(size).toString('hex'),
        aesEncrypt: (
          buffer: Buffer,
          mode: string,
          key: Buffer | string,
          iv?: Buffer | string
        ): Buffer => {
          const cipher = createCipheriv(mode as any, key as any, (iv ?? null) as any)
          return Buffer.concat([cipher.update(buffer), cipher.final()])
        },
        rsaEncrypt: (buffer: Buffer, key: string): Buffer =>
          publicEncrypt({ key, padding: cryptoConstants.RSA_PKCS1_PADDING }, buffer)
      },
      zlib: {
        inflate: (buffer: Buffer): Promise<Buffer> => Promise.resolve(zlib.inflateSync(buffer)),
        deflate: (buffer: Buffer): Promise<Buffer> => Promise.resolve(zlib.deflateSync(buffer)),
        inflateRaw: (buffer: Buffer): Promise<Buffer> =>
          Promise.resolve(zlib.inflateRawSync(buffer))
      }
    }
  }

  /** 构造注入沙箱的 lx 对象 */
  private buildLx(): Record<string, any> {
    const host = this
    return {
      version: 2,
      env: 'desktop',
      currentScriptInfo: {
        name: this.scriptInfo.name,
        description: this.scriptInfo.description,
        version: this.scriptInfo.version,
        author: this.scriptInfo.author,
        homepage: this.scriptInfo.homepage,
        rawScript: this.code
      },
      EVENT_NAMES,
      on(eventName: string, handler: (data: any) => Promise<any>): void {
        host.handlers[eventName] = handler
      },
      send(eventName: string, data: any): void {
        host.handleSend(eventName, data)
      },
      request: (url: string, options: any, callback: (err: any, resp?: any, body?: any) => void) =>
        host.lxRequest(url, options, callback),
      utils: this.buildUtils()
    }
  }

  /** 处理插件主动发送的事件 */
  private handleSend(eventName: string, data: any): void {
    if (eventName === EVENT_NAMES.inited) {
      const payload = (data ?? {}) as LxInitedPayload
      this.sources = payload.sources ?? {}
      this.initedResolve?.()
    } else if (eventName === EVENT_NAMES.updateAlert) {
      const alert = { log: data?.log, updateUrl: data?.updateUrl }
      this.updateAlert = alert
      this.deps.onNotice?.({ type: 'updateAlert', pluginId: this.id, ...alert })
    }
  }

  /** 实现 lx.request：基于 node fetch，返回取消函数 */
  private lxRequest(
    url: string,
    options: any,
    callback: (err: any, resp?: any, body?: any) => void
  ): () => void {
    const ac = new AbortController()
    const timeout = typeof options?.timeout === 'number' ? options.timeout : 0
    let timer: ReturnType<typeof setTimeout> | null = null
    if (timeout > 0) {
      timer = setTimeout(() => ac.abort(new Error('request timeout')), timeout)
    }

    void (async () => {
      try {
        const method: string = (options?.method || 'GET').toUpperCase()
        const headers: Record<string, string> = { ...(options?.headers ?? {}) }
        const init: RequestInit = { method, headers, signal: ac.signal, redirect: 'follow' }

        if (options?.body != null) {
          init.body = options.body
        } else if (options?.form) {
          init.body = new URLSearchParams(options.form).toString()
          if (!headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
          }
        } else if (options?.formData) {
          const fd = new FormData()
          for (const key of Object.keys(options.formData)) {
            const v = options.formData[key]
            if (v && typeof v === 'object' && 'value' in v) {
              fd.append(key, v.value, v.fileName)
            } else {
              fd.append(key, v)
            }
          }
          init.body = fd as any
          delete headers['Content-Type']
          delete headers['content-type']
        }

        const resp = await fetch(url, init)
        const text = await resp.text()
        const contentType = resp.headers.get('content-type') || ''
        let body: any = text
        if (/json/i.test(contentType)) {
          try {
            body = JSON.parse(text)
          } catch {
            body = text
          }
        }
        callback(
          null,
          {
            statusCode: resp.status,
            statusMessage: resp.statusText,
            headers: Object.fromEntries(resp.headers.entries()),
            body
          },
          body
        )
      } catch (err) {
        callback(err)
      } finally {
        if (timer) clearTimeout(timer)
      }
    })()

    return () => ac.abort()
  }

  /** 初始化：执行脚本 + 等待 inited */
  async init(): Promise<void> {
    const initedPromise = new Promise<void>((resolve) => {
      this.initedResolve = resolve
    })

    this.sandbox = createSandbox(this.id, {
      extra: { lx: this.buildLx() },
      onLog: this.deps.onLog
    })

    try {
      this.sandbox.run(this.code, basename(this.filePath))
    } catch (err) {
      await this.dispose()
      throw new Error(`洛雪插件执行失败: ${(err as Error).message}`)
    }

    try {
      await withTimeout(initedPromise, 5000, '洛雪插件未在 5 秒内发送 inited 事件')
    } catch (err) {
      await this.dispose()
      throw err
    }

    if (!this.sources || Object.keys(this.sources).length === 0) {
      await this.dispose()
      throw new Error('洛雪插件未声明任何音源（sources 为空）')
    }
  }

  /** 释放资源 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.sandbox?.clearTimers()
    this.sandbox = null
    this.handlers = {}
    this.initedResolve = null
  }

  /** 构造能力摘要 */
  getCapabilities(): PluginSourceInfo['capabilities'] {
    const sources: SourceCapability[] = Object.keys(this.sources).map((key) => {
      const decl = this.sources[key] ?? {}
      const defaultActions = key === 'local' ? ['musicUrl', 'lyric', 'pic'] : ['musicUrl']
      const qualities = (decl.qualitys ?? [])
        .map((q) => normalizeQuality(q))
        .filter((q, i, arr) => arr.indexOf(q) === i) as QualityId[]
      return {
        key,
        name: decl.name || key,
        actions:
          Array.isArray(decl.actions) && decl.actions.length > 0 ? decl.actions : defaultActions,
        qualities
      }
    })
    return {
      sources,
      canSearch: false,
      canBrowsePlaylist: false
    }
  }

  /** 插件上报的更新提示 */
  getUpdateAlert(): { log?: string; updateUrl?: string } | undefined {
    return this.updateAlert
  }

  /**
   * 把外部传入的平台标识映射到插件真正声明过的 key。
   * 兼容大小写差异与别名（如调用方传 qq，插件声明的是 tx）。
   */
  matchSourceKey(sourceKey: string | undefined): string | undefined {
    if (!sourceKey) return undefined
    const declared = Object.keys(this.sources)
    if (declared.length === 0) return undefined
    const byLower = new Map(declared.map((key) => [key.toLowerCase(), key]))
    const candidates = expandSourceKeys(sourceKey)
    for (const candidate of candidates) {
      const hit = byLower.get(candidate)
      if (hit) return hit
    }
    return undefined
  }

  /** 是否有支持指定 source 的某动作 */
  supports(sourceKey: string | undefined, action: string): boolean {
    const key = this.matchSourceKey(sourceKey)
    if (!key) return false
    const decl = this.sources[key]
    if (!decl) return false
    const actions =
      Array.isArray(decl.actions) && decl.actions.length > 0
        ? decl.actions
        : key === 'local'
          ? ['musicUrl', 'lyric', 'pic']
          : ['musicUrl']
    return actions.includes(action)
  }

  /**
   * 从插件声明的音质中挑出不超过请求等级的最高项。
   * 部分插件会直接拒绝未声明的音质（而不是自行降级），因此宿主必须先收敛请求。
   */
  private pickDeclaredQuality(sourceKey: string, requested: QualityId): string {
    const declaredRaw = this.sources[sourceKey]?.qualitys ?? []
    if (declaredRaw.length === 0) return requested
    const reqIndex =
      LX_QUALITY_ORDER.indexOf(requested) === -1 ? LX_QUALITY_ORDER.indexOf('320k') : LX_QUALITY_ORDER.indexOf(requested)
    const available = declaredRaw
      .map((q) => String(q).toLowerCase())
      .filter((q) => LX_QUALITY_ORDER.includes(q))
    if (available.length === 0) return requested
    // 优先「不高于请求等级」的最高项；都高于请求时取最低可用
    let best: string | undefined
    for (const q of available) {
      const idx = LX_QUALITY_ORDER.indexOf(q)
      if (idx <= reqIndex && (!best || idx > LX_QUALITY_ORDER.indexOf(best))) best = q
    }
    if (!best) {
      best = available.reduce((a, b) =>
        LX_QUALITY_ORDER.indexOf(a) <= LX_QUALITY_ORDER.indexOf(b) ? a : b
      )
    }
    return best
  }

  /** 构造 musicInfo（超集，兼容不同源的字段命名；ref 原样透传） */
  private buildMusicInfo(sourceKey: string, id: string, ref?: unknown): Record<string, any> {
    const r = (ref ?? {}) as Record<string, any>
    return {
      id,
      songmid: r.songmid ?? r.mid ?? id,
      mid: r.mid ?? r.songmid ?? id,
      name: r.name ?? r.song ?? r.title,
      singer: r.singer ?? r.artist,
      albumName: r.albumName ?? r.album,
      albumId: r.albumId,
      source: sourceKey,
      ...r
    }
  }

  private async callRequest(
    source: string,
    action: string,
    info: Record<string, any>,
    timeoutMs = 30000
  ): Promise<any> {
    const handler = this.handlers[EVENT_NAMES.request]
    if (typeof handler !== 'function') {
      throw new Error('洛雪插件未注册 request 事件处理器')
    }
    const result = handler({ source, action, info })
    if (!result || typeof result.then !== 'function') {
      throw new Error('洛雪插件 request 处理器未返回 Promise')
    }
    return withTimeout(result, timeoutMs, `洛雪插件 ${action} 超时`)
  }

  async resolveUrl(req: ResolveRequest): Promise<ResolveResult> {
    const source = this.matchSourceKey(req.sourceKey)
    if (!source) {
      throw new Error(
        `该插件未声明音源「${req.sourceKey || '未知'}」（已声明：${Object.keys(this.sources).join('/') || '无'}）`
      )
    }
    const type = this.pickDeclaredQuality(source, req.quality)
    const url = await this.callRequest(source, 'musicUrl', {
      type,
      musicInfo: this.buildMusicInfo(source, req.id, req.ref)
    })
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('洛雪插件返回了无效的播放地址')
    }
    return { url }
  }

  async lyric(req: LyricRequest): Promise<LyricResult | null> {
    const source = this.matchSourceKey(req.sourceKey)
    if (!source) return null
    if (!this.supports(source, 'lyric')) return null
    const res = await this.callRequest(source, 'lyric', {
      musicInfo: this.buildMusicInfo(source, req.id, req.ref)
    })
    if (!res || typeof res !== 'object') return null
    return {
      lyrics: res.lyric || '',
      translatedLyrics: res.tlyric || '',
      romanLyrics: res.rlyric || res.lxlyric || ''
    }
  }

  async pic(req: LyricRequest): Promise<PicResult | null> {
    const source = this.matchSourceKey(req.sourceKey)
    if (!source) return null
    if (!this.supports(source, 'pic')) return null
    const url = await this.callRequest(source, 'pic', {
      musicInfo: this.buildMusicInfo(source, req.id, req.ref)
    })
    if (typeof url !== 'string' || !url) return null
    return { url }
  }
}
