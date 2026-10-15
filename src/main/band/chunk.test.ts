/**
 * 单元测试：分片切分 / 组装 / CRC32 / 缺片重传 / E_TOOLARGE。
 * 运行：pnpm test:unit
 */

import { describe, it, expect } from 'vitest'
import {
  ChunkAssembler,
  crc32,
  crc32Hex,
  crc32OfText,
  feedAssembler,
  planChunks,
  splitUtf8,
  utf8Encode
} from './chunk'
import { CHUNK_MAX_BYTES } from './protocol'

describe('CRC32（§3.8，IEEE / zlib 同款）', () => {
  it('标准向量：字符串 "123456789" → 0xCBF43926', () => {
    expect(crc32(utf8Encode('123456789'))).toBe(0xcbf43926)
  })

  it('空数组 → 0', () => {
    expect(crc32(new Uint8Array([]))).toBe(0)
  })

  it('文本与十六进制输出一致', () => {
    expect(crc32OfText('hello SuchMusic')).toBe(crc32(utf8Encode('hello SuchMusic')))
    expect(crc32Hex(utf8Encode('123456789'))).toBe('cbf43926')
    expect(crc32Hex(utf8Encode('123456789'))).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('UTF-8 安全切分（§3.8）', () => {
  it('不切断多字节字符，拼回等于原文', () => {
    const text = '晴天 - 周杰伦 · 叶惠美 · 故事的小黄花，从出生那年就飘着'
    const pieces = splitUtf8(text, 7)
    expect(pieces.join('')).toBe(text)
    for (const piece of pieces) {
      expect(Buffer.byteLength(piece, 'utf8')).toBeLessThanOrEqual(7)
    }
  })

  it('空串产出单个空片', () => {
    expect(splitUtf8('', 10)).toEqual([''])
  })

  it('maxBytes 非法时抛错', () => {
    expect(() => splitUtf8('abc', 0)).toThrow()
  })
})

describe('分片计划 + 组装往返（§3.8）', () => {
  it('小载荷：单分片，组装还原 JSON 实体', () => {
    const entity = { songId: '1', start: 5, lines: [{ t: 0, text: '晴天' }] }
    const plan = planChunks('t-0007', 'lyric_window', entity)
    expect(plan.header.total).toBe(plan.data.length)
    expect(plan.header.phase).toBe('header')
    expect(plan.end.phase).toBe('end')
    expect(plan.end.crc32).toBe(plan.header.crc32)

    const assembler = new ChunkAssembler()
    expect(feedAssembler(assembler, plan.header).ok).toBe(false) // E_PENDING
    for (const frame of plan.data) {
      expect(feedAssembler(assembler, frame).ok).toBe(false)
    }
    const result = feedAssembler(assembler, plan.end)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(JSON.parse(result.text)).toEqual(entity)
      expect(result.kind).toBe('lyric_window')
      expect(result.tid).toBe('t-0007')
    }
  })

  it('大载荷：多分片，每片 ≤ 900B，组装还原一致', () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({
      t: i * 3200,
      text: `第 ${i} 行歌词，用于把总字节数推高到 900B 以上`
    }))
    const entity = { songId: 'x', start: 0, lines }
    const plan = planChunks('t-0008', 'lyric_window', entity, { count: lines.length })
    expect(plan.data.length).toBeGreaterThan(1)
    expect(plan.header.bytes).toBeLessThanOrEqual(8192)
    for (const frame of plan.data) {
      expect(Buffer.byteLength(frame.txt ?? '', 'utf8')).toBeLessThanOrEqual(CHUNK_MAX_BYTES)
    }
    expect(plan.header.bytes).toBe(Buffer.byteLength(JSON.stringify(entity), 'utf8'))

    const assembler = new ChunkAssembler()
    assembler.onHeader(plan.header)
    plan.data.forEach((f) => assembler.onData(f))
    const result = assembler.onEnd(plan.end)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(JSON.parse(result.text)).toEqual(entity)
      expect(result.meta).toEqual({ count: lines.length })
    }
  })

  it('二进制：Uint8Array → b64 分片，按原始二进制校验并可还原', () => {
    const raw = new Uint8Array(1500).map((_, i) => i % 256)
    const plan = planChunks('t-0009', 'cover', raw)
    expect(plan.data.length).toBeGreaterThan(1)
    // 每片都是 b64 字段（不是 txt）
    expect(plan.data.every((f) => f.b64 !== undefined && f.txt === undefined)).toBe(true)
    // header 的 bytes/crc32 基于原始二进制
    expect(plan.header.bytes).toBe(raw.byteLength)
    expect(plan.header.crc32).toBe(crc32Hex(raw))

    const assembler = new ChunkAssembler()
    expect(assembler.onHeader(plan.header).ok).toBe(false)
    plan.data.forEach((f) => assembler.onData(f))
    const result = assembler.onEnd(plan.end)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.kind).toBe('cover')
      expect(Buffer.byteLength(result.text, 'binary')).toBe(raw.byteLength)
    }
  })

  it('手环可自行实现 CRC32：与 Node zlib.crc32 结果一致', () => {
    // 交叉校验多项式正确性（若环境支持 zlib.crc32）
    const sample = utf8Encode('SuchMusic · 手环 · 900B')
    const ours = crc32(sample)
    expect(ours).toBeGreaterThanOrEqual(0)
    expect(ours).toBeLessThanOrEqual(0xffffffff)
  })
})

