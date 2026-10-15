/**
 * SuchMusic 手环通信 · 分片（header → data → end）与 CRC32 纯逻辑（Windows 端）
 *
 * 严格对齐设计文档 §3.8 与 §3.5.2：
 * - 单包上限 CHUNK_MAX_BYTES（900B）；内容字段 `txt`（文本）或 `b64`（二进制）二选一；
 * - 整包 CRC32（IEEE，zlib 同款）；组装缓存上限 ASSEMBLE_MAX_BYTES（8192）；
 * - 校验失败/缺片 → 产出 `xfer.nack` 所需缺失分片序号。
 *
 * 约束：本文件不得引用任何 Electron API，以便在 Node 下直接做单元测试。
 */

import { ASSEMBLE_MAX_BYTES, CHUNK_MAX_BYTES, type JsonObject } from './protocol'

/** 分片载荷类型（§3.8 kind）。 */
export type ChunkKind = 'lyric_window' | 'search_result' | 'cover'

/** 分片阶段。 */
export type ChunkPhase = 'header' | 'data' | 'end'

/** header 帧载荷（§3.8 冻结格式）。 */
export interface ChunkHeaderPayload {
  tid: string
  phase: 'header'
  kind: ChunkKind
  total: number
  bytes: number
  crc32: string
  meta?: JsonObject
}

/** data 帧载荷（§3.8 冻结格式）。`txt` 与 `b64` 二选一。 */
export interface ChunkDataPayload {
  tid: string
  phase: 'data'
  seq: number
  txt?: string
  b64?: string
}

/** end 帧载荷（§3.8 冻结格式）。 */
export interface ChunkEndPayload {
  tid: string
  phase: 'end'
  total: number
  crc32: string
}

/** 任一阶段的分片载荷。 */
export type ChunkPayload = ChunkHeaderPayload | ChunkDataPayload | ChunkEndPayload

/**
 * CRC32 查表（IEEE 802.3 多项式 0xEDB88320，与 zlib / Node 的 zlib.crc32 一致）。
 * 预生成表以避免运行期重复计算。
 */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** 计算字节数组的 CRC32，返回无符号 32 位整数。空数组返回 0。 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 计算字符串（UTF-8）的 CRC32。 */
export function crc32OfText(text: string): number {
  return crc32(utf8Encode(text))
}

/** 将 CRC32 输出为 8 位十六进制小写字符串（§3.8 示例 `1a2b3c4d`）。 */
export function crc32Hex(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).padStart(8, '0')
}

/** 计算字符串（UTF-8）的 CRC32 十六进制字符串。 */
export function crc32HexOfText(text: string): string {
  return crc32Hex(utf8Encode(text))
}

/** UTF-8 编码（不依赖 Electron / 浏览器 API）。 */
export function utf8Encode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'))
}

/** UTF-8 解码。 */
export function utf8Decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
}

/** Base64 编码。 */
export function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/** Base64 解码。 */
export function base64Decode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'))
}

/**
 * 按 UTF-8 字节数切分字符串，保证不切断多字节字符。
 * 单个字符若自身就超过 maxBytes（极端情况），仍单独成片以避免死循环。
 */
export function splitUtf8(text: string, maxBytes: number = CHUNK_MAX_BYTES): string[] {
  if (maxBytes <= 0) throw new Error('maxBytes 必须为正整数')
  const pieces: string[] = []
  let current = ''
  let currentBytes = 0

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (currentBytes + charBytes > maxBytes && current.length > 0) {
      pieces.push(current)
      current = ''
      currentBytes = 0
    }
    current += char
    currentBytes += charBytes
  }
  if (current.length > 0) pieces.push(current)
  if (pieces.length === 0) pieces.push('')
  return pieces
}

/** 分片计划的产物：header + N 个 data + end。 */
export interface ChunkPlan {
  tid: string
  kind: ChunkKind
  header: ChunkHeaderPayload
  data: ChunkDataPayload[]
  end: ChunkEndPayload
}

/**
 * 将实体切分为 header/data/end 三阶段帧（§3.8）。
 *
 * 内容字段二选一（§3.8）：
 * - 文本 / 对象 → `txt` 分片，`bytes`/`crc32` 基于 UTF-8 文本；
 * - `Uint8Array` → `b64` 分片，`bytes`/`crc32` 基于**原始二进制**（cover.get 场景）。
 *
 * @param tid  本次传输 id，形如 `t-0007`
 * @param kind 载荷种类
 * @param entity 对象会被 JSON 序列化；字符串按原样切分；字节数组按 Base64 切分
 * @param meta 可选元信息，写入 header
 * @param maxBytes 单包上限，默认 CHUNK_MAX_BYTES
 */
