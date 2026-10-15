/**
 * 单元测试：WebSocket 客户端 —— 令牌脱敏、升级前携带令牌、升级前失败收尾。
 * 运行：npx vitest run
 *
 * 这是 QA 指出的「65 条单测测不到跨端升级与令牌传递」的回归补充：
 * 用假 WebSocket 记录**构造时的 URL**，证明令牌在**升级前**（构造/升级请求）就已携带，
 * 与手机端 `band_ws_server.dart` 在升级前校验 `?token=` 的时机一致。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { BandWsClient, sanitizeUrl, type BandConnectOptions } from './ws-client'

/** 记录构造 URL 与已发送帧的假 WebSocket（仅实现客户端用到的部分）。 */
class FakeWebSocket {
  static ctorUrls: string[] = []
  static instances: FakeWebSocket[] = []

  readyState = 0 // CONNECTING
  readonly sent: string[] = []
  onopen: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.ctorUrls.push(url)
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3 // CLOSED
    this.onclose?.({ code: 1000, reason: '' })
  }

  // ---- 测试驱动 ----
  /** 模拟升级成功。 */
  open(): void {
    this.readyState = 1 // OPEN
    this.onopen?.({})
  }

  /** 模拟「升级前」失败：只触发 error，readyState 仍为 CONNECTING，且**不**触发 close。 */
  failPreUpgrade(message: string): void {
    this.onerror?.({ error: new Error(message) })
  }

  /** 模拟「升级后」被关闭（带关闭码）。 */
  closeByServer(code: number, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

const OPTS: BandConnectOptions = {
  url: 'ws://192.168.1.5:8787/suchmusic?token=SECRET123',
  pairCode: '123456',
  token: 'SECRET123'
}

beforeEach(() => {
  FakeWebSocket.ctorUrls = []
  FakeWebSocket.instances = []
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket
})

afterEach(() => {
  delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket
})

describe('sanitizeUrl（令牌不得进入日志 / 状态）', () => {
  it('去除查询串：含令牌 URL 不泄露令牌', () => {
    const safe = sanitizeUrl('ws://192.168.1.5:8787/suchmusic?token=SUPER_SECRET')
    expect(safe).toBe('ws://192.168.1.5:8787/suchmusic')
    expect(safe).not.toContain('SUPER_SECRET')
    expect(safe).not.toContain('token')
  })

  it('无查询串时原样返回', () => {
    expect(sanitizeUrl('ws://192.168.1.5:8787/suchmusic')).toBe('ws://192.168.1.5:8787/suchmusic')
  })

  it('编码后的令牌同样被截断，不泄露任何查询串内容', () => {
    const safe = sanitizeUrl('ws://h:1/suchmusic?token=a%20b%2Bc&x=1')
    expect(safe).toBe('ws://h:1/suchmusic')
    expect(safe).not.toContain('%20')
    expect(safe).not.toContain('x=1')
  })
})

describe('BandWsClient · 令牌在升级前携带（对齐基线 §4.3.1）', () => {
  it('构造（即升级请求）使用的 URL 已含 ?token= 查询串', async () => {
    const client = new BandWsClient()
    client.on('error', () => {})
    await client.connect(OPTS)

    expect(FakeWebSocket.ctorUrls).toHaveLength(1)
    expect(FakeWebSocket.ctorUrls[0]).toBe(OPTS.url)
    expect(FakeWebSocket.ctorUrls[0]).toContain('token=SECRET123')

    client.disconnect()
  })

  it('状态快照中的 peer 已脱敏（不含令牌）', async () => {
    const client = new BandWsClient()
    client.on('error', () => {})
    await client.connect(OPTS)
    FakeWebSocket.instances[0].open()

    const status = client.getStatus()
    expect(status.peer).toBe('ws://192.168.1.5:8787/suchmusic')
    expect(status.peer).not.toContain('SECRET123')

    client.disconnect()
  })

  it('升级后仍发送 sys.hello，并冗余携带 pair / token（兼容保留）', async () => {
    const client = new BandWsClient()
    client.on('error', () => {})
    await client.connect(OPTS)
    FakeWebSocket.instances[0].open()

    const hello = JSON.parse(FakeWebSocket.instances[0].sent[0]) as {
      method: string
      payload: Record<string, unknown>
    }
    expect(hello.method).toBe('sys.hello')
    expect(hello.payload.role).toBe('windows')
    expect(hello.payload.pair).toBe('123456')
    expect(hello.payload.token).toBe('SECRET123')

    client.disconnect()
  })
})

describe('BandWsClient · 升级前失败也能收尾并重连', () => {
  it('undici 只给 error（无 close）时：状态转为 disconnected，并给出可操作提示', async () => {
    const client = new BandWsClient()
    const errors: Array<{ code: string; message: string }> = []
    client.on('error', (error) => errors.push(error))

    await client.connect(OPTS)
    FakeWebSocket.instances[0].failPreUpgrade('Received network error or non-101 status code.')

    expect(client.getStatus().state).toBe('disconnected')
    expect(client.getStatus().reconnectAttempts).toBeGreaterThanOrEqual(1)

    const last = errors.at(-1)
    expect(last?.code).toBe('E_LINK')
    expect(last?.message).toContain('手机端')

    client.disconnect()
  })

  it('升级后 1008 关闭：分类为握手超时提示', async () => {
    const client = new BandWsClient()
    const errors: Array<{ code: string; message: string }> = []
    client.on('error', (error) => errors.push(error))

    await client.connect(OPTS)
    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].closeByServer(1008, 'handshake timeout')

    const last = errors.at(-1)
    expect(last?.code).toBe('E_LINK')
    expect(last?.message).toContain('握手')

    client.disconnect()
  })
})
