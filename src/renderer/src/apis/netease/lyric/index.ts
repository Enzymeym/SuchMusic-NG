import request from '../../../utils/request'

// 单种歌词块结构（LRC / TLYRIC / YRC 等）
export interface LyricBlock {
  version?: number
  lyric?: string
}

// 新版歌词接口完整返回结构
export interface NewLyricResponse {
  // 是否为纯音乐（无歌词）
  sgc?: boolean
  // 是否已经翻译
  sfy?: boolean
  // 是否已经罗马音
  qfy?: boolean

  // 翻译歌词上传者信息
  transUser?: {
    id?: number
    status?: number
    demand?: number
    userid?: number
    nickname?: string
    uptime?: number
  }

  // 原歌词上传者信息
  lyricUser?: {
    id?: number
    status?: number
    demand?: number
    userid?: number
    nickname?: string
    uptime?: number
  }

  // 普通 LRC 歌词
  lrc?: LyricBlock
  // 卡拉 OK 样式歌词
  klyric?: LyricBlock
  // 翻译歌词（逐行）
  tlyric?: LyricBlock
  // 罗马音歌词
  romalrc?: LyricBlock

  // 新版逐字歌词
  yrc?: LyricBlock
  // 新版逐字翻译歌词
  ytlrc?: LyricBlock
  // 新版逐字罗马音歌词
  yromalrc?: LyricBlock

  // 接口状态码
  code: number
  // 可选提示信息
  message?: string
}

/**
 * 通过 /lyric/new 接口获取歌词，支持图片中展示的所有歌词字段
 * @param id 歌曲 ID
 */
export function fetchNewLyric(id: number | string): Promise<NewLyricResponse> {
  // 统一转成字符串，避免大整数精度问题
  const songId = String(id)
  return request<NewLyricResponse>('/lyric/new', { id: songId })
}