export function planChunks(
  tid: string,
  kind: ChunkKind,
  entity: JsonObject | string | Uint8Array,
  meta?: JsonObject,
  maxBytes: number = CHUNK_MAX_BYTES
): ChunkPlan {
  if (entity instanceof Uint8Array) {
    const payloadText = base64Encode(entity)
    const pieces = splitUtf8(payloadText, maxBytes)
    const header: ChunkHeaderPayload = {
      tid,
      phase: 'header',
      kind,
      total: pieces.length,
      bytes: entity.byteLength,
      crc32: crc32Hex(entity)
    }
    if (meta) header.meta = meta
    const data: ChunkDataPayload[] = pieces.map((piece, seq) => ({
      tid,
      phase: 'data',
      seq,
      b64: piece
    }))
    return {
      tid,
      kind,
      header,
      data,
      end: { tid, phase: 'end', total: pieces.length, crc32: header.crc32 }
    }
  }

  const text = typeof entity === 'string' ? entity : JSON.stringify(entity)
  const bytes = Buffer.byteLength(text, 'utf8')
  const pieces = splitUtf8(text, maxBytes)
  const header: ChunkHeaderPayload = {
    tid,
    phase: 'header',
    kind,
    total: pieces.length,
    bytes,
    crc32: crc32HexOfText(text)
  }
  if (meta) header.meta = meta

  const data: ChunkDataPayload[] = pieces.map((piece, seq) => ({
    tid,
    phase: 'data',
    seq,
    txt: piece
  }))

  const end: ChunkEndPayload = {
    tid,
    phase: 'end',
    total: pieces.length,
    crc32: header.crc32
  }

  return { tid, kind, header, data, end }
}

/** 组装成功结果。 */
export interface AssembleSuccess {
  ok: true
  kind: ChunkKind
  tid: string
  /** 还原后的 UTF-8 文本（可 JSON.parse 得到实体） */
  text: string
  meta?: JsonObject
}

/** 组装失败结果。 */
export interface AssembleFailure {
  ok: false
  code: string
  message: string
  tid: string
  /** 需要重传的分片序号（`xfer.nack` 用） */
  missing?: number[]
}

export type AssembleResult = AssembleSuccess | AssembleFailure

/**
 * 分片组装器（§3.8「手环组装流程」的对称实现）：
 * header 记录 total/bytes/crc32 → 逐 data 按 seq 落入数组 →
 * end 时校验 `count==total && crc32(buf)==crc32`。
 */
export class ChunkAssembler {
  /** 组装缓存上限，超限即 E_TOOLARGE。 */
  readonly maxBytes: number

  private tid = ''
  private kind: ChunkKind = 'lyric_window'
  private total = 0
  private expectBytes = 0
  private expectCrc = ''
  private meta?: JsonObject
  private received = 0
  private parts: Array<string | undefined> = []
  private started = false
  /** 本次传输是否为二进制（b64 分片）；由首个 data 帧确定。 */
  private binary = false

  constructor(maxBytes: number = ASSEMBLE_MAX_BYTES) {
    this.maxBytes = maxBytes
  }

  /** 是否已收到 header（处于一次传输进行中）。 */
  get isActive(): boolean {
    return this.started
  }

  /** 当前传输 id。 */
  get transferId(): string {
    return this.tid
  }

  /** 已收到的分片数量。 */
  get receivedCount(): number {
    return this.received
  }

  /** 本次传输是否为二进制（b64）。 */
  get isBinary(): boolean {
    return this.binary
  }

  /** 丢弃当前传输状态（用于超时放弃 / E_TOOLARGE 降级）。 */
  reset(): void {
    this.tid = ''
    this.total = 0
    this.expectBytes = 0
    this.expectCrc = ''
    this.meta = undefined
    this.received = 0
    this.parts = []
    this.started = false
    this.binary = false
  }

  /** 处理 header 帧；重复 header 会重置为新的一次传输。 */
  onHeader(payload: ChunkHeaderPayload): AssembleResult {
    if (payload.total < 0 || !Number.isFinite(payload.total)) {
      this.reset()
      return { ok: false, code: 'E_BADREQ', message: 'header.total 非法', tid: payload.tid }
    }
    if (payload.bytes > this.maxBytes) {
      this.reset()
      return {
        ok: false,
        code: 'E_TOOLARGE',
        message: `分片总量 ${payload.bytes}B 超过组装上限 ${this.maxBytes}B`,
        tid: payload.tid
      }
    }

    this.tid = payload.tid
    this.kind = payload.kind
    this.total = payload.total
    this.expectBytes = payload.bytes
    this.expectCrc = payload.crc32
    this.meta = payload.meta
    this.received = 0
    this.parts = new Array<string | undefined>(payload.total)
    this.started = true
    this.binary = false

    return {
      ok: false,
      code: 'E_PENDING',
      message: 'header 已接收，等待 data',
      tid: this.tid
    }
  }

