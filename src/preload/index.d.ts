import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      rustAudio: any
      audioEngine: any
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
