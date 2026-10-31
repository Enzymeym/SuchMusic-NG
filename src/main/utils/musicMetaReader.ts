/**
 * 音乐元数据手动解析器（兜底方案）
 *
 * 当 native 标签读取器与 music-metadata 都没能拿到封面时，直接按文件内容
 * 嗅探真实格式并提取封面/标签/时长。分头尾两趟：
 *
 * 头部窗口（默认 64KB，按 4 倍扩容至 16MB）：
 * - FLAC：搜索 fLaC 魔数（允许文件头存在 ID3v2 前置数据），解析 STREAMINFO /
 *   VORBIS_COMMENT / PICTURE 元数据块
 * - MP3 / 误标扩展名的 MPEG 音频：解析 ID3v2 标签（APIC 封面 + 文本标签），
 *   并基于 Xing 头或逐帧统计估算时长
 *
 * 尾部窗口（固定 256KB）：
 * - APEv2：`.ape` / `.wv` 的唯一标签容器，封面存在 `Cover Art (Front)` 二进制项里
 * - 尾部 ID3v2：WAV / AIFF 的 "ID3 " chunk 常被写在 RIFF/FORM 声明范围之外
 */
import { promises as fs } from 'fs'
import { sniffImageMime } from './imageSniff'

// 元数据块几乎总是位于文件头部，只需读取前 16MB 即可覆盖绝大多数情况（硬上限）
const MAX_PROBE_BYTES = 16 * 1024 * 1024
// 首段探测窗口：绝大多数文件的标签/封面块都在 64KB 内，只有不足以覆盖完整
// 元数据块时才按 4 倍步进扩容（fillMeta 并发 3，旧实现固定 Buffer.alloc(16MB)
// 会在瞬时占用 48MB 零填充内存）
const HEAD_PROBE_BYTES = 64 * 1024
// 尾部窗口：APEv2 footer 与 WAV/AIFF 的 "ID3 " chunk 都在文件末尾，
// 256KB 足以覆盖绝大多数情况（个别超大标签会在下面按 APEv2 的 tagSize 精确回读）
const TAIL_PROBE_BYTES = 256 * 1024
// APEv2 单个标签块的容忍上限，防御损坏文件把 tagSize 写成天文数字
const APE_MAX_TAG_BYTES = 8 * 1024 * 1024

/** 从文件指定偏移读取 len 字节（不超过文件末尾） */
async function readAt(
  fd: Awaited<ReturnType<typeof fs.open>>,
  start: number,
  len: number
): Promise<Buffer> {
  let buf = Buffer.alloc(len)
  const { bytesRead } = await fd.read(buf, 0, len, start)
  buf = bytesRead < len ? buf.subarray(0, bytesRead) : buf
  return buf
}

/** 从文件头读取 len 字节（不超过文件大小） */
async function readRange(
  fd: Awaited<ReturnType<typeof fs.open>>,
  len: number
): Promise<Buffer> {
  return readAt(fd, 0, len)
}

/** 读取 ID3v2 标签长度（syncsafe 整数）；数据不足或非法返回 null */
function readId3TagSize(buf: Buffer): number | null {
  if (buf.length < 10) return null
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null
  const size = (
    ((buf[6] & 0x7f) << 21) |
    ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) |
    (buf[9] & 0x7f)
  ) >>> 0
  return size > 0 ? size : null
}

/**
 * 计算 FLAC 元数据块区间的结束位置。
 * @returns end：已知元数据块结束偏移；complete：是否已在 buf 内走完全部元数据块
 */
function flacMetadataRange(
  buf: Buffer,
  flacAt: number
): { end: number; complete: boolean } {
  let offset = flacAt + 4
  for (;;) {
    if (offset + 4 > buf.length) return { end: offset, complete: false }
    const header = buf[offset]
    const isLast = (header & 0x80) !== 0
    const length = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]
    offset += 4 + length
    if (isLast) return { end: offset, complete: true }
    if (offset >= buf.length) return { end: offset, complete: false }
  }
}

