import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  FolderPatch,
  FolderTracksQuery,
  LibraryBootstrap,
  LibraryFolder,
  LibraryTrack,
  ScanProgress,
  ScanStats
} from '../../shared/library/types'

/** 扫描结束事件载荷 */
export interface LibraryScanDoneEvent {
  ok: boolean
  stats?: ScanStats
  lastScanAt?: number
  error?: string
}

/** 网易云归一化歌曲结构（渲染层可直接喂给 SongList） */
export interface NeteaseSong {
  id: number
  name: string
  ar: { id: number; name: string }[]
  al: { id: number; name: string; picUrl: string }
  dt: number
  mv: number
  fee: number
  source: 'netease'
}

/** 网易云歌单摘要（导入列表用） */
export interface NeteasePlaylistSummary {
  id: number
  name: string
  cover: string
  trackCount: number
  description?: string
}

/** 网易云歌手详情（歌手详情页头部） */
export interface NeteaseArtistDetail {
  id: number
  name: string
  cover: string
  briefDesc: string
  musicSize: number
  albumSize: number
  followed: boolean
}

/** 网易云歌手专辑 */
export interface NeteaseArtistAlbum {
  id: number
  name: string
  cover: string
  size: number
  publishTime: number
}

/** 网易云登录用户信息（含 VIP 与等级） */export interface NeteaseLoginProfile {
  nickname: string
  userId: string
  avatarUrl?: string
  /** VIP 类型（位标志）：0=无，1=仅音乐包，10/100/110=黑胶（11=黑胶+音乐包） */
  vipType?: number
  /** 黑胶 VIP 等级 */
  vipLevel?: number
  /** 账号等级 */
  level?: number
  /** 个性签名 */
  signature?: string
}

/** 系统媒体控制状态 */
export interface MediaControlStatus {
  title?: string
  artist?: string
  album?: string
  /** data: | http(s): | file: | 本地绝对文件路径 | blob:(渲染层先转 data:) */
  cover?: string
  durationMs?: number
  playing: boolean
  positionMs?: number
}

