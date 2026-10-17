/**
 * 澜音 Ceru Music v2 插件宿主
 *
 * 负责在沙箱内执行澜音 v2 单文件插件，构建 `PluginContext`，收集
 * Provider 能力，并把宿主的播放/歌词/歌单需求派发到对应 Provider。
 *
 * 支持的单文件形态：
 *   - `exports.manifest = {...}` + `exports.activate = function (ctx) {...}`
 *   - `module.exports = { manifest, activate }`
 *   - `exports.default = definePlugin(fn)`（CLI 打包产物的 CJS 形态）
 *
 * 参考：https://ceru.docs.shiqianjiang.cn/guide/plugins/v2/
 */
import { basename, extname } from 'path'
import { createSandbox, withTimeout, type Sandbox } from './sandbox'
import { hasBareEsmSyntax } from './detect'
import { normalizeQuality } from './quality'
import { expandSourceKeys } from './types'
import {
  buildPluginContext,
  createHostModules,
  createOperation,
  isCtxBoundModule,
  resolveHostModule,
  type CeruCtxHost,
  type CeruHostModules
} from './ceru/ctx'
import type { HostRealm } from './ceru/modules'
import { createSdkStub, resolveBuiltinModuleName } from './ceru/modules'
import {
  clearPluginStorage,
  deletePluginStorage,
  getPluginConfigEntry,
  getPluginPermissions,
  getPluginStorage,
  getPluginStorageAll,
  getSourceConfigOptions,
  setPluginPermission,
  setPluginStorage
} from './config'
import type {
  CeruManifest,
  CeruProviderDecl,
  CeruProviderImplementation,
  ResourceRef
} from './ceru/types'
import type {
  LyricRequest,
  LyricResult,
  PageResult,
  PicResult,
  PlaylistListRequest,
  PlaylistTrackPage,
  PluginSourceInfo,
  ProviderCapability,
  QualityId,
  ResolveRequest,
  ResolveResult,
  SearchRequest,
  SourceCapability,
  SourceHost,
  SourceTrack
} from './types'

/** 宿主注入的依赖 */
export interface CeruHostDeps {
  onNotice?: (notice: { type: string; pluginId: string; [k: string]: any }) => void
  onLog?: (level: 'log' | 'warn' | 'error', args: any[]) => void
}

/** 激活阶段等待上限（与澜音桌面一致：30 秒） */
const ACTIVATE_TIMEOUT_MS = 30000
/** 单次 Provider 调用超时 */
const CALL_TIMEOUT_MS = 30000
/** 封面缓存条数上限（`providerId:id → coverUrl`，仅用于歌词页兜底取图） */
const COVER_CACHE_MAX = 500

/** 由文件路径与推断名生成稳定插件 id（manifest 解析前的临时 id） */
function provisionalId(filePath: string): string {
  const raw = basename(filePath, extname(filePath))
  const slug = raw.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 32) || 'plugin'
  return `ceru.${slug}`
}

/** 懒解析模块引用：允许插件在激活前 `require()`，首次访问时再取真实模块 */
function lazyModule(resolver: () => any): any {
  // 代理目标需为可调用对象；函数体本身不会被触发（apply 陷阱接管调用）
  const target = function lazyModuleTarget(): void {
    // 仅占位
  }
  return new Proxy(target, {
    get(_target, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined
      const mod = resolver()
      return mod?.[prop as any]
    },
    apply(_target, _thisArg, args: any[]) {
      const mod = resolver()
      return typeof mod === 'function' ? mod(...args) : mod
    },
    has(_target, prop) {
      const mod = resolver()
      return !!mod && prop in mod
    }
  })
}

/**
 * 构造「宿主 Buffer → 插件 realm 字节」的桥。
 *
 * 插件打包产物自带 `buffer` polyfill，其 `Buffer.concat` 用 `instanceof Uint8Array`
 * 判定入参；跨 vm 上下文时宿主的 Buffer 会判定失败（报
 * `"list" argument must be an Array of Buffers`）。这里在沙箱内编译一个转换函数，
 * 让字节对象创建在插件自己的 realm 里，并保留 Buffer 风格的 `toString(encoding)`。
 */
