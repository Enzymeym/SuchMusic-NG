/**
 * 本地曲库搜索（纯函数，可单测）。
 *
 * 为什么放在渲染层而不是 SQL：
 * 曲库本来就要整份进内存喂给虚拟列表，1 万条做一次 `includes` 过滤是毫秒级；
 * 而走一次 IPC 往返至少 1~3ms 且要处理竞态（旧请求晚到覆盖新结果）。
 *
 * 支持两种输入：
 * - 普通关键词：`七里香 周杰伦` → 空格分词，词之间是 AND
 * - 字段限定：`artist:周杰伦 album:叶惠美` / `title:七里香` / `file:live`
 */
import { normalizeSearchText } from '../../../shared/library/normalize'

/** 搜索只依赖这几个字段，避免与 store 的类型互相 import */
export interface SearchableSong {
  id?: string | number
  name?: string
  title?: string
  ar?: Array<{ name?: string }>
  al?: { name?: string }
  album?: string
  fileName?: string
  filePath?: string
}

export type SearchField = 'any' | 'title' | 'artist' | 'album' | 'file'

interface Token {
  field: SearchField
  text: string
}

interface IndexEntry<T extends SearchableSong> {
  song: T
  title: string
  artist: string
  album: string
  file: string
}

export interface SearchOptions {
  limit?: number
  /** 强制只在这些字段里匹配（用户没写前缀时生效） */
  field?: SearchField
}

export interface SearchResult<T extends SearchableSong> {
  items: T[]
  total: number
  /** 命中数量超过 limit 时为 true，UI 可提示「共 N 条」 */
  truncated: boolean
}

const FIELD_PREFIXES: Record<string, SearchField> = {
  title: 'title',
  name: 'title',
  artist: 'artist',
  ar: 'artist',
  album: 'album',
  al: 'album',
  file: 'file',
  filename: 'file'
}

function fileBaseName(filePath?: string): string {
  if (!filePath) return ''
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const name = idx >= 0 ? filePath.slice(idx + 1) : filePath
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function entryOf<T extends SearchableSong>(song: T): IndexEntry<T> {
  const title = normalizeSearchText(song.name ?? song.title ?? '')
  const artist = normalizeSearchText((song.ar ?? []).map((a) => a?.name ?? '').join(' '))
  const album = normalizeSearchText(song.al?.name ?? song.album ?? '')
  const file = normalizeSearchText(song.fileName ? fileBaseName(song.fileName) : fileBaseName(song.filePath))
  return { song, title, artist, album, file }
}

/**
 * 解析查询串。`artist:周杰伦 稻香` → [{field:'artist',text:'周杰伦'},{field:'any',text:'稻香'}]
 * 冒号前不是已知字段名时按普通文本处理（避免把 `AC:DC` 这类歌名吃掉）。
 */
export function parseQuery(raw: string, defaultField: SearchField = 'any'): Token[] {
  const text = normalizeSearchText(raw)
  if (!text) return []

  const tokens: Token[] = []
  for (const chunk of text.split(/\s+/)) {
    if (!chunk) continue
    const colon = chunk.indexOf(':')
    if (colon > 0 && colon < chunk.length - 1) {
      const prefix = chunk.slice(0, colon)
      const value = chunk.slice(colon + 1)
      const field = FIELD_PREFIXES[prefix]
      if (field) {
        tokens.push({ field, text: value })
        continue
      }
    }
    tokens.push({ field: defaultField, text: chunk })
  }
  return tokens
}

function matchToken(entry: IndexEntry<SearchableSong>, token: Token): boolean {
  switch (token.field) {
    case 'title':
      return entry.title.includes(token.text)
    case 'artist':
      return entry.artist.includes(token.text)
    case 'album':
      return entry.album.includes(token.text)
    case 'file':
      return entry.file.includes(token.text)
    default:
      return (
        entry.title.includes(token.text) ||
        entry.artist.includes(token.text) ||
        entry.album.includes(token.text) ||
        entry.file.includes(token.text)
      )
  }
}

/** 打分：标题命中权重最高，文件名最低；前缀命中高于子串命中 */
export function scoreEntry(entry: IndexEntry<SearchableSong>, tokens: Token[]): number {
  let score = 0
  for (const token of tokens) {
    if (entry.title === token.text) score += 200
    else if (entry.title.startsWith(token.text)) score += 120
    else if (entry.title.includes(token.text)) score += 80

    if (entry.artist.startsWith(token.text)) score += 60
    else if (entry.artist.includes(token.text)) score += 40

    if (entry.album.includes(token.text)) score += 25
    if (entry.file.includes(token.text)) score += 12
  }
  return score
}

export class SearchIndex<T extends SearchableSong> {
  readonly entries: IndexEntry<T>[]

  constructor(songs: T[]) {
    this.entries = songs.map(entryOf)
  }

  get size(): number {
    return this.entries.length
  }

  search(raw: string, options: SearchOptions = {}): SearchResult<T> {
    const tokens = parseQuery(raw, options.field ?? 'any')
    if (tokens.length === 0) {
      const items = this.entries.map((e) => e.song)
      return { items, total: items.length, truncated: false }
    }

    const limit = Math.max(1, options.limit ?? 200)
    const scored: Array<{ song: T; score: number; order: number }> = []

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]
      let hit = true
      for (const token of tokens) {
        if (!matchToken(entry, token)) {
          hit = false
          break
        }
      }
      if (!hit) continue
      scored.push({ song: entry.song, score: scoreEntry(entry, tokens), order: i })
    }

    // 同分时保持曲库原顺序（目录顺序），避免结果在不同输入下跳动
    scored.sort((a, b) => b.score - a.score || a.order - b.order)
    const total = scored.length
    const items = scored.slice(0, limit).map((s) => s.song)
    return { items, total, truncated: total > items.length }
  }
}

/** 按曲目数组缓存索引：数组引用变了就重建（扫描/重载后自然失效） */
const indexCache = new WeakMap<object, SearchIndex<SearchableSong>>()

export function getSearchIndex<T extends SearchableSong>(songs: T[]): SearchIndex<T> {
  const cached = indexCache.get(songs)
  if (cached) return cached as SearchIndex<T>
  const index = new SearchIndex(songs)
  indexCache.set(songs, index as SearchIndex<SearchableSong>)
  return index
}

/** 一次性查询（无缓存版，供测试与临时用途） */
export function searchSongs<T extends SearchableSong>(
  songs: T[],
  raw: string,
  options: SearchOptions = {}
): SearchResult<T> {
  return new SearchIndex(songs).search(raw, options)
}