/** 当前探测窗口是否还不足以覆盖完整元数据块（需要继续扩容） */
function needsMoreBytes(buf: Buffer, fileSize: number): boolean {
  if (buf.length >= fileSize) return false

  const id3Size = readId3TagSize(buf)
  if (id3Size !== null && buf.length < 10 + id3Size) return true

  const flacAt = buf.indexOf('fLaC')
  if (flacAt >= 0 && !flacMetadataRange(buf, flacAt).complete) return true

  // MP3 / MPEG：没有 Xing/Info 头时，时长依赖「整个文件在缓冲区内」逐帧统计。
  // 旧实现总是读到 min(fileSize,16MB)，这里对 ≤16MB 的 MPEG 文件保持同样的完整读取，
  // 避免时长从精确帧数退化为码率估算（VBR 文件会明显不准）。
  const audioStart = id3Size !== null ? 10 + id3Size : 0
  const isMpeg =
    buf.length > audioStart + 4 && buf[audioStart] === 0xff && (buf[audioStart + 1] & 0xe0) === 0xe0
  if (isMpeg && fileSize <= MAX_PROBE_BYTES) {
    const header = parseMpegHeader(buf, audioStart)
    if (header) {
      const xing = findXing(buf, audioStart, header)
      if (!xing || xing.frames <= 0) return true
    }
  }

  return false
}

/**
 * 封面原始字节。MIME 可能缺失或是脏值（APEv2 甚至只存文件名），
 * 一律交给 imageSniff.finalizeCover 在 IPC 出口统一裁决，这里不做猜测。
 */
export interface ManualCover {
  mimeType?: string
  data: Uint8Array
}

export interface ManualMeta {
  durationMs?: number
  bitrate?: number
  sampleRate?: number
  cover?: ManualCover
  title?: string
  artists?: string[]
  album?: string
  year?: number
}

/** 封面择优过程中的内部状态：已选中的是否前封面，用于后续遇到前封面时替换 */
interface CoverPickState {
  isFront: boolean
}

/** 只在 target 缺失时用 src 补齐，绝不覆盖已有值 */
function mergeManualMeta(target: ManualMeta, src: ManualMeta | null | undefined): ManualMeta {
  if (!src) return target
  if (target.cover === undefined) target.cover = src.cover
  if (target.durationMs === undefined) target.durationMs = src.durationMs
  if (target.bitrate === undefined) target.bitrate = src.bitrate
  if (target.sampleRate === undefined) target.sampleRate = src.sampleRate
  if (target.title === undefined) target.title = src.title
  if (target.artists === undefined) target.artists = src.artists
  if (target.album === undefined) target.album = src.album
  if (target.year === undefined) target.year = src.year
  return target
}

/**
 * 按文件内容手动读取元数据
 *
 * 先走头部窗口（FLAC / ID3v2 / 裸 MPEG），头部拿不到封面时再补读尾部窗口
 * （APEv2 / 尾部 ID3 chunk）。两趟互不阻塞。
 *
 * @returns 无法识别的格式返回 null
 */
export async function readMetaManually(filePath: string): Promise<ManualMeta | null> {
  let head: ManualMeta | null = null
  try {
    head = await readHeadMeta(filePath)
  } catch {
    head = null
  }
  // 头部已经拿到封面（绝大多数 MP3/FLAC）就不必再开一次文件读尾部
  if (head?.cover) return head

  let tail: ManualMeta | null = null
  try {
    tail = await readTailMeta(filePath)
  } catch {
    tail = null
  }

  if (!tail) return head
  if (!head) return tail
  return mergeManualMeta(head, tail)
}

