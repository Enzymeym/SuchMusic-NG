/**
 * 单元测试：信封编解码、版本/能力协商、模式映射、限流与错误策略。
 * 运行：pnpm test:unit
 */

import { describe, it, expect } from 'vitest'
import {
  PROTOCOL_VERSION,
  CAPABILITIES,
  IdGenerator,
  buildErr,
  buildEvt,
  buildReq,
  buildRes,
  createId,
  decodeEnvelope,
  encodeEnvelope,
  errorCodeMeaning,
  formatSeq,
  generateBootId,
  isKnownEvent,
  isKnownMethod,
  isMethodIdempotent,
  isProtocolPlayMode,
  methodCap,
  missingCapabilities,
  negotiateCaps,
  negotiateVersion,
  normalizeSongDto,
  protocolPlayModeToWindows,
  retryBackoffMs,
  shouldEmitProgress,
  shouldRetry,
  windowsPlayModeToProtocol
} from './protocol'
import type { Envelope } from './protocol'

describe('信封编解码与校验（§3.4）', () => {
  it('req 往返：encode → decode 字段完全一致', () => {
    const env = buildReq('w-0b12-0001', 'playback.next', {})
    const decoded = decodeEnvelope(encodeEnvelope(env))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect(decoded.envelope).toEqual(env)
      expect(decoded.envelope.v).toBe(PROTOCOL_VERSION)
      expect(decoded.envelope.type).toBe('req')
      expect(decoded.envelope.method).toBe('playback.next')
      expect(decoded.envelope.payload).toEqual({})
    }
  })

  it('res 往返：复用请求 id，payload 保留', () => {
    const env = buildRes('w-0b12-0001', { ok: true })
    const decoded = decodeEnvelope(encodeEnvelope(env))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect(decoded.envelope.id).toBe('w-0b12-0001')
      expect(decoded.envelope.type).toBe('res')
    }
  })

  it('err 往返：携带 code/message/missing', () => {
    const env = buildErr('b-7fa1-0007', 'E_UNSUPPORTED', 'no common protocol', 'volume')
    const decoded = decodeEnvelope(encodeEnvelope(env))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect(decoded.envelope.payload).toEqual({
        code: 'E_UNSUPPORTED',
        message: 'no common protocol',
        missing: 'volume'
      })
    }
  })

  it('evt 往返：携带 event，pduload 为对象', () => {
    const env = buildEvt('p-3c0e-0012', 'player.song', {
      song: { id: '1', name: '晴天', artist: '周杰伦' }
    })
    const decoded = decodeEnvelope(encodeEnvelope(env))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect(decoded.envelope.type).toBe('evt')
      expect(decoded.envelope.event).toBe('player.song')
    }
  })

  it('非法 JSON → E_BADREQ', () => {
    const decoded = decodeEnvelope('{ not json ')
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error.code).toBe('E_BADREQ')
  })

  it('req 缺 method → E_BADREQ', () => {
    const decoded = decodeEnvelope(JSON.stringify({ v: 1, id: 'w-0b12-0001', type: 'req', payload: {} }))
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error.code).toBe('E_BADREQ')
  })

  it('evt 缺 event → E_BADREQ', () => {
    const decoded = decodeEnvelope(JSON.stringify({ v: 1, id: 'p-3c0e-0001', type: 'evt', payload: {} }))
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.error.code).toBe('E_BADREQ')
  })

  it('payload 非对象 → E_BADREQ', () => {
    const decoded = decodeEnvelope(
      JSON.stringify({ v: 1, id: 'w-0b12-0001', type: 'res', payload: [1, 2, 3] })
    )
    expect(decoded.ok).toBe(false)
  })

  it('type 非法 → E_BADREQ', () => {
    const decoded = decodeEnvelope(JSON.stringify({ v: 1, id: 'w-0b12-0001', type: 'x', payload: {} }))
    expect(decoded.ok).toBe(false)
  })

  it('res/err 缺 id → E_BADREQ；evt 允许缺 id', () => {
    expect(decodeEnvelope(JSON.stringify({ v: 1, type: 'res', payload: {} })).ok).toBe(false)
    const evt = decodeEnvelope(JSON.stringify({ v: 1, type: 'evt', event: 'band.toast', payload: {} }))
    expect(evt.ok).toBe(true)
  })

  it('payload 缺省时补为 {}', () => {
    const decoded = decodeEnvelope(JSON.stringify({ v: 1, id: 'w-0b12-0001', type: 'res' }))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.envelope.payload).toEqual({})
  })
})

describe('id 生成（§3.4）', () => {
  it('格式为 {origin}-{bootId}-{seq}，seq 四位十六进制', () => {
    expect(createId('w', '0b12', 1)).toBe('w-0b12-0001')
    expect(createId('b', '7fa1', 7)).toBe('b-7fa1-0007')
    expect(createId('p', '3c0e', 256)).toBe('p-3c0e-0100')
    expect(formatSeq(0)).toBe('0000')
  })

  it('IdGenerator 递增且前缀正确', () => {
    const gen = new IdGenerator('w', '0b12')
    expect(gen.next()).toBe('w-0b12-0001')
    expect(gen.next()).toBe('w-0b12-0002')
    expect(gen.current).toBe(2)
    expect(gen.boot).toBe('0b12')
  })

  it('generateBootId 恒为 4 位十六进制', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateBootId()).toMatch(/^[0-9a-f]{4}$/)
    }
    expect(generateBootId(() => 0)).toBe('0000')
  })
})

