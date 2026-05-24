import request from '../../../utils/request'

/**
 * 歌手信息
 */
export interface Artist {
  id: number
  name: string
  tns: string[]
  alias: string[]
}

/**
 * 专辑信息
 */
export interface Album {
  id: number
  name: string
  picUrl: string
  tns: string[]
  pic: number
}

/**
 * 歌曲详情
 */
export interface SongDetail {
  name: string
  id: number
  pst: number
  t: number
  ar: Artist[]
  alia: string[]
  pop: number
  st: number
  rt: string | null
  fee: number
  v: number
  version: number
  crbt: string | null
  cf: string | null
  al: Album
  dt: number
  hr: any | null
  sq: any | null
  h: any | null
  m: any | null
  l: any | null
  a: any | null
  cd: string | null
  no: number
  rtUrl: string | null
  rtUrls: string[]
  djId: number
  copyright: number
  s_id: number
  mark: number
  originCoverType: number
  originSongSimpleData: any | null
  single: number
  noCopyrightRcmd: any | null
  mv: number
  rtype: number
  rurl: string | null
  mst: number
  cp: number
  publishTime: number
  pc: any | null
  privilege: {
    cs: boolean
    st: number
    toast: boolean
    flLevel: string
    plLevel: string
    dlLevel: string
    maxBrLevel: string
  }
}

/**
 * 歌曲详情响应
 */
export interface SongDetailResponse {
  code: number
  songs: SongDetail[]
  privileges: any[]
}

/**
 * 获取歌曲详情
 * @param ids 音乐id，支持多个id，用逗号隔开
 * @returns 歌曲详情响应
 */
export async function fetchSongDetail(ids: string | number): Promise<SongDetailResponse | null> {
  try {
    const data = await request<SongDetailResponse>('/song/detail', { ids })
    if (data.code === 200) {
      return data
    }
    return null
  } catch (error) {
    console.error('[SongDetail] 获取歌曲详情失败', error)
    return null
  }
}
