/**
 * 单个 v2 插件的宿主
 *
 * 生命周期：`init()`（建沙箱 → 执行脚本 → 等 such.register → 归一化能力）
 *          → 处理动作调用 → `dispose()`
 *
 * 几条硬规矩：
 * - 插件代码只在 `init()` 里执行一次；之后所有交互都走 `actions` 里注册的 handler
 * - 跨 realm 的返回值一律先 `awaitResult()`（`instanceof Promise` 在 vm 里不可靠）
 * - 所有出宿主的数据先 `toSerializable()`，避免结构化克隆失败
 * - `dispose()` 后任何调用都直接拒绝，防止挂起的插件 Promise 回写已销毁的宿主
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { basename } from 'node:path'
import type {
  PlaylistOpRequest,
  PlaylistOpResponse,
  SensitiveOperation,
  SuchCandidate,
  SuchMusicAction,
  SuchPluginHeader,
  SuchRegisterDeclaration,
  SuchSourceDeclaration,
  V2LyricResult,
  V2PageResult,
  V2ResolveResult,
  V2Track
} from './types'
import { buildPluginHostId, pluginDataDirName } from './header'
import { awaitResult, createSandbox, withTimeout, type Sandbox } from './runtime/sandbox'
import { PluginLogRing } from './runtime/logs'
import { PluginStorage } from './runtime/storage'
import { PluginSettingsStore, normalizeSettingSchema } from './runtime/settings'
import { buildSuchApi, type SuchApiContext, type SuchHandler } from './runtime/suchApi'
import { pickDeclaredQuality } from './runtime/quality'
import type { ConfirmQueue } from './runtime/confirm'
import { toSerializable } from '../shared/plugin/serialize'
import type { PluginNotice, SettingField, V2PluginState, V2SourceSummary } from '../shared/plugin/types'

/** 单个候选序列化后的字节上限（随队列/歌单持久化，不能塞大对象） */
const CANDIDATE_MAX_BYTES = 8192

/** 各动作的超时（播放地址需要多等一会儿） */
const ACTION_TIMEOUT: Record<string, number> = {
  musicUrl: 20_000,
  musicSearch: 15_000,
  musicLyric: 15_000,
  musicPic: 15_000
}

/** 宿主依赖（由应用层注入，src/plugin 不直接依赖 electron / main） */
export interface HostDeps {
  userDataDir: string
  appVersion: string
  locale: string
  confirm: ConfirmQueue
  playlistOp: (req: PlaylistOpRequest) => Promise<PlaylistOpResponse>
  writeAudioMeta: (filePath: string, tags: Record<string, unknown>) => Promise<boolean>
  notify: (notice: PluginNotice) => void
}

/** 解析音源请求（宿主内部用） */
export interface HostResolveRequest {
  sourceKey?: string
  providerId?: string
  id?: string
  ref?: unknown
  quality?: string
  qualityOverride?: string
}

interface SettingsFileShape {
  values?: Record<string, unknown>
}

export class V2PluginHost {
  readonly id: string
  readonly header: SuchPluginHeader
  readonly filePath: string
  readonly logs = new PluginLogRing()
  readonly storage: PluginStorage

  /** 声明的音源表 */
  sources: Record<string, SuchSourceDeclaration> = {}
  /** 设置 schema（register 之后才确定） */
  settingsSchema: SettingField[] = []
  /** schema 归一化过程中的告警 */
  warnings: string[] = []

  private actions = new Map<string, SuchHandler>()
  private sandbox: Sandbox | null = null
  /** 设置存储：注册时热替换 schema，实例本身不变（插件可能已持有引用） */
  private readonly settingsStore: PluginSettingsStore
  private readonly settingsFile: string
  private readonly settingsRaw: Record<string, unknown>
  private disposed = false
  private state: V2PluginState = 'disabled'
  private callSeq = 0

  constructor(
    header: SuchPluginHeader,
    filePath: string,
    private readonly deps: HostDeps
  ) {
    this.header = header
    this.filePath = filePath
    this.id = buildPluginHostId(header, filePath)

    const dir = join(deps.userDataDir, 'plugin-data', pluginDataDirName(this.id))
    this.storage = new PluginStorage(join(dir, 'storage.json'))
    this.storage.loadSync()

    this.settingsFile = join(dir, 'settings.json')
    this.settingsRaw = readJsonSync(this.settingsFile)
    this.settingsStore = new PluginSettingsStore(this.settingsFile)
  }