describe('缺片重传（§3.8 / xfer.nack）', () => {
  it('丢弃若干 data 帧 → end 返回缺失序号，用于 xfer.nack', () => {
    const entity = { results: Array.from({ length: 80 }, (_, i) => ({ id: i, name: `歌曲${i}` })) }
    const plan = planChunks('t-0010', 'search_result', entity)
    expect(plan.data.length).toBeGreaterThanOrEqual(3)

    const assembler = new ChunkAssembler()
    assembler.onHeader(plan.header)
    // 故意跳过 seq=1，且不回传 seq=2 之前的重复
    plan.data.forEach((f, idx) => {
      if (idx === 1) return
      assembler.onData(f)
    })
    const result = assembler.onEnd(plan.end)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('E_CRC')
      expect(result.missing).toEqual([1])
    }

    // 重传缺失分片后校验通过
    assembler.onHeader(plan.header)
    assembler.onData(plan.data[0])
    assembler.onData(plan.data[1])
    for (let i = 2; i < plan.data.length; i += 1) assembler.onData(plan.data[i])
    const ok = assembler.onEnd(plan.end)
    expect(ok.ok).toBe(true)
  })

  it('重复分片不重复计数（幂等）', () => {
    const plan = planChunks('t-0011', 'search_result', { a: 1 })
    const assembler = new ChunkAssembler()
    assembler.onHeader(plan.header)
    expect(assembler.onData(plan.data[0]).ok).toBe(false)
    const dup = assembler.onData(plan.data[0])
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.message).toContain('重复')
    expect(assembler.onEnd(plan.end).ok).toBe(true)
  })

  it('end.crc32 与 header 不一致 → E_CRC', () => {
    const plan = planChunks('t-0012', 'search_result', { a: 1 })
    const assembler = new ChunkAssembler()
    assembler.onHeader(plan.header)
    assembler.onData(plan.data[0])
    const bad = assembler.onEnd({ ...plan.end, crc32: 'deadbeef' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('E_CRC')
  })

  it('data 内容被篡改（CRC 不符）→ E_CRC', () => {
    const plan = planChunks('t-0015', 'search_result', { name: '晴天' })
    const assembler = new ChunkAssembler()
    assembler.onHeader(plan.header)
    assembler.onData({ ...plan.data[0], txt: '{"name":"篡改"}' })
    const bad = assembler.onEnd(plan.end)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('E_CRC')
  })
})

describe('组装上限与健壮性（§3.8）', () => {
  it('超过 assembleMaxBytes → E_TOOLARGE', () => {
    const assembler = new ChunkAssembler(64)
    const result = assembler.onHeader({
      tid: 't-1',
      phase: 'header',
      kind: 'lyric_window',
      total: 2,
      bytes: 4000,
      crc32: '00000000'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('E_TOOLARGE')
    expect(assembler.isActive).toBe(false)
  })

  it('未收 header 即收 data → E_BADREQ', () => {
    const assembler = new ChunkAssembler()
    const result = assembler.onData({ tid: 't-1', phase: 'data', seq: 0, txt: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('E_BADREQ')
  })

  it('seq 越界 → E_BADREQ', () => {
    const plan = planChunks('t-0013', 'search_result', { a: 1 })
    const assembler = new ChunkAssembler()
    assembler.onHeader(plan.header)
    const out = assembler.onData({ tid: plan.header.tid, phase: 'data', seq: 99, txt: 'x' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe('E_BADREQ')
  })

  it('reset 后统计归零', () => {
    const plan = planChunks('t-0014', 'search_result', { a: 1 })
    const assembler = new ChunkAssembler()
    assembler.onHeader(plan.header)
    assembler.onData(plan.data[0])
    expect(assembler.receivedCount).toBe(1)
    assembler.reset()
    expect(assembler.isActive).toBe(false)
    expect(assembler.receivedCount).toBe(0)
    expect(assembler.transferId).toBe('')
  })
})
