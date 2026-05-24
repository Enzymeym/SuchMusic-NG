import request from '../../../utils/request'

/**
 * 用户歌单
 */
export interface UserPlaylist {
  id: number
  name: string
  coverImgUrl: string
  creator: {
    userId: number
    nickname: string
  }
  trackCount: number
  playCount: number
  subscribed: boolean
}

/**
 * 用户歌单响应
 */
export interface UserPlaylistResponse {
  code: number
  playlist: UserPlaylist[]
  more: boolean
  version: string
}

/**
 * 获取用户歌单
 * @param uid 用户ID
 * @param cookie 可选的cookie字符串
 * @returns 用户歌单响应
 */
export async function fetchUserPlaylist(uid: number, cookie?: string): Promise<UserPlaylistResponse | null> {
  try {
    const params: Record<string, unknown> = { uid }
    if (cookie) {
      params.cookie = cookie
    }
    const data = await request<UserPlaylistResponse>('/user/playlist', params)
    if (data.code === 200) {
      return data
    }
    return null
  } catch (error) {
    console.error('[UserPlaylist] 获取用户歌单失败', error)
    return null
  }
}