/** 头部窗口解析 */
async function readHeadMeta(filePath: string): Promise<ManualMeta | null> {
  let buf: Buffer
  let fileSize: number
  try {
    const fd = await fs.open(filePath, 'r')
    try {
      const stat = await fd.stat()
      fileSize = stat.size
      // 两段式读取：先取 64KB，仅在元数据块超出窗口时按 4 倍扩容，
      // 上限仍是 MAX_PROBE_BYTES（与旧行为一致，只是不再无脑读 16MB）
      let probe = Math.min(fileSize, HEAD_PROBE_BYTES)
      buf = await readRange(fd, probe)
      while (probe < fileSize && probe < MAX_PROBE_BYTES && needsMoreBytes(buf, fileSize)) {
        probe = Math.min(fileSize, MAX_PROBE_BYTES, probe * 4)
        buf = await readRange(fd, probe)
      }
    } finally {
      await fd.close()
    }
  } catch {
    return null
  }

  // FLAC：文件头可能带有 ID3v2 等前置数据，直接搜索 fLaC 魔数
  const flacAt = buf.indexOf('fLaC')
  if (flacAt >= 0) return parseFlac(buf, flacAt)

  // ID3v2 标签（常见于 MP3，或误标为 .flac 的 MPEG 音频）
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return parseId3(buf, fileSize)
  }

  // 裸 MPEG 帧（无标签的 MP3 / 误标扩展名）
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    const audio = estimateMpegDuration(buf, fileSize, 0)
    if (audio) {
      return { durationMs: audio.durationMs, bitrate: audio.bitrate, sampleRate: audio.sampleRate }
    }
  }

  return null
}

// ==================== FLAC ====================

function parseFlac(buf: Buffer, flacAt: number): ManualMeta | null {
  const res: ManualMeta = {}
  let coverIsFront = false
  let pos = flacAt + 4
  let last = false
  while (!last && pos + 4 <= buf.length) {
    const header = buf.readUInt32BE(pos)
    last = header >>> 31 !== 0
    const type = (header >>> 24) & 0x7f
    const length = header & 0xffffff
    const blockStart = pos + 4
    const blockEnd = blockStart + length
    if (blockEnd > buf.length) break
    if (type === 0) {
      // STREAMINFO：采样率(20bit) + 总采样数(36bit)
      const sampleRate =
        buf[blockStart + 10] * 0x1000 + buf[blockStart + 11] * 0x10 + (buf[blockStart + 12] >> 4)
      const totalSamples =
        (buf[blockStart + 13] & 0x0f) * 0x100000000 +
        buf[blockStart + 14] * 0x1000000 +
        buf[blockStart + 15] * 0x10000 +
        buf[blockStart + 16] * 0x100 +
        buf[blockStart + 17]
      res.sampleRate = sampleRate
      if (sampleRate > 0 && totalSamples > 0) {
        res.durationMs = Math.round((totalSamples / sampleRate) * 1000)
      }
    } else if (type === 4) {
      // VORBIS_COMMENT
      parseVorbisComment(buf, blockStart, blockEnd, res)
    } else if (type === 6) {
      // PICTURE：同一文件可能同时带前封面/封底/艺人照，优先取 type=3 的前封面
      const pic = parseFlacPicture(buf, blockStart, blockEnd)
      if (pic) {
        const isFront = pic.type === 3
        if (!res.cover || (isFront && !coverIsFront)) {
          res.cover = { mimeType: pic.mime || undefined, data: pic.data }
          coverIsFront = isFront
        }
      }
    }
    pos = blockEnd
  }
  return hasAny(res) ? res : null
}

function parseVorbisComment(buf: Buffer, start: number, end: number, res: ManualMeta): void {
  let pos = start
  if (pos + 4 > end) return
  const vendorLen = buf.readUInt32LE(pos)
  pos += 4 + vendorLen
  if (pos + 4 > end) return
  const count = buf.readUInt32LE(pos)
  pos += 4
  for (let i = 0; i < count && pos + 4 <= end; i++) {
    const len = buf.readUInt32LE(pos)
    pos += 4
    if (pos + len > end) break
    const kv = buf.toString('utf8', pos, pos + len)
    pos += len
    const eq = kv.indexOf('=')
    if (eq <= 0) continue
    const key = kv.slice(0, eq).trim().toUpperCase()
    const value = kv.slice(eq + 1)
    if (!value) continue
    if (key === 'TITLE' && res.title === undefined) {
      res.title = value
    } else if (key === 'ARTIST' && res.artists === undefined) {
      res.artists = [value]
    } else if (key === 'ALBUM' && res.album === undefined) {
      res.album = value
    } else if (key === 'DATE' && res.year === undefined) {
      const y = parseInt(value, 10)
      if (Number.isFinite(y)) res.year = y
    }
  }
}

