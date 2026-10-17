import { describe, expect, it } from 'vitest'
import { toSerializable } from '../serialize'

/**
 * 回归：插件返回值（可能来自 vm 沙箱的 Proxy / 类实例）必须收敛为纯数据，
 * 否则 ipcMain.handle 的返回值结构化克隆失败，渲染层只看到
 * 「An object could not be cloned.」。
 */
describe('toSerializable', () => {
  it('Proxy 会被展开成普通对象', () => {
    const target = { url: 'https://example.com/a.flac', headers: { Referer: 'https://x' } }
    const proxied = new Proxy(target, {
      get: (obj, key) => (obj as any)[key]
    })
    const result = toSerializable(proxied)
    expect(() => structuredClone(result)).not.toThrow()
    expect(result).toEqual(target)
  })

  it('剔除函数成员并保留可克隆字段', () => {
    const result = toSerializable({
      url: 'https://example.com/b.mp3',
      expiresAt: 1700000000000,
      requestHeaders: { 'User-Agent': 'x' },
      dispose: () => {}
    } as any)
    expect(() => structuredClone(result)).not.toThrow()
    expect(result).toEqual({
      url: 'https://example.com/b.mp3',
      expiresAt: 1700000000000,
      requestHeaders: { 'User-Agent': 'x' }
    })
  })

  it('循环引用不会死递归', () => {
    const cyc: any = { url: 'https://example.com/c.mp3' }
    cyc.self = cyc
    const result = toSerializable(cyc)
    expect(() => structuredClone(result)).not.toThrow()
    expect(result.url).toBe('https://example.com/c.mp3')
  })
})
