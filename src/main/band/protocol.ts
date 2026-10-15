/**
 * SuchMusic 手环通信 · 统一信封与协议纯逻辑（Windows 端 · 主进程）
 *
 * 本模块严格对齐设计文档 `docs/ARCH-手环通信.md` §3（协议规范）：
 * 字段名 / 消息名 / 事件名 / 错误码 / 能力令牌 / 分片常量均为文档冻结值，不得自创。
 *
 * 约束：本文件不得引用任何 Electron API，以便在 Node 下直接做单元测试。
 */

/** 协议主版本。会话内固定为协商值（§3.4）。 */
export const PROTOCOL_VERSION = 1

/** 本端支持的协议版本集合，用于 `sys.hello.proto`（§3.3）。 */
export const PROTOCOL_VERSIONS: readonly number[] = [1]

/** 单包字节上限 chunkMaxBytes（§3.8）。真实上限待验证 V2，先按 900B 保守实现。 */
export const CHUNK_MAX_BYTES = 900

/** 组装缓存上限 assembleMaxBytes（§3.8）。超限即 E_TOOLARGE。 */
export const ASSEMBLE_MAX_BYTES = 8192

/** 请求超时 reqTimeoutMs（§3.11）。 */
export const REQ_TIMEOUT_MS = 3000

/** 重试退避阶梯（§3.11）：同 id 重试 ≤2 次，退避 300ms / 900ms。 */
export const RETRY_BACKOFF_MS: readonly number[] = [300, 900]

/** 进度事件节流上限 player.progress ≤1 次/秒（§3.6 / §3.11）。 */
export const PROGRESS_THROTTLE_MS = 1000

/** 保活 sys.ping 周期（§3.11）。 */
export const PING_INTERVAL_MS = 10000

/** 兜底重同步 state.get 周期（§3.11）。 */
export const RESYNC_INTERVAL_MS = 15000

/** 接收端幂等去重 LRU 容量（§3.11）。 */
export const DEDUP_LRU_SIZE = 64

/** id 前缀：手环 / 手机 / Windows（§3.4 / 附录 D）。 */
export type Origin = 'b' | 'p' | 'w'

/** 信封类型（§3.4）。 */
export type EnvelopeType = 'req' | 'res' | 'evt' | 'err'

/** 角色标识（§3.5 sys.hello.role）。 */
export type BandRole = 'band' | 'phone' | 'windows'

/** 最小泛型 JSON 对象。 */
export type JsonObject = Record<string, unknown>

/** 能力令牌（§3.3，最终值）。 */
export const CAPABILITIES = [
  'playback',
  'queue',
  'search',
  'lyric',
  'playmode',
  'volume',
  'cover',
  'transfer'
] as const

export type Capability = (typeof CAPABILITIES)[number]

/** 统一信封（§3.4，冻结）。 */
export interface Envelope {
  /** 协议主版本，会话内固定 */
  v: number
  /** 格式 `{origin}-{bootId}-{seq}`；evt 亦生成，仅用于日志/去重 */
  id: string
  /** req / res / evt / err */
  type: EnvelopeType
  /** 仅 req 携带 */
  method?: string
  /** 仅 evt 携带 */
  event?: string
  /** 恒存在，可为 {} */
  payload: JsonObject
  /** 发送时间戳（ms）；手机时钟为权威 */
  ts?: number
}

/** 错误载荷（§3.4 / §3.7）。 */
export interface BandErrorPayload {
  code: string
  message: string
  /** E_UNSUPPORTED 时可选携带缺失的能力令牌 */
  missing?: string
}

/** 错误码表（§3.7，冻结）。 */
export const ERROR_CODES = {
  E_BADREQ: '信封/JSON schema 非法（丢弃 + 记录，不重试）',
  E_UNSUPPORTED: '版本/方法/能力不支持（附 missing，不再重试）',
  E_TIMEOUT: '处理超时（同 id 重试）',
  E_NOT_READY: '播放器未就绪（无歌/加载中）',
  E_EMPTY: '队列为空（next/prev/queue.play）',
  E_NOT_FOUND: '歌曲/歌词行不存在',
  E_LINK: '链路断开/发送失败（进入重连）',
  E_TOOLARGE: '分片总量超手环缓存上限（降级为增量模式）',
  E_CRC: '分片校验失败（触发 xfer.nack）',
  E_INTERNAL: '其它内部错误'
} as const

export type ErrorCode = keyof typeof ERROR_CODES

/** 判断某个字符串是否为已冻结的错误码。 */
export function isErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code)
}

/**
 * 方法清单（§3.5，冻结）。
 * `cap` 为 null 表示该方法不需要任何能力；`idempotent` 表示可安全重试。
 */
