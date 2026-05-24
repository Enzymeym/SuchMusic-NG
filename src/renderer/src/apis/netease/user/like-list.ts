import request from '../../../utils/request'

/**
 * 喜欢音乐列表响应
 */
export interface LikeListResponse {
  code: number
  ids: number[]
  playlistId: number
}

/**
 * 获取用户喜欢的音乐列表
 * @param uid 用户ID
 * @param cookie 可选的cookie字符串
 * @returns 喜欢音乐列表响应
 */
export async function fetchLikeList(uid: number, cookie?: string): Promise<LikeListResponse | null> {
  try {
    const params: Record<string, unknown> = { uid }
    if (cookie) {
      params.cookie = cookie
    }
    const data = await request<LikeListResponse>('/likelist', params)
    if (data.code === 200) {
      return data
    }
    return null
  } catch (error) {
    console.error('[LikeList] 获取喜欢音乐列表失败', error)
    return null
  }
}
