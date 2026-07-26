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

/** 专辑缓存：AlbumView 构建的专辑数据，供 AlbumDetailView 直接使用 */
export const albumCache = new Map<string, AlbumInfo>()
