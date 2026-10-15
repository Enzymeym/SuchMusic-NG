/**
 * 单元测试：WebSocket URL 组装（§4.3.1「升级前携带令牌」）。
 * 运行：npx vitest run
 *
 * 背景（QA 定位的致命缺陷）：手机端在 **WS 升级前**校验 `?token=`，而 Windows 端
 * 旧实现生成的 URL **不含令牌** → 必然 401。本用例锁定修复后的行为。
 */

import { describe, it, expect, vi } from 'vitest'

// config.ts 顶部 `import { app } from 'electron'` 仅用于 configPath()；
// 本测试只覆盖纯函数，用 mock 隔离 Electron，避免在 Node 下加载 electron 二进制。
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/suchmusic-test' } }))

import { DEFAULT_BAND_CONFIG, buildWsUrl, type BandConfig } from './config'

/** 基准配置：局域网地址 + 默认端口/路径。 */
const BASE: BandConfig = {
  ...DEFAULT_BAND_CONFIG,
  host: '192.168.1.5',
  port: 8787,
  path: '/suchmusic'
}

describe('buildWsUrl（§4.3.1 令牌随升级请求携带）', () => {
  it('无令牌时不追加查询串（保持干净 URL）', () => {
    expect(buildWsUrl({ ...BASE, token: '' })).toBe('ws://192.168.1.5:8787/suchmusic')
  })

  it('带令牌时以 ?token= 追加到路径之后', () => {
    expect(buildWsUrl({ ...BASE, token: 'abc123' })).toBe(
      'ws://192.168.1.5:8787/suchmusic?token=abc123'
    )
  })

  it('令牌做 URL 编码（空格 / + / / / = / & 等特殊字符）', () => {
    expect(buildWsUrl({ ...BASE, token: 'a b+c/d=e&f' })).toBe(
      'ws://192.168.1.5:8787/suchmusic?token=a%20b%2Bc%2Fd%3De%26f'
    )
  })

  it('path 已含查询串时用 & 追加，不产生重复 ? / 连字符', () => {
    const url = buildWsUrl({ ...BASE, path: '/suchmusic?foo=bar', token: 't0k' })
    expect(url).toBe('ws://192.168.1.5:8787/suchmusic?foo=bar&token=t0k')
    expect(url).not.toContain('??')
    expect(url).not.toContain('?&')
    // 仅协议处出现一次 `//`（不出现路径拼接引入的多余斜杠）。
    expect(url.split('//')).toHaveLength(2)
  })

  it('path 以 ? 结尾时不产生 ?&', () => {
    expect(buildWsUrl({ ...BASE, path: '/suchmusic?', token: 't0k' })).toBe(
      'ws://192.168.1.5:8787/suchmusic?token=t0k'
    )
  })

  it('path 以 & 结尾时不再补分隔符', () => {
    expect(buildWsUrl({ ...BASE, path: '/suchmusic?a=1&', token: 't0k' })).toBe(
      'ws://192.168.1.5:8787/suchmusic?a=1&token=t0k'
    )
  })
})
