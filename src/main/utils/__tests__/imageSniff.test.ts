import { describe, expect, it } from 'vitest'
import {
  finalizeCover,
  isUsableCoverData,
  resolveCoverMime,
  sniffImageMime
} from '../imageSniff'

/** 造一个「长度够、魔数对」的假图片；嗅探只看前 16 字节，后面随意填充 */
function fake(bytes: number[], padTo = 64): Buffer {
  const buf = Buffer.alloc(padTo)
  Buffer.from(bytes).copy(buf)
  return buf
}

const JPEG = fake([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const PNG = fake([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const GIF = fake([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
const BMP = fake([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00])
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(52)
])
const AVIF = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x1c]),
  Buffer.from('ftyp', 'latin1'),
  Buffer.from('avif', 'latin1'),
  Buffer.alloc(52)
])

describe('sniffImageMime', () => {
  it('识别常见封面格式的魔数', () => {
    expect(sniffImageMime(JPEG)).toBe('image/jpeg')
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(GIF)).toBe('image/gif')
    expect(sniffImageMime(BMP)).toBe('image/bmp')
    expect(sniffImageMime(WEBP)).toBe('image/webp')
    expect(sniffImageMime(AVIF)).toBe('image/avif')
  })

  it('无法识别时返回 null，且不会越界', () => {
    expect(sniffImageMime(Buffer.from('这不是图片，只是一段文本'))).toBeNull()
    expect(sniffImageMime(Buffer.alloc(3))).toBeNull()
    expect(sniffImageMime(undefined)).toBeNull()
    expect(sniffImageMime(null)).toBeNull()
  })

  it('RIFF 但容器是 WAVE 时不认成 WebP', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'latin1'),
      Buffer.alloc(52)
    ])
    expect(sniffImageMime(wav)).toBeNull()
  })
})

describe('resolveCoverMime', () => {
  it('魔数优先于声明值（覆盖 APEv2 只存文件名、MP4 covr 无 MIME 的情况）', () => {
    expect(resolveCoverMime('', JPEG)).toBe('image/jpeg')
    expect(resolveCoverMime(undefined, PNG)).toBe('image/png')
    expect(resolveCoverMime('image/jpg', PNG)).toBe('image/png')
    expect(resolveCoverMime('application/octet-stream', WEBP)).toBe('image/webp')
  })

  it('魔数不可用时才信任声明值，且只认允许集内的值', () => {
    const junk = Buffer.from('x'.repeat(64))
    expect(resolveCoverMime('image/jpg', junk)).toBe('image/jpeg')
    expect(resolveCoverMime('image/png; charset=binary', junk)).toBe('image/png')
    // 目标格式 Chromium 渲染不了，收进来只会把「空白」换个方式暴露
    expect(resolveCoverMime('image/tiff', junk)).toBeNull()
    expect(resolveCoverMime('text/plain', junk)).toBeNull()
    expect(resolveCoverMime('', junk)).toBeNull()
  })
})

describe('isUsableCoverData', () => {
  it('畸形小图（只有帧头）不算可用封面', () => {
    expect(isUsableCoverData(Buffer.alloc(12))).toBe(false)
    expect(isUsableCoverData(Buffer.alloc(0))).toBe(false)
    expect(isUsableCoverData(undefined)).toBe(false)
    // 够长但根本不是图片
    expect(isUsableCoverData(Buffer.from('x'.repeat(4096)))).toBe(false)
  })

  it('魔数正确的图片才算可用', () => {
    expect(isUsableCoverData(JPEG)).toBe(true)
    expect(isUsableCoverData(PNG)).toBe(true)
  })
})

describe('finalizeCover', () => {
  it('过滤 0 字节与畸形小图（只有帧头的空 APIC）', () => {
    expect(finalizeCover('image/jpeg', Buffer.alloc(0))).toBeNull()
    expect(finalizeCover('image/jpeg', Buffer.alloc(10))).toBeNull()
    expect(finalizeCover('image/jpeg', undefined)).toBeNull()
  })

  it('通过校验时产出可解码的 base64 与正确 MIME', () => {
    const data = Buffer.concat([JPEG, Buffer.alloc(300)])
    const out = finalizeCover('', data)
    expect(out).not.toBeNull()
    expect(out!.mimeType).toBe('image/jpeg')
    expect(out!.bytes).toBe(data.length)
    expect(Buffer.from(out!.base64, 'base64').equals(data)).toBe(true)
  })

  it('超过上限时丢弃', () => {
    expect(finalizeCover('image/png', Buffer.concat([PNG, Buffer.alloc(2048)]), { maxBytes: 1024 })).toBeNull()
  })
})
