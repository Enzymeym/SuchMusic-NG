export interface AlbumSong {
  id: string | number
  title: string
  artist: string
  cover: string
  album?: string
  filePath?: string
  durationMs?: number
  year?: number
}

export interface AlbumInfo {
  name: string
  artist: string
  cover: string
  playCount: number
  songs: AlbumSong[]
}

/** 专辑缓存最大容量 */
const ALBUM_CACHE_MAX_SIZE = 200

/** 专辑缓存：AlbumView 构建的专辑数据，供 AlbumDetailView 直接使用 */
const _cache = new Map<string, AlbumInfo>()

export const albumCache = {
  get(key: string): AlbumInfo | undefined {
    return _cache.get(key)
  },

  set(key: string, value: AlbumInfo): void {
    // 容量上限时，淘汰最早插入的条目（Map 插入顺序）
    if (_cache.size >= ALBUM_CACHE_MAX_SIZE && !_cache.has(key)) {
      const firstKey = _cache.keys().next().value
      if (firstKey !== undefined) {
        _cache.delete(firstKey)
      }
    }
    _cache.set(key, value)
  },

  clear(): void {
    _cache.clear()
  },

  /** 获取当前缓存条目数 */
  get size(): number {
    return _cache.size
  }
}
