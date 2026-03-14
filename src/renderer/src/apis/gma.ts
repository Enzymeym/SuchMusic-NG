import axios from 'axios'

const BASE_URL = 'https://gma.api.enzymeym.top'

export interface GMASong {
  id: string
  name: string
  artist: string
  album: string
  cover: string
  duration: number // seconds
  source: string
  url: string
  size?: number
  ext?: string
  is_invalid?: boolean
  link?: string
}

export interface GMAResponse<T> {
  code: number
  msg: string
  data: T
}

export interface GMAPlaylist {
  id: string
  name: string
  cover: string
  link: string
  source: string
  author?: {
    name: string
    avatar?: string
  }
  playCount?: number
  trackCount?: number
}

interface GMASearchDataRaw {
  songs: GMASong[]
  playlists: GMAPlaylist[]
}

export interface GMASearchResult {
  songs: GMASong[]
  playlists: GMAPlaylist[]
}

export const searchMusic = async (
  keyword: string,
  _page: number = 1,
  _limit: number = 30,
  sources?: string[],
  type: 'song' | 'playlist' = 'song'
): Promise<GMASearchResult> => {
  const params = new URLSearchParams()
  params.append('q', keyword)
  params.append('type', type)
  
  // 映射内部平台代码到 GMA API 代码
  const mapToApi = (s: string) => {
    switch (s) {
      case 'tx': return 'qq'
      case 'wy': return 'netease'
      case 'kg': return 'kugou'
      case 'kw': return 'kuwo'
      case 'mg': return 'migu'
      default: return s
    }
  }

  if (sources && sources.length > 0) {
    sources.forEach((s) => params.append('sources', mapToApi(s)))
  }

  let data: any
  // 优先尝试使用 Electron 代理请求绕过 CORS
  if (window.electron && window.electron.ipcRenderer) {
    try {
      // 直接将 query string 拼接到 url，避免 Object.fromEntries 导致重复 key (如 sources) 丢失
      const queryString = params.toString()
      const result = await window.electron.ipcRenderer.invoke('proxy:request', {
        url: `${BASE_URL}/api/v1/music/search?${queryString}`,
        method: 'GET'
      })
      if (result.success) {
        data = result.data
      } else {
        console.error('Proxy search failed:', result.error)
      }
    } catch (e) {
      console.error('IPC proxy invoke failed', e)
    }
  }

  // 如果代理失败或不可用，回退到普通 axios 请求 (可能遭遇 CORS)
  if (!data) {
    const res = await axios.get<GMAResponse<GMASearchDataRaw>>(`${BASE_URL}/api/v1/music/search`, {
      params
    })
    data = res.data
  }

  // 映射 GMA API 返回的平台代码到内部代码
  const mapFromApi = (s: string) => {
    switch (s) {
      case 'qq': return 'tx'
      case 'netease': return 'wy'
      case 'kugou': return 'kg'
      case 'kuwo': return 'kw'
      case 'migu': return 'mg'
      default: return s
    }
  }

  const result: GMASearchResult = { songs: [], playlists: [] }

  if (data && data.code === 200 && data.data) {
    if (Array.isArray(data.data.songs)) {
      result.songs = data.data.songs.map((song: GMASong) => ({
        ...song,
        source: mapFromApi(song.source)
      }))
    }
    if (Array.isArray(data.data.playlists)) {
      result.playlists = data.data.playlists.map((playlist: GMAPlaylist) => ({
        ...playlist,
        source: mapFromApi(playlist.source)
      }))
    }
  }
  
  return result
}

/**
 * 获取歌词 API
 * GET /api/v1/music/lyric
 * @param id 音乐 ID
 * @param source 平台
 */
export const fetchGMALyric = async (id: string, source: string): Promise<string> => {
  try {
    const params = new URLSearchParams()
    params.append('id', id)
    
    // 适配 GMA 歌词接口：内部代码 -> API 代码
    let apiSource = source
    switch (source) {
      case 'tx': apiSource = 'qq'; break;
      case 'wy': apiSource = 'netease'; break;
      case 'kg': apiSource = 'kugou'; break;
      case 'kw': apiSource = 'kuwo'; break;
      case 'mg': apiSource = 'migu'; break;
    }
    params.append('source', apiSource)

    // 直接在前端发起请求，不使用 IPC 代理
    const res = await axios.get<GMAResponse<any>>(`${BASE_URL}/api/v1/music/lyric`, {
      params
    })
    
    const data = res.data

    if (data && data.code === 200) {
      // API 返回格式可能为 { data: "lyric string" } 或 { data: { lyric: "lyric string" } }
      // 根据用户提供的日志：data: { lyric: "..." }
      if (typeof data.data === 'string') {
        return data.data
      } else if (data.data && typeof data.data.lyric === 'string') {
        return data.data.lyric
      }
      return ''
    }
    return ''
  } catch (error) {
    console.error('Failed to fetch lyric from GMA:', error)
    return ''
  }
}