function parseFlacPicture(
  buf: Buffer,
  start: number,
  end: number
): { type: number; mime: string; data: Buffer } | null {
  let pos = start
  if (pos + 8 > end) return null
  const pictureType = buf.readUInt32BE(pos)
  pos += 4 // 图片类型
  const mimeLen = buf.readUInt32BE(pos)
  pos += 4
  if (pos + mimeLen > end) return null
  const mime = buf.toString('latin1', pos, pos + mimeLen)
  pos += mimeLen
  if (pos + 4 > end) return null
  const descLen = buf.readUInt32BE(pos)
  pos += 4 + descLen
  // 宽(4) + 高(4) + 位深(4) + 索引色数(4) + 数据长度(4)
  if (pos + 20 > end) return null
  pos += 16
  const dataLen = buf.readUInt32BE(pos)
  pos += 4
  if (pos + dataLen > end || dataLen <= 0) return null
  return { type: pictureType, mime, data: Buffer.from(buf.subarray(pos, pos + dataLen)) }
}

// ==================== ID3v2 / MPEG ====================

function syncsafeInt(b: Buffer, o: number): number {
  return (
    ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f)
  )
}

function parseId3(buf: Buffer, fileSize: number): ManualMeta | null {
  return parseId3At(buf, 0, fileSize, true)
}

/**
 * 从 buf 的任意偏移解析一个独立的 ID3v2 标签块。
 *
 * @param withDuration 是否顺带按 MPEG 帧估算时长。只有「标签在文件头」时才有意义；
 *   尾部 ID3 的宿主可能是 WAV/AIFF，在那种文件里按 MPEG 帧扫描纯属误判。
 */
function parseId3At(
  buf: Buffer,
  offset: number,
  fileSize: number,
  withDuration: boolean
): ManualMeta | null {
  if (buf.length < offset + 10) return null
  const res: ManualMeta = {}
  const major = buf[offset + 3]
  const tagSize = syncsafeInt(buf, offset + 6)
  const bodyStart = offset + 10
  const bodyEnd = Math.min(bodyStart + tagSize, buf.length)
  if (major === 2 || major === 3 || major === 4) {
    parseId3Frames(buf, bodyStart, bodyEnd, major, res, { isFront: false })
  }
  if (withDuration) {
    // 标签结束后扫描 MPEG 帧估算时长
    const audio = estimateMpegDuration(buf, fileSize, bodyEnd)
    if (audio) {
      res.durationMs = audio.durationMs
      res.bitrate = audio.bitrate
      res.sampleRate = audio.sampleRate
    }
  }
  return hasAny(res) ? res : null
}

function parseId3Frames(
  buf: Buffer,
  start: number,
  end: number,
  major: number,
  res: ManualMeta,
  state: CoverPickState
): void {
  let pos = start
  while (pos + 10 <= end) {
    if (major === 2) {
      const id = buf.toString('latin1', pos, pos + 3)
      if (!/^[A-Z0-9]{3}$/.test(id)) break
      const size = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5]
      handleId3Frame(buf, pos + 6, Math.min(pos + 6 + size, end), id, major, res, state)
      pos += 6 + size
    } else {
      const id = buf.toString('latin1', pos, pos + 4)
      if (!/^[A-Z0-9]{4}$/.test(id)) break
      let size = major === 4 ? syncsafeInt(buf, pos + 4) : buf.readUInt32BE(pos + 4)
      if (size <= 0 || size > end - pos - 10) {
        // v2.4 帧大小允许非 syncsafe 写入，兼容异常写法
        size = buf.readUInt32BE(pos + 4)
      }
      handleId3Frame(buf, pos + 10, Math.min(pos + 10 + size, end), id, major, res, state)
      pos += 10 + size
    }
    if (pos > end) break
  }
}