function createRealmBridge(sandbox: Sandbox): HostRealm {
  const factory = sandbox.compile(
    `return function (format) {
      return function toRealmBytes(bytes) {
        var out = new Uint8Array(bytes.length)
        out.set(bytes)
        Object.defineProperty(out, 'toString', {
          value: function (encoding) { return format(Array.prototype.slice.call(this), encoding) },
          writable: true,
          configurable: true,
          enumerable: false
        })
        return out
      }
    }`,
    [],
    'ceru-realm'
  )

  const format = (values: number[], encoding?: string): string => {
    const buf = Buffer.from(values)
    if (!encoding) return buf.toString('utf8')
    try {
      return buf.toString(encoding as BufferEncoding)
    } catch {
      return new TextDecoder(encoding).decode(buf)
    }
  }

  // compileFunction 的源码是「函数体」，故 factory() 返回接收 format 的工厂
  const toRealm = factory()(format)
  return {
    toBytes(bytes: Buffer): any {
      if (!bytes || typeof bytes !== 'object' || typeof bytes.length !== 'number') return bytes
      return toRealm(bytes)
    }
  }
}

/** 毫秒时间戳 → LRC 时间标签 [mm:ss.xx] */
function msToLrcTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const m = Math.floor(total / 60000)
  const s = Math.floor((total % 60000) / 1000)
  const cs = Math.floor((total % 1000) / 10)
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`
}

/** CrLyric → 现有渲染层可消费的 LRC 文本 */
export function crLyricToResult(doc: any): LyricResult {
  const empty: LyricResult = { lyrics: '', translatedLyrics: '', romanLyrics: '' }
  if (!doc || typeof doc !== 'object') return empty

  const lines = Array.isArray(doc.lines) ? doc.lines : []
  if (lines.length === 0) {
    return doc.plainText ? { ...empty, lyrics: String(doc.plainText) } : empty
  }

  const offset = Number(doc.offsetMs) || 0
  const main: string[] = []
  const trans: string[] = []
  const roma: string[] = []
  for (const line of lines) {
    if (!line) continue
    const tag = msToLrcTime((Number(line.startTimeMs) || 0) + offset)
    main.push(`${tag}${line.text ?? ''}`)
    if (line.translation) trans.push(`${tag}${line.translation}`)
    if (line.romanization) roma.push(`${tag}${line.romanization}`)
  }
  return {
    lyrics: main.join('\n'),
    translatedLyrics: trans.join('\n'),
    romanLyrics: roma.join('\n')
  }
}

export class CeruSourceHost implements SourceHost {
  readonly kind = 'ceru' as const
  readonly filePath: string
  readonly manifest: CeruManifest
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly author?: string
  readonly homepage?: string

  private code: string
  private deps: CeruHostDeps
  private sandbox: Sandbox
  private api: Record<string, any>
  /** 宿主内建模块实例（`ctx` 就绪前也要可用，故与 ctx 解耦；在 evaluate() 中初始化） */
  private hostModules!: CeruHostModules

  private ctx: Record<string, any> | null = null
  private providers = new Map<string, CeruProviderImplementation>()
  private actions = new Map<string, (input: any, op: any) => any>()
  private lyricConverters = new Map<string, any>()
  private playlistImporters = new Map<string, any>()
  private effects: Array<() => any> = []
  private activationDisposable: (() => any) | null = null
  private coverCache = new Map<string, string>()
  private activated = false

  constructor(filePath: string, code: string, deps: CeruHostDeps = {}) {
    this.filePath = filePath
    this.code = code
    this.deps = deps

    const { api, sandbox } = this.evaluate()
    this.api = api
    this.sandbox = sandbox

    const manifest = api?.manifest
    if (!manifest || typeof manifest !== 'object' || !manifest.id) {
      throw new Error('澜音插件未导出有效 manifest（需要 exports.manifest = {...}）')
    }
    this.manifest = manifest as CeruManifest
    this.id = String(manifest.id)
    this.name = String(manifest.name || this.id)
    this.version = String(manifest.version || '0.0.0')
    this.description = typeof manifest.description === 'string' ? manifest.description : undefined
    this.author =
      typeof manifest.author === 'string'
        ? manifest.author
        : ((manifest.author as any)?.name ?? undefined)
    this.homepage =
      typeof manifest.homepage === 'string'
        ? manifest.homepage
        : ((manifest.author as any)?.homepage ?? undefined)
  }

  /** 在沙箱中执行脚本以读取 manifest（不调用 activate） */
  private evaluate(): { api: Record<string, any>; sandbox: Sandbox } {
    const exportsObj: Record<string, any> = {}
    const moduleObj = { exports: exportsObj }
    const sdk = createSdkStub()
    // 必须在 sandbox.run 之前就绪：打包产物会在文件顶层调用 `globalThis.__ceruRequire(...)`
    const realm: HostRealm = { toBytes: (bytes: Buffer) => bytes }
    this.hostModules = createHostModules(this.createCtxHost(), realm)

    const sandbox = createSandbox(provisionalId(this.filePath), {
      extra: {
        exports: exportsObj,
        module: moduleObj,
        require: (name: string) => this.requireModule(name, sdk),
        // 澜音 CLI 把宿主模块编译为 `module.exports = globalThis.__ceruRequire('@ceru/xxx')`
        __ceruRequire: (name: string) => this.requireHostModule(name, sdk),
        ...sdk
      },
      onLog: this.deps.onLog
    })

    // 沙箱建好后补上 realm 桥（内建模块按引用读取，故可后置赋值）
    realm.toBytes = createRealmBridge(sandbox).toBytes

    try {
      sandbox.run(this.code, basename(this.filePath), 8000)
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      if (hasBareEsmSyntax(this.code)) {
        throw new Error(
          `澜音插件包含未打包的 ESM 语法（import/export），请使用澜音 CLI 构建后的单文件：${message}`
        )
      }
      throw new Error(`澜音插件执行失败: ${message}`)
    }

    const api =
      moduleObj.exports && Object.keys(moduleObj.exports).length > 0
        ? moduleObj.exports
        : exportsObj
    return { api, sandbox }
  }

  /** 加载阶段的 require：与 `__ceruRequire` 走同一套解析 */
  private requireModule(name: string, sdk: Record<string, any>): any {
    return this.requireHostModule(name, sdk)
  }

  /**
   * 解析宿主模块（`require` 与 `globalThis.__ceruRequire` 共用）。
   *
   * 澜音 CLI 打包产物形如：
   *   `module.exports = globalThis.__ceruRequire('@ceru/legacy-http')`
   * 且这些调用发生在插件文件顶层（早于 `activate`）。因此不依赖 `ctx` 的模块
   * 必须在求值阶段就能返回实例；依赖 `ctx` 的模块退化为惰性代理，等 `init()` 后再解析。
   */
  private requireHostModule(name: string, sdk: Record<string, any>): any {
    if (name === '@shiqianjiang/ceru-plugin-sdk' || name.startsWith('@shiqianjiang/')) {
      return sdk
    }
    if (!resolveBuiltinModuleName(name)) {
      throw new Error(`澜音插件 require 了非内建模块: ${name}（请用 CLI 将其打包进单文件）`)
    }
    if (isCtxBoundModule(name) && !this.ctx) {
      return lazyModule(() => resolveHostModule(name, this.hostModules, this.ctx))
    }
    return resolveHostModule(name, this.hostModules, this.ctx)
  }

  /** 取出激活函数 */
  private resolveActivate(): ((ctx: any) => any) | null {
    if (typeof this.api.activate === 'function') return this.api.activate
    const def = this.api.default
    if (typeof def === 'function') return def
    if (def && typeof def.activate === 'function') return def.activate
    return null
  }

  /** 初始化：构建 ctx + 执行 activate */
  async init(): Promise<void> {
    if (this.activated) return

    const activate = this.resolveActivate()
    if (!activate) {
      throw new Error(
        '澜音插件未导出 activate 函数（需要 exports.activate = function (ctx) {...}）'
      )
    }

    this.providers.clear()
    this.actions.clear()
    this.lyricConverters.clear()
    this.playlistImporters.clear()
    this.effects = []
    this.activationDisposable = null
    this.ctx = buildPluginContext(this.createCtxHost(), this.hostModules)

    try {
      const ret = activate.call(this.api, this.ctx)
      const resolved = await withTimeout(
        Promise.resolve(ret),
        ACTIVATE_TIMEOUT_MS,
        '澜音插件激活超时（30 秒）'
      )
      if (typeof resolved === 'function') this.activationDisposable = resolved
      this.activated = true
    } catch (err) {
      await this.dispose()
      throw new Error(`澜音插件激活失败: ${(err as Error)?.message ?? String(err)}`)
    }
  }

  /** 释放资源（幂等；可被 init 再次激活） */
  async dispose(): Promise<void> {
    const runSafe = async (fn: () => any): Promise<void> => {
      try {
        await fn()
      } catch (err) {
        console.warn(`[Source:${this.id}] 释放插件资源失败:`, err)
      }
    }

    if (this.activationDisposable) {
      await runSafe(this.activationDisposable)
      this.activationDisposable = null
    }
    for (const fn of [...this.effects].reverse()) await runSafe(fn)
    this.effects = []

    this.providers.clear()
    this.actions.clear()
    this.lyricConverters.clear()
    this.playlistImporters.clear()
    this.coverCache.clear()
    this.sandbox.clearTimers()
    this.ctx = null
    this.activated = false
  }

  /** 构造 ctx 所需的宿主钩子 */
  private createCtxHost(): CeruCtxHost {
    const host = this
    return {
      manifest: this.manifest,
      pluginId: this.id,
      pluginVersion: this.version,
      log(level, message, data) {
        const mapped = level === 'warn' || level === 'error' ? level : 'log'
        host.deps.onLog?.(mapped, [`[${host.name}] ${message}`, data])
      },
      addEffect(fn) {
        host.effects.push(fn)
      },
      registerProvider(id, impl) {
        host.providers.set(id, impl)
        return () => host.providers.delete(id)
      },
      registerAction(id, handler) {
        host.actions.set(id, handler)
        return () => host.actions.delete(id)
      },
      registerLyricConverter(id, impl) {
        host.lyricConverters.set(id, impl)
        return () => host.lyricConverters.delete(id)
      },
      registerPlaylistImporter(id, impl) {
        host.playlistImporters.set(id, impl)
        return () => host.playlistImporters.delete(id)
      },
      async storageGet(key) {
        return getPluginStorage(host.id, key)
      },
      async storageSet(key, value) {
        await setPluginStorage(host.id, key, value)
      },
      async storageDelete(key) {
        await deletePluginStorage(host.id, key)
      },
      async storageKeys() {
        return Object.keys(await getPluginStorageAll(host.id))
      },
      async storageClear() {
        await clearPluginStorage(host.id)
      },
      async getConfig() {
        return { ...(host.manifest.config ?? {}), ...(await getPluginConfigEntry(host.id)) }
      },
      async queryPermission(key) {
        const options = await getSourceConfigOptions()
        if (options.autoGrantNetwork) return 'granted'
        const record = await getPluginPermissions(host.id)
        return record[key] ?? 'unknown'
      },
      async requestPermission(key) {
        const options = await getSourceConfigOptions()
        // 应用内暂无权限交互界面：默认自动授予并记录，保证音源可用
        await setPluginPermission(host.id, key, 'granted')
        host.deps.onLog?.('log', [
          `[${host.name}] 已自动授予权限「${key}」（autoGrantNetwork=${options.autoGrantNetwork}）`
        ])
        return { status: 'granted' as const }
      },
      async requestPermissionGroup(keys) {
        for (const key of keys) await setPluginPermission(host.id, key, 'granted')
        return { status: 'granted' as const }
      }
    }
  }

  // ==================== 能力 ====================

  /** manifest 中声明的 Provider（兼容 providers / sources 两种字段） */
  private providerDecls(): CeruProviderDecl[] {
    const contributes = this.manifest.contributes ?? {}
    const decls = [...(contributes.providers ?? []), ...(contributes.sources ?? [])]
    if (decls.length > 0) return decls
    return [...this.providers.keys()].map((id) => ({ id, name: id }))
  }

  /** 判定 Provider 实现是否具备某动作 */
  private implSupports(impl: CeruProviderImplementation | undefined, action: string): boolean {
    if (!impl) return false
    switch (action) {
      case 'musicUrl':
        return typeof impl.tracks?.resolve === 'function'
      case 'lyric':
        return typeof impl.tracks?.lyrics === 'function'
      case 'search':
        return typeof impl.tracks?.search === 'function'
      case 'playlist':
        return (
          typeof impl.playlists?.get === 'function' || typeof impl.playlists?.list === 'function'
        )
      case 'pic':
        return false
      default:
        return false
    }
  }

  getCapabilities(): PluginSourceInfo['capabilities'] {
    const sources: SourceCapability[] = []
    const providers: ProviderCapability[] = []
    for (const decl of this.providerDecls()) {
      const impl = this.providers.get(decl.id)
      const actions: string[] = []
      for (const action of ['musicUrl', 'lyric', 'search', 'playlist'] as const) {
        if (this.implSupports(impl, action)) actions.push(action)
      }
      const qualities = (decl.qualities ?? [])
        .map((q) => normalizeQuality(q))
        .filter((q, i, arr) => arr.indexOf(q) === i) as QualityId[]
      const name = decl.name || decl.id
      sources.push({ key: decl.id, name, actions, qualities })
      providers.push({ id: decl.id, name, protocols: decl.protocols ?? [], qualities })
    }
    return {
      sources,
      providers,
      canSearch: sources.some((s) => s.actions.includes('search')),
      canBrowsePlaylist: sources.some((s) => s.actions.includes('playlist'))
    }
  }

  supports(sourceKey: string | undefined, action: string): boolean {
    const key = this.matchSourceKey(sourceKey)
    if (!key) return false
    return this.implSupports(this.providers.get(key), action)
  }

  /**
   * 把外部传入的平台标识映射到插件真正注册的 providerId。
   * 澜音插件的 providerId 常写 `qq` / `tencent`，而调用方（QQ 搜索页）固定传 `tx`，
   * 只做字面比较会让已加载的插件被判成「没有音源」。
   */
  matchSourceKey(sourceKey: string | undefined): string | undefined {
    if (!sourceKey) return undefined
    if (this.providers.has(sourceKey)) return sourceKey
    const byLower = new Map([...this.providers.keys()].map((key) => [key.toLowerCase(), key]))
    for (const candidate of expandSourceKeys(sourceKey)) {
      const hit = byLower.get(candidate)
      if (hit) return hit
    }
    return undefined
  }

  /** 定位具备指定能力的 Provider */
  private findProvider(
    providerId: string | undefined,
    action: string
  ): { providerId: string; impl: CeruProviderImplementation } | null {
    const matched = this.matchSourceKey(providerId)
    if (matched) {
      const impl = this.providers.get(matched)!
      if (this.implSupports(impl, action)) return { providerId: matched, impl }
      return null
    }
    for (const [id, impl] of this.providers) {
      if (this.implSupports(impl, action)) return { providerId: id, impl }
    }
    return null
  }

  /** 组装 ResourceRef（ref 原样透传，否则按 providerId + id 合成） */
  private toResourceRef(ref: unknown, providerId: string, id: string): ResourceRef {
    if (ref && typeof ref === 'object' && (ref as any).providerId) {
      return ref as ResourceRef
    }
    return { pluginId: this.id, providerId, kind: 'track', id: String(id) }
  }

  /** ContentEntity → SourceTrack，并缓存封面供 pic 使用 */
  private entityToTrack(entity: any, providerId: string): SourceTrack {
    const ref = (entity?.ref ?? {}) as ResourceRef
    const meta = entity?.metadata ?? {}
    const artists: string[] =
      Array.isArray(meta.artists) && meta.artists.length
        ? meta.artists.map((a: any) => String(a))
        : entity?.subtitle
          ? [String(entity.subtitle)]
          : []
    const id = String(ref.id ?? entity?.id ?? '')
    const coverUrl: string | undefined =
      meta.artworkUrl || entity?.playlist?.artworkUrl || entity?.chart?.artworkUrl || undefined
    if (coverUrl && id) this.setCoverCache(`${providerId}:${id}`, coverUrl)

    return {
      pluginId: this.id,
      providerId,
      sourceKey: providerId,
      id,
      ref: Object.keys(ref).length ? ref : undefined,
      title: String(entity?.title ?? '未知歌曲'),
      artist: artists.length ? artists.join(' / ') : '未知歌手',
      album: meta.album?.title ? String(meta.album.title) : undefined,
      coverUrl,
      durationMs:
        typeof entity?.durationMs === 'number'
          ? entity.durationMs
          : typeof meta.durationMs === 'number'
            ? meta.durationMs
            : undefined,
      qualities: Array.isArray(meta.qualities)
        ? (meta.qualities.map((q: any) => normalizeQuality(q)) as QualityId[])
        : undefined,
      playable: entity?.playable !== false
    }
  }

  // ==================== 曲目能力 ====================

  async search(req: SearchRequest): Promise<PageResult<SourceTrack>> {
    const entry = this.findProvider(req.providerId, 'search')
    if (!entry?.impl.tracks?.search) {
      throw new Error(`澜音插件（${this.name}）未注册支持搜索的 Provider`)
    }
    const operation = createOperation(CALL_TIMEOUT_MS)
    const page = await withTimeout(
      Promise.resolve(
        entry.impl.tracks.search(
          {
            query: req.query,
            kinds: ['track'],
            filters: {},
            limit: req.limit,
            cursor: req.cursor
          },
          operation
        )
      ),
      CALL_TIMEOUT_MS,
      `澜音插件（${this.name}）搜索超时`
    )
    const items = (page?.items ?? []).map((entity: any) =>
      this.entityToTrack(entity, entry.providerId)
    )
    return {
      items,
      nextCursor: page?.nextCursor,
      totalEstimate: page?.totalEstimate
    }
  }

  async resolveUrl(req: ResolveRequest): Promise<ResolveResult> {
    const entry = this.findProvider(req.providerId || req.sourceKey, 'musicUrl')
    if (!entry?.impl.tracks?.resolve) {
      throw new Error(`澜音插件（${this.name}）未注册支持解析播放地址的 Provider`)
    }
    const ref = this.toResourceRef(req.ref, entry.providerId, String(req.id))
    const operation = createOperation(CALL_TIMEOUT_MS)
    const result: any = await withTimeout(
      Promise.resolve(entry.impl.tracks.resolve(ref, req.quality, operation)),
      CALL_TIMEOUT_MS,
      `澜音插件（${this.name}）解析播放地址超时`
    )
    if (
      !result ||
      result.ok !== true ||
      typeof result.url !== 'string' ||
      !/^https?:\/\//i.test(result.url)
    ) {
      const fault = result?.ok === false ? result.error : null
      throw new Error(fault?.message || '澜音插件未返回有效的播放地址')
    }
    return {
      url: result.url,
      expiresAt: typeof result.expiresAt === 'number' ? result.expiresAt : undefined,
      requestHeaders:
        result.requestHeaders && typeof result.requestHeaders === 'object'
          ? result.requestHeaders
          : undefined
    }
  }

  async lyric(req: LyricRequest): Promise<LyricResult | null> {
    const entry = this.findProvider(req.providerId || req.sourceKey, 'lyric')
    if (!entry?.impl.tracks?.lyrics) return null
    const ref = this.toResourceRef(req.ref, entry.providerId, String(req.id))
    const operation = createOperation(CALL_TIMEOUT_MS)
    const doc = await withTimeout(
      Promise.resolve(entry.impl.tracks.lyrics(ref, operation)),
      CALL_TIMEOUT_MS,
      `澜音插件（${this.name}）获取歌词超时`
    )
    const result = crLyricToResult(doc)
    if (!result.lyrics && !result.translatedLyrics) return null
    return result
  }

  /**
   * 写入封面缓存（带上限 + LRU 重排）。
   * 翻页搜索/歌单会持续累积 `providerId:id → coverUrl`，不设上限会随会话无限增长。
   */
  private setCoverCache(key: string, url: string): void {
    this.coverCache.delete(key)
    this.coverCache.set(key, url)
    while (this.coverCache.size > COVER_CACHE_MAX) {
      const oldest = this.coverCache.keys().next().value
      if (oldest === undefined) break
      this.coverCache.delete(oldest)
    }
  }

  async pic(req: LyricRequest): Promise<PicResult | null> {
    const providerId = req.providerId || req.sourceKey || ''
    const cached = this.coverCache.get(`${providerId}:${req.id}`)
    if (cached) {
      // 命中时重排为最近使用，保持 LRU 语义
      this.setCoverCache(`${providerId}:${req.id}`, cached)
      return { url: cached }
    }
    for (const [key, url] of this.coverCache) {
      if (key.endsWith(`:${req.id}`)) return { url }
    }
    return null
  }

  // ==================== 歌单能力 ====================

  async playlistCategories(): Promise<SourceTrack[]> {
    const items: SourceTrack[] = []
    for (const [providerId, impl] of this.providers) {
      if (typeof impl.playlists?.categories !== 'function') continue
      try {
        const page = await withTimeout(
          Promise.resolve(impl.playlists.categories(createOperation(CALL_TIMEOUT_MS))),
          CALL_TIMEOUT_MS,
          '澜音插件获取歌单类目超时'
        )
        for (const entity of page?.items ?? []) items.push(this.entityToTrack(entity, providerId))
      } catch (err) {
        console.warn(`[Source:${this.id}] 获取歌单类目失败 (${providerId}):`, err)
      }
    }
    return items
  }

  async playlistSearch(req: PlaylistListRequest): Promise<PageResult<SourceTrack>> {
    const entry = this.findProvider(req.providerId, 'playlist')
    const search = entry?.impl.playlists?.search
    if (!entry || typeof search !== 'function') return { items: [] }
    const page = await withTimeout(
      Promise.resolve(
        search.call(
          entry.impl.playlists,
          {
            query: req.query ?? '',
            kinds: ['playlist'],
            filters: {},
            limit: 30,
            cursor: req.cursor
          },
          createOperation(CALL_TIMEOUT_MS)
        )
      ),
      CALL_TIMEOUT_MS,
      '澜音插件歌单搜索超时'
    )
    return {
      items: (page?.items ?? []).map((e: any) => this.entityToTrack(e, entry.providerId)),
      nextCursor: page?.nextCursor,
      totalEstimate: page?.totalEstimate
    }
  }

  async playlistList(req: PlaylistListRequest): Promise<PageResult<SourceTrack>> {
    const entry = this.findProvider(req.providerId, 'playlist')
    const list = entry?.impl.playlists?.list
    if (!entry || typeof list !== 'function') return { items: [] }
    const ref = this.toResourceRef(req.ref, entry.providerId, '')
    const page = await withTimeout(
      Promise.resolve(
        list.call(entry.impl.playlists, ref, req.cursor, createOperation(CALL_TIMEOUT_MS))
      ),
      CALL_TIMEOUT_MS,
      '澜音插件获取歌单列表超时'
    )
    return {
      items: (page?.items ?? []).map((e: any) => this.entityToTrack(e, entry.providerId)),
      nextCursor: page?.nextCursor,
      totalEstimate: page?.totalEstimate
    }
  }

  async playlistGet(req: PlaylistListRequest): Promise<PlaylistTrackPage> {
    const entry = this.findProvider(req.providerId, 'playlist')
    const get = entry?.impl.playlists?.get
    if (!entry || typeof get !== 'function') return { items: [] }
    const ref = this.toResourceRef(req.ref, entry.providerId, '')
    const page: any = await withTimeout(
      Promise.resolve(
        get.call(entry.impl.playlists, ref, req.cursor, createOperation(CALL_TIMEOUT_MS))
      ),
      CALL_TIMEOUT_MS,
      '澜音插件获取歌单曲目超时'
    )
    const meta = page?.playlist ?? page?.meta
    return {
      items: (page?.items ?? []).map((e: any) => this.entityToTrack(e, entry.providerId)),
      nextCursor: page?.nextCursor,
      meta: meta
        ? {
            name: meta.name ?? meta.title,
            coverUrl: meta.coverUrl ?? meta.artworkUrl,
            description: meta.description
          }
        : undefined
    }
  }
}
