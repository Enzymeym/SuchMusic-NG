import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      rustAudio: any
      audioEngine: any
      ffmpegEngine: {
        create: () => Promise<{ success: boolean; engineId?: string; error?: string }>
        destroy: () => Promise<boolean>
        load: (filePath: string) => Promise<{ success: boolean; streamInfo?: any; error?: string }>
        loadData: (buffer: ArrayBuffer) => Promise<{ success: boolean; streamInfo?: any; error?: string }>
        decodeFrame: () => Promise<{ success: boolean; frame?: any; error?: string }>
        decodeAll: () => Promise<{ success: boolean; samples?: number[]; error?: string }>
        seek: (positionMs: number) => Promise<{ success: boolean; error?: string }>
        play: () => Promise<{ success: boolean; error?: string }>
        pause: () => Promise<{ success: boolean; error?: string }>
        stop: () => Promise<{ success: boolean; error?: string }>
        reset: () => Promise<{ success: boolean; error?: string }>
        getState: () => Promise<string>
        getStreamInfo: () => Promise<any | null>
        getDsdParams: () => Promise<any | null>
        isFormatSupported: (extension: string) => Promise<boolean>
        isFfmpegExclusive: (extension: string) => Promise<boolean>
        getVersion: () => Promise<string>
      }
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
      ffmpegInstaller: {
        check: () => Promise<{ success: boolean; installed: boolean; status: string; dllsFound?: string[]; missingDlls?: string[]; error?: string }>
        install: () => void
        getDir: () => Promise<{ dir: string }>
        onProgress: (callback: (progress: { status: string; downloadedBytes: number; totalBytes: number; percent: number; speedBps: number; estimatedSeconds: number; error?: string }) => void) => () => void
        onResult: (callback: (result: { success: boolean; installed: boolean; status: string; error?: string }) => void) => () => void
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
    }
  }
}
