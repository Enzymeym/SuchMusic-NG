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
  total?: number
  code: number
  cat?: string
}

export interface PlaylistCategory {
  name: string
  resourceCount: number
  imgId: number
  imgUrl: string | null
  type: number
  category: number
  resourceType: number
  hot: boolean
  activity: boolean
}

export interface PlaylistCatlistResponse {
  code: number
  sub: PlaylistCategory[]
  categories: { [key: string]: string }
  all: PlaylistCategory
}

/**
 * 获取歌单分类列表
 */
export async function fetchPlaylistCategories(): Promise<PlaylistCatlistResponse | null> {
  try {
    const data = await request<PlaylistCatlistResponse>('/playlist/catlist')
    if (data.code !== 200) {
      throw new Error('Failed to fetch categories')
    }
    return data
  } catch (error) {
    console.error('[TopPlaylist] 获取歌单分类失败', error)
    return null
  }
}

/**
 * 获取网友精选碟歌单 (歌单广场)
 * @param cat - 歌单分类, 比如 " 华语 ", " 古风 ", " 欧美 ", " 流行 ", 默认为 "全部"
 * @param limit - 取出数量, 默认为 50
 * @param offset - 偏移数量, 用于分页
 * @param order - 可选值为 'new' 和 'hot', 分别对应最新和最热, 默认为 'hot'
 */
export async function fetchTopPlaylists(
  cat: string = '全部',
  limit: number = 50,
  offset: number = 0,
  order: 'hot' | 'new' = 'hot'
): Promise<TopPlaylistItem[]> {
  try {
    const data = await request<TopPlaylistResponse>('/top/playlist', {
      cat,
      limit,
      offset,
      order
    })
    
    if (!data || !Array.isArray(data.playlists)) {
      return []
    }
    return data.playlists
  } catch (error) {
    console.error('[TopPlaylist] 获取歌单广场数据失败', error)
    return []
  }
}

