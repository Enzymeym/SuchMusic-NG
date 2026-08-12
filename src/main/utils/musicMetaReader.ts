/**
 * 音乐元数据手动解析器（兜底方案）
 *
 * 当 music-metadata 因扩展名路由（如 MPEG 音频被误标为 .flac）或损坏的
 * ID3 头部等原因解析失败时，直接按文件内容嗅探真实格式并提取封面/标签/时长。
 *
 * 覆盖格式：
 * - FLAC：搜索 fLaC 魔数（允许文件头存在 ID3v2 前置数据），解析 STREAMINFO /
 *   VORBIS_COMMENT / PICTURE 元数据块
 * - MP3 / 误标扩展名的 MPEG 音频：解析 ID3v2 标签（APIC 封面 + 文本标签），
 *   并基于 Xing 头或逐帧统计估算时长
 */
import { promises as fs } from 'fs'

// 元数据块几乎总是位于文件头部，只需读取前 16MB 即可覆盖绝大多数情况
const MAX_PROBE_BYTES = 16 * 1024 * 1024

export interface ManualMeta {
  durationMs?: number
  bitrate?: number
  sampleRate?: number
  cover?: { mimeType: string; base64: string }
  title?: string
  artists?: string[]
  album?: string
  year?: number
}

/**
 * 按文件内容手动读取元数据
 * @returns 无法识别的格式返回 null
 */
export async function readMetaManually(filePath: string): Promise<ManualMeta | null> {
  let buf: Buffer
  let fileSize: number
  try {
    const fd = await fs.open(filePath, 'r')
    try {
      const stat = await fd.stat()
      fileSize = stat.size
      const toRead = Math.min(fileSize, MAX_PROBE_BYTES)
      buf = Buffer.alloc(toRead)
      const { bytesRead } = await fd.read(buf, 0, toRead, 0)
      buf = bytesRead < toRead ? buf.subarray(0, bytesRead) : buf
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
      // PICTURE
      const pic = parseFlacPicture(buf, blockStart, blockEnd)
      if (pic && !res.cover) {
        res.cover = { mimeType: pic.mime || 'image/jpeg', base64: pic.data.toString('base64') }
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
): { mime: string; data: Buffer } | null {
  let pos = start
  if (pos + 8 > end) return null
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
  return { mime: mime || 'image/jpeg', data: Buffer.from(buf.subarray(pos, pos + dataLen)) }
}

// ==================== ID3v2 / MPEG ====================

function syncsafeInt(b: Buffer, o: number): number {
  return (
    ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f)
  )
}

function parseId3(buf: Buffer, fileSize: number): ManualMeta | null {
  const res: ManualMeta = {}
  if (buf.length >= 10) {
    const major = buf[3]
    const tagSize = syncsafeInt(buf, 6)
    const bodyStart = 10
    const bodyEnd = Math.min(bodyStart + tagSize, buf.length)
    if (major === 2 || major === 3 || major === 4) {
      parseId3Frames(buf, bodyStart, bodyEnd, major, res)
    }
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
  res: ManualMeta
): void {
  let pos = start
  while (pos + 10 <= end) {
    if (major === 2) {
      const id = buf.toString('latin1', pos, pos + 3)
      if (!/^[A-Z0-9]{3}$/.test(id)) break
      const size = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5]
      handleId3Frame(buf, pos + 6, Math.min(pos + 6 + size, end), id, major, res)
      pos += 6 + size
    } else {
      const id = buf.toString('latin1', pos, pos + 4)
      if (!/^[A-Z0-9]{4}$/.test(id)) break
      let size = major === 4 ? syncsafeInt(buf, pos + 4) : buf.readUInt32BE(pos + 4)
      if (size <= 0 || size > end - pos - 10) {
        // v2.4 帧大小允许非 syncsafe 写入，兼容异常写法
        size = buf.readUInt32BE(pos + 4)
      }
      handleId3Frame(buf, pos + 10, Math.min(pos + 10 + size, end), id, major, res)
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
  res: ManualMeta
): void {
  if (end <= start) return
  if (id.startsWith('APIC') || (major === 2 && id === 'PIC')) {
    if (!res.cover) {
      const pic = parseApic(buf, start, end, major === 2)
      if (pic) res.cover = pic
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
): { mimeType: string; base64: string } | null {
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
    mimeType: mime || 'image/jpeg',
    base64: buf.subarray(pos, end).toString('base64')
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
