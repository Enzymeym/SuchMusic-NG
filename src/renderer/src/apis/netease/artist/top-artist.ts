import request from '../../../utils/request'

export interface TopArtistItem {
  id: number
  name: string
  picUrl: string
  score?: number
  topicPerson?: number
  alias: string[]
}

export interface TopArtistResponse {
  code: number
  list: {
    artists: TopArtistItem[]
    updateTime: number
    type: number
  }
}

// 获取热门歌手列表
export async function fetchTopArtists(limit: number = 30, offset: number = 0): Promise<TopArtistItem[]> {
  try {
    const data = await request<TopArtistResponse>('/toplist/artist', {
      limit,
      offset,
      type: 1 // 1: 华语 2: 欧美 3: 韩国 4: 日本 (可选，默认全部)
    })
    
    if (!data || !data.list || !Array.isArray(data.list.artists)) {
      return []
    }
    
    return data.list.artists
  } catch (error) {
    console.error('[TopArtist] 获取歌手广场数据失败', error)
    return []
  }
}