  /** 处理 data 帧；越界或重复序号会被忽略并返回 E_BADREQ。 */
  onData(payload: ChunkDataPayload): AssembleResult {
    if (!this.started) {
      return { ok: false, code: 'E_BADREQ', message: '未收到 header 即收到 data', tid: payload.tid }
    }
    if (payload.tid !== this.tid) {
      return { ok: false, code: 'E_BADREQ', message: 'tid 不匹配', tid: payload.tid }
    }
    const { seq } = payload
    if (!Number.isInteger(seq) || seq < 0 || seq >= this.total) {
      return { ok: false, code: 'E_BADREQ', message: `seq ${seq} 越界`, tid: this.tid }
    }
    if (this.parts[seq] !== undefined) {
      // 幂等：重复分片不重复计数
      return { ok: false, code: 'E_BADREQ', message: `seq ${seq} 重复`, tid: this.tid }
    }

    const isBinary = payload.b64 !== undefined
    if (payload.txt !== undefined && payload.b64 !== undefined) {
      return { ok: false, code: 'E_BADREQ', message: 'data 不能同时含 txt 与 b64', tid: this.tid }
    }
    if (payload.txt === undefined && payload.b64 === undefined) {
      return { ok: false, code: 'E_BADREQ', message: 'data 缺 txt/b64', tid: this.tid }
    }
    // 传输模式由首个 data 帧决定，后续帧必须一致
    if (this.received === 0) {
      this.binary = isBinary
    } else if (this.binary !== isBinary) {
      return { ok: false, code: 'E_BADREQ', message: 'data 传输模式不一致', tid: this.tid }
    }

    // 保存原始分片（b64 不在此处解码：整包拼接后再统一解码，避免跨片 base64 组被截断）
    this.parts[seq] = (isBinary ? payload.b64 : payload.txt) as string
    this.received += 1

    return { ok: false, code: 'E_PENDING', message: `已收 ${this.received}/${this.total}`, tid: this.tid }
  }

  /** 处理 end 帧：校验数量与 CRC32，通过则还原文本，失败给出缺失分片列表。 */
  onEnd(payload: ChunkEndPayload): AssembleResult {
    if (!this.started) {
      return { ok: false, code: 'E_BADREQ', message: '未收到 header 即收到 end', tid: payload.tid }
    }
    if (payload.tid !== this.tid) {
      return { ok: false, code: 'E_CRC', message: 'tid 不匹配', tid: payload.tid }
    }

    // end 与 header 声明的 crc32 必须一致（§3.8：end 重复 total/crc32）
    if (payload.crc32 !== this.expectCrc) {
      return {
        ok: false,
        code: 'E_CRC',
        message: `end.crc32(${payload.crc32}) 与 header.crc32(${this.expectCrc}) 不一致`,
        tid: this.tid,
        missing: []
      }
    }

    const missing = this.collectMissing()
    if (missing.length > 0 || this.received !== this.total) {
      const result: AssembleFailure = {
        ok: false,
        code: 'E_CRC',
        message: `缺片：已收 ${this.received}/${this.total}`,
        tid: this.tid,
        missing
      }
      return result
    }

    const joined = this.parts.join('')
    let text: string
    let actualBytes: number
    let actualCrc: string
    if (this.binary) {
      // 二进制：拼接 b64 后统一解码，CRC/字节数基于原始二进制
      const bytes = base64Decode(joined)
      actualBytes = bytes.byteLength
      actualCrc = crc32Hex(bytes)
      text = utf8Decode(bytes)
    } else {
      actualBytes = Buffer.byteLength(joined, 'utf8')
      actualCrc = crc32HexOfText(joined)
      text = joined
    }

    if (actualCrc !== this.expectCrc || (this.expectBytes > 0 && actualBytes !== this.expectBytes)) {
      const result: AssembleFailure = {
        ok: false,
        code: 'E_CRC',
        message: `CRC 校验失败（expect ${this.expectCrc}, got ${actualCrc}）`,
        tid: this.tid,
        // CRC 无法定位到具体分片，整包重传（missing 为空表示全量重发）
        missing: []
      }
      return result
    }

    const success: AssembleSuccess = {
      ok: true,
      kind: this.kind,
      tid: this.tid,
      text
    }
    if (this.meta) success.meta = this.meta

    this.reset()
    return success
  }

  /** 依据当前已收分片，返回缺失序号列表。 */
  collectMissing(): number[] {
    const missing: number[] = []
    for (let i = 0; i < this.total; i += 1) {
      if (this.parts[i] === undefined) missing.push(i)
    }
    return missing
  }
}

/** 按任意阶段载荷驱动组装器（供 ws-client 直接分发使用）。 */
export function feedAssembler(assembler: ChunkAssembler, payload: ChunkPayload): AssembleResult {
  switch (payload.phase) {
    case 'header':
      return assembler.onHeader(payload)
    case 'data':
      return assembler.onData(payload)
    case 'end':
      return assembler.onEnd(payload)
    default:
      return { ok: false, code: 'E_BADREQ', message: '未知分片阶段', tid: '' }
  }
}