describe('版本协商（§3.3）', () => {
  it('取交集最大值', () => {
    expect(negotiateVersion([1], [1])).toBe(1)
    expect(negotiateVersion([1, 2], [1, 2, 3])).toBe(2)
  })

  it('交集为空返回 null', () => {
    expect(negotiateVersion([2], [1])).toBeNull()
    expect(negotiateVersion([], [])).toBeNull()
  })
})

describe('能力协商（§3.3）', () => {
  it('生效能力为交集', () => {
    const caps = negotiateCaps(['playback', 'search', 'volume'], ['playback', 'search', 'lyric'])
    expect(caps).toEqual(['playback', 'search'])
  })

  it('未知令牌被过滤', () => {
    expect(negotiateCaps(['playback', 'nope'] as string[], ['playback', 'nope'])).toEqual(['playback'])
  })

  it('方法能力查询与缺失检测', () => {
    expect(methodCap('playback.setMode')).toBe('playmode')
    expect(methodCap('sys.hello')).toBeNull()
    expect(missingCapabilities('playback.setVolume', ['playback'])).toBe('volume')
    expect(missingCapabilities('playback.play', ['playback'])).toBeNull()
    expect(missingCapabilities('sys.hello', [])).toBeNull()
  })

  it('能力令牌与清单一致（8 个冻结值）', () => {
    expect(CAPABILITIES).toEqual([
      'playback',
      'queue',
      'search',
      'lyric',
      'playmode',
      'volume',
      'cover',
      'transfer'
    ])
  })
})

describe('方法与事件清单一致性（§3.5 / §3.6）', () => {
  it('已知方法/事件判定', () => {
    expect(isKnownMethod('playback.next')).toBe(true)
    expect(isKnownMethod('playback.nope')).toBe(false)
    expect(isKnownEvent('lyric.line')).toBe(true)
    expect(isKnownEvent('lyric.nope')).toBe(false)
  })

  it('幂等性：next 幂等、toggle 非幂等、未知方法非幂等', () => {
    expect(isMethodIdempotent('playback.next')).toBe(true)
    expect(isMethodIdempotent('playback.toggle')).toBe(false)
    expect(isMethodIdempotent('playback.unknown')).toBe(false)
  })
})

describe('PlayMode 映射（§3.5 / §4.4 D1）', () => {
  it('协议 → Windows', () => {
    expect(protocolPlayModeToWindows('loop')).toBe('list')
    expect(protocolPlayModeToWindows('single')).toBe('loop')
    expect(protocolPlayModeToWindows('shuffle')).toBe('shuffle')
  })

  it('Windows → 协议', () => {
    expect(windowsPlayModeToProtocol('list')).toBe('loop')
    expect(windowsPlayModeToProtocol('loop')).toBe('single')
    expect(windowsPlayModeToProtocol('shuffle')).toBe('shuffle')
    expect(windowsPlayModeToProtocol('whatever')).toBe('loop')
  })

  it('往返一致（对合法集合）', () => {
    expect(protocolPlayModeToWindows(windowsPlayModeToProtocol('list'))).toBe('list')
    expect(protocolPlayModeToWindows(windowsPlayModeToProtocol('loop'))).toBe('loop')
    expect(protocolPlayModeToWindows(windowsPlayModeToProtocol('shuffle'))).toBe('shuffle')
  })

  it('isProtocolPlayMode 判定', () => {
    expect(isProtocolPlayMode('single')).toBe(true)
    expect(isProtocolPlayMode('list')).toBe(false)
  })
})

describe('限流 / 重试策略（§3.11）', () => {
  it('进度节流 1Hz，可强制补发', () => {
    expect(shouldEmitProgress(1000, 0)).toBe(true)
    expect(shouldEmitProgress(999, 0)).toBe(false)
    expect(shouldEmitProgress(100, 0, true)).toBe(true)
  })

  it('仅 E_TIMEOUT / E_LINK 重试，且总尝试 ≤3', () => {
    expect(shouldRetry('E_TIMEOUT', 1)).toBe(true)
    expect(shouldRetry('E_LINK', 2)).toBe(true)
    expect(shouldRetry('E_TIMEOUT', 3)).toBe(false)
    expect(shouldRetry('E_UNSUPPORTED', 1)).toBe(false)
    expect(shouldRetry('E_BADREQ', 1)).toBe(false)
  })

  it('退避阶梯 300 / 900', () => {
    expect(retryBackoffMs(1)).toBe(300)
    expect(retryBackoffMs(2)).toBe(900)
    expect(retryBackoffMs(3)).toBe(900)
  })

  it('错误码语义可查询', () => {
    expect(errorCodeMeaning('E_LINK')).toContain('链路')
    expect(errorCodeMeaning('NOPE')).toBe('未知错误码')
  })
})

describe('歌曲 DTO 规整（§3.5.1）', () => {
  it('合法对象转 DTO，数值 id 转字符串', () => {
    const dto = normalizeSongDto({ id: 12, name: '稻香', artist: '周杰伦', durationMs: 223000 })
    expect(dto).toEqual({ id: '12', name: '稻香', artist: '周杰伦', durationMs: 223000 })
  })

  it('缺少 id/name 返回 null', () => {
    expect(normalizeSongDto({ name: 'x' })).toBeNull()
    expect(normalizeSongDto(null)).toBeNull()
    expect(normalizeSongDto('nope')).toBeNull()
  })

  it('encode 后仍可 decode（DTO 位于 payload）', () => {
    const env: Envelope = buildEvt('p-3c0e-0001', 'player.song', {
      song: normalizeSongDto({ id: '1', name: '晴天', artist: '周杰伦' }) as unknown as Record<
        string,
        unknown
      >
    })
    const decoded = decodeEnvelope(encodeEnvelope(env))
    expect(decoded.ok).toBe(true)
  })
})
