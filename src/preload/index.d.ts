import { ElectronAPI } from '@electron-toolkit/preload'

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

/** 网易云登录用户信息（含 VIP 与等级） */
export interface NeteaseLoginProfile {
  nickname: string
  userId: string
  avatarUrl?: string
  /** VIP 类型：0=无 VIP，>0 为黑胶 VIP */
  vipType?: number
  /** 黑胶 VIP 等级 */
  vipLevel?: number
  /** 账号等级 */
  level?: number
  /** 个性签名 */
  signature?: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      rustAudio: any
      analyzer: {
        getWasmBinary: () => Promise<Uint8Array | null>
      }
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
      wasapi: {
        enumerateDevices: () => Promise<{ success: boolean; devices?: any[]; error?: string }>
        create: (sampleRate: number, channels: number, mode: 'Shared' | 'Exclusive', deviceId?: string) =>
          Promise<{ success: boolean; engineId?: string; deviceName?: string; mode?: string; error?: string }>
        destroy: (engineId: string) => Promise<{ success: boolean; error?: string }>
        start: (engineId: string) => Promise<{ success: boolean; error?: string }>
        stop: (engineId: string) => Promise<{ success: boolean; error?: string }>
        outputAudio: (engineId: string, data: number[], channels: number, sampleRate: number) =>
          Promise<{ success: boolean; error?: string }>
        flush: (engineId: string) => Promise<{ success: boolean; error?: string }>
        getState: (engineId: string) => Promise<{
          success: boolean; isRunning?: boolean; isReady?: boolean;
          mode?: string; deviceName?: string; position?: number; error?: string
        }>
        getVersion: () => Promise<{ success: boolean; version?: string; error?: string }>
      }
      netease: {
        search: (keywords: string, offset?: number, limit?: number) => Promise<{
          songs: NeteaseSong[]
          hasMore: boolean
          total: number
        }>
        songUrl: (ids: number[], quality?: string) => Promise<Record<number, string>>
        hotSearch: () => Promise<{ searchWord: string; iconUrl?: string }[]>
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
      }
      updater: {
        check: (channel: 'stable' | 'beta') => Promise<any>
        download: (url: string) => Promise<any>
        install: (filePath?: string) => Promise<any>
        getCurrentVersion: () => Promise<string>
        cleanup: () => Promise<any>
        onProgress: (callback: (progress: { downloaded: number; total: number; percent: number; speed: number }) => void) => void
        offProgress: (callback: (progress: { downloaded: number; total: number; percent: number; speed: number }) => void) => void
        onAutoCheckResult: (callback: (result: any) => void) => void
        offAutoCheckResult: (callback: (result: any) => void) => void
      }
      plugins: {
        load: (filePath: string) => Promise<{ success: boolean; manifest?: any; state?: string; error?: string }>
        remove: (pluginId: string) => Promise<{ success: boolean; error?: string }>
        setActive: (pluginId: string | null) => Promise<{ success: boolean; error?: string }>
        call: (pluginId: string, methodName: string, ...args: any[]) => Promise<{ success: boolean; result?: any; error?: string }>
        checkUpdate: (pluginId: string) => Promise<{ success: boolean; result?: any; error?: string }>
        list: () => Promise<{ success: boolean; plugins?: any[] }>
        selectFile: () => Promise<{ success: boolean; filePath?: string; canceled?: boolean }>
        selectDirectory: () => Promise<{ success: boolean; filePath?: string; canceled?: boolean }>
        onNotice: (callback: (data: any) => void) => () => void
        onLog: (callback: (level: string, ...args: any[]) => void) => () => void
        onConfirmRequest: (callback: (request: any) => void) => () => void
        onBatchConfirmRequest: (callback: (request: any) => void) => () => void
        respondConfirm: (response: { requestId: string; confirmed: boolean; skipSession: boolean }) => Promise<void>
        respondBatchConfirm: (response: { requestId: string; confirmed: boolean; rejectedOpIds?: string[]; skipSession: boolean }) => Promise<void>
        onEmit: (callback: (data: { pluginId: string; eventName: string; args: any[] }) => void) => () => void
        onPropsChanged: (callback: (data: { pluginId: string; props: Record<string, any> }) => void) => () => void
        onPlaylistOp: (callback: (request: any) => void) => () => void
        respondPlaylistOp: (response: { requestId: string; success: boolean; error?: string; result?: any }) => Promise<void>
      }
    }
  }
}