export interface MethodSpec {
  cap: Capability | null
  idempotent: boolean
}

export const METHODS: Readonly<Record<string, MethodSpec>> = {
  'sys.hello': { cap: null, idempotent: true },
  'sys.ping': { cap: null, idempotent: true },
  'state.get': { cap: null, idempotent: true },
  'playback.play': { cap: 'playback', idempotent: true },
  'playback.pause': { cap: 'playback', idempotent: true },
  'playback.toggle': { cap: 'playback', idempotent: false },
  'playback.next': { cap: 'playback', idempotent: true },
  'playback.prev': { cap: 'playback', idempotent: true },
  'playback.seek': { cap: 'playback', idempotent: true },
  'playback.setMode': { cap: 'playmode', idempotent: true },
  'playback.setVolume': { cap: 'volume', idempotent: true },
  'queue.play': { cap: 'queue', idempotent: true },
  'queue.clear': { cap: 'queue', idempotent: true },
  'search.song': { cap: 'search', idempotent: true },
  'search.suggest': { cap: 'search', idempotent: true },
  'search.hot': { cap: 'search', idempotent: true },
  'lyric.window': { cap: 'lyric', idempotent: true },
  'song.info': { cap: null, idempotent: true },
  'cover.get': { cap: 'cover', idempotent: true },
  'xfer.nack': { cap: 'transfer', idempotent: true }
}

/** 事件清单（§3.6，冻结）。cap 为 null 表示不需要能力。 */
export interface EventSpec {
  cap: Capability | null
}

export const EVENTS: Readonly<Record<string, EventSpec>> = {
  'sys.hello_ack': { cap: null },
  'sys.error': { cap: null },
  'player.state': { cap: 'playback' },
  'player.song': { cap: null },
  'player.progress': { cap: 'playback' },
  'player.mode': { cap: 'playmode' },
  'player.volume': { cap: 'volume' },
  'player.queue': { cap: 'queue' },
  'lyric.line': { cap: 'lyric' },
  'lyric.meta': { cap: 'lyric' },
  'search.result': { cap: 'search' },
  'search.preset': { cap: 'search' },
  'xfer.chunk': { cap: 'transfer' },
  'band.toast': { cap: null }
}

/** 协议侧播放模式（§3.5 playback.setMode）。 */
export type ProtocolPlayMode = 'loop' | 'single' | 'shuffle'

/** Windows 端 playerStore 的播放模式取值（见 `src/renderer/src/stores/playerStore.ts`）。 */
export type WindowsPlayMode = 'list' | 'loop' | 'shuffle'

/**
 * 协议模式 → Windows 模式 映射。
 *
 * 注意两端语义不同（设计文档 §4.4 D1 的同源差异）：
 * - 协议 `loop` = 顺序/列表循环 → Windows `list`（图标 mgc_repeat_line）
 * - 协议 `single` = 单曲循环       → Windows `loop`（图标 mgc_repeat_one_line）
 * - 协议 `shuffle` = 乱序            → Windows `shuffle`
 */
export function protocolPlayModeToWindows(mode: ProtocolPlayMode): WindowsPlayMode {
  switch (mode) {
    case 'loop':
      return 'list'
    case 'single':
      return 'loop'
    case 'shuffle':
      return 'shuffle'
    default:
      return 'list'
  }
}

/**
 * Windows 模式 → 协议模式 映射（`protocolPlayModeToWindows` 的逆）。
 * 未知值回退 `loop` 并交由调用方记录日志（§4.4 D1「未知值回退 loop」）。
 */
export function windowsPlayModeToProtocol(mode: WindowsPlayMode | string): ProtocolPlayMode {
  switch (mode) {
    case 'loop':
      return 'single'
    case 'shuffle':
      return 'shuffle'
    case 'list':
    default:
      return 'loop'
  }
}

/** 判断任意值是否为合法的协议播放模式。 */
export function isProtocolPlayMode(value: unknown): value is ProtocolPlayMode {
  return value === 'loop' || value === 'single' || value === 'shuffle'
}

/** 判断任意值是否为普通对象（非数组、非 null）。 */
export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断任意值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** 将 4 位以内的序号格式化为协议 id 的 `seq` 段（十六进制、补零到 4 位）。 */
export function formatSeq(seq: number): string {
  const safe = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0
  return safe.toString(16).padStart(4, '0')
}

/** 生成一个 4 位十六进制 bootId（各端随机，§3.4）。 */
export function generateBootId(random: () => number = Math.random): string {
  const value = Math.floor((random() || 0) * 0x10000) & 0xffff
  return value.toString(16).padStart(4, '0')
}

