/**
 * 澜音 Ceru v2 PluginContext 构建
 *
 * 为插件提供 `ctx`：配置、权限、HTTP、Provider 注册、歌词转换、存储和日志。
 * 宿主未接通的宿主服务（播放器 / 队列 / 下载 / 账号写操作等）统一抛出可识别的
 * 明确错误；而「激活阶段常被调用」的接口（effects.add / events.on / ui.toast /
 * account.getSession）退化为安全空实现，避免插件激活直接失败。
 *
 * 参考：https://ceru.docs.shiqianjiang.cn/guide/plugins/v2/plugin-context.html
 */
import { randomUUID } from 'crypto'
import {
  createCompressionModule,
  createCryptoModule,
  createEncodingModule,
  createLegacyHttpModule,
  createLodashSubset,
  createSdkStub,
  resolveBuiltinModuleName,
  type HostRealm
} from './modules'
import { createHttpModule, performHttpRequest, type OperationContext } from './http'
import type {
  CeruLyricLine,
  CeruManifest,
  CeruProviderImplementation,
  CrLyric,
  ResourceRef
} from './types'

/** Host API 版本（用于 ctx.host.apiVersion） */
export const HOST_API_VERSION = '2.0.0'

/** 宿主已接通的能力标识 */
const CONNECTED_CAPABILITIES = [
  'storage',
  'log',
  'config',
  'network',
  'ui.toast',
  'providers',
  'actions'
]

/** 宿主侧为构建 ctx 需要暴露的钩子 */
export interface CeruCtxHost {
  readonly manifest: CeruManifest
  readonly pluginId: string
  readonly pluginVersion: string

  /** 结构化日志 */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: any): void
  /** 收集一次性释放函数（dispose 时统一执行） */
  addEffect(fn: () => any): void

  /** 注册 Provider */
  registerProvider(id: string, impl: CeruProviderImplementation): () => void
  /** 注册 Action */
  registerAction(id: string, handler: (input: any, op: OperationContext) => any): () => void
  /** 注册歌词转换器 */
  registerLyricConverter(id: string, impl: any): () => void
  /** 注册歌单导入器 */
  registerPlaylistImporter(id: string, impl: any): () => void

  /** 插件私有 JSON 存储 */
  storageGet(key: string): Promise<any>
  storageSet(key: string, value: any): Promise<void>
  storageDelete(key: string): Promise<void>
  storageKeys(): Promise<string[]>
  storageClear(): Promise<void>

  /** 插件配置（已合并默认值） */
  getConfig(): Promise<Record<string, any>>
  /** 权限申请 */
  requestPermission(key: string): Promise<{ status: 'granted' | 'denied' | 'unknown' }>
  requestPermissionGroup(keys: string[]): Promise<{ status: 'granted' | 'denied' | 'unknown' }>
  queryPermission(key: string): Promise<'granted' | 'denied' | 'unknown'>
}

/** 构造一个操作上下文 */
export function createOperation(timeoutMs = 30000, connectionId?: string): OperationContext {
  const ac = new AbortController()
  const id = randomUUID()
  const timer = setTimeout(() => ac.abort(new Error('operation timeout')), timeoutMs)
  // 未捕获的 abort 事件不应导致主进程报错
  timer.unref?.()
  return { id, deadlineAt: Date.now() + timeoutMs, signal: ac.signal, connectionId }
}

/** 立即返回的释放函数 */
function noop(): void {
  // 无副作用
}

/** 未接通服务的统一替身：任意方法调用抛出明确错误 */
function unsupportedService(name: string): any {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'then') return undefined
        return () => {
          throw new Error(
            `澜音宿主尚未接通「${name}」服务，当前仅支持音源 Provider / HTTP / 存储 / 日志`
          )
        }
      }
    }
  )
}

/** 构造 CrLyric 空文档 */
export function emptyCrLyric(track: ResourceRef): CrLyric {
  return { format: 'crlyric', version: 1, track, offsetMs: 0, lines: [] }
}