  getState(): V2PluginState {
    return this.state
  }

  /** 已声明的设置 schema 副本 */
  getSettingsSchema(): SettingField[] {
    return [...this.settingsSchema]
  }

  /** 当前设置值 */
  getSettings(): Record<string, unknown> {
    return this.settingsStore.all()
  }

  /** 写入一项设置；返回归一化后的完整值表 */
  async setSetting(key: string, value: unknown): Promise<Record<string, unknown>> {
    this.assertAlive()
    const values = await this.settingsStore.set(key, value)
    return values
  }

  /** 能力摘要（与音源注册表的 capability 形状对齐） */
  getSourceSummaries(): V2SourceSummary[] {
    return Object.entries(this.sources).map(([key, decl]) => ({
      key,
      name: decl.name || key,
      actions: decl.actions,
      qualities: decl.qualities ?? []
    }))
  }

  hasAction(action: string): boolean {
    return this.actions.has(action)
  }

  /** 声明了该 sourceKey 且带该动作 */
  supports(sourceKey: string | undefined, action: SuchMusicAction): boolean {
    if (!sourceKey) return false
    const decl = this.sources[sourceKey]
    if (!decl) return false
    return decl.actions.includes(action) && this.actions.has(action)
  }

  /** 启动：执行脚本并收集声明 */
  async init(code: string): Promise<void> {
    if (this.disposed) throw new Error('插件宿主已销毁')

    const ctx: SuchApiContext = {
      pluginId: this.id,
      header: this.header,
      appVersion: this.deps.appVersion,
      locale: this.deps.locale,
      logs: this.logs,
      storage: this.storage,
      settings: this.settingsStore,
      confirm: this.deps.confirm,
      onRegister: (decl) => this.applyRegistration(decl),
      onAction: (action, handler) => this.actions.set(action, handler),
      notify: (message, type) =>
        this.deps.notify({
          type: 'notify',
          pluginId: this.id,
          pluginName: this.header.name,
          message,
          notifyType: type
        }),
      playlistOp: (req) => this.deps.playlistOp(req),
      writeAudioMeta: (filePath, tags) => this.deps.writeAudioMeta(filePath, tags),
      requestConfirm: (_pluginName, operation, detail) => this.requestConfirm(operation, detail)
    }

    const suchApi = buildSuchApi(ctx)

    this.sandbox = createSandbox(this.id, {
      globals: 'v2',
      logScope: 'Plugin',
      extra: { such: suchApi },
      onLog: (level, args) => this.logs.push(level === 'log' ? 'info' : level, args)
    })

    this.state = 'running'
    try {
      this.sandbox.run(code, basename(this.filePath), 8000)
    } catch (err) {
      this.state = 'error'
      throw new Error(`插件脚本执行失败：${(err as Error).message}`)
    }

    if (Object.keys(this.sources).length === 0) {
      this.state = 'error'
      throw new Error('插件未声明任何音源（such.register({ sources }) 为空）')
    }

    // 生效一次设置落盘（补齐默认值，方便用户在设置里看到完整值）
    await this.settingsStore.flush()
  }

  /** 处理 `such.register()` */
  private applyRegistration(decl: SuchRegisterDeclaration): void {
    if (decl.sources && typeof decl.sources === 'object') {
      this.sources = normalizeSources(decl.sources)
    }

    const normalized = normalizeSettingSchema(decl.settings)
    this.warnings = normalized.warnings
    for (const w of normalized.warnings) this.logs.push('warn', [`settings 声明问题：${w}`])
    this.settingsSchema = normalized.schema

    // 复用同一个 store：插件在 register 之后可能立刻 getSetting，必须已经就绪
    this.settingsStore.replaceSchema(normalized.schema, this.settingsRaw)
  }

  private async requestConfirm(
    operation: SensitiveOperation,
    detail: string
  ): Promise<boolean> {
    return this.deps.confirm.request(this.id, this.header.name, operation, detail)
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('插件已卸载')
  }