function handleId3Frame(
  buf: Buffer,
  start: number,
  end: number,
  id: string,
  major: number,
  res: ManualMeta,
  state: CoverPickState
): void {
  if (end <= start) return
  if (id.startsWith('APIC') || (major === 2 && id === 'PIC')) {
    const pic = parseApic(buf, start, end, major === 2)
    if (pic) {
      // 同一文件可能有多张图（前封面/封底/艺人照），type=3 的前封面优先
      const isFront = pic.type === 3
      if (!res.cover || (isFront && !state.isFront)) {
        res.cover = { mimeType: pic.mimeType, data: pic.data }
        state.isFront = isFront
      }
    }
    return
  }
  if (!id.startsWith('T') || id === 'TXXX') return
  const text = decodeId3TextFrame(buf, start, end)
  if (!text) return
  if ((id === 'TIT2' || id === 'TT2') && res.title === undefined) {
    res.title = text
  } else if ((id === 'TPE1' || id === 'TP1') && res.artists === undefined) {
    res.artists = [text]
  } else if ((id === 'TALB' || id === 'TAL') && res.album === undefined) {
    res.album = text
  } else if ((id === 'TYER' || id === 'TYE' || id === 'TDRC') && res.year === undefined) {
    const y = parseInt(text, 10)
    if (Number.isFinite(y)) res.year = y
  }
}

function decodeId3TextFrame(buf: Buffer, start: number, end: number): string | undefined {
  if (end - start < 2) return undefined
  const enc = buf[start]
  const body = buf.subarray(start + 1, end)
  // 去除文本中的 \0 终止符（no-control-regex 规则下避免使用控制字符正则）
  const stripNulls = (s: string): string => s.split('\u0000').join('').trim()
  try {
    if (enc === 0) {
      return stripNulls(body.toString('latin1')) || undefined
    }
    if (enc === 3) {
      return stripNulls(body.toString('utf8')) || undefined
    }
    if (enc === 1) {
      // UTF-16（可能带 BOM）
      if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
        const even = body.length - (body.length % 2)
        return stripNulls(body.subarray(2, even).toString('utf16le')) || undefined
      }
      if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
        const even = body.length - (body.length % 2)
        const tmp = Buffer.from(body.subarray(2, even))
        tmp.swap16()
        return stripNulls(tmp.toString('utf16le')) || undefined
      }
      const even = body.length - (body.length % 2)
      return stripNulls(body.subarray(0, even).toString('utf16le')) || undefined
    }
    if (enc === 2) {
      const even = body.length - (body.length % 2)
      const tmp = Buffer.from(body.subarray(0, even))
      tmp.swap16()
      return stripNulls(tmp.toString('utf16le')) || undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

function parseApic(
  buf: Buffer,
  start: number,
  end: number,
  isV22: boolean
): { type: number; mimeType?: string; data: Buffer } | null {
  if (end - start < 4) return null
  const enc = buf[start]
  let pos = start + 1
  const mimeEnd = buf.indexOf(0, pos)
  if (mimeEnd === -1 || mimeEnd >= end) return null
  const mime = buf.toString('latin1', pos, mimeEnd)
  pos = mimeEnd + 1
  if (isV22) {
    // v2.2 PIC：编码(1) + 图片格式(3) + 类型(1) + 描述 + 数据
    pos += 3
  }
  if (pos >= end) return null
  const pictureType = buf[pos]
  pos += 1 // 图片类型
  if (pos >= end) return null
  if (enc === 0 || enc === 3) {
    const descEnd = buf.indexOf(0, pos)
    if (descEnd === -1 || descEnd >= end) return null
    pos = descEnd + 1
  } else {
    // UTF-16 描述以两个 0x00 结尾
    let dEnd = -1
    for (let i = pos; i + 1 < end; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0) {
        dEnd = i
        break
      }
    }
    if (dEnd === -1) return null
    pos = dEnd + 2
  }
  if (pos >= end) return null
  return {
    type: pictureType,
    mimeType: mime || undefined,
    data: Buffer.from(buf.subarray(pos, end))
  }
}