/** 系统媒体控制命令 */
export type MediaControlCommand =
  'play' | 'pause' | 'toggle' | 'next' | 'prev' | 'stop' | 'seek' | 'seekRelative' | 'setVolume'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      rustAudio: any
      memory: {
        getReport: () => Promise<{
          current: {
            t: number
            rss: number
            heapTotal: number
            heapUsed: number
            external: number
            arrayBuffers: number
            processes: Array<{ pid: number; type: string; rss: number; cpu: number }>
            totalProcesses: number
          } | null
          min: number
          max: number
          avg: number
          count: number
          durationMs: number
        }>
      }
      audioEngine: any
      /** 本地曲库（SQLite）与文件夹歌单 */
      library: {
        bootstrap: () => Promise<LibraryBootstrap>
        scan: (roots?: string[]) => Promise<{ started: boolean; jobId: string }>
        cancelScan: () => Promise<unknown>
        folderTracks: (folderId: number, options?: FolderTracksQuery) => Promise<LibraryTrack[]>
        folderChildren: (parentPath: string) => Promise<LibraryFolder[]>
        updateFolder: (folderId: number, patch: FolderPatch) => Promise<LibraryFolder | null>
        reloadTracks: (filePaths: string[]) => Promise<{ updated: number }>
        reveal: (filePath: string) => Promise<boolean>
        onScanProgress: (callback: (progress: ScanProgress) => void) => () => void
        onScanDone: (callback: (event: LibraryScanDoneEvent) => void) => () => void
      }
      wasapi: {
        enumerateDevices: () => Promise<{ success: boolean; devices?: any[]; error?: string }>
        create: (
          sampleRate: number,
          channels: number,
          mode: 'Shared' | 'Exclusive',
          deviceId?: string
        ) => Promise<{
          success: boolean
          engineId?: string
          deviceId?: string | null
          deviceName?: string
          mode?: string
          error?: string
        }>
        destroy: (engineId: string) => Promise<{ success: boolean; error?: string }>
        start: (engineId: string) => Promise<{ success: boolean; error?: string }>
        stop: (engineId: string) => Promise<{ success: boolean; error?: string }>
        outputAudio: (
          engineId: string,
          data: number[],
          channels: number,
          sampleRate: number
        ) => Promise<{ success: boolean; error?: string }>
        flush: (engineId: string) => Promise<{ success: boolean; error?: string }>
        getState: (engineId: string) => Promise<{
          success: boolean
          isRunning?: boolean
          isReady?: boolean
          mode?: string
          deviceName?: string
          position?: number
          error?: string
        }>
        getVersion: () => Promise<{ success: boolean; version?: string; error?: string }>
      }
      netease: {
        search: (
          keywords: string,
          offset?: number,
          limit?: number
        ) => Promise<{
          songs: NeteaseSong[]
          hasMore: boolean
          total: number
        }>
        songUrl: (
          ids: number[],
          quality?: string,
          refresh?: boolean
        ) => Promise<Record<number, string>>
        hotSearch: () => Promise<{ searchWord: string; iconUrl?: string }[]>
        suggest: (keywords: string) => Promise<string[]>
        loginQr: () => Promise<{ unikey: string; qrimg: string }>
        loginQrCheck: (unikey: string) => Promise<{
          code: number
          profile?: NeteaseLoginProfile
        }>
        loginStatus: () => Promise<{
          loggedIn: boolean
          profile?: NeteaseLoginProfile
          accounts: NeteaseLoginProfile[]
          activeUserId: string
        }>
        switchAccount: (userId: string) => Promise<{
          loggedIn: boolean
          profile?: NeteaseLoginProfile
          accounts: NeteaseLoginProfile[]
          activeUserId: string
        }>
        logout: (userId?: string) => Promise<void>
        playlistDetail: (id: number) => Promise<NeteasePlaylistSummary | null>
        playlistTracks: (id: number) => Promise<NeteaseSong[]>
        userPlaylists: () => Promise<NeteasePlaylistSummary[]>
        /** 每日推荐歌曲（未登录时返回公共口味推荐） */
        dailySongs: () => Promise<NeteaseSong[]>
        /** 首页专属歌单（推荐歌单，登录后按账号口味） */
        recommendPlaylists: (limit?: number) => Promise<NeteasePlaylistSummary[]>
        /** 歌手详情（搜索页点击歌手名进入） */
        artistDetail: (id: number) => Promise<NeteaseArtistDetail | null>
        /** 歌手歌曲（分页，单页上限 200） */
        artistSongs: (
          id: number,
          offset?: number,
          limit?: number
        ) => Promise<{ songs: NeteaseSong[]; hasMore: boolean }>
        /** 歌手专辑（分页） */
        artistAlbums: (
          id: number,
          offset?: number,
          limit?: number
        ) => Promise<{ albums: NeteaseArtistAlbum[]; hasMore: boolean }>
        /** 专辑全部曲目（歌手页点击专辑按需拉取） */
        albumTracks: (id: number) => Promise<NeteaseSong[]>
      }
      cache: {
        getInfo: () => Promise<{
          dir: string
          isDefault: boolean
          fileCount: number
          totalSize: number
          maxSize: number
        }>
        setDir: (dir: string) => Promise<{ success: boolean; dir: string }>
        clear: () => Promise<{ success: boolean; removedCount: number; removedSize: number }>
      }
      mediaControl: {
        update: (status: MediaControlStatus) => void
        getStatus: () => Promise<MediaControlStatus>
        onCommand: (cb: (payload: { command: MediaControlCommand; value?: number }) => void) => void
        offCommand: (
          cb: (payload: { command: MediaControlCommand; value?: number }) => void
        ) => void
      }
      updater: {
        check: (channel: 'stable' | 'beta') => Promise<any>
        download: (url: string) => Promise<any>
        install: (filePath?: string) => Promise<any>
        getCurrentVersion: () => Promise<string>
        cleanup: () => Promise<any>
        onProgress: (
          callback: (progress: {
            downloaded: number
            total: number
            percent: number
            speed: number
          }) => void
        ) => void
        offProgress: (
          callback: (progress: {
            downloaded: number
            total: number
            percent: number
            speed: number
          }) => void
        ) => void
      }
      plugins: {
        /** 已安装的 v2 插件 */
        list: () => Promise<{
          success: boolean
          plugins?: import('../shared/plugin/types').V2PluginSummary[]
          error?: string
        }>
        selectFile: () => Promise<{ success: boolean; filePath?: string; canceled?: boolean }>
        /** 仅解析插件头（安装前预览） */
        inspect: (filePath: string) => Promise<{
          success: boolean
          header?: import('../shared/plugin/types').SuchPluginHeader
          hostId?: string
          warnings?: string[]
          error?: string
        }>
        install: (filePath: string) => Promise<{
          success: boolean
          plugin?: import('../shared/plugin/types').V2PluginSummary
          error?: string
        }>
        /** 统一导入：自动识别 v2 / 洛雪 / 澜音 */
        importFile: (filePath: string) => Promise<{
          success: boolean
          kind?: 'v2' | 'lx' | 'ceru'
          plugin?: import('../shared/plugin/types').V2PluginSummary
          info?: any
          error?: string
        }>
        remove: (pluginId: string) => Promise<{ success: boolean; error?: string }>
        setEnabled: (
          pluginId: string,
          enabled: boolean
        ) => Promise<{
          success: boolean
          plugin?: import('../shared/plugin/types').V2PluginSummary
          error?: string
        }>
        reload: (pluginId: string) => Promise<{
          success: boolean
          plugin?: import('../shared/plugin/types').V2PluginSummary
          error?: string
        }>
        checkUpdate: (pluginId: string) => Promise<{
          success: boolean
          result?: { hasNew: boolean; version?: string; url?: string; changelog?: string }
          error?: string
        }>
        getSettings: (pluginId: string) => Promise<{
          success: boolean
          schema?: import('../shared/plugin/types').SettingField[]
          values?: Record<string, any>
          error?: string
        }>
        setSetting: (
          pluginId: string,
          key: string,
          value: any
        ) => Promise<{ success: boolean; values?: Record<string, any>; error?: string }>
        getLogs: (
          pluginId: string,
          limit?: number
        ) => Promise<{
          success: boolean
          entries?: import('../shared/plugin/types').PluginLogEntry[]
          error?: string
        }>
        clearLogs: (pluginId: string) => Promise<{ success: boolean; error?: string }>

        onNotice: (callback: (data: any) => void) => () => void
        onLog: (callback: (level: string, ...args: any[]) => void) => () => void
        onBatchConfirmRequest: (callback: (request: any) => void) => () => void
        respondBatchConfirm: (response: {
          requestId: string
          confirmed: boolean
          rejectedOpIds?: string[]
          skipSession: boolean
        }) => Promise<void>
        onPlaylistOp: (callback: (request: any) => void) => () => void
        respondPlaylistOp: (response: {
          requestId: string
          success: boolean
          error?: string
          result?: any
        }) => Promise<void>
      }
      sources: {
        list: () => Promise<{ success: boolean; plugins?: any[] }>
        selectFile: () => Promise<{ success: boolean; filePath?: string; canceled?: boolean }>
        inspect: (filePath: string) => Promise<{
          success: boolean
          kind?: 'lx' | 'ceru'
          name?: string
          version?: string
          error?: string
        }>
        load: (filePath: string) => Promise<{ success: boolean; info?: any; error?: string }>
        remove: (pluginId: string) => Promise<{ success: boolean; error?: string }>
        setEnabled: (
          pluginId: string,
          enabled: boolean
        ) => Promise<{
          success: boolean
          info?: any
          error?: string
        }>
        setPreferences: (
          pluginId: string,
          patch: { sources?: string[] | null; quality?: string | null }
        ) => Promise<{ success: boolean; settings?: any; info?: any; error?: string }>
        /** 可搜索来源目录（v2 插件的 musicSearch 源 + 澜音 provider） */
        listSources: () => Promise<{
          success: boolean
          sources?: import('../shared/plugin/types').SearchSource[]
          error?: string
        }>
        search: (
          req: any
        ) => Promise<{
          success: boolean
          items?: any[]
          nextCursor?: string
          hasMore?: boolean
          totalEstimate?: number
          error?: string
        }>
        resolveUrl: (req: any) => Promise<{
          success: boolean
          result?: any
          error?: string
          /** NO_PLUGIN / PLUGIN_DISABLED / PLUGIN_ERROR / UNSUPPORTED_ACTION / RESOLVE_FAILED */
          code?: string
        }>
        lyric: (req: any) => Promise<{ success: boolean; result?: any; error?: string }>
        pic: (req: any) => Promise<{ success: boolean; result?: any; error?: string }>
        playlistCategories: (
          pluginId: string
        ) => Promise<{ success: boolean; items?: any[]; error?: string }>
        playlistSearch: (req: any) => Promise<{
          success: boolean
          items?: any[]
          nextCursor?: string
          error?: string
        }>
        playlistList: (req: any) => Promise<{
          success: boolean
          items?: any[]
          nextCursor?: string
          error?: string
        }>
        playlistGet: (req: any) => Promise<{
          success: boolean
          items?: any[]
          nextCursor?: string
          meta?: any
          error?: string
        }>
        qqSearch: (
          query: string,
          limit?: number,
          offset?: number
        ) => Promise<{
          success: boolean
          items?: any[]
          total?: number
          hasMore?: boolean
          error?: string
        }>
        onNotice: (callback: (data: any) => void) => () => void
      }
    }
  }
}
