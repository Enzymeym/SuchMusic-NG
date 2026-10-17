/**
 * 音源插件注册表
 *
 * 负责：插件文件的加载 / 启停 / 移除 / 持久化，以及把宿主要求的音乐能力
 * 派发到正确的插件宿主。全局单例。
 */
import { readFileSync } from 'fs'
import { detectPluginKind } from './detect'
import { LxSourceHost } from './lxHost'
import { CeruSourceHost } from './ceruHost'
import { expandSourceKeys, isSameSourceKey } from './types'
import { normalizeQuality } from './quality'
import {
  getSourceConfig,
  getPluginPreferences,
  normalizePreferences,
  savePluginPreferences,
  upsertSourcePlugin,
  removeSourcePlugin,
  setSourcePluginEnabled,
  type SourcePluginRecord
} from './config'
import type {
  LoadedSourcePlugin,
  LyricRequest,
  LyricResult,
  PageResult,
  PicResult,
  PlaylistListRequest,
  PlaylistTrackPage,
  PluginSourceInfo,
  ResolveRequest,
  ResolveResult,
  SearchRequest,
  SourceHost,
  SourceKey,
  SourcePluginKind,
  SourcePreferences,
  SourceTrack
} from './types'

/** 解析结果 + 命中的插件 id */
export type ResolveDispatchResult = ResolveResult & { pluginId: string }

/**
 * 音源插件相关错误码。
 * 渲染层据此区分「没有插件可用」与「插件解析失败」，避免把失败原因统一
 * 显示成误导性的「未找到音源插件」。
 */
export type SourcePluginErrorCode =
  /** 没有任何已启用插件声明该音源 */
  | 'NO_PLUGIN'
  /** 命中插件但被停用 */
  | 'PLUGIN_DISABLED'
  /** 命中插件但加载/激活失败 */
  | 'PLUGIN_ERROR'
  /** 插件不具备该能力 */
  | 'UNSUPPORTED_ACTION'
  /** 插件执行解析时抛错（网络、版权、音质等） */
  | 'RESOLVE_FAILED'

/** 带错误码的音源插件异常 */
export class SourcePluginError extends Error {
  readonly code: SourcePluginErrorCode

  constructor(code: SourcePluginErrorCode, message: string) {
    super(message)
    this.name = 'SourcePluginError'
    this.code = code
  }
}

/** 能力动作 → 中文名（用于拼装可读的错误信息） */
const ACTION_LABELS: Record<string, string> = {
  musicUrl: '播放地址',
  lyric: '歌词',
  pic: '封面',
  search: '搜索'
}

/** 命中结果：插件实例 + 插件真正声明的平台标识 */
interface SourceMatch {
  plugin: LoadedSourcePlugin
  /** 插件声明/识别的 key（如澜音 providerId），解析时应原样回传 */
  sourceKey: string
}

/** 插件通知 */
export interface SourceNotice {
  type:
    | 'loaded'
    | 'removed'
    | 'error'
    | 'enabled'
    | 'disabled'
    | 'updateAlert'
    | 'log'
    | 'settings'
  pluginId: string
  [k: string]: any
}

/** 插件加载依赖：由 IPC 层注入通知回调 */
export interface LoadOptions {
  /** 是否在执行后置为启用（默认 true） */
  enabled?: boolean
  /** 是否持久化到配置（默认 true） */
  persist?: boolean
}

export class SourcePluginRegistry {
  private plugins = new Map<string, LoadedSourcePlugin>()
  private noticeHandler: ((notice: SourceNotice) => void) | null = null

  setNoticeHandler(fn: ((notice: SourceNotice) => void) | null): void {
    this.noticeHandler = fn
  }

  private emitNotice(notice: SourceNotice): void {
    this.noticeHandler?.(notice)
  }

