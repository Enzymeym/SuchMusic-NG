import { describe, expect, it } from 'vitest'
import { expandSourceKeys, isSameSourceKey } from '../types'

/**
 * 平台标识别名回归测试
 *
 * 背景：QQ 搜索页固定用 `tx` 请求解析，而澜音插件的 providerId 常写 `qq` / `tencent`。
 * 只做字面比较会把「已加载的插件」判成「没有音源」，最终误导成「未找到音源插件」。
 */
describe('expandSourceKeys', () => {
  it('把 tx 展开为等价的 QQ 标识', () => {
    expect(expandSourceKeys('tx')).toEqual(['tx', 'qq', 'tencent', 'qqmusic'])
    expect(expandSourceKeys('qq')).toEqual(['qq', 'tx', 'tencent', 'qqmusic'])
  })

  it('大小写不敏感', () => {
    expect(expandSourceKeys('TX')).toEqual(expandSourceKeys('tx'))
    expect(isSameSourceKey('Netease', 'wy')).toBe(true)
  })

  it('覆盖其余平台与本地音源', () => {
    expect(expandSourceKeys('wy')).toContain('netease')
    expect(expandSourceKeys('kg')).toContain('kugou')
    expect(expandSourceKeys('kw')).toContain('kuwo')
    expect(expandSourceKeys('mg')).toContain('migu')
    expect(expandSourceKeys('local')).toContain('localmusic')
  })

  it('未登记的自定义 providerId 原样返回', () => {
    expect(expandSourceKeys('my-provider')).toEqual(['my-provider'])
    expect(expandSourceKeys('')).toEqual([])
    expect(expandSourceKeys(undefined)).toEqual([])
  })
})

describe('isSameSourceKey', () => {
  it('同一上游的不同写法等价', () => {
    expect(isSameSourceKey('tx', 'qq')).toBe(true)
    expect(isSameSourceKey('tx', 'tencent')).toBe(true)
    expect(isSameSourceKey('wy', 'netease')).toBe(true)
  })

  it('不同平台/空值不等价', () => {
    expect(isSameSourceKey('tx', 'wy')).toBe(false)
    expect(isSameSourceKey('tx', undefined)).toBe(false)
    expect(isSameSourceKey('', 'tx')).toBe(false)
  })
})
