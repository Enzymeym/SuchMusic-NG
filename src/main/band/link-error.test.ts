/**
 * 单元测试：链路失败分类（纯函数）。
 * 运行：npx vitest run
 *
 * 覆盖 QA 指出的「错误提示不清晰」：把传输层信号映射为可操作提示。
 */

import { describe, it, expect } from 'vitest'
import { classifyLinkFailure, type LinkFailureInput } from './link-error'

describe('classifyLinkFailure（故障分类纯函数）', () => {
  it('HTTP 401 → 令牌错误', () => {
    const r = classifyLinkFailure({ phase: 'connect', httpStatus: 401 })
    expect(r.kind).toBe('token_rejected')
    expect(r.hint).toContain('令牌')
  })

  it('HTTP 403 → 非局域网来源', () => {
    const r = classifyLinkFailure({ phase: 'connect', httpStatus: 403 })
    expect(r.kind).toBe('non_private_source')
    expect(r.hint).toContain('局域网')
  })

  it('HTTP 404 → 地址 / 路径错误', () => {
    const r = classifyLinkFailure({ phase: 'connect', httpStatus: 404 })
    expect(r.kind).toBe('path_not_found')
    expect(r.hint).toContain('路径')
    expect(r.hint).toContain('/suchmusic')
  })

  it('其它 4xx/5xx → 握手被拒', () => {
    expect(classifyLinkFailure({ phase: 'connect', httpStatus: 500 }).kind).toBe(
      'handshake_rejected'
    )
  })

  it('关闭码 1008（服务端 5s 未收到 sys.hello）→ 握手超时', () => {
    const r = classifyLinkFailure({ phase: 'handshake', closeCode: 1008 })
    expect(r.kind).toBe('handshake_rejected')
  })

  it('undici 的 non-101 统一文案 → 连接未建立（综合排查）', () => {
    const r = classifyLinkFailure({
      phase: 'connect',
      errorMessage: 'Received network error or non-101 status code.'
    })
    expect(r.kind).toBe('unreachable')
    expect(r.hint).toContain('手机端')
    expect(r.hint).toContain('局域网')
  })

  it('连接被拒（ECONNREFUSED）→ 连接未建立', () => {
    expect(
      classifyLinkFailure({ phase: 'connect', errorMessage: 'connect ECONNREFUSED' }).kind
    ).toBe('unreachable')
  })

  it('无任何信号但处于连接阶段 → 连接未建立（保守）', () => {
    expect(classifyLinkFailure({ phase: 'connect' }).kind).toBe('unreachable')
  })

  it('会话中掉线 → session_lost（不误报为配置错误）', () => {
    const r = classifyLinkFailure({ phase: 'session', closeCode: 1006 })
    expect(r.kind).toBe('session_lost')
  })

  it('握手阶段无明确信号 → unknown', () => {
    expect(classifyLinkFailure({ phase: 'handshake' }).kind).toBe('unknown')
  })

  it('所有分类的提示均非空且不含令牌字样', () => {
    const inputs: LinkFailureInput[] = [
      { phase: 'connect', httpStatus: 401 },
      { phase: 'connect', httpStatus: 403 },
      { phase: 'connect', httpStatus: 404 },
      { phase: 'connect' },
      { phase: 'handshake', closeCode: 1008 },
      { phase: 'session' },
      { phase: 'handshake' }
    ]
    for (const input of inputs) {
      const r = classifyLinkFailure(input)
      expect(r.title.length).toBeGreaterThan(0)
      expect(r.hint.length).toBeGreaterThan(0)
    }
  })
})
