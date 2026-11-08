import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { useLibrarySearch } from '../useLibrarySearch'
import type { SearchField } from '../../utils/librarySearch'

const songs = [
  { id: 1, name: '七里香', ar: [{ name: '周杰伦' }], al: { name: '七里香' } },
  { id: 2, name: '稻香', ar: [{ name: '周杰伦' }], al: { name: '魔杰座' } },
  { id: 3, name: '晴天', ar: [{ name: '周杰伦' }], al: { name: '叶惠美' } }
]

const ids = (list: Array<{ id?: string | number }>): Array<string | number | undefined> =>
  list.map((s) => s.id)

describe('useLibrarySearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('输入后先挂起，防抖结束才生效', () => {
    const s = useLibrarySearch({ source: () => songs, delay: 100 })

    s.update('稻香')
    expect(s.pending.value).toBe(true)
    expect(s.activeKeyword.value).toBe('')
    // 生效前仍展示全量
    expect(s.results.value).toHaveLength(3)

    vi.advanceTimersByTime(100)
    expect(s.pending.value).toBe(false)
    expect(s.activeKeyword.value).toBe('稻香')
    expect(ids(s.results.value)).toEqual([2])
  })

  it('连续输入只生效最后一次（不为每个字符算一遍）', () => {
    const s = useLibrarySearch({ source: () => songs, delay: 100 })
    s.update('七')
    s.update('七里')
    s.update('七里香')
    vi.advanceTimersByTime(99)
    expect(s.activeKeyword.value).toBe('')
    vi.advanceTimersByTime(1)
    expect(s.activeKeyword.value).toBe('七里香')
    expect(ids(s.results.value)).toEqual([1])
  })

  it('输入法合成期不触发搜索，合成结束才查一次', () => {
    const s = useLibrarySearch({ source: () => songs, delay: 100 })

    s.onCompositionStart()
    s.update('zhou')
    s.update('zhoujielun')
    vi.advanceTimersByTime(500)
    expect(s.composing.value).toBe(true)
    expect(s.pending.value).toBe(false)
    expect(s.activeKeyword.value).toBe('')

    s.onCompositionEnd('周杰伦')
    expect(s.composing.value).toBe(false)
    expect(s.keyword.value).toBe('周杰伦')
    vi.advanceTimersByTime(100)
    expect(ids(s.results.value)).toEqual([1, 2, 3])
  })

  it('清空输入立即失效，且挂起中的旧关键词不会复活', () => {
    const s = useLibrarySearch({ source: () => songs, delay: 100 })
    s.update('稻')
    vi.advanceTimersByTime(60)

    s.update('')
    expect(s.activeKeyword.value).toBe('')
    expect(s.pending.value).toBe(false)

    vi.advanceTimersByTime(500)
    expect(s.activeKeyword.value).toBe('')
    expect(s.hasQuery.value).toBe(false)
  })

  it('纯空白视为清空', () => {
    const s = useLibrarySearch({ source: () => songs, delay: 100 })
    s.submit('稻香')
    s.update('   ')
    expect(s.activeKeyword.value).toBe('')
    vi.advanceTimersByTime(500)
    expect(s.activeKeyword.value).toBe('')
  })

  it('submit 跳过防抖立即生效（回车提交）', () => {
    const s = useLibrarySearch({ source: () => songs, delay: 200 })
    s.update('稻香')
    s.submit()
    expect(s.pending.value).toBe(false)
    expect(s.activeKeyword.value).toBe('稻香')
    expect(ids(s.results.value)).toEqual([2])
    // 原本挂起的防抖不应再触发一次
    vi.advanceTimersByTime(500)
    expect(s.activeKeyword.value).toBe('稻香')
  })

  it('reset 清空全部状态', () => {
    const s = useLibrarySearch({ source: () => songs, delay: 100 })
    s.submit('稻香')
    s.reset()
    expect(s.keyword.value).toBe('')
    expect(s.activeKeyword.value).toBe('')
    expect(s.hasQuery.value).toBe(false)
    expect(s.results.value).toHaveLength(3)
  })

  it('field 变化后结果跟着变（computed 依赖生效）', async () => {
    const field = ref<SearchField>('album')
    const s = useLibrarySearch({ source: () => songs, field })

    s.submit('魔杰座')
    expect(ids(s.results.value)).toEqual([2])

    field.value = 'title'
    await nextTick()
    expect(s.results.value).toHaveLength(0)
  })

  it('数据源数组换引用后索引重建', async () => {
    const list = ref([...songs])
    const s = useLibrarySearch({ source: () => list.value })
    s.submit('周杰伦')
    expect(s.total.value).toBe(3)

    list.value = [songs[0]]
    await nextTick()
    expect(s.total.value).toBe(1)
  })

  it('limit 生效时 truncated 为 true 且 total 保留命中总数', () => {
    const s = useLibrarySearch({ source: () => songs, limit: 2 })
    s.submit('周杰伦')
    expect(s.results.value).toHaveLength(2)
    expect(s.total.value).toBe(3)
    expect(s.truncated.value).toBe(true)
  })
})
