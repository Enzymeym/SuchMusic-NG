import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 搜索历史 store。
 *
 * 纯前端状态，落 localStorage；测试环境是 node，没有 localStorage，
 * 这里用一个最小内存替身在导入 store 前挂到 globalThis 上。
 */

const memory = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key)
})

const { useSearchHistoryStore } = await import('../searchHistoryStore')

describe('searchHistoryStore', () => {
  beforeEach(() => {
    memory.clear()
    setActivePinia(createPinia())
  })

  it('新搜索置顶且不重复', () => {
    const store = useSearchHistoryStore()
    store.add('晴天')
    store.add('稻香')
    store.add('晴天')

    expect(store.items.map((i) => i.keyword)).toEqual(['晴天', '稻香'])
  })

  it('忽略空白关键词', () => {
    const store = useSearchHistoryStore()
    store.add('   ')
    expect(store.items).toHaveLength(0)
  })

  it('关键词两端空白被裁掉', () => {
    const store = useSearchHistoryStore()
    store.add('  七里香  ')
    expect(store.items[0].keyword).toBe('七里香')
  })

  it('超过上限丢弃最旧记录', () => {
    const store = useSearchHistoryStore()
    for (let i = 0; i < 20; i++) store.add(`kw${i}`)

    expect(store.items).toHaveLength(12)
    expect(store.items[0].keyword).toBe('kw19')
    expect(store.items.some((i) => i.keyword === 'kw0')).toBe(false)
  })

  it('删除单条不影响其他记录', () => {
    const store = useSearchHistoryStore()
    store.add('A')
    store.add('B')
    store.add('C')

    store.remove('B')

    expect(store.items.map((i) => i.keyword)).toEqual(['C', 'A'])
  })

  it('清空后写入空数组', () => {
    const store = useSearchHistoryStore()
    store.add('A')
    store.clear()

    expect(store.items).toHaveLength(0)
    expect(JSON.parse(memory.get('search-history') ?? 'null')).toEqual([])
  })

  it('读取时兼容旧格式并过滤脏数据', () => {
    memory.set(
      'search-history',
      JSON.stringify(['旧字符串', { keyword: '合法', at: 1 }, { keyword: '' }, 42])
    )

    const store = useSearchHistoryStore()
    store.load()

    expect(store.items.map((i) => i.keyword)).toEqual(['旧字符串', '合法'])
  })
})
