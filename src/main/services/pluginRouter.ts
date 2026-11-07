/**
 * 统一音源路由
 *
 * 背景：应用里有两种「能提供播放地址 / 搜索」的插件生态——
 *   1. 洛雪 LX / 澜音 Ceru（`main/services/pluginSource`，配置在 source-plugin-config.json）
 *   2. Such v2 插件（`src/plugin`，配置在 plugin-config.json + plugin-data/）
 *
 * 渲染层不应该知道这个区别：它只拿 `pluginId` / `sourceKey` / `ref` 请求解析，
 * 只拿 `SearchSource.key` 请求搜索。本模块是唯一知道两套生态的地方，
 * 负责按 id 路由、把 v2 的结果归一成 `SourceTrack`、并统一错误码语义。
 *
 * 分层约定：本文件属于应用层（main），可以依赖 `src/plugin`；反之不允许。
 */
import { sourceRegistry, SourcePluginError } from './pluginSource/registry'
import type {
  LyricRequest,
  LyricResult,
  PageResult,
  PicResult,
  ResolveRequest,
  SearchRequest,
  SourceTrack
} from './pluginSource/types'
import type { ResolveDispatchResult } from './pluginSource/registry'
import type { SearchSource } from '../../shared/plugin/types'

/** v2 插件宿主 id 前缀（见 plugin/header.ts 的 buildPluginHostId） */
export const V2_PLUGIN_ID_PREFIX = 'v2.'

/** 统一搜索请求：`key` 来自 `source:list-sources` */
export interface UnifiedSearchRequest {
  /** SearchSource.key；省略时按 pluginId/providerId 兜底（兼容旧调用） */
  key?: string
  pluginId?: string
  providerId?: string
  query: string
  limit?: number
  /** 不透明游标：v2 是页码字符串，ceru 原样透传 */
  cursor?: string
}

/** 统一搜索响应 */
export interface UnifiedSearchPage {
  items: SourceTrack[]
  nextCursor?: string
  hasMore: boolean
  totalEstimate?: number
}

/**
 * 单个插件生态需要向路由层提供的能力。
 * 洛雪/澜音由 `sourceRegistry` 适配，v2 由 `v2Registry` 适配。
 */
export interface SourceBackend {
  has(pluginId: string): boolean
  resolveUrl(req: ResolveRequest): Promise<ResolveDispatchResult>
  lyric(req: LyricRequest): Promise<LyricResult | null>
  pic(req: LyricRequest): Promise<PicResult | null>
  search(req: SearchRequest): Promise<PageResult<SourceTrack>>
  listSearchSources(): SearchSource[]
  /** 注册表为空但配置里有已启用插件时尝试重载（自愈） */
  reload?(): Promise<boolean>
}

/** 解析 `v2:<pluginId>:<sourceKey>` 形式的 key */
function parseV2Key(key: string): { pluginId: string; sourceKey: string } | null {
  if (!key.startsWith('v2:')) return null
  const rest = key.slice(3)
  const idx = rest.indexOf(':')
  if (idx <= 0) return null
  return { pluginId: rest.slice(0, idx), sourceKey: rest.slice(idx + 1) }
}

/** 解析 `ceru:<pluginId>:<providerId>` / `lx:<pluginId>:<sourceKey>` 形式的 key */
function parseLegacyKey(key: string): { kind: 'lx' | 'ceru'; pluginId: string; sourceKey: string } | null {
  const m = /^(lx|ceru):([^:]+):(.+)$/.exec(key)
  if (!m) return null
  return { kind: m[1] as 'lx' | 'ceru', pluginId: m[2], sourceKey: m[3] }
}

export class PluginRouter {
  constructor(
    private readonly legacy: SourceBackend,
    /** v2 后端：v2 内核上线前为 null，此时 v2 曲目一律报「插件已移除」 */
    private v2: SourceBackend | null = null
  ) {}

  /** 后端热替换（v2 注册表在 main 启动时才装配） */
  setV2Backend(backend: SourceBackend | null): void {
    this.v2 = backend
  }

  /** 是否为 v2 插件 id */
  isV2Plugin(pluginId?: string): boolean {
    return !!pluginId && pluginId.startsWith(V2_PLUGIN_ID_PREFIX)
  }

  /** 汇总所有可搜索来源（v2 在前，洛雪/澜音在后） */
  listSearchSources(): SearchSource[] {
    const v2 = this.v2?.listSearchSources() ?? []
    const legacy = this.legacy.listSearchSources()
    // 去重：同一 key 只保留第一份（热重载时可能短暂重复）
    const seen = new Set<string>()
    const out: SearchSource[] = []
    for (const item of [...v2, ...legacy]) {
      if (seen.has(item.key)) continue
      seen.add(item.key)
      out.push(item)
    }
    return out
  }