// ==================== 尾部标签（APEv2 / 尾部 ID3） ====================

const APE_SIGNATURE = Buffer.from('APETAGEX', 'latin1')
const ID3_SIGNATURE = Buffer.from('ID3', 'latin1')
/** footer 的 flags bit29：为 1 表示这块是 header 而不是 footer */
const APE_FLAG_IS_HEADER = 0x20000000

/** 在缓冲区里从尾部往前找 APEv2 footer，返回其偏移；找不到返回 -1 */
function findApeFooter(buf: Buffer): number {
  let at = buf.lastIndexOf(APE_SIGNATURE)
  while (at >= 0) {
    if (at + 32 <= buf.length) {
      const flags = buf.readUInt32LE(at + 20)
      if ((flags & APE_FLAG_IS_HEADER) === 0) return at
    }
    if (at === 0) break
    at = buf.lastIndexOf(APE_SIGNATURE, at - 1)
  }
  return -1
}

/** APEv2 的封面项值是「文件名 \0 图片数据」，但部分写入器省略了文件名 */
function extractApePicture(value: Buffer): ManualCover | null {
  if (value.length === 0) return null
  if (sniffImageMime(value)) return { data: value }
  const nul = value.indexOf(0)
  if (nul >= 0 && nul + 1 < value.length) {
    const after = value.subarray(nul + 1)
    if (sniffImageMime(after)) return { data: after }
  }
  return null
}

/**
 * 解析一个完整的 APEv2 标签块（items 与 footer 都必须落在 buf 内）。
 *
 * 项布局：valueSize(u32LE) + itemFlags(u32LE) + key(\0 结尾) + value。
 * footer 32 字节：'APETAGEX' + version + tagSize + itemCount + flags + 8 字节保留，
 * 其中 tagSize 覆盖 items 与 footer，但不含可选的 header。
 *
 * 抽成纯函数是为了能单测（见 src/main/utils/__tests__/apeCover.test.ts）。
 */
export function parseApeTag(buf: Buffer): ManualMeta | null {
  const footerAt = findApeFooter(buf)
  if (footerAt < 0) return null

  const tagSize = buf.readUInt32LE(footerAt + 12)
  const itemCount = buf.readUInt32LE(footerAt + 16)
  const itemsStart = footerAt + 32 - tagSize
  if (tagSize < 32 || itemsStart < 0 || itemCount > 4096) return null

  const res: ManualMeta = {}
  let coverIsFront = false
  let pos = itemsStart

  for (let i = 0; i < itemCount; i++) {
    if (pos + 8 > footerAt) break
    const valueSize = buf.readUInt32LE(pos)
    const keyStart = pos + 8
    const keyEnd = buf.indexOf(0, keyStart)
    if (keyEnd < 0 || keyEnd >= footerAt) break
    const key = buf.toString('latin1', keyStart, keyEnd)
    const valueStart = keyEnd + 1
    // 越界说明文件被截断或 tagSize 不可信，停止解析
    if (valueSize > footerAt - valueStart) break
    const value = buf.subarray(valueStart, valueStart + valueSize)
    pos = valueStart + valueSize

    const upper = key.toUpperCase()
    if (upper.startsWith('COVER ART')) {
      const isFront = upper.includes('FRONT')
      if (!res.cover || (isFront && !coverIsFront)) {
        const pic = extractApePicture(value)
        if (pic) {
          res.cover = pic
          coverIsFront = isFront
        }
      }
      continue
    }

    const text = value.toString('utf8')
    if (!text) continue
    if (upper === 'TITLE' && res.title === undefined) {
      res.title = text
    } else if (upper === 'ARTIST' && res.artists === undefined) {
      res.artists = [text]
    } else if (upper === 'ALBUM' && res.album === undefined) {
      res.album = text
    } else if ((upper === 'YEAR' || upper === 'DATE') && res.year === undefined) {
      const y = parseInt(text, 10)
      if (Number.isFinite(y)) res.year = y
    }
  }

  return hasAny(res) ? res : null
}