  /** 调用一个动作 handler，带超时与跨 realm 归一 */
  private async callAction<T>(action: SuchMusicAction, payload: unknown): Promise<T> {
    this.assertAlive()
    const handler = this.actions.get(action)
    if (!handler) throw new Error(`插件「${this.header.name}」未实现 ${action}`)

    const seq = ++this.callSeq
    const timeoutMs = ACTION_TIMEOUT[action] ?? 15_000
    const result = await withTimeout(
      awaitResult<T>(handler(payload)),
      timeoutMs,
      `插件「${this.header.name}」执行 ${action} 超时（${timeoutMs}ms）`
    )
    if (this.disposed || seq !== this.callSeq) {
      // 超时后插件才返回：丢弃结果，避免回写到已变化的宿主状态
      throw new Error(`插件「${this.header.name}」的 ${action} 结果已过期`)
    }
    return result
  }

  /** 搜索 */
  async search(req: {
    sourceKey: string
    keyword: string
    page?: number
    limit?: number
  }): Promise<V2PageResult<V2Track>> {
    const decl = this.sources[req.sourceKey]
    if (!decl) throw new Error(`插件「${this.header.name}」没有音源 "${req.sourceKey}"`)

    const page = Math.max(1, Math.floor(req.page ?? 1))
    const limit = Math.min(Math.max(1, Math.floor(req.limit ?? 20)), 50)
    const raw = await this.callAction<any>('musicSearch', {
      source: req.sourceKey,
      keyword: req.keyword,
      page,
      limit
    })

    const list = Array.isArray(raw?.list) ? raw.list : []
    const items: V2Track[] = []
    for (const candidate of list) {
      const clean = this.sanitizeCandidate(candidate)
      if (clean) items.push(this.toTrack(clean, req.sourceKey))
    }

    const total = typeof raw?.total === 'number' ? raw.total : undefined
    const hasMore =
      typeof raw?.hasMore === 'boolean' ? raw.hasMore : total !== undefined ? page * limit < total : items.length >= limit

    return {
      items,
      hasMore,
      nextCursor: hasMore ? String(page + 1) : undefined,
      totalEstimate: total
    }
  }

  /** 解析播放地址 */
  async resolveUrl(req: HostResolveRequest): Promise<V2ResolveResult> {
    const sourceKey = req.sourceKey ?? req.providerId ?? ''
    const decl = this.sources[sourceKey]
    if (!decl) throw new Error(`插件「${this.header.name}」没有音源 "${sourceKey}"`)

    const musicInfo = this.buildMusicInfo(req)
    const quality = pickDeclaredQuality(decl.qualities ?? [], req.qualityOverride ?? req.quality ?? '320k')
    const raw = await this.callAction<any>('musicUrl', {
      source: sourceKey,
      musicInfo,
      quality
    })

    const url = typeof raw?.url === 'string' ? raw.url : ''
    if (!url) throw new Error(`插件「${this.header.name}」未返回播放地址`)

    return {
      url,
      expiresAt: typeof raw?.expire === 'number' ? raw.expire : undefined,
      requestHeaders: normalizeHeaders(raw?.headers ?? raw?.requestHeaders)
    }
  }

  /** 歌词 */
  async lyric(req: HostResolveRequest): Promise<V2LyricResult | null> {
    const sourceKey = req.sourceKey ?? req.providerId ?? ''
    if (!this.sources[sourceKey]) return null
    if (!this.hasAction('musicLyric')) return null

    const raw = await this.callAction<any>('musicLyric', {
      source: sourceKey,
      musicInfo: this.buildMusicInfo(req)
    })
    if (!raw) return null
    const lyric = typeof raw.lyric === 'string' ? raw.lyric : ''
    const word = typeof raw.awlyric === 'string' ? raw.awlyric : ''
    if (!lyric && !word) return null
    return {
      lyrics: lyric,
      translatedLyrics: typeof raw.tlyric === 'string' ? raw.tlyric : '',
      romanLyrics: typeof raw.rlyric === 'string' ? raw.rlyric : '',
      wordLyrics: word || undefined
    }
  }