/** 精简后的 ContentEntity（用于 Provider 内部构造） */
export function buildEntity(
  pluginId: string,
  providerId: string,
  id: string,
  extra: Record<string, any>
): any {
  return {
    ref: { pluginId, providerId, kind: 'track', id },
    capabilities: [],
    ...extra
  }
}

/**
 * 与 `ctx` 生命周期解耦的内建模块实例。
 *
 * 澜音 CLI 打包产物会把宿主模块编译成
 * `module.exports = globalThis.__ceruRequire('@ceru/xxx')`，而这类调用出现在
 * **模块文件顶层**（早于 `activate`，此时 `ctx` 尚未构建）。因此这些模块必须能在
 * 求值阶段就构造出来，不能依赖 `ctx`。
 */
export interface CeruHostModules {
  lodash: Record<string, any>
  crypto: Record<string, any>
  compression: Record<string, any>
  encoding: Record<string, any>
  http: Record<string, any>
  legacyHttp: Record<string, any>
}

/** 构造内建模块实例（每个插件宿主构造一次，`ctx.modules` 与 `__ceruRequire` 共用） */
export function createHostModules(host: CeruCtxHost, realm?: HostRealm): CeruHostModules {
  const http = createHttpModule({
    authorize: async (permissionKey) => {
      if (!permissionKey) return
      const status = await host.queryPermission(permissionKey)
      if (status === 'granted') return
      const grant = await host.requestPermission(permissionKey)
      if (grant.status !== 'granted') {
        throw new Error(`澜音插件缺少「${permissionKey}」权限，网络请求被拒绝`)
      }
    }
  })

  const legacyHttp = createLegacyHttpModule({
    request: (input) => performHttpRequest(input),
    authorize: async (permissionKey) => {
      if (!permissionKey) return
      const grant = await host.requestPermission(permissionKey)
      if (grant.status !== 'granted') {
        throw new Error(`澜音插件缺少「${permissionKey}」权限，网络请求被拒绝`)
      }
    },
    createOperation: () => createOperation(30000)
  })

  return {
    lodash: createLodashSubset(),
    crypto: createCryptoModule(realm),
    compression: createCompressionModule(),
    encoding: createEncodingModule(),
    http,
    legacyHttp
  }
}

/** 必须依赖 `ctx` 才能解析的内建模块名 */
const CTX_BOUND_MODULES = [
  'ceru',
  '@ceru/ui',
  '@ceru/socket',
  '@ceru/library',
  '@ceru/account',
  '@ceru/player',
  '@ceru/tools'
] as const

/** 判定内建模块是否依赖 ctx */
export function isCtxBoundModule(name: string): boolean {
  return (CTX_BOUND_MODULES as readonly string[]).includes(name)
}

/**
 * 解析宿主内建模块。
 * @param name `@ceru/*` / `lodash` / `ceru` 等模块名
 * @param modules 已构造的模块实例
 * @param ctx 已构建的插件上下文（未激活时传 null）
 */
export function resolveHostModule(
  name: string,
  modules: CeruHostModules,
  ctx: Record<string, any> | null
): any {
  switch (name) {
    case 'lodash':
      return modules.lodash
    case '@ceru/crypto':
      return modules.crypto
    case '@ceru/compression':
      return modules.compression
    case '@ceru/encoding':
      return modules.encoding
    case '@ceru/http':
      return modules.http
    case '@ceru/legacy-http':
      return modules.legacyHttp
    default:
      break
  }
  if (!isCtxBoundModule(name)) {
    throw new Error(`澜音宿主未内置模块: ${name}`)
  }
  if (!ctx) {
    throw new Error(`澜音宿主尚未初始化，无法访问内建模块 ${name}`)
  }
  switch (name) {
    case 'ceru':
      return ctx
    case '@ceru/ui':
      return ctx.ui
    case '@ceru/socket':
      return ctx.sockets
    case '@ceru/library':
      return ctx.library
    case '@ceru/account':
      return ctx.account
    case '@ceru/player':
      return ctx.player
    case '@ceru/tools':
      return ctx.utils
    default:
      throw new Error(`澜音宿主未内置模块: ${name}`)
  }
}