/** 在尾部窗口里从后往前找形如 "ID3" + 版本(2/3/4) + 0x00 的独立标签块 */
function findTailId3(buf: Buffer): number {
  let at = buf.lastIndexOf(ID3_SIGNATURE)
  while (at >= 0) {
    if (at + 10 <= buf.length) {
      const major = buf[at + 3]
      const revision = buf[at + 4]
      if ((major === 2 || major === 3 || major === 4) && revision === 0) return at
    }
    if (at === 0) break
    at = buf.lastIndexOf(ID3_SIGNATURE, at - 1)
  }
  return -1
}

/**
 * 尾部窗口解析。
 *
 * 覆盖两类「只有从文件尾才看得见」的标签：
 * - APEv2：`.ape` / `.wv` 的唯一标签容器，封面存在 `Cover Art (Front)` 二进制项里
 * - 尾部 ID3v2：WAV / AIFF 的 "ID3 " chunk 常被写在 RIFF/FORM 声明范围之外
 */
async function readTailMeta(filePath: string): Promise<ManualMeta | null> {
  const fd = await fs.open(filePath, 'r')
  try {
    const { size: fileSize } = await fd.stat()
    if (fileSize < 128) return null

    const len = Math.min(fileSize, TAIL_PROBE_BYTES)
    const start = fileSize - len
    const view = await readAt(fd, start, len)
    const res: ManualMeta = {}

    const footerAt = findApeFooter(view)
    if (footerAt >= 0) {
      const tagSize = view.readUInt32LE(footerAt + 12)
      if (tagSize >= 32 && tagSize <= APE_MAX_TAG_BYTES) {
        const itemsStartInFile = start + footerAt + 32 - tagSize
        if (itemsStartInFile >= 0) {
          // 整块已在窗口内就直接切片，否则按 tagSize 精确回读（超大封面标签）
          const tagBuf =
            itemsStartInFile >= start
              ? view.subarray(footerAt + 32 - tagSize)
              : await readAt(fd, itemsStartInFile, tagSize)
          const ape = parseApeTag(tagBuf)
          if (ape) mergeManualMeta(res, ape)
        }
      }
    }

    if (res.cover) return res

    // 尾部 ID3：不做 MPEG 时长估算，宿主可能是 WAV/AIFF
    const id3At = findTailId3(view)
    if (id3At >= 0) {
      const id3 = parseId3At(view, id3At, fileSize, false)
      if (id3) mergeManualMeta(res, id3)
    }

    return hasAny(res) ? res : null
  } finally {
    await fd.close()
  }
}

// ==================== MPEG 帧 / 时长估算 ====================

interface MpegHeader {
  bitrate: number // kbps
  sampleRate: number
  samplesPerFrame: number
  frameSize: number // 字节
  channelMode: number
  hasCrc: boolean
  version: number
}

// bitrate 表：[版本]-[层]，1=MPEG1, 2=MPEG2, 25=MPEG2.5；层 1/2/3
const MPEG_BITRATES: Record<string, number[]> = {
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '25-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '25-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '25-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
}

const MPEG_SAMPLE_RATES: Record<string, number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '25': [11025, 12000, 8000]
}

function parseMpegHeader(buf: Buffer, pos: number): MpegHeader | null {
  if (pos + 4 > buf.length) return null
  const b1 = buf[pos + 1]
  const b2 = buf[pos + 2]
  const b3 = buf[pos + 3]
  const versionBits = (b1 >> 3) & 0x03
  if (versionBits === 1) return null // 保留
  const versionKey = versionBits === 0 ? '25' : versionBits === 2 ? '2' : '1'
  const layerBits = (b1 >> 1) & 0x03
  if (layerBits === 0) return null // 保留
  const layerKey = String(4 - layerBits)
  const bitrateIdx = (b2 >> 4) & 0x0f
  const sampleIdx = (b2 >> 2) & 0x03
  const padding = (b2 >> 1) & 0x01
  const brTable = MPEG_BITRATES[`${versionKey}-${layerKey}`]
  const srTable = MPEG_SAMPLE_RATES[versionKey]
  if (!brTable || !srTable) return null
  const bitrate = brTable[bitrateIdx]
  const sampleRate = srTable[sampleIdx]
  if (!bitrate || !sampleRate) return null
  const version = versionKey === '25' ? 2.5 : parseInt(versionKey, 10)
  const layer = parseInt(layerKey, 10)
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version >= 2 ? 576 : 1152
  let frameSize: number
  if (layer === 1) {
    frameSize = Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4
  } else {
    const coeff = version >= 2 ? 72 : 144
    frameSize = Math.floor((coeff * bitrate * 1000) / sampleRate) + padding
  }
  if (frameSize <= 0) return null
  return {
    bitrate,
    sampleRate,
    samplesPerFrame,
    frameSize,
    channelMode: (b3 >> 6) & 0x03,
    hasCrc: (b1 & 0x01) === 0,
    version
  }
}