  /** 统一搜索 */
  async search(req: UnifiedSearchRequest): Promise<UnifiedSearchPage> {
    const key = req.key
    if (key) {
      const v2Target = parseV2Key(key)
      if (v2Target) {
        if (!this.v2) throw new SourcePluginError('PLUGIN_ERROR', '插件系统未就绪')
        const page = await this.v2.search({
          pluginId: v2Target.pluginId,
          providerId: v2Target.sourceKey,
          query: req.query,
          limit: req.limit ?? 30,
          cursor: req.cursor
        })
        return {
          items: page.items,
          nextCursor: page.nextCursor,
          hasMore: !!page.nextCursor,
          totalEstimate: page.totalEstimate
        }
      }
      const legacyTarget = parseLegacyKey(key)
      if (legacyTarget) {
        const page = await this.legacy.search({
          pluginId: legacyTarget.pluginId,
          providerId: legacyTarget.sourceKey,
          query: req.query,
          limit: req.limit ?? 30,
          cursor: req.cursor
        })
        return {
          items: page.items,
          nextCursor: page.nextCursor,
          hasMore: !!page.nextCursor,
          totalEstimate: page.totalEstimate
        }
      }
    }

    // 未给 key：先按显式 pluginId 路由，再退回旧生态的聚合搜索
    if (this.isV2Plugin(req.pluginId)) {
      if (!this.v2) throw new SourcePluginError('PLUGIN_ERROR', '插件系统未就绪')
      const page = await this.v2.search({
        pluginId: req.pluginId,
        providerId: req.providerId,
        query: req.query,
        limit: req.limit ?? 30,
        cursor: req.cursor
      })
      return {
        items: page.items,
        nextCursor: page.nextCursor,
        hasMore: !!page.nextCursor,
        totalEstimate: page.totalEstimate
      }
    }
    const page = await this.legacy.search({
      pluginId: req.pluginId,
      providerId: req.providerId,
      query: req.query,
      limit: req.limit ?? 30,
      cursor: req.cursor
    })
    return {
      items: page.items,
      nextCursor: page.nextCursor,
      hasMore: !!page.nextCursor,
      totalEstimate: page.totalEstimate
    }
  }

  /** 解析播放地址 */
  async resolveUrl(req: ResolveRequest): Promise<ResolveDispatchResult> {
    if (this.isV2Plugin(req.pluginId)) {
      return this.requireV2().resolveUrl(req)
    }
    // 旧生态优先：保持既有行为与既有回归测试
    try {
      return await this.legacy.resolveUrl(req)
    } catch (err) {
      // 只有「没有插件」才值得再问一次 v2；其他错误（停用/解析失败）原样上抛
      if (!(err instanceof SourcePluginError) || err.code !== 'NO_PLUGIN') throw err
      if (!this.v2) throw err
      try {
        return await this.v2.resolveUrl(req)
      } catch {
        // v2 也没解析出来：抛回旧生态的错误（它的文案更详细，会列出已启用插件的能力）
        throw err
      }
    }
  }

  /**
   * 歌词。
   *
   * v2 曲目必须由**所属插件**提供歌词（不能回落到别的插件），因此这里不做跨生态回退。
   */
  async lyric(req: LyricRequest): Promise<LyricResult | null> {
    if (this.isV2Plugin(req.pluginId)) {
      return this.requireV2().lyric(req)
    }
    return this.legacy.lyric(req)
  }

  /** 封面：同 lyric 的归属规则 */
  async pic(req: LyricRequest): Promise<PicResult | null> {
    if (this.isV2Plugin(req.pluginId)) {
      return this.requireV2().pic(req)
    }
    return this.legacy.pic(req)
  }

  /** 尝试重载两个生态（解析失败自愈） */
  async reload(): Promise<boolean> {
    let any = false
    try {
      if (this.legacy.reload) any = (await this.legacy.reload()) || any
    } catch (err) {
      console.warn('[PluginRouter] 重载音源插件失败:', err)
    }
    try {
      if (this.v2?.reload) any = (await this.v2.reload()) || any
    } catch (err) {
      console.warn('[PluginRouter] 重载 v2 插件失败:', err)
    }
    return any
  }

  private requireV2(): SourceBackend {
    if (!this.v2) {
      throw new SourcePluginError(
        'PLUGIN_ERROR',
        '该曲目来自 v2 插件，但插件系统未就绪；请重启应用或重新安装该插件'
      )
    }
    return this.v2
  }
}

/**
 * 洛雪 / 澜音 → 路由后端适配
 *
 * 可搜索来源 = 插件能力里声明了 `search` 动作、且用户没有在插件设置里关掉的音源。
 */
export function createLegacyBackend(): SourceBackend {
  return {
    has: (pluginId) => !!sourceRegistry.get(pluginId),
    resolveUrl: (req) => sourceRegistry.resolveUrl(req),
    lyric: (req) => sourceRegistry.lyric(req),
    pic: (req) => sourceRegistry.pic(req),
    search: (req) => sourceRegistry.search(req),
    reload: () => sourceRegistry.reloadEnabledPlugins(),
    listSearchSources() {
      const out: SearchSource[] = []
      for (const info of sourceRegistry.list()) {
        const enabledSources = info.settings?.sources
        const sourceAllowed = (key: string): boolean => {
          if (!Array.isArray(enabledSources)) return true
          const k = key.toLowerCase()
          return enabledSources.some((item) => item.toLowerCase() === k)
        }
        for (const cap of info.capabilities?.sources ?? []) {
          if (!cap.actions.includes('search')) continue
          if (!sourceAllowed(cap.key)) continue
          out.push({
            key: `${info.kind}:${info.id}:${cap.key}`,
            kind: info.kind,
            pluginId: info.id,
            sourceKey: cap.key,
            providerId: info.kind === 'ceru' ? cap.key : undefined,
            label: cap.name || cap.key,
            pluginName: info.name,
            qualities: cap.qualities ?? [],
            enabled: info.enabled,
            state: info.state === 'running' ? 'running' : info.state === 'error' ? 'error' : 'disabled'
          })
        }
      }
      return out
    }
  }
}

/** 全局路由单例（v2 后端在 main/index.ts 启动时注入） */
export const pluginRouter = new PluginRouter(createLegacyBackend())
