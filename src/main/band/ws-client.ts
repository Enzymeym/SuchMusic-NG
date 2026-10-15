/**
 * SuchMusic 手环通信 · WebSocket 客户端（Windows 端 · 主进程）
 *
 * 链路：`Windows（本模块）↔ 手机 BandWsServer ↔ 手环快应用`（§2.2 / §4.3）。
 * 手环无法被 Windows 直连，Windows 只能经手机中转（F11）。
 *
 * 对齐设计文档：
 * - §3.1 传输层：信封序列化为 UTF-8 JSON 字符串后经 WebSocket 传输；
 * - §3.6 / §3.11 握手：连上后发 `sys.hello`，收 `sys.hello_ack` 后 `state.get` 重同步；
 * - §3.8 分片：`xfer.chunk` header→data→end，校验失败回 `xfer.nack`；
 * - §3.11 保活 10s、兜底同步 15s、断线退避 1s→2s→4s（上限 8s）。
 *
 * 依赖：仅使用宿主全局 `WebSocket`（Node 22 / Electron 主进程内置），不新增依赖。
 * 约束：本文件不 import 任何 Electron API，便于在 Node 下测试。
 */

import { EventEmitter } from 'node:events'
import { ChunkAssembler, feedAssembler, type ChunkPayload } from './chunk'
import { LruDeduper } from './dedup'
import {
  CAPABILITIES,
  IdGenerator,
  PING_INTERVAL_MS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  REQ_TIMEOUT_MS,
  RESYNC_INTERVAL_MS,
  buildErr,
  buildReq,
  decodeEnvelope,
  encodeEnvelope,
  negotiateCaps,
  negotiateVersion,
  type BandErrorPayload,
  type Capability,
  type Envelope,
  type JsonObject
} from './protocol'
import { RequestTracker } from './requests'

/** 客户端连接状态（§3.2 手机端状态机的 Windows 对称）。 */
export type BandClientState =
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'ready'
  | 'error'

/** 对外暴露的状态快照。 */
export interface BandClientStatus {
  state: BandClientState
  /** 已连接的手机地址（未连接时为空） */
  peer: string
  /** 协商后的协议版本 */
  proto: number
  /** 生效能力（协商交集） */
  caps: Capability[]
  /** 最近一次错误 */
  lastError: BandErrorPayload | null
  /** 断线重连尝试次数 */
  reconnectAttempts: number
}

/** 连接参数。 */
export interface BandConnectOptions {
  url: string
  /** 配对码（首次握手用，§4.3） */
  pairCode: string
  /** 会话令牌（可选，§4.3） */
  token: string
}

/** 极简 WebSocket 接口（避免依赖 DOM / undici 类型定义）。 */
interface WsLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
}

type WsCtor = new (url: string) => WsLike