  /** 构建宿主实例 */
  private createHost(kind: SourcePluginKind, filePath: string, code: string): SourceHost {
    const deps = {
      onNotice: (n: { type: string; pluginId: string; [k: string]: any }) =>
        this.emitNotice(n as SourceNotice),
      onLog: (level: 'log' | 'warn' | 'error', args: any[]) =>
        this.emitNotice({ type: 'log', pluginId: '', level, args })
    }
    if (kind === 'lx') {
      return new LxSourceHost(filePath, code, deps)
    }
    if (kind === 'ceru') {
      return new CeruSourceHost(filePath, code, deps)
    }
    throw new Error(`不支持的音源插件类型: ${kind}`)
  }

  /** 由宿主实例构建插件摘要信息 */
  private buildInfo(
    host: SourceHost,
    filePath: string,
    kind: SourcePluginKind,
    enabled: boolean,
    state: PluginSourceInfo['state'],
    error?: string,
    settings?: SourcePreferences
  ): PluginSourceInfo {
    const capabilities = host.getCapabilities?.() ?? {
      sources: [],
      canSearch: false,
      canBrowsePlaylist: false
    }
    return {
      id: host.id,
      kind,
      name: host.name,
      version: host.version,
      author: host.author,
      description: host.description,
      homepage: host.homepage,
      filePath,
      enabled,
      state,
      capabilities,
      updateAlert: host.getUpdateAlert?.(),
      settings: normalizePreferences(settings),
      error
    }
  }

  /** 从文件加载插件（执行 + 注册 + 持久化） */
  async loadFromFile(filePath: string, options: LoadOptions = {}): Promise<PluginSourceInfo> {
    const persist = options.persist !== false
    const enabled = options.enabled !== false

    let code: string
    try {
      code = readFileSync(filePath, 'utf-8')
    } catch (err) {
      throw new Error(`无法读取插件文件: ${(err as Error).message}`)
    }

    const kind = detectPluginKind(code)
    if (kind === 'such') {
      throw new Error('这是 Such 应用插件，请在「插件管理」中加载')
    }
    if (kind !== 'lx' && kind !== 'ceru') {
      throw new Error('无法识别的插件文件（既不是洛雪也不是澜音音源插件）')
    }

    const host = this.createHost(kind, filePath, code)
    await host.init()

    // 保留既有 config/storage/preferences，避免重新加载丢失
    const prev = (await getSourceConfig()).plugins.find((p) => p.id === host.id)
    const info = this.buildInfo(
      host,
      filePath,
      kind,
      enabled,
      'running',
      undefined,
      prev?.preferences
    )

    // 同一文件若因路径写法变化算出了新 id，清掉旧条目，避免列表里出现重复且残留 error 状态
    for (const [id, plugin] of [...this.plugins.entries()]) {
      if (id !== info.id && plugin.info.filePath === filePath) {
        await plugin.host.dispose().catch(() => undefined)
        this.plugins.delete(id)
      }
    }
    this.plugins.set(info.id, { info, host })

    if (persist) {
      await upsertSourcePlugin({
        id: info.id,
        filePath,
        kind,
        enabled,
        config: prev?.config,
        storage: prev?.storage,
        preferences: prev?.preferences
      })
    }

    if (!enabled) {
      await host.dispose()
      info.state = 'disabled'
    }

    this.emitNotice({
      type: 'loaded',
      pluginId: info.id,
      pluginName: info.name,
      version: info.version,
      kind
    })
    return info
  }