  /** 封面 */
  async pic(req: HostResolveRequest): Promise<{ url: string } | null> {
    const sourceKey = req.sourceKey ?? req.providerId ?? ''
    if (!this.sources[sourceKey]) return null
    if (!this.hasAction('musicPic')) return null

    const raw = await this.callAction<any>('musicPic', {
      source: sourceKey,
      musicInfo: this.buildMusicInfo(req)
    })
    const url = typeof raw?.url === 'string' ? raw.url : ''
    return url ? { url } : null
  }

  /** 卸载 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.state = 'disabled'
    this.callSeq++
    this.actions.clear()
    this.sandbox?.clearTimers()
    this.sandbox = null
    this.deps.confirm.cancelPlugin(this.id)
    await this.settingsStore.flush().catch(() => undefined)
    await this.storage.flush().catch(() => undefined)
  }

  // ---------- 内部工具 ----------

  /** 还原传给插件的 musicInfo：优先用持久化的 ref，其次用 id 兜底 */
  private buildMusicInfo(req: HostResolveRequest): SuchCandidate {
    if (req.ref && typeof req.ref === 'object') {
      const ref = { ...(req.ref as Record<string, unknown>) }
      if (ref.id === undefined && req.id !== undefined) ref.id = req.id
      return ref as unknown as SuchCandidate
    }
    return {
      id: String(req.id ?? ''),
      name: ''
    } as SuchCandidate
  }

  /** 收敛候选：剥 Proxy + 限制 8 KiB */
  private sanitizeCandidate(raw: unknown): SuchCandidate | null {
    if (!raw || typeof raw !== 'object') return null
    const clean = toSerializable(raw) as Record<string, unknown>
    if (!clean || clean.id === undefined || clean.id === null || clean.id === '') return null
    if (!clean.name) return null

    let size = 0
    try {
      size = Buffer.byteLength(JSON.stringify(clean), 'utf8')
    } catch {
      this.logs.push('warn', ['候选含不可序列化字段，已丢弃'])
      return null
    }
    if (size > CANDIDATE_MAX_BYTES) {
      this.logs.push('warn', [
        `候选「${String(clean.name)}」序列化后 ${size}B，超过 ${CANDIDATE_MAX_BYTES}B 上限，已跳过`
      ])
      return null
    }
    return clean as unknown as SuchCandidate
  }

  /** 候选 → 统一曲目结构 */
  private toTrack(candidate: SuchCandidate, sourceKey: string): V2Track {
    const decl = this.sources[sourceKey]
    const duration = Number(candidate.durationMs)
    return {
      pluginId: this.id,
      sourceKey,
      id: String(candidate.id),
      ref: candidate,
      title: String(candidate.name),
      artist: candidate.singer ? String(candidate.singer) : '未知歌手',
      album: candidate.album ? String(candidate.album) : undefined,
      coverUrl: candidate.cover ? String(candidate.cover) : undefined,
      durationMs: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      qualities: decl?.qualities ?? [],
      playable: decl ? decl.actions.includes('musicUrl') : false
    }
  }
}

/** `register({ sources })` 归一化：丢掉非法条目，补默认值 */
function normalizeSources(raw: Record<string, any>): Record<string, SuchSourceDeclaration> {
  const out: Record<string, SuchSourceDeclaration> = {}
  const allowed: SuchMusicAction[] = ['musicUrl', 'musicSearch', 'musicLyric', 'musicPic']

  for (const [key, value] of Object.entries(raw)) {
    const name = key.trim()
    if (!name || !value || typeof value !== 'object') continue
    const actions = Array.isArray(value.actions)
      ? (value.actions.filter((a: unknown) => allowed.includes(a as SuchMusicAction)) as SuchMusicAction[])
      : []
    if (actions.length === 0) continue
    const qualities = Array.isArray(value.qualities)
      ? value.qualities.filter((q: unknown) => typeof q === 'string').map((q: string) => q.toLowerCase())
      : []
    out[name] = {
      name: typeof value.name === 'string' && value.name ? value.name : name,
      actions,
      qualities
    }
  }
  return out
}

/** 只保留字符串键值的请求头 */
function normalizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 同步读取 settings.json（忽略一切错误） */
function readJsonSync(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as SettingsFileShape
    return parsed && typeof parsed.values === 'object' && parsed.values ? parsed.values : {}
  } catch {
    return {}
  }
}
