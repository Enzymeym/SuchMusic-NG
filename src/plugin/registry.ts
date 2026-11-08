/**
 * v2 插件注册表
 *
 * 负责：加载 / 安装 / 启停 / 移除 / 持久化，以及把宿主要求的音乐能力派发到
 * 正确的插件宿主。与音源插件注册表（洛雪 / 澜音）职责对称，互不依赖。
 */
import { promises as fs, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { V2PluginHost, type HostDeps } from './host'
import { buildPluginHostId, parsePluginHeader, pluginDataDirName } from './header'
import { atomicWriteJson, readJsonFile } from './runtime/atomicJson'
import { PluginHostError } from './errors'
import type { ConfirmQueue } from './runtime/confirm'
import type {
  PlaylistOpRequest,
  PlaylistOpResponse,
  SuchMusicAction,
  SuchPluginHeader,
  V2LyricResult,
  V2PageResult,
  V2ResolveResult,
  V2Track
} from './types'
import type {
  PluginLogEntry,
  PluginNotice,
  SearchSource,
  SettingField,
  V2PluginState,
  V2PluginSummary
} from '../shared/plugin/types'

/** 注册表配置（`userData/plugin-config.json`） */
interface PluginConfigFile {
  schemaVersion: 2
  plugins: PluginRecord[]
}

/** 单个插件的持久化记录 */
export interface PluginRecord {
  id: string
  headerId: string
  filePath: string
  enabled: boolean
  apiLevel: number
  grants: string[]
  installedAt: number
  lastLoadedAt?: number
  lastError?: string | null
}

/** 内存中的插件条目 */
interface Entry {
  record: PluginRecord
  host: V2PluginHost | null
  /** 上次成功加载时的摘要快照（停用/加载失败时用于展示） */
  snapshot: V2PluginSummary | null
  error?: string
}

export interface RegistryDeps {
  userDataDir: string
  appVersion: string
  locale: string
  confirm: ConfirmQueue
  playlistOp: (req: PlaylistOpRequest) => Promise<PlaylistOpResponse>
  writeAudioMeta: (filePath: string, tags: Record<string, unknown>) => Promise<boolean>
  notify: (notice: PluginNotice) => void
}

/** 音源动作 → 是否有对应 handler（用于能力判定） */
const SEARCH_ACTION: SuchMusicAction = 'musicSearch'

export class PluginRegistry {
  private entries = new Map<string, Entry>()
  private reloading = false
  private reloadedAt = 0

  constructor(private readonly deps: RegistryDeps) {}

  // ==================== 配置 ====================

  private get configFile(): string {
    return join(this.deps.userDataDir, 'plugin-config.json')
  }

  private hostDeps(): HostDeps {
    return {
      userDataDir: this.deps.userDataDir,
      appVersion: this.deps.appVersion,
      locale: this.deps.locale,
      confirm: this.deps.confirm,
      playlistOp: this.deps.playlistOp,
      writeAudioMeta: this.deps.writeAudioMeta,
      notify: this.deps.notify
    }
  }

  private async readConfig(): Promise<PluginConfigFile> {
    const raw = await readJsonFile<any>(this.configFile)
    if (!raw) return { schemaVersion: 2, plugins: [] }
    if (Array.isArray(raw.plugins)) {
      return { schemaVersion: 2, plugins: raw.plugins as PluginRecord[] }
    }
    // v1 结构（pluginPaths）：旧插件是 window.source 脚本，已无法加载，直接丢弃
    if (Array.isArray(raw.pluginPaths) && raw.pluginPaths.length > 0) {
      console.warn(
        `[Plugin] 检测到 v1 插件配置（${raw.pluginPaths.length} 个旧插件），新版插件系统不再支持，已忽略`
      )
    }
    return { schemaVersion: 2, plugins: [] }
  }

  private async saveConfig(): Promise<void> {
    const plugins = [...this.entries.values()].map((e) => e.record)
    await atomicWriteJson(this.configFile, { schemaVersion: 2, plugins })
  }

  // ==================== 生命周期 ====================

  /** 启动时加载已保存的插件 */
  async loadSaved(): Promise<void> {
    const config = await this.readConfig()
    for (const record of config.plugins) {
      await this.loadRecord(record)
    }
    console.log(`[Plugin] 已加载 ${this.entries.size} 个 v2 插件`)
  }

  private async loadRecord(record: PluginRecord): Promise<void> {
    const entry: Entry = { record, host: null, snapshot: null }
    try {
      const code = await fs.readFile(record.filePath, 'utf-8')
      const parsed = parsePluginHeader(code)
      if (!parsed.header) throw new Error(parsed.error || '无法解析插件头')

      const host = new V2PluginHost(parsed.header, record.filePath, this.hostDeps())
      entry.record.id = host.id
      entry.record.headerId = parsed.header.id
      entry.record.apiLevel = parsed.header.apiLevel
      entry.record.grants = parsed.header.grants

      if (record.enabled) {
        await host.init(code)
        entry.host = host
        entry.snapshot = this.buildSummary(entry)
        record.lastLoadedAt = Date.now()
        record.lastError = null
      } else {
        entry.snapshot = this.buildSummary({ ...entry, host: placeholderHost(parsed.header, record.filePath, this.hostDeps()) })
      }
    } catch (err) {
      entry.error = (err as Error).message
      entry.record.lastError = entry.error
      entry.record.enabled = false
      this.deps.notify({
        type: 'error',
        pluginId: record.id,
        pluginName: record.headerId,
        message: entry.error
      })
    }
    this.entries.set(entry.record.id, entry)
  }

  /** 安装 / 更新（同路径覆盖） */
  async install(filePath: string): Promise<V2PluginSummary> {
    const code = await fs.readFile(filePath, 'utf-8')
    const parsed = parsePluginHeader(code)
    if (!parsed.header) throw new Error(parsed.error || '无法解析插件头')

    const host = new V2PluginHost(parsed.header, filePath, this.hostDeps())
    for (const warning of parsed.unknownGrants ?? []) {
      host.logs.push('warn', [`忽略了未知的 @grant：${warning}`])
    }
    await host.init(code)

    // 同一文件装了新版本 / 作者改了 @id：清掉同路径的旧条目
    for (const [id, entry] of [...this.entries.entries()]) {
      if (id !== host.id && entry.record.filePath === filePath) {
        await entry.host?.dispose()
        this.entries.delete(id)
      }
    }

    const prev = this.entries.get(host.id)?.record
    const record: PluginRecord = {
      id: host.id,
      headerId: parsed.header.id,
      filePath,
      enabled: true,
      apiLevel: parsed.header.apiLevel,
      grants: parsed.header.grants,
      installedAt: prev?.installedAt ?? Date.now(),
      lastLoadedAt: Date.now(),
      lastError: null
    }
    const entry: Entry = { record, host, snapshot: null }
    entry.snapshot = this.buildSummary(entry)
    this.entries.set(host.id, entry)
    await this.saveConfig()

    this.deps.notify({
      type: 'loaded',
      pluginId: host.id,
      pluginName: parsed.header.name,
      version: parsed.header.version
    })
    return entry.snapshot
  }

  /** 仅解析插件头，不执行脚本（用于导入前的校验/预览） */
  async inspect(
    filePath: string
  ): Promise<{ header: SuchPluginHeader; hostId: string; warnings: string[] }> {
    const code = await fs.readFile(filePath, 'utf-8')
    const parsed = parsePluginHeader(code)
    if (!parsed.header) throw new Error(parsed.error || '无法解析插件头')
    return {
      header: parsed.header,
      hostId: buildPluginHostId(parsed.header, filePath),
      warnings: (parsed.unknownGrants ?? []).map((g) => `未知的 @grant：${g}（已忽略）`)
    }
  }

  /** 启用 / 停用 */
  async setEnabled(pluginId: string, enabled: boolean): Promise<V2PluginSummary> {
    const entry = this.entries.get(pluginId)
    if (!entry) throw new PluginHostError('PLUGIN_ERROR', `插件「${pluginId}」不存在`)

    if (enabled) {
      if (!entry.host) {
        const code = await fs.readFile(entry.record.filePath, 'utf-8')
        const parsed = parsePluginHeader(code)
        if (!parsed.header) throw new Error(parsed.error || '无法解析插件头')
        const host = new V2PluginHost(parsed.header, entry.record.filePath, this.hostDeps())
        await host.init(code)
        entry.host = host
        entry.error = undefined
      }
    } else {
      await entry.host?.dispose()
      entry.host = null
    }

    entry.record.enabled = enabled
    entry.record.lastError = enabled ? null : entry.record.lastError
    entry.snapshot = this.buildSummary(entry)
    await this.saveConfig()

    this.deps.notify({ type: enabled ? 'enabled' : 'disabled', pluginId })
    return entry.snapshot
  }

  /** 重新加载（开发期改完脚本后重跑） */
  async reload(pluginId: string): Promise<V2PluginSummary> {
    const entry = this.entries.get(pluginId)
    if (!entry) throw new PluginHostError('PLUGIN_ERROR', `插件「${pluginId}」不存在`)

    await entry.host?.dispose()
    entry.host = null
    const code = await fs.readFile(entry.record.filePath, 'utf-8')
    const parsed = parsePluginHeader(code)
    if (!parsed.header) throw new Error(parsed.error || '无法解析插件头')
    const host = new V2PluginHost(parsed.header, entry.record.filePath, this.hostDeps())
    await host.init(code)
    entry.host = host
    entry.error = undefined
    entry.record.enabled = true
    entry.record.lastLoadedAt = Date.now()
    entry.record.lastError = null
    entry.snapshot = this.buildSummary(entry)
    await this.saveConfig()
    this.deps.notify({ type: 'enabled', pluginId })
    return entry.snapshot
  }

  /** 移除（含插件数据目录） */
  async remove(pluginId: string): Promise<void> {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    await entry.host?.dispose()
    this.deps.confirm.cancelPlugin(pluginId)
    this.entries.delete(pluginId)
    await this.saveConfig()
    // 卸载即清数据：与「按插件隔离、卸载时移除」的约定一致
    const dir = join(this.deps.userDataDir, 'plugin-data', pluginDataDirName(pluginId))
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    this.deps.notify({ type: 'removed', pluginId })
  }

  /** 自愈：把配置里已启用但未运行的插件再加载一次（10s 冷却） */
  async reloadEnabled(): Promise<boolean> {
    if (this.reloading) return false
    if (Date.now() - this.reloadedAt < 10_000) return false
    this.reloading = true
    this.reloadedAt = Date.now()
    let any = false
    try {
      for (const entry of this.entries.values()) {
        if (!entry.record.enabled || entry.host) continue
        try {
          const code = await fs.readFile(entry.record.filePath, 'utf-8')
          const parsed = parsePluginHeader(code)
          if (!parsed.header) continue
          const host = new V2PluginHost(parsed.header, entry.record.filePath, this.hostDeps())
          await host.init(code)
          entry.host = host
          entry.error = undefined
          entry.snapshot = this.buildSummary(entry)
          any = true
        } catch (err) {
          entry.error = (err as Error).message
          console.warn(`[Plugin] 重新加载失败: ${entry.record.filePath}`, err)
        }
      }
    } finally {
      this.reloading = false
    }
    return any
  }

  // ==================== 查询 ====================

  list(): V2PluginSummary[] {
    return [...this.entries.values()]
      .map((e) => e.snapshot ?? this.buildSummary(e))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  get(pluginId: string): V2PluginSummary | undefined {
    const entry = this.entries.get(pluginId)
    return entry ? entry.snapshot ?? this.buildSummary(entry) : undefined
  }

  has(pluginId: string): boolean {
    return this.entries.has(pluginId)
  }

  getSettings(pluginId: string): { schema: SettingField[]; values: Record<string, unknown> } {
    const entry = this.requireEntry(pluginId)
    // 停用/加载失败的插件没有宿主，也就没有 schema：设置表单显示空态并提示先启用
    if (!entry.host) return { schema: [], values: {} }
    return { schema: entry.host.getSettingsSchema(), values: entry.host.getSettings() }
  }

  async setSetting(
    pluginId: string,
    key: string,
    value: unknown
  ): Promise<Record<string, unknown>> {
    const entry = this.requireEntry(pluginId)
    if (!entry.host) throw new PluginHostError('PLUGIN_DISABLED', '插件已停用，请先启用再修改设置')
    return entry.host.setSetting(key, value)
  }

  logs(pluginId: string, limit?: number): PluginLogEntry[] {
    const entry = this.entries.get(pluginId)
    return entry?.host ? entry.host.logs.entries(limit) : []
  }

  clearLogs(pluginId: string): void {
    this.entries.get(pluginId)?.host?.logs.clear()
  }

  /** 可搜索来源目录 */
  listSearchSources(): SearchSource[] {
    const out: SearchSource[] = []
    for (const entry of this.entries.values()) {
      const host = entry.host
      if (!host) continue
      for (const source of host.getSourceSummaries()) {
        if (!source.actions.includes(SEARCH_ACTION)) continue
        out.push({
          key: `v2:${entry.record.id}:${source.key}`,
          kind: 'v2',
          pluginId: entry.record.id,
          sourceKey: source.key,
          label: source.name,
          pluginName: host.header.name,
          qualities: source.qualities,
          enabled: entry.record.enabled,
          state: 'running'
        })
      }
    }
    return out
  }

  // ==================== 能力派发 ====================

  /** 搜索 */
  async search(req: {
    pluginId?: string
    providerId?: string
    query: string
    limit?: number
    cursor?: string
  }): Promise<V2PageResult<V2Track>> {
    const page = Math.max(1, Number(req.cursor ?? '1') || 1)
    const limit = req.limit ?? 20

    if (req.pluginId) {
      const entry = this.requireRunning(req.pluginId)
      const sourceKey = req.providerId ?? this.firstSearchable(entry.host!)
      if (!sourceKey) {
        throw new PluginHostError('UNSUPPORTED_ACTION', '该插件没有可用于搜索的音源')
      }
      return entry.host!.search({ sourceKey, keyword: req.query, page, limit })
    }

    // 聚合：所有可搜索插件并行请求，单个失败不影响整体
    const targets = [...this.entries.values()].filter(
      (e) => e.record.enabled && e.host && e.host.hasAction(SEARCH_ACTION)
    )
    const results = await Promise.allSettled(
      targets.map(async (entry) => {
        const sourceKey = this.firstSearchable(entry.host!)
        if (!sourceKey) return [] as V2Track[]
        const res = await entry.host!.search({ sourceKey, keyword: req.query, page, limit })
        return res.items
      })
    )
    const items: V2Track[] = []
    for (const result of results) {
      if (result.status === 'fulfilled') items.push(...result.value)
    }
    return { items, hasMore: false }
  }

  /** 解析播放地址 */
  async resolveUrl(req: {
    pluginId?: string
    providerId?: string
    sourceKey?: string
    id?: string
    ref?: unknown
    quality?: string
    qualityOverride?: string
  }): Promise<V2ResolveResult & { pluginId: string }> {
    // 队列/歌单里残留已移除插件的 id：必须报「已移除」，否则 UI 会误导用户去重新导入
    if (req.pluginId && !this.entries.has(req.pluginId) && req.pluginId.startsWith('v2.')) {
      throw new PluginHostError(
        'PLUGIN_ERROR',
        `曲目来自已移除的插件（${req.pluginId}），请重新安装该插件后再播放`
      )
    }
    // 显式指定了 pluginId 但它不可用：给出精确原因（停用 / 加载失败），而不是笼统的「没插件」
    if (req.pluginId) {
      const explicit = this.entries.get(req.pluginId)
      if (explicit && !explicit.record.enabled) {
        throw new PluginHostError(
          'PLUGIN_DISABLED',
          `插件「${explicit.record.headerId}」已停用，请在「设置 → 插件」中启用`
        )
      }
      if (explicit && !explicit.host) {
        throw new PluginHostError(
          'PLUGIN_ERROR',
          `插件「${explicit.record.headerId}」未能加载${explicit.error ? `：${explicit.error}` : ''}`
        )
      }
    }
    const entry = this.locate(req)
    if (!entry?.host) {
      throw new PluginHostError(
        'NO_PLUGIN',
        req.sourceKey
          ? `未找到支持「${req.sourceKey}」音源的 v2 插件`
          : '未找到可解析播放地址的 v2 插件'
      )
    }
    try {
      const res = await entry.host.resolveUrl(req)
      return { pluginId: entry.record.id, ...res }
    } catch (err) {
      throw new PluginHostError(
        'RESOLVE_FAILED',
        `插件「${entry.host.header.name}」解析失败：${(err as Error).message}`
      )
    }
  }

  /** 歌词 */
  async lyric(req: {
    pluginId?: string
    providerId?: string
    sourceKey?: string
    id?: string
    ref?: unknown
  }): Promise<{ lyrics: string; translatedLyrics: string; romanLyrics: string } | null> {
    const entry = req.pluginId ? this.entries.get(req.pluginId) : this.locate(req)
    if (!entry?.host) return null
    try {
      const res: V2LyricResult | null = await entry.host.lyric(req)
      if (!res) return null
      return {
        // 有逐字歌词就优先用它：现有歌词解析链（parseLyricsToCore）认得 YRC/TTML/QRC
        lyrics: res.wordLyrics || res.lyrics,
        translatedLyrics: res.translatedLyrics,
        romanLyrics: res.romanLyrics
      }
    } catch (err) {
      console.warn(`[Plugin] 获取歌词失败 (${entry.record.id}):`, err)
      return null
    }
  }

  /** 封面 */
  async pic(req: {
    pluginId?: string
    providerId?: string
    sourceKey?: string
    id?: string
    ref?: unknown
  }): Promise<{ url: string } | null> {
    const entry = req.pluginId ? this.entries.get(req.pluginId) : this.locate(req)
    if (!entry?.host) return null
    try {
      return await entry.host.pic(req)
    } catch (err) {
      console.warn(`[Plugin] 获取封面失败 (${entry.record.id}):`, err)
      return null
    }
  }

  // ==================== 内部 ====================

  private requireEntry(pluginId: string): Entry {
    const entry = this.entries.get(pluginId)
    if (!entry) throw new PluginHostError('PLUGIN_ERROR', `插件「${pluginId}」已被移除`)
    return entry
  }

  private requireRunning(pluginId: string): Entry {
    const entry = this.requireEntry(pluginId)
    if (!entry.record.enabled) {
      throw new PluginHostError('PLUGIN_DISABLED', `插件「${entry.record.headerId}」已停用`)
    }
    if (!entry.host) {
      throw new PluginHostError(
        'PLUGIN_ERROR',
        `插件「${entry.record.headerId}」未能加载${entry.error ? `：${entry.error}` : ''}`
      )
    }
    return entry
  }

  /** 按 pluginId 或 sourceKey 定位一个可用宿主 */
  private locate(req: { pluginId?: string; providerId?: string; sourceKey?: string }): Entry | null {
    if (req.pluginId) {
      const entry = this.entries.get(req.pluginId)
      if (entry?.host) return entry
    }
    const sourceKey = (req.sourceKey ?? req.providerId)?.toLowerCase()
    if (!sourceKey) return null
    for (const entry of this.entries.values()) {
      if (!entry.record.enabled || !entry.host) continue
      if (entry.host.supports(sourceKey, 'musicUrl')) return entry
      const matched = Object.keys(entry.host.sources).find((k) => k.toLowerCase() === sourceKey)
      if (matched) return entry
    }
    return null
  }

  private firstSearchable(host: V2PluginHost): string | undefined {
    return host
      .getSourceSummaries()
      .find((s) => s.actions.includes(SEARCH_ACTION) && host.hasAction(SEARCH_ACTION))?.key
  }

  private buildSummary(entry: Entry): V2PluginSummary {
    const record = entry.record
    const host = entry.host
    const snapshot = entry.snapshot
    const state: V2PluginState = entry.error
      ? 'error'
      : record.enabled
        ? host
          ? 'running'
          : 'disabled'
        : 'disabled'

    return {
      id: record.id,
      headerId: record.headerId,
      name: host?.header.name ?? snapshot?.name ?? record.headerId,
      version: host?.header.version ?? snapshot?.version ?? '0.0.0',
      description: host?.header.description ?? snapshot?.description,
      author: host?.header.author ?? snapshot?.author,
      homepage: host?.header.homepage ?? snapshot?.homepage,
      apiLevel: host?.header.apiLevel ?? record.apiLevel,
      grants: (host?.header.grants ?? record.grants ?? []) as V2PluginSummary['grants'],
      filePath: record.filePath,
      enabled: record.enabled,
      state,
      error: entry.error ?? record.lastError ?? undefined,
      sources: host?.getSourceSummaries() ?? snapshot?.sources ?? [],
      settingCount: host?.getSettingsSchema().length ?? snapshot?.settingCount ?? 0,
      updateAlert: snapshot?.updateAlert
    }
  }
}

/**
 * 只为读取元信息而构造的宿主：不 init、不执行插件代码。
 * 用于「插件已停用，但列表里仍要显示名称/版本」。
 */
function placeholderHost(header: SuchPluginHeader, filePath: string, deps: HostDeps): V2PluginHost {
  return new V2PluginHost(header, filePath, deps)
}

/** 同步读取插件代码（供需要在同步路径里判定的场景） */
export function readPluginCodeSync(filePath: string): string {
  return readFileSync(filePath, 'utf-8')
}