  /** 仅解析元信息，不执行插件代码（用于 UI 校验） */
  inspectFile(filePath: string): {
    success: boolean
    kind?: SourcePluginKind
    name?: string
    version?: string
    error?: string
  } {
    try {
      const code = readFileSync(filePath, 'utf-8')
      const kind = detectPluginKind(code)
      if (kind === 'such')
        return { success: false, error: '这是 Such 应用插件，请在「插件管理」中加载' }
      if (kind !== 'lx' && kind !== 'ceru') {
        return { success: false, error: '无法识别的插件文件' }
      }
      const host = this.createHost(kind, filePath, code)
      return { success: true, kind, name: host.name, version: host.version }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /** 启动时加载已保存的插件 */
  async loadSavedPlugins(): Promise<void> {
    const config = await getSourceConfig()
    for (const rec of config.plugins) {
      try {
        if (rec.enabled) {
          await this.loadFromFile(rec.filePath, { enabled: true, persist: false })
        } else {
          await this.registerDisabled(rec)
        }
      } catch (err) {
        console.error(`[PluginSource] 加载音源插件失败: ${rec.filePath}`, err)
        const host = this.tryCreateMetadataHost(rec)
        const info: PluginSourceInfo = host
          ? this.buildInfo(
              host,
              rec.filePath,
              rec.kind,
              rec.enabled,
              'error',
              (err as Error).message,
              rec.preferences
            )
          : {
              id: rec.id,
              kind: rec.kind,
              name: rec.id,
              version: '0.0.0',
              filePath: rec.filePath,
              enabled: rec.enabled,
              state: 'error',
              capabilities: { sources: [], canSearch: false, canBrowsePlaylist: false },
              settings: normalizePreferences(rec.preferences),
              error: (err as Error).message
            }
        this.plugins.set(info.id, {
          info,
          host: host ?? this.nullHost(info.id, rec.kind)
        })
        this.emitNotice({ type: 'error', pluginId: info.id, message: info.error })
      }
    }
  }

  /** 注册一个未启用的插件（不执行代码，仅读取元信息） */
  private async registerDisabled(rec: SourcePluginRecord): Promise<void> {
    const host = this.tryCreateMetadataHost(rec)
    if (!host) return
    const info = this.buildInfo(
      host,
      rec.filePath,
      rec.kind,
      false,
      'disabled',
      undefined,
      rec.preferences
    )
    this.plugins.set(info.id, { info, host })
  }

  /** 尝试只创建宿主以读取静态元信息（不 init） */
  private tryCreateMetadataHost(rec: SourcePluginRecord): SourceHost | null {
    try {
      const code = readFileSync(rec.filePath, 'utf-8')
      return this.createHost(rec.kind, rec.filePath, code)
    } catch {
      return null
    }
  }

  /** 空宿主占位（加载失败但需要在 UI 中展示） */
  private nullHost(id: string, kind: SourcePluginKind): SourceHost {
    return {
      id,
      kind,
      name: id,
      version: '0.0.0',
      filePath: '',
      init: async () => {},
      dispose: async () => {}
    }
  }

  /** 移除插件 */
  async remove(pluginId: string): Promise<void> {
    const loaded = this.plugins.get(pluginId)
    if (loaded) {
      await loaded.host.dispose()
      this.plugins.delete(pluginId)
    }
    await removeSourcePlugin(pluginId)
    this.emitNotice({ type: 'removed', pluginId })
  }

  /** 启用 / 停用 */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const loaded = this.plugins.get(pluginId)
    if (!loaded) throw new Error(`插件 "${pluginId}" 不存在`)

    if (enabled) {
      await loaded.host.init()
      loaded.info = this.buildInfo(
        loaded.host,
        loaded.info.filePath,
        loaded.info.kind,
        true,
        'running',
        undefined,
        loaded.info.settings
      )
      this.plugins.set(pluginId, loaded)
    } else {
      await loaded.host.dispose()
      loaded.info.enabled = false
      loaded.info.state = 'disabled'
    }
    await setSourcePluginEnabled(pluginId, enabled)
    this.emitNotice({ type: enabled ? 'enabled' : 'disabled', pluginId })
  }

  /**
   * 更新单个音源插件的偏好（音乐源开关 / 音质）。
   * 偏好立即写回内存中的插件摘要并持久化，解析播放地址时按下述顺序取音质：
   * 调用方显式指定（下载） > 插件偏好 > 调用方默认值。
   */
  async setPreferences(pluginId: string, patch: SourcePreferences): Promise<SourcePreferences> {
    const loaded = this.plugins.get(pluginId)
    if (!loaded) throw new Error(`插件 "${pluginId}" 不存在`)
    // 以内存在的偏好为基准合并：patch 里没出现的字段（音乐源 / 音质）保持原值
    const current = normalizePreferences(loaded.info.settings)
    const merged = normalizePreferences({ ...current, ...patch })
    const next = await savePluginPreferences(pluginId, merged)
    loaded.info.settings = next
    this.emitNotice({ type: 'settings', pluginId })
    return next
  }

  /** 读取偏好（内存优先，未加载时回落到配置文件） */
  async getPreferences(pluginId: string): Promise<SourcePreferences> {
    const loaded = this.plugins.get(pluginId)
    if (loaded) return normalizePreferences(loaded.info.settings)
    return getPluginPreferences(pluginId)
  }

  /**
   * 该插件是否允许使用指定音乐源。
   * `settings.sources` 为 null 表示全部启用；为数组时按别名（qq ↔ tx）匹配。
   */
  private allowsSource(plugin: LoadedSourcePlugin, sourceKey: string | undefined): boolean {
    const enabledSources = plugin.info.settings?.sources
    if (!Array.isArray(enabledSources)) return true
    if (!sourceKey) return enabledSources.length > 0
    return enabledSources.some((key) => isSameSourceKey(key, sourceKey))
  }

  /** 插件是否还有某个动作可用的音乐源（用于搜索聚合时跳过全关闭的插件） */
  private hasAllowedSource(plugin: LoadedSourcePlugin, action: string): boolean {
    const sources = plugin.info.capabilities?.sources ?? []
    return sources.some((s) => s.actions.includes(action) && this.allowsSource(plugin, s.key))
  }

  /** 该插件在指定动作下第一个允许的音乐源 */
  private firstAllowedSource(plugin: LoadedSourcePlugin, action: string): string | undefined {
    const sources = plugin.info.capabilities?.sources ?? []
    return sources.find((s) => s.actions.includes(action) && this.allowsSource(plugin, s.key))?.key
  }

  /** 列出所有插件 */
  list(): PluginSourceInfo[] {
    return [...this.plugins.values()].map((p) => p.info)
  }

  get(pluginId: string): PluginSourceInfo | undefined {
    return this.plugins.get(pluginId)?.info
  }

  /** 按 sourceKey + action 查找已启用的插件（支持平台标识别名，如 qq → tx） */
  findBySourceKey(sourceKey: SourceKey | undefined, action: string): LoadedSourcePlugin | null {
    return this.findSource(sourceKey, action)?.plugin ?? null
  }

  /**
   * 按 sourceKey + action 查找插件，并返回插件真正声明的 key。
   * 返回的 `sourceKey` 必须用于后续宿主调用（别名不能直接丢给插件）。
   */
  findSource(sourceKey: SourceKey | undefined, action: string): SourceMatch | null {
    const candidates = expandSourceKeys(sourceKey)
    if (candidates.length === 0) return null
    for (const plugin of this.plugins.values()) {
      if (!plugin.info.enabled || plugin.info.state !== 'running') continue
      for (const candidate of candidates) {
        if (!plugin.host.supports?.(candidate, action)) continue
        // 插件能识别别名时取插件自己的写法（如 tx 而非 qq）
        const actual = plugin.host.matchSourceKey?.(candidate) ?? candidate
        // 用户在插件设置里关掉了这个音乐源 → 继续找下一个插件
        if (!this.allowsSource(plugin, actual)) continue
        return { plugin, sourceKey: actual }
      }
    }
    return null
  }

  private activePlugins(): LoadedSourcePlugin[] {
    return [...this.plugins.values()].filter((p) => p.info.enabled && p.info.state === 'running')
  }

  /** 列出插件声明的平台标识（用于错误提示） */
  private describeSources(plugin: LoadedSourcePlugin): string {
    const keys = (plugin.info.capabilities?.sources ?? [])
      .filter((s) => s.actions.includes('musicUrl') || s.actions.length > 0)
      .map((s) => s.key)
    return keys.length ? keys.join('/') : '无可用音源'
  }

  /** 搜索（指定插件或聚合所有可搜索插件） */
  async search(req: SearchRequest): Promise<PageResult<SourceTrack>> {
    if (req.pluginId) {
      const p = this.plugins.get(req.pluginId)
      if (!p || !p.host.search) {
        throw new Error('该插件不支持搜索')
      }
      // 未指定 provider 时，改用该插件里第一个「未被用户关闭」的音乐源
      const providerId = req.providerId ?? this.firstAllowedSource(p, 'search')
      const res = await p.host.search({ ...req, providerId })
      return { ...res, items: res.items.map((t) => ({ ...t, pluginId: p.info.id })) }
    }

    const searchable = this.activePlugins().filter(
      (p) =>
        p.host.search &&
        this.hasAllowedSource(p, 'search') &&
        (!req.providerId || this.allowsSource(p, req.providerId))
    )
    const results = await Promise.allSettled(
      searchable.map((p) => {
        const providerId = req.providerId ?? this.firstAllowedSource(p, 'search')
        return p.host
          .search!({ ...req, providerId })
          .then((r) => r.items.map((t) => ({ ...t, pluginId: p.info.id })))
      })
    )
    const items: SourceTrack[] = []
    for (const r of results) {
      if (r.status === 'fulfilled') items.push(...r.value)
    }
    return { items }
  }

  /**
   * 解析播放地址。
   *
   * 定位顺序：
   * 1. 歌曲自带的 `pluginId`（插件被移除/改名时不再直接失败，继续按 sourceKey 兜底）
   * 2. 按 `sourceKey` + 别名（tx/qq/tencent…）在已启用插件中查找
   * 3. 注册表里没有任何可用插件时，按配置重新加载一次已启用的插件（自愈）
   */
  async resolveUrl(req: ResolveRequest): Promise<ResolveDispatchResult> {
    let match = this.locateMatch(req, 'musicUrl')
    if (!match) {
      await this.reloadEnabledPlugins()
      match = this.locateMatch(req, 'musicUrl')
    }
    if (!match) {
      // 歌曲自带 pluginId 指向的插件存在但不可用 → 给出精确原因，否则说明没有插件
      throw (
        this.explicitPluginIssue(req.pluginId) ??
        new SourcePluginError('NO_PLUGIN', this.missingPluginMessage(req.sourceKey))
      )
    }

    const { plugin, sourceKey } = match
    if (!plugin.host.resolveUrl) {
      throw new SourcePluginError(
        'UNSUPPORTED_ACTION',
        `音源插件「${plugin.info.name}」不支持解析播放地址`
      )
    }

    // 音质优先级：调用方显式指定（下载面板） > 该插件的音质偏好 > 调用方默认值
    const preferQuality = plugin.info.settings?.quality
    const effectiveQuality = req.qualityOverride ?? preferQuality ?? req.quality

    const forwarded: ResolveRequest = { ...req, quality: normalizeQuality(effectiveQuality), sourceKey }
    delete forwarded.qualityOverride
    // 别名命中时，providerId 可能是另一个写法，交给插件自己的 key 更稳
    if (req.providerId && !plugin.host.supports?.(req.providerId, 'musicUrl')) {
      forwarded.providerId = sourceKey
    }

    try {
      const res = await plugin.host.resolveUrl(forwarded)
      return { pluginId: plugin.info.id, ...res }
    } catch (err) {
      const message = (err as Error)?.message || String(err)
      throw new SourcePluginError(
        'RESOLVE_FAILED',
        `音源插件「${plugin.info.name}」解析失败：${message}`
      )
    }
  }

  /**
   * 定位插件（显式 pluginId 优先，其次 sourceKey 别名）。
   * 不抛错：显式 pluginId 指向的插件不可用时继续按 sourceKey 兜底，
   * 这样「旧队列里残留已停用插件的 pluginId」不会把还能用的插件挡住。
   */
  private locateMatch(
    req: { pluginId?: string; providerId?: string; sourceKey?: SourceKey },
    action: string
  ): SourceMatch | null {
    if (req.pluginId) {
      const explicit = this.plugins.get(req.pluginId)
      if (explicit?.info.enabled && explicit.info.state === 'running') {
        if (explicit.host.supports?.(req.providerId ?? req.sourceKey, action)) {
          const actual =
            explicit.host.matchSourceKey?.(req.providerId ?? req.sourceKey) ??
            req.providerId ??
            req.sourceKey ??
            ''
          // 该音乐源已被用户在插件设置里关闭 → 交给别名查找找别的插件
          if (this.allowsSource(explicit, actual)) {
            return { plugin: explicit, sourceKey: actual }
          }
        }
      }
    }
    return this.findSource(req.sourceKey ?? req.providerId, action)
  }

  /** 歌曲自带的 pluginId 若指向停用/加载失败的插件，返回精确错误 */
  private explicitPluginIssue(pluginId?: string): SourcePluginError | null {
    if (!pluginId) return null
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return null
    if (!plugin.info.enabled) {
      return new SourcePluginError(
        'PLUGIN_DISABLED',
        `音源插件「${plugin.info.name}」已停用，请在「设置 → 音源插件」中启用`
      )
    }
    if (plugin.info.state !== 'running') {
      return new SourcePluginError(
        'PLUGIN_ERROR',
        `音源插件「${plugin.info.name}」未能正常加载${
          plugin.info.error ? `：${plugin.info.error}` : ''
        }`
      )
    }
    return null
  }

  /**
   * 自愈：把配置里已启用、但注册表中缺失或处于错误状态的插件重新加载一次。
   * 覆盖「插件已导入但当前进程没有加载成功」导致的所有解析失败。
   * 带 10s 冷却，避免每次解析失败都触发文件读取与沙箱执行。
   */
  private reloading = false
  private reloadedAt = 0

  async reloadEnabledPlugins(): Promise<boolean> {
    if (this.reloading) return false
    if (Date.now() - this.reloadedAt < 10_000) return false
    this.reloading = true
    this.reloadedAt = Date.now()
    let loadedAny = false
    try {
      const config = await getSourceConfig()
      for (const rec of config.plugins) {
        if (!rec.enabled) continue
        const existing = this.plugins.get(rec.id)
        if (existing && existing.info.enabled && existing.info.state === 'running') continue
        try {
          await this.loadFromFile(rec.filePath, { enabled: true, persist: false })
          loadedAny = true
        } catch (err) {
          console.warn(`[PluginSource] 重新加载音源插件失败: ${rec.filePath}`, err)
        }
      }
    } finally {
      this.reloading = false
    }
    return loadedAny
  }

  /** 拼装「为什么没找到插件」的可读说明，避免只给一句误导性的提示 */
  private missingPluginMessage(sourceKey?: SourceKey): string {
    const label = ACTION_LABELS.musicUrl
    const head = sourceKey
      ? `未找到支持「${sourceKey}」音源的音源插件`
      : '未找到可用于解析播放地址的音源插件'

    const running = this.activePlugins()
    const inactive = [...this.plugins.values()].filter(
      (p) => !p.info.enabled || p.info.state !== 'running'
    )
    const parts: string[] = []
    if (running.length > 0) {
      parts.push(
        `已启用的插件不支持该音源（${running
          .map((p) => `${p.info.name}：${this.describeSources(p)}`)
          .join('；')}）`
      )
    }
    if (inactive.length > 0) {
      parts.push(
        `未启用或加载失败：${inactive
          .map((p) => `${p.info.name}${p.info.error ? `（${p.info.error}）` : ''}`)
          .join('、')}`
      )
    }
    if (parts.length === 0) parts.push('当前没有已加载的音源插件，请先导入并启用')
    return `${head} → ${parts.join('；')}（缺少${label}能力）`
  }

  /** 按 pluginId 或 sourceKey 定位宿主（歌词/封面等无需显式指定 pluginId 的场景） */
  private locate(
    req: { pluginId?: string; sourceKey?: SourceKey },
    action: string
  ): SourceMatch | null {
    if (req.pluginId) {
      const explicit = this.plugins.get(req.pluginId)
      if (explicit) {
        // 显式插件把该音乐源关掉了 → 退回按 sourceKey 找别的插件
        if (req.sourceKey && !this.allowsSource(explicit, req.sourceKey)) {
          return this.findSource(req.sourceKey, action)
        }
        return { plugin: explicit, sourceKey: req.sourceKey ?? '' }
      }
    }
    return this.findSource(req.sourceKey, action)
  }

  /** 获取歌词 */
  async lyric(req: LyricRequest): Promise<LyricResult | null> {
    const match = this.locate(req, 'lyric')
    if (!match) return null
    const { plugin, sourceKey } = match
    if (!plugin.host.lyric) return null
    if (!plugin.info.enabled || plugin.info.state !== 'running') return null
    try {
      return await plugin.host.lyric({
        ...req,
        pluginId: plugin.info.id,
        sourceKey: sourceKey || req.sourceKey
      })
    } catch (err) {
      console.warn(`[PluginSource] 获取歌词失败 (${plugin.info.id}):`, err)
      return null
    }
  }

  /** 获取封面 */
  async pic(req: LyricRequest): Promise<PicResult | null> {
    const match = this.locate(req, 'pic')
    if (!match) return null
    const { plugin, sourceKey } = match
    if (!plugin.host.pic) return null
    if (!plugin.info.enabled || plugin.info.state !== 'running') return null
    try {
      return await plugin.host.pic({
        ...req,
        pluginId: plugin.info.id,
        sourceKey: sourceKey || req.sourceKey
      })
    } catch (err) {
      console.warn(`[PluginSource] 获取封面失败 (${plugin.info.id}):`, err)
      return null
    }
  }


  /** 歌单：类目 */
  async playlistCategories(pluginId: string): Promise<SourceTrack[]> {
    const p = this.plugins.get(pluginId)
    if (!p?.host.playlistCategories) throw new Error('该插件不支持歌单浏览')
    const items = await p.host.playlistCategories()
    return items.map((t) => ({ ...t, pluginId }))
  }

  /** 歌单：搜索 */
  async playlistSearch(req: PlaylistListRequest): Promise<PageResult<SourceTrack>> {
    const p = this.plugins.get(req.pluginId)
    if (!p?.host.playlistSearch) throw new Error('该插件不支持歌单搜索')
    const res = await p.host.playlistSearch(req)
    return { ...res, items: res.items.map((t) => ({ ...t, pluginId: p.info.id })) }
  }

  /** 歌单：列表 */
  async playlistList(req: PlaylistListRequest): Promise<PageResult<SourceTrack>> {
    const p = this.plugins.get(req.pluginId)
    if (!p?.host.playlistList) throw new Error('该插件不支持歌单列表')
    const res = await p.host.playlistList(req)
    return { ...res, items: res.items.map((t) => ({ ...t, pluginId: p.info.id })) }
  }

  /** 歌单：曲目明细 */
  async playlistGet(req: PlaylistListRequest): Promise<PlaylistTrackPage> {
    const p = this.plugins.get(req.pluginId)
    if (!p?.host.playlistGet) throw new Error('该插件不支持获取歌单曲目')
    const res = await p.host.playlistGet(req)
    return { ...res, items: res.items.map((t) => ({ ...t, pluginId: p.info.id })) }
  }
}

/** 全局单例 */
export const sourceRegistry = new SourcePluginRegistry()
