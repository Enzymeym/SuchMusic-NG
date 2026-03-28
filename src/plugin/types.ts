export interface PluginInfo {
  name: string
  version: string
  author: string
  description?: string
  [key: string]: any
}

export interface PluginSource {
  name: string
  qualities: string[]
  [key: string]: any
}

export interface MusicItem {
  id: number | string
  name: string
  singer: string
  source: string
  interval: string | null
  metaData: any
  quality?: any
  [key: string]: any
}

export interface MusicInfo extends MusicItem {
  id: string
}

export interface SourceHandler {
  musicUrl: (musicId: string, quality?: string) => Promise<string>
  search: (query: string, page: number, limit: number) => Promise<any>
  getPic?: (musicId: string) => Promise<string>
  getLyric?: (musicId: string) => Promise<string>
  [key: string]: any
}

export interface SuchPluginNew {
  name: string
  version: string
  author: string
  source: string[]
  search: (source: string, query: string, page: number, limit: number) => Promise<any>
  getMusicUrl: (source: string, musicId: string, quality?: string) => Promise<string>
  checkUpdate?: () => Promise<any>
  getPic?: (source: string, musicId: string) => Promise<string>
  getLyric?: (source: string, musicId: string) => Promise<string>
  [key: string]: any
}

// 旧版插件接口
export interface SuchMusicPlugin {
  pluginInfo: PluginInfo
  sources: PluginSource[]
  musicUrl: (source: string, musicInfo: MusicInfo, quality: string) => Promise<string>
  getPic?: (source: string, musicInfo: MusicInfo) => Promise<string>
  getLyric?: (source: string, musicInfo: MusicInfo) => Promise<string>
}
