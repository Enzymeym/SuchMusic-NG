import request from '../../../utils/request'

export interface SearchSong {
  id: number
  name: string
  ar: { id: number; name: string; tns?: string[]; alias?: string[] }[]
  al: { id: number; name: string; picUrl: string; tns?: string[]; pic_str?: string; pic?: number }
  dt: number
  h?: { br: number; fid: number; size: number; vd: number }
  m?: { br: number; fid: number; size: number; vd: number }
  l?: { br: number; fid: number; size: number; vd: number }
  sq?: { br: number; fid: number; size: number; vd: number }
  hr?: { br: number; fid: number; size: number; vd: number }
  a: any
  cd: string
  no: number
  rtUrl: any
  ftype: number
  rtUrls: any[]
  djId: number
  copyright: number
  s_id: number
  mark: number
  originCoverType: number
  originSongSimpleData: any
  tagPicList: any
  resourceState: boolean
  version: number
  songJumpInfo: any
  entertainmentTags: any
  single: number
  noCopyrightRcmd: any
  mst: number
  cp: number
  mv: number
  rtype: number
  rurl: any
  publishTime: number
  privilege?: {
    id: number
    fee: number
    payed: number
    st: number
    pl: number
    dl: number
    sp: number
    cp: number
    subp: number
    cs: boolean
    maxbr: number
    fl: number
    toast: boolean
    flag: number
    preSell: boolean
    playMaxbr: number
    downloadMaxbr: number
    maxBrLevel: string
    playMaxBrLevel: string
    downloadMaxBrLevel: string
    plLevel: string
    dlLevel: string
    flLevel: string
    rscl: any
    freeTrialPrivilege: {
      resConsumable: boolean
      userConsumable: boolean
      listenType: any
    }
    chargeInfoList: {
      rate: number
      chargeUrl: any
      chargeMessage: any
      chargeType: number
    }[]
  }
}

export interface CloudSearchResult {
  result: {
    songs?: SearchSong[]
    songCount?: number
    playlists?: any[] // TODO: Define Playlist type if needed
    playlistCount?: number
    // add more types as needed
  }
  code: number
}

/**
 * 网易云云搜索接口
 * @param keywords 搜索关键词
 * @param type 搜索类型；默认为 1 即单曲 , 取值意义 : 1: 单曲, 10: 专辑, 100: 歌手, 1000: 歌单, 1002: 用户, 1004: MV, 1006: 歌词, 1009: 电台, 1014: 视频, 1018:综合, 2000:声音
 * @param limit 返回数量 , 默认为 30
 * @param offset 偏移数量，用于分页 , 如 : ( 页数 -1)*30, 其中 30 为 limit 的值 , 默认为 0
 * @returns 搜索结果
 */
export function cloudSearch(keywords: string, type: number = 1, limit: number = 30, offset: number = 0) {
  return request<CloudSearchResult>('/cloudsearch', {
    keywords,
    type,
    limit,
    offset
  })
}
