import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      rustAudio: any
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
