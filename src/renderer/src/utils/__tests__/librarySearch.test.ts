import { describe, it, expect } from 'vitest'
import { getSearchIndex, parseQuery, searchSongs, SearchIndex } from '../librarySearch'

/** 覆盖四种匹配字段（标题 / 艺术家 / 专辑 / 文件名）的最小样本 */
const songs = [
  {
    id: 1,
    name: '七里香',
    ar: [{ name: '周杰伦' }],
    al: { name: '七里香' },
    filePath: 'C:/Music/周杰伦/01 七里香.flac'
  },
  {
    id: 2,
    name: '七里香 (Live)',
    ar: [{ name: '周杰伦' }],
    al: { name: '演唱会' },
    filePath: 'C:/Music/周杰伦/02 七里香 live.flac'
  },
  {
    id: 3,
    name: '稻香',
    ar: [{ name: '周杰伦' }],
    al: { name: '魔杰座' },
    filePath: 'C:/Music/周杰伦/03 稻香.flac'
  },
  {
    id: 4,
    name: '晴天',
    ar: [{ name: '周杰伦' }],
    al: { name: '叶惠美' },
    filePath: 'C:/Music/周杰伦/04 晴天.mp3'
  }
]

const ids = (list: Array<{ id?: string | number }>): Array<string | number | undefined> =>
  list.map((s) => s.id)

describe('parseQuery', () => {
  it('空串与纯空白返回空数组', () => {
    expect(parseQuery('')).toEqual([])
    expect(parseQuery('   \t\n ')).toEqual([])
  })

  it('普通关键词按空白分词，字段为 any', () => {
    expect(parseQuery('七里香 周杰伦')).toEqual([
      { field: 'any', text: '七里香' },
      { field: 'any', text: '周杰伦' }
    ])
  })

  it('识别字段前缀（title/artist/album/file 及别名）', () => {
    expect(parseQuery('artist:周杰伦 album:叶惠美')).toEqual([
      { field: 'artist', text: '周杰伦' },
      { field: 'album', text: '叶惠美' }
    ])
    expect(parseQuery('name:稻香')).toEqual([{ field: 'title', text: '稻香' }])
    expect(parseQuery('ar:周杰伦')).toEqual([{ field: 'artist', text: '周杰伦' }])
    expect(parseQuery('filename:live')).toEqual([{ field: 'file', text: 'live' }])
  })

  it('未知前缀按普通文本处理（不吃掉 AC:DC 这类歌名）', () => {
    expect(parseQuery('AC:DC')).toEqual([{ field: 'any', text: 'ac:dc' }])
  })

  it('冒号在末尾时不当前缀（值不能为空）', () => {
    expect(parseQuery('title:')).toEqual([{ field: 'any', text: 'title:' }])
  })

  it('全角与大小写归一化', () => {
    expect(parseQuery('ＪＡＹ　ＣＨＯＵ')).toEqual([
      { field: 'any', text: 'jay' },
      { field: 'any', text: 'chou' }
    ])
  })

  it('defaultField 作用于无前缀的词', () => {
    expect(parseQuery('jay album:叶惠美', 'title')).toEqual([
      { field: 'title', text: 'jay' },
      { field: 'album', text: '叶惠美' }
    ])
  })
})

describe('searchSongs 匹配', () => {
  it('按标题匹配', () => {
    expect(ids(searchSongs(songs, '稻香').items)).toEqual([3])
  })

  it('按艺术家匹配（同分时保持曲库原顺序）', () => {
    expect(ids(searchSongs(songs, '周杰伦').items)).toEqual([1, 2, 3, 4])
  })

  it('按专辑匹配', () => {
    expect(ids(searchSongs(songs, '叶惠美').items)).toEqual([4])
  })

  it('按文件名匹配（不含目录名，只看 basename）', () => {
    expect(ids(searchSongs(songs, 'file:live').items)).toEqual([2])
    // 「周杰伦」只出现在目录名里，文件名不含 → 不该被 file: 命中
    expect(searchSongs(songs, 'file:周杰伦').total).toBe(0)
  })

  it('多个词之间是 AND', () => {
    expect(ids(searchSongs(songs, '周杰伦 稻香').items)).toEqual([3])
    expect(searchSongs(songs, '周杰伦 不存在的词').total).toBe(0)
  })

  it('options.field 在无前缀时强制限定字段', () => {
    expect(ids(searchSongs(songs, '七里香', { field: 'album' }).items)).toEqual([1])
    expect(ids(searchSongs(songs, '七里香', { field: 'artist' }).items)).toEqual([])
  })

  it('全角输入也能命中', () => {
    expect(ids(searchSongs(songs, 'ＬＩＶＥ').items)).toEqual([2])
    expect(ids(searchSongs(songs, 'Ｌｉｖｅ').items)).toEqual([2])
  })

  it('title/name 缺一个时互相兜底', () => {
    expect(searchSongs([{ title: '只有标题' }], '只有').total).toBe(1)
    expect(searchSongs([{ name: '只有名称' }], '名称').total).toBe(1)
  })

  it('fileName 优先于 filePath 参与文件名匹配', () => {
    const list = [{ name: 'x', fileName: '07 隐藏曲目.mp3', filePath: 'C:/a/无关.mp3' }]
    expect(searchSongs(list, 'file:隐藏').total).toBe(1)
    expect(searchSongs(list, 'file:无关').total).toBe(0)
  })
})

describe('searchSongs 排序与截断', () => {
  it('标题完全相等 > 前缀命中 > 子串命中', () => {
    const result = searchSongs(songs, '七里香')
    expect(ids(result.items)).toEqual([1, 2])
  })

  it('空查询返回全部且不截断', () => {
    const result = searchSongs(songs, '', { limit: 2 })
    expect(result.items).toHaveLength(4)
    expect(result.truncated).toBe(false)
  })

  it('超过 limit 时 total 仍是命中总数', () => {
    const result = searchSongs(songs, '周杰伦', { limit: 2 })
    expect(ids(result.items)).toEqual([1, 2])
    expect(result.total).toBe(4)
    expect(result.truncated).toBe(true)
  })
})

describe('getSearchIndex 缓存', () => {
  it('同一数组引用复用索引，新数组重建', () => {
    const first = getSearchIndex(songs)
    expect(getSearchIndex(songs)).toBe(first)
    expect(getSearchIndex([...songs])).not.toBe(first)
  })

  it('size 与直接构造一致', () => {
    expect(getSearchIndex(songs).size).toBe(4)
    expect(new SearchIndex(songs).size).toBe(4)
  })
})