function findXing(buf: Buffer, frameStart: number, header: MpegHeader): { frames: number } | null {
  const sideInfo =
    header.channelMode === 3 ? (header.version >= 2 ? 9 : 17) : header.version >= 2 ? 17 : 32
  const offset = 4 + (header.hasCrc ? 2 : 0)
  const windowStart = frameStart + offset
  const windowEnd = Math.min(windowStart + sideInfo + 8, buf.length)
  if (windowStart >= windowEnd) return null
  for (let i = windowStart; i + 4 <= windowEnd; i++) {
    const s = buf.toString('latin1', i, i + 4)
    if (s === 'Xing' || s === 'Info') {
      if (i + 12 > buf.length) return null
      const flags = buf.readUInt32BE(i + 4)
      if (flags & 0x01) {
        const frames = buf.readUInt32BE(i + 8)
        if (frames > 0) return { frames }
      }
      return null
    }
  }
  return null
}

function estimateMpegDuration(
  buf: Buffer,
  fileSize: number,
  start: number
): { durationMs: number; bitrate: number; sampleRate: number } | null {
  // 定位第一个有效 MPEG 帧头
  let pos = start
  let header: MpegHeader | null = null
  while (pos + 4 <= buf.length) {
    if (buf[pos] === 0xff && (buf[pos + 1] & 0xe0) === 0xe0) {
      const h = parseMpegHeader(buf, pos)
      if (h) {
        header = h
        break
      }
    }
    pos++
  }
  if (!header) return null

  // Xing / Info 头可提供精确帧数（VBR 文件也适用）
  const xing = findXing(buf, pos, header)
  if (xing && xing.frames > 0) {
    return {
      durationMs: Math.round(((xing.frames * header.samplesPerFrame) / header.sampleRate) * 1000),
      bitrate: header.bitrate,
      sampleRate: header.sampleRate
    }
  }

  // 整个文件都在缓冲区中时逐帧统计（CBR/VBR 均较准确）
  if (fileSize <= buf.length) {
    let frameCount = 0
    let p = pos
    const maxFrames = 200000
    while (p + 4 <= fileSize && frameCount < maxFrames) {
      const h = parseMpegHeader(buf, p)
      if (!h || h.frameSize <= 0) break
      p += h.frameSize
      frameCount++
    }
    if (frameCount > 0) {
      return {
        durationMs: Math.round(((frameCount * header.samplesPerFrame) / header.sampleRate) * 1000),
        bitrate: header.bitrate,
        sampleRate: header.sampleRate
      }
    }
  }

  // 无法精确统计时按码率估算（文件过大、未读取完整时）
  const audioBytes = fileSize - start
  if (header.bitrate > 0 && audioBytes > 0) {
    return {
      durationMs: Math.round((audioBytes * 8) / header.bitrate),
      bitrate: header.bitrate,
      sampleRate: header.sampleRate
    }
  }
  return null
}

function hasAny(m: ManualMeta): boolean {
  return (
    m.durationMs !== undefined ||
    m.bitrate !== undefined ||
    m.sampleRate !== undefined ||
    m.cover !== undefined ||
    m.title !== undefined ||
    m.artists !== undefined ||
    m.album !== undefined ||
    m.year !== undefined
  )
}
