import request from '../../../utils/request'

// 排行榜接口：获取各类榜单列表
export interface ToplistItem {
  id: number
  name: string
  coverImgUrl: string
  playCount: number
  updateFrequency?: string
  description?: string
}

export interface ToplistResponse {
  code: number
  list: ToplistItem[]
}

// 从后端接口获取排行榜列表
export async function fetchToplists(): Promise<ToplistItem[]> {
  try {
    const data = await request<ToplistResponse>('/toplist')
    if (!data || !Array.isArray(data.list)) {
      return []
    }
    return data.list
  } catch (error) {
    console.error('[Toplist] 获取排行榜数据失败', error)
    return []
  }
}