/** 取全局 WebSocket 构造器；不存在时返回 undefined（由调用方报错）。 */
export function getWebSocketCtor(): WsCtor | undefined {
  return (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket
}

/**
 * 去除 URL 中的查询串，避免令牌等敏感信息出现在日志 / 状态里（§3.12）。
 */
export function sanitizeUrl(url: string): string {
  const index = url.indexOf('?')
  return index >= 0 ? url.slice(0, index) : url
}

/** WebSocket.OPEN 常量。 */
const WS_OPEN = 1

/** 对外事件名（EventEmitter）：`status` / `event` / `error` / `log` / `snapshot` / `xfer`。 */
export interface BandClientEvents {
  status: (status: BandClientStatus) => void
  event: (event: string, payload: JsonObject) => void
  snapshot: (payload: JsonObject) => void
  error: (error: BandErrorPayload) => void
  log: (message: string) => void
  /** 分片组装完成：kind + 还原后的文本 */
  xfer: (kind: string, tid: string, text: string) => void
}

/** 入站 `req` 处理器签名（Windows 作为接收端时的可选能力，§3.11 幂等）。 */
export type InboundRequestHandler = (method: string, payload: JsonObject) => JsonObject

export class BandWsClient extends EventEmitter {
  private readonly idGen = new IdGenerator('w')
  /** 已发出但未收尾的信封，供超时重试时按**同一 id** 重发（§3.11）。 */
  private readonly pendingEnvelopes = new Map<string, Envelope>()
  private readonly tracker = new RequestTracker<JsonObject>(REQ_TIMEOUT_MS, undefined, (id) =>
    this.resendPending(id)
  )
  private readonly inboundDeduper = new LruDeduper<string>()
  private readonly inboundHandlers = new Map<string, InboundRequestHandler>()
  private readonly assembler = new ChunkAssembler()

  private ws: WsLike | null = null
  private options: BandConnectOptions | null = null
  private manualClose = false
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private state: BandClientState = 'disabled'
  private proto = PROTOCOL_VERSION
  private caps: Capability[] = []
  private lastError: BandErrorPayload | null = null
  private reconnectAttempts = 0

  /** 当前状态快照。 */
  getStatus(): BandClientStatus {
    return {
      state: this.state,
      peer: this.ws && this.options ? sanitizeUrl(this.options.url) : '',
      proto: this.proto,
      caps: [...this.caps],
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts
    }
  }

  /** 启用并连接（§4.3：默认关闭，用户显式开启后调用）。 */
  async connect(options: BandConnectOptions): Promise<void> {
    const ctor = getWebSocketCtor()
    if (!ctor) {
      this.setError({ code: 'E_INTERNAL', message: '当前运行环境缺少全局 WebSocket' })
      return
    }

    this.options = options
    this.manualClose = false
    this.reconnectAttempts = 0
    this.openSocket(ctor)
  }

  /** 主动断开（同时关闭自动重连）。 */
  disconnect(): void {
    this.manualClose = true
    this.clearTimers()
    this.tracker.rejectAll('E_LINK', '链路已断开')
    if (this.ws && this.ws.readyState === WS_OPEN) {
      try {
        this.ws.close(1000, 'client disconnect')
      } catch {
        // 忽略关闭异常
      }
    }
    this.ws = null
    this.setState('disabled')
  }

  /** 是否已就绪（可发请求）。 */
  get isReady(): boolean {
    return this.state === 'ready' && this.ws !== null && this.ws.readyState === WS_OPEN
  }

  /** 注册入站请求处理器（Windows 作为接收端时使用）。 */
  registerInboundHandler(method: string, handler: InboundRequestHandler): void {
    this.inboundHandlers.set(method, handler)
  }

  /**
   * 发送一个 RPC 请求（§3.5）。
   * @throws 当链路未就绪或超时（错误对象带 `code`）。
   */
  async request(method: string, payload: JsonObject = {}): Promise<JsonObject> {
    if (!this.isReady) {
      const error: Error & { code?: string } = new Error('链路未就绪')
      error.code = 'E_LINK'
      throw error
    }
    const id = this.idGen.next()
    const envelope = buildReq(id, method, payload)
    this.pendingEnvelopes.set(id, envelope)
    const promise = this.tracker.track(id, method)
    this.sendEnvelope(envelope)

    // 收尾时清理重发缓存
    return promise.then(
      (value) => {
        this.pendingEnvelopes.delete(id)
        return value
      },
      (error) => {
        this.pendingEnvelopes.delete(id)
        throw error
      }
    )
  }

  /** 按同一 id 重发已发出的信封（§3.11 同 id 重试）。 */
  private resendPending(id: string): void {
    const envelope = this.pendingEnvelopes.get(id)
    if (!envelope) return
    this.log(`重发 ${envelope.method ?? envelope.event ?? 'req'} (${id})`)
    this.sendEnvelope(envelope)
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  private openSocket(ctor: WsCtor): void {
    if (!this.options) return
    this.setState('connecting')
    this.log(`正在连接 ${sanitizeUrl(this.options.url)}`)

    let socket: WsLike
    try {
      socket = new ctor(this.options.url)
    } catch (error) {
      this.setError({ code: 'E_LINK', message: `WebSocket 初始化失败：${String(error)}` })
      this.scheduleReconnect()
      return
    }
    this.ws = socket

    socket.onopen = (): void => {
      this.reconnectAttempts = 0
      this.setState('handshaking')
      this.sendHello()
    }
    socket.onmessage = (event): void => {
      this.handleRawMessage(event?.data)
    }
    socket.onerror = (): void => {
      this.emit('error', { code: 'E_LINK', message: 'WebSocket 发生错误' })
    }
    socket.onclose = (): void => {
      this.handleClose()
    }
  }

  /** 握手首帧 `sys.hello`（§3.3 / §4.3）。 */
  private sendHello(): void {
    if (!this.ws || !this.options) return
    const payload: JsonObject = {
      role: 'windows',
      proto: [...PROTOCOL_VERSIONS],
      caps: [...CAPABILITIES]
    }
    if (this.options.pairCode) payload.pair = this.options.pairCode
    if (this.options.token) payload.token = this.options.token
    this.sendEnvelope(buildReq(this.idGen.next(), 'sys.hello', payload))
  }

  private sendEnvelope(envelope: Envelope): void {
    this.sendRaw(encodeEnvelope(envelope))
  }

  /** 直接发送已编码的原始 JSON 字符串（用于回放去重缓存响应）。 */
  private sendRaw(text: string): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      this.emit('error', { code: 'E_LINK', message: '发送失败：链路未打开' })
      return
    }
    try {
      this.ws.send(text)
    } catch (error) {
      this.emit('error', { code: 'E_LINK', message: `发送异常：${String(error)}` })
    }
  }

  private handleRawMessage(raw: unknown): void {
    const text = typeof raw === 'string' ? raw : this.decodeUnknown(raw)
    if (text === null) return

    const decoded = decodeEnvelope(text)
    if (!decoded.ok) {
      this.emit('error', decoded.error)
      return
    }

    const envelope = decoded.envelope
    switch (envelope.type) {
      case 'res':
        this.tracker.resolve(envelope.id, envelope.payload)
        break
      case 'err':
        this.handleErr(envelope)
        break
      case 'evt':
        this.handleEvent(envelope)
        break
      case 'req':
        this.handleInboundRequest(envelope)
        break
      default:
        break
    }
  }

  /** 将 Buffer / ArrayBuffer / Blob 等解码为字符串。 */
  private decodeUnknown(raw: unknown): string | null {
    if (raw == null) return null
    if (typeof raw === 'object' && 'toString' in raw) {
      try {
        return String(raw)
      } catch {
        return null
      }
    }
    return null
  }

  private handleErr(envelope: Envelope): void {
    const payload = envelope.payload as unknown as Partial<BandErrorPayload>
    const error: BandErrorPayload = {
      code: typeof payload.code === 'string' ? payload.code : 'E_INTERNAL',
      message: typeof payload.message === 'string' ? payload.message : '未知错误'
    }
    if (typeof payload.missing === 'string') error.missing = payload.missing
    this.lastError = error
    this.tracker.reject(envelope.id, error.code, error.message)
    this.emit('error', error)
  }

  private handleEvent(envelope: Envelope): void {
    const name = envelope.event ?? ''

    if (name === 'sys.hello_ack') {
      this.handleHelloAck(envelope.payload)
      return
    }

    if (name === 'xfer.chunk') {
      this.handleChunk(envelope.payload as unknown as ChunkPayload)
      return
    }

    this.emit('event', name, envelope.payload)
  }

  /** 处理 `sys.hello_ack`（§3.3 版本/能力协商）。 */
  private handleHelloAck(payload: JsonObject): void {
    const peerProto = Array.isArray(payload.proto) ? (payload.proto as unknown[]) : []
    const peerCaps = Array.isArray(payload.caps) ? (payload.caps as unknown[]) : []

    const version = negotiateVersion(PROTOCOL_VERSIONS, peerProto.filter((v): v is number => typeof v === 'number'))
    if (version === null) {
      this.setError({ code: 'E_UNSUPPORTED', message: 'no common protocol' })
      this.setState('error')
      this.emit('event', 'sys.error', { code: 'E_PROTO', message: 'no common protocol' })
      return
    }

    this.proto = version
    this.caps = negotiateCaps(
      CAPABILITIES,
      peerCaps.filter((c): c is string => typeof c === 'string')
    )
    this.setState('ready')
    this.startKeepalive()
    // 握手完成即拉全量快照（§3.3 / 时序图阶段0）
    void this.resync()
    this.emit('event', 'sys.hello_ack', payload)
  }

  /** 处理 `xfer.chunk` 分片（§3.8）。 */
  private handleChunk(payload: ChunkPayload): void {
    const result = feedAssembler(this.assembler, payload)
    if (result.ok) {
      this.emit('xfer', result.kind, result.tid, result.text)
      return
    }
    if (result.code === 'E_CRC' && Array.isArray(result.missing)) {
      // 缺片 → 请求重发（§3.8 xfer.nack）
      this.requestNack(result.tid, result.missing)
    }
  }

  /** 请求补齐缺失分片；`missing` 为空表示整包重传。 */
  private requestNack(tid: string, missing: number[]): void {
    const seqs = missing.length > 0 ? missing : [0]
    for (const seq of seqs) {
      void this.request('xfer.nack', { tid, seq }).catch(() => {
        // 重传请求失败不阻断主流程
      })
    }
  }

  /** 处理入站 `req`：LRU 去重 + 处理器分发（§3.11）。 */
  private handleInboundRequest(envelope: Envelope): void {
    const method = envelope.method ?? ''
    const { duplicate, cached } = this.inboundDeduper.begin(envelope.id)
    if (duplicate && typeof cached === 'string') {
      // 重复请求：直接回放缓存响应，不重复执行（§3.11 幂等）
      this.sendRaw(cached)
      return
    }

    const handler = this.inboundHandlers.get(method)
    let response: Envelope
    if (!handler) {
      // Windows 端不实现手环侧方法：明确回 E_UNSUPPORTED，不重试
      response = buildErr(envelope.id, 'E_UNSUPPORTED', `Windows 端不支持方法 ${method}`)
    } else {
      try {
        const payload = handler(method, envelope.payload)
        response = { v: this.proto, id: envelope.id, type: 'res', payload, ts: Date.now() }
      } catch (error) {
        const bandError = error as BandErrorPayload
        response = buildErr(
          envelope.id,
          bandError.code ?? 'E_INTERNAL',
          bandError.message ?? '处理器异常'
        )
      }
    }
    this.inboundDeduper.remember(envelope.id, encodeEnvelope(response))
    this.sendEnvelope(response)
  }

  private startKeepalive(): void {
    this.clearKeepalive()
    this.pingTimer = setInterval(() => {
      void this.request('sys.ping', {}).catch(() => {})
    }, PING_INTERVAL_MS)
    this.resyncTimer = setInterval(() => {
      void this.resync().catch(() => {})
    }, RESYNC_INTERVAL_MS)
  }

  /** 拉取全量快照并发 `snapshot` 事件。 */
  private async resync(): Promise<void> {
    if (!this.isReady) return
    const payload = await this.request('state.get', {})
    this.emit('snapshot', payload)
  }

  private handleClose(): void {
    this.ws = null
    this.clearKeepalive()
    this.tracker.rejectAll('E_LINK', '链路断开')
    if (this.manualClose) {
      this.setState('disabled')
      return
    }
    this.setState('disconnected')
    this.scheduleReconnect()
  }

  /** 退避重连：1s → 2s → 4s，上限 8s（§3.11）。 */
  private scheduleReconnect(): void {
    if (this.manualClose || !this.options) return
    const ctor = getWebSocketCtor()
    if (!ctor) return

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 8000)
    this.reconnectAttempts += 1
    this.log(`将在 ${delay}ms 后重连（第 ${this.reconnectAttempts} 次）`)

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket(ctor)
    }, delay)
  }

  private clearKeepalive(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer)
      this.resyncTimer = null
    }
  }

  private clearTimers(): void {
    this.clearKeepalive()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setState(next: BandClientState): void {
    this.state = next
    this.emit('status', this.getStatus())
  }

  private setError(error: BandErrorPayload): void {
    this.lastError = error
    this.emit('error', error)
    this.emit('status', this.getStatus())
  }

  private log(message: string): void {
    this.emit('log', message)
  }
}