/** 按 `{origin}-{bootId}-{seq}` 生成信封 id（§3.4）。 */
export function createId(origin: Origin, bootId: string, seq: number): string {
  return `${origin}-${bootId}-${formatSeq(seq)}`
}

/**
 * 递增序号生成器：为同一 origin 持续生成 `{origin}-{bootId}-{seq}`。
 */
export class IdGenerator {
  private seq = 0

  constructor(
    private readonly origin: Origin,
    private readonly bootId: string = generateBootId()
  ) {}

  /** 生成下一个 id（seq 从 1 开始）。 */
  next(): string {
    this.seq += 1
    return createId(this.origin, this.bootId, this.seq)
  }

  /** 当前已使用的序号。 */
  get current(): number {
    return this.seq
  }

  /** 当前 bootId。 */
  get boot(): string {
    return this.bootId
  }
}

/** 构造 `req` 信封。 */
export function buildReq(
  id: string,
  method: string,
  payload: JsonObject = {},
  ts: number = Date.now()
): Envelope {
  return { v: PROTOCOL_VERSION, id, type: 'req', method, payload, ts }
}

/** 构造 `res` 信封（复用请求 id，§3.4）。 */
export function buildRes(id: string, payload: JsonObject = {}, ts: number = Date.now()): Envelope {
  return { v: PROTOCOL_VERSION, id, type: 'res', payload, ts }
}

/** 构造 `err` 信封（复用请求 id，§3.4）。 */
export function buildErr(
  id: string,
  code: ErrorCode | string,
  message: string,
  missing?: string,
  ts: number = Date.now()
): Envelope {
  const payload: BandErrorPayload = { code, message }
  if (missing) payload.missing = missing
  return { v: PROTOCOL_VERSION, id, type: 'err', payload: { ...payload }, ts }
}

/** 构造 `evt` 信封。 */
export function buildEvt(
  id: string,
  event: string,
  payload: JsonObject = {},
  ts: number = Date.now()
): Envelope {
  return { v: PROTOCOL_VERSION, id, type: 'evt', event, payload, ts }
}

/** 信封序列化为 UTF-8 JSON 字符串（§3.1）。 */
export function encodeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope)
}

/** 解码结果：成功携带信封，失败携带错误码与说明。 */
export type DecodeResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; error: BandErrorPayload }

/**
 * 解析并校验一封来自对端的原始消息（§3.4 / §3.7）。
 * 任何 schema 非法均返回 `E_BADREQ`，调用方应丢弃并记录、不重试。
 */
export function decodeEnvelope(raw: string): DecodeResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: { code: 'E_BADREQ', message: 'JSON 解析失败' } }
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: { code: 'E_BADREQ', message: '信封必须是 JSON 对象' } }
  }

  const { v, id, type, method, event, payload, ts } = parsed as Partial<Envelope>

  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { ok: false, error: { code: 'E_BADREQ', message: '字段 v 必须是数字' } }
  }

  if (type !== 'req' && type !== 'res' && type !== 'evt' && type !== 'err') {
    return { ok: false, error: { code: 'E_BADREQ', message: '字段 type 非法' } }
  }

  // req / res / err 必须携带 id；evt 允许缺失（§3.4 注）。
  if (type !== 'evt' && !isNonEmptyString(id)) {
    return { ok: false, error: { code: 'E_BADREQ', message: '字段 id 缺失或非法' } }
  }

  const normalizedId = typeof id === 'string' ? id : ''

  if (type === 'req' && !isNonEmptyString(method)) {
    return { ok: false, error: { code: 'E_BADREQ', message: 'req 必须携带 method' } }
  }

  if (type === 'evt' && !isNonEmptyString(event)) {
    return { ok: false, error: { code: 'E_BADREQ', message: 'evt 必须携带 event' } }
  }

  if (payload !== undefined && !isRecord(payload)) {
    return { ok: false, error: { code: 'E_BADREQ', message: '字段 payload 必须是对象' } }
  }

  if (ts !== undefined && (typeof ts !== 'number' || !Number.isFinite(ts))) {
    return { ok: false, error: { code: 'E_BADREQ', message: '字段 ts 必须是数字' } }
  }

  const envelope: Envelope = {
    v,
    id: normalizedId,
    type,
    payload: (payload as JsonObject) ?? {}
  }
  if (typeof method === 'string') envelope.method = method
  if (typeof event === 'string') envelope.event = event
  if (typeof ts === 'number') envelope.ts = ts

  return { ok: true, envelope }
}

/**
 * 版本协商（§3.3）：取双方 `.proto` 交集的最大值。
 * 交集为空返回 null，表示无可通信版本。
 */
export function negotiateVersion(
  bandProto: readonly number[],
  phoneProto: readonly number[]
): number | null {
  const common = bandProto.filter((version) => phoneProto.includes(version))
  if (common.length === 0) return null
  return Math.max(...common)
}