/**
 * 构建 `ctx`
 * @param host 宿主钩子
 * @param modules 已构造的内建模块实例（可传入宿主复用的那一份）
 */
export function buildPluginContext(
  host: CeruCtxHost,
  modules: CeruHostModules = createHostModules(host)
): Record<string, any> {
  const manifest = host.manifest
  const sdk = createSdkStub()
  const { lodash, http: httpModule } = modules

  /** 解析内置模块（ctx 就绪后按需取，与 `__ceruRequire` 走同一张表） */
  const resolveBuiltin = (name: string): any => {
    if (!resolveBuiltinModuleName(name)) {
      throw new Error(`澜音宿主未内置模块: ${name}`)
    }
    return resolveHostModule(name, modules, ctx)
  }

  const effects = {
    add(fn: any): void {
      if (typeof fn === 'function') host.addEffect(fn)
    }
  }

  const events = {
    // 宿主未实现事件总线：返回可注销的空实现，避免激活阶段报错
    on: (): (() => void) => noop,
    once: (): (() => void) => noop,
    emit: (): void => {
      // 无订阅者
    }
  }

  const ui = {
    async toast(_input?: any): Promise<void> {
      host.log('info', 'ui.toast', _input)
    },
    async notify(input?: any): Promise<void> {
      host.log('info', 'ui.notify', input)
    },
    navigation: {
      async open(input?: any): Promise<void> {
        host.log('info', 'ui.navigation.open', input)
      },
      async close(): Promise<void> {
        // 无窗口可关
      }
    },
    dialogs: {
      async confirm(input?: any): Promise<boolean> {
        host.log('warn', 'ui.dialogs.confirm 被调用（宿主未接入交互 UI，默认返回 false）', input)
        return false
      },
      async prompt(): Promise<string | null> {
        return null
      }
    },
    progress: {
      create(): any {
        return { update: noop, complete: noop, fail: noop }
      }
    }
  }

  const account = {
    async getSession(): Promise<any> {
      return null
    },
    async getProfile(): Promise<any> {
      return null
    },
    async listAccounts(): Promise<any[]> {
      return []
    },
    async openLogin(): Promise<void> {
      throw new Error('澜音宿主尚未接通账号登录服务')
    }
  }

  const capabilities = {
    list(): string[] {
      return [...CONNECTED_CAPABILITIES]
    },
    get(key: string): boolean {
      return CONNECTED_CAPABILITIES.includes(key)
    }
  }

  const permissions = {
    async query(key: string): Promise<any> {
      return { key, status: await host.queryPermission(key) }
    },
    async request(key: string): Promise<any> {
      const result = await host.requestPermission(key)
      return { key, ...result }
    },
    async requestGroup(input: { group?: string; keys?: string[] }): Promise<any> {
      const keys = input?.keys ?? []
      return host.requestPermissionGroup(keys)
    }
  }

  const storage = {
    async get(key: string): Promise<any> {
      return host.storageGet(key)
    },
    async set(key: string, value: any): Promise<void> {
      return host.storageSet(key, value)
    },
    async delete(key: string): Promise<void> {
      return host.storageDelete(key)
    },
    async keys(): Promise<string[]> {
      return host.storageKeys()
    },
    async clear(): Promise<void> {
      return host.storageClear()
    }
  }

  const config = {
    async get<T = Record<string, any>>(): Promise<T> {
      return (await host.getConfig()) as T
    }
  }

  const log = {
    debug(message: string, data?: any): void {
      host.log('debug', message, data)
    },
    info(message: string, data?: any): void {
      host.log('info', message, data)
    },
    warn(message: string, data?: any): void {
      host.log('warn', message, data)
    },
    error(message: string, data?: any): void {
      host.log('error', message, data)
    }
  }

  const providers = {
    register(id: string, impl: CeruProviderImplementation): () => void {
      return host.registerProvider(id, impl)
    }
  }

  const actions = {
    register(id: string, handler: (input: any, op: OperationContext) => any): () => void {
      return host.registerAction(id, handler)
    }
  }

  const lyricConverters = {
    register(id: string, impl: any): () => void {
      return host.registerLyricConverter(id, impl)
    }
  }

  const playlistImporters = {
    register(id: string, impl: any): () => void {
      return host.registerPlaylistImporter(id, impl)
    }
  }

  const playback = {
    failure(error: any): { ok: false; error: any } {
      return { ok: false, error: { retryable: false, ...error } }
    },
    success(url: string, extra?: Record<string, any>): { ok: true; url: string } {
      return { ok: true, url, ...(extra ?? {}) }
    }
  }

  const ctx: Record<string, any> = {
    plugin: {
      get id() {
        return host.pluginId
      },
      get version() {
        return host.pluginVersion
      },
      get manifest() {
        return manifest
      }
    },
    host: {
      get apiVersion() {
        return HOST_API_VERSION
      },
      get mode() {
        return 'production'
      },
      get libraries() {
        return { hostApi: HOST_API_VERSION, logicRuntime: 'ceru-js@1' }
      }
    },
    capabilities,
    permissions,
    config,
    storage,
    log,
    effects,
    events,
    http: httpModule,
    ui,
    account,
    providers,
    actions,
    lyricConverters,
    playlistImporters,
    playback,
    icons: {
      list: () => [],
      url: async () => ''
    },
    assets: {
      list: () => [],
      url: async () => ''
    },
    utils: {
      lodash,
      // 格式化工具（compat/format 中常用的少数几个）
      formatPlayTime,
      sizeFormate,
      dateFormat,
      decodeName
    },
    sockets: unsupportedService('socket'),
    library: unsupportedService('library'),
    player: unsupportedService('player'),
    queue: unsupportedService('queue'),
    downloads: unsupportedService('downloads'),
    files: unsupportedService('files'),
    clipboard: unsupportedService('clipboard'),
    settings: unsupportedService('settings'),
    window: unsupportedService('window'),
    hotkeys: unsupportedService('hotkeys'),
    sharing: unsupportedService('sharing'),
    rooms: unsupportedService('rooms'),
    devices: unsupportedService('devices'),
    /**
     * 澜音 guest 运行时（把用户导入的洛雪音源当子环境跑）。
     * 本应用未接入该运行时：`list()` 返回空列表，让插件走「未导入音源」的分支
     * 而不是抛内部错误；其余操作抛明确提示。
     */
    guests: {
      async list(): Promise<any[]> {
        return []
      },
      async import(): Promise<any> {
        throw new Error('澜音宿主尚未接通「guest 音源导入」服务')
      },
      async select(): Promise<void> {
        throw new Error('澜音宿主尚未接通「guest 音源切换」服务')
      },
      async remove(): Promise<void> {
        throw new Error('澜音宿主尚未接通「guest 音源移除」服务')
      },
      async invoke(): Promise<any> {
        throw new Error('澜音宿主尚未接通「guest 音源调用」服务')
      }
    },
    modules: {
      require(name: string): any {
        return resolveBuiltin(name)
      },
      // 部分打包产物会把 SDK 入口写进 modules
      sdk
    }
  }

  return ctx
}

/** 秒 → mm:ss */
function formatPlayTime(seconds: any): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 字节 → 可读体积 */
function sizeFormate(size: any): string {
  const bytes = Number(size) || 0
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

/** 简单日期格式化（YYYY-MM-DD HH:mm:ss） */
function dateFormat(value: any): string {
  const d = value ? new Date(value) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`
}

/** HTML 实体解码 */
function decodeName(value: any): string {
  const map: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' '
  }
  return String(value ?? '').replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => map[m] ?? m)
}

export type { CeruLyricLine }
