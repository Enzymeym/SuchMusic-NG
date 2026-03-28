import request from '../../../utils/request'

export interface PlaylistCreator {
  userId: number
  nickname: string
  avatarUrl: string
}

export interface PlaylistDetail {
  id: number
  name: string
  coverImgUrl: string
  description: string
  tags: string[]
  playCount: number
  trackCount: number
  creator: PlaylistCreator
  createTime: number
}

export interface PlaylistDetailResponse {
  code: number
  playlist: PlaylistDetail
}

export interface PlaylistTrack {
  id: number
  name: string
  ar: { id: number; name: string }[]
  al: { id: number; name: string; picUrl: string }
  dt: number
}

export interface PlaylistTracksResponse {
  code: number
  songs: PlaylistTrack[]
}

export interface PlaylistDynamicResponse {
  code: number
  playCount: number
  bookedCount: number
  commentCount: number
  shareCount: number
}

/**
 * 获取歌单详情
 * @param id 歌单 id
 */
export async function fetchPlaylistDetail(id: number | string): Promise<PlaylistDetailResponse | null> {
  try {
    const data = await request<PlaylistDetailResponse>('/playlist/detail', { id })
    if (data.code === 200) {
      return data
    }
    return null
  } catch (error) {
    console.error('[PlaylistDetail] 获取歌单详情失败', error)
    return null
  }
}

/**
 * 获取歌单所有歌曲
 * @param id 歌单 id
 * @param limit 限制获取歌曲的数量，默认值为当前歌单的歌曲数量
 * @param offset 默认值为 0
 */
export async function fetchPlaylistTracks(
  id: number | string,
  limit?: number,
  offset: number = 0
): Promise<PlaylistTracksResponse | null> {
  try {
    const params: any = { id, offset }
    if (limit !== undefined) {
      params.limit = limit
    }
    const data = await request<PlaylistTracksResponse>('/playlist/track/all', params)
    if (data.code === 200) {
      return data
    }
    return null
  } catch (error) {
    console.error('[PlaylistDetail] 获取歌单所有歌曲失败', error)
    return null
  }
}

/**
 * 歌单详情动态
 * @param id 歌单 id
 */
export async function fetchPlaylistDynamic(id: number | string): Promise<PlaylistDynamicResponse | null> {
  try {
    const data = await request<PlaylistDynamicResponse>('/playlist/detail/dynamic', { id })
    if (data.code === 200) {
      return data
    }
    return null
  } catch (error) {
    console.error('[PlaylistDetail] 获取歌单详情动态失败', error)
    return null
  }
}