/**
 * 能力协商（§3.3）：生效能力 = 双方 caps 的交集。
 * 结果按自我方（本端）声明的顺序输出，便于稳定比较。
 */
export function negotiateCaps(
  selfCaps: readonly string[],
  peerCaps: readonly string[]
): Capability[] {
  const peer = new Set(peerCaps)
  return selfCaps.filter((cap): cap is Capability => peer.has(cap) && isCapability(cap))
}

/** 判断字符串是否为合法能力令牌。 */
export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value)
}

/** 给定目标方法，计算本端缺失的必要能力（用于发送前过滤 / 回 E_CAP）。 */
export function missingCapabilities(
  method: string,
  effectiveCaps: readonly string[]
): Capability | null {
  const spec = METHODS[method]
  if (!spec || spec.cap === null) return null
  return effectiveCaps.includes(spec.cap) ? null : spec.cap
}

/** 给定方法名返回其所需能力（无则 null）。 */
export function methodCap(method: string): Capability | null {
  return METHODS[method]?.cap ?? null
}

/** 给定事件名返回其所需能力（无则 null）。 */
export function eventCap(event: string): Capability | null {
  return EVENTS[event]?.cap ?? null
}

/** 判断方法是否幂等（可安全重试）。未知方法按不幂等处理。 */
export function isMethodIdempotent(method: string): boolean {
  return METHODS[method]?.idempotent === true
}

/** 判断某方法是否在本协议冻结清单内。 */
export function isKnownMethod(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(METHODS, method)
}

/** 判断某事件是否在本协议冻结清单内。 */
export function isKnownEvent(event: string): boolean {
  return Object.prototype.hasOwnProperty.call(EVENTS, event)
}

/** 错误码语义查询（用于日志 / UI 提示）。 */
export function errorCodeMeaning(code: string): string {
  return isErrorCode(code) ? ERROR_CODES[code] : '未知错误码'
}

/**
 * 判断某次失败是否应重试（§3.11）：
 * - 仅 E_TIMEOUT / E_LINK 重试；
 * - E_UNSUPPORTED / E_BADREQ 明确不重试；
 * - 总尝试次数（含首次）上限 3（即重试 ≤2 次）。
 */
export function shouldRetry(code: string, attempts: number): boolean {
  const maxAttempts = RETRY_BACKOFF_MS.length + 1
  if (attempts >= maxAttempts) return false
  return code === 'E_TIMEOUT' || code === 'E_LINK'
}

/** 第 `attempts` 次重试前的退避毫秒数（attempts 从 1 起）。 */
export function retryBackoffMs(attempts: number): number {
  if (attempts < 1) return RETRY_BACKOFF_MS[0]
  const index = Math.min(attempts, RETRY_BACKOFF_MS.length) - 1
  return RETRY_BACKOFF_MS[index]
}

/**
 * 按每秒 ≤1 次的规则计算下一次允许推送 `player.progress` 的时间点（§3.6）。
 * seek / 切歌时可传 `force=true` 立即补发。
 */
export function shouldEmitProgress(
  now: number,
  lastEmitAt: number,
  force = false,
  intervalMs = PROGRESS_THROTTLE_MS
): boolean {
  if (force) return true
  return now - lastEmitAt >= intervalMs
}

/** 歌曲 DTO（§3.5.1 / §3.5.2），字段名冻结。 */
export interface SongDto {
  id: string
  name: string
  artist: string
  album?: string
  durationMs?: number
  source?: string
  hasCover?: boolean
}

/** 播放状态快照（§3.5.1）。 */
export interface StateSnapshot {
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'error'
  playing: boolean
  song: SongDto | null
  positionMs: number
  durationMs: number
  mode: ProtocolPlayMode
  volume?: number
  queue: { count: number; currentIndex: number }
  lyric: { has: boolean; count: number }
  ts: number
}

/** 将任意字符串安全转为歌曲 DTO，字段名对齐协议。 */
export function normalizeSongDto(raw: unknown): SongDto | null {
  if (!isRecord(raw)) return null
  const id = raw.id
  const name = raw.name
  if (typeof id !== 'string' && typeof id !== 'number') return null
  if (typeof name !== 'string') return null
  const dto: SongDto = {
    id: String(id),
    name,
    artist: typeof raw.artist === 'string' ? raw.artist : ''
  }
  if (typeof raw.album === 'string') dto.album = raw.album
  if (typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)) {
    dto.durationMs = raw.durationMs
  }
  if (typeof raw.source === 'string') dto.source = raw.source
  if (typeof raw.hasCover === 'boolean') dto.hasCover = raw.hasCover
  return dto
}
