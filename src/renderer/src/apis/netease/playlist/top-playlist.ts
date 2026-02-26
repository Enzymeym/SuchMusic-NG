import request from '../../../utils/request'

// 歌单广场接口：获取最热歌单列表
export interface TopPlaylistItem {
  id: number
  name: string
  coverImgUrl: string
  playCount: number
}

export interface TopPlaylistResponse {
  playlists: TopPlaylistItem[]
}

// 从后端接口获取最热歌单
export async function fetchTopPlaylists(): Promise<TopPlaylistItem[]> {
  try {
    const data = await request<TopPlaylistResponse>('/top/playlist')
    if (!data || !Array.isArray(data.playlists)) {
      return []
    }
    return data.playlists
  } catch (error) {
    console.error('[TopPlaylist] 获取歌单广场数据失败', error)
    return []
  }
}

