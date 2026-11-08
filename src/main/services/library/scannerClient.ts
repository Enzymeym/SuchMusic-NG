/**
 * scanner 子进程的生命周期与消息协议（主进程侧）。
 *
 * 一句约定：**主进程只负责下发 init、收批、收尾**。所有耗时解析都在子进程里，
 * 主进程在这段时间内保持完全可响应。
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import type {
  ScanProgress,
  ScannedTrack,
  ScannerCommand,
  ScannerInitPayload,
  ScannerMessage
} from '../../../shared/library/types'
import { getCoversDir } from './coverStore'
import { getNativeTagReaderPath } from '../tagReaderService'

export interface ScanDonePayload {
  deletedIds: string[]
  scanned: number
  added: number
  unchanged: number
  errors: number
  durationMs: number
}

export interface ScannerHandlers {
  onProgress?: (progress: ScanProgress) => void
  onTracks?: (tracks: ScannedTrack[]) => void
  onDone?: (payload: ScanDonePayload) => void
  onError?: (message: string) => void
}

export interface ScannerHandle {
  cancel: () => void
  /** 扫描结束（正常/失败/取消都会 resolve） */
  done: Promise<ScanDonePayload | null>
}

/** 子进程脚本路径：与 index.js 同目录（多入口产物，见 electron.vite.config.ts） */
function scannerScriptPath(): string {
  return join(__dirname, 'library-scanner.js')
}

export function startScanner(
  payload: Omit<ScannerInitPayload, 'nativePath' | 'coversDir'>,
  handlers: ScannerHandlers = {}
): ScannerHandle {
  let settled = false
  // UtilityProcess 没有 killed 属性，自己记一个，避免重复 kill
  let child: UtilityProcess | null = null
  let childKilled = false
  let settle!: (value: ScanDonePayload | null) => void
  const done = new Promise<ScanDonePayload | null>((resolve) => {
    settle = resolve
  })

  const finish = (value: ScanDonePayload | null): void => {
    if (settled) return
    settled = true
    settle(value)
    try {
      if (child && !childKilled) {
        childKilled = true
        child.kill()
      }
    } catch {
      /* ignore */
    }
  }

  try {
    child = utilityProcess.fork(scannerScriptPath(), [], {
      serviceName: 'such-music-library-scanner'
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[library] 启动扫描进程失败:', error)
    handlers.onError?.(`启动扫描进程失败：${message}`)
    finish(null)
    return { cancel: () => {}, done }
  }

  const initPayload: ScannerInitPayload = {
    ...payload,
    nativePath: getNativeTagReaderPath(),
    coversDir: getCoversDir()
  }

  const post = (command: ScannerCommand): void => {
    try {
      child?.postMessage(command)
    } catch (error) {
      console.warn('[library] 向扫描进程发消息失败:', error)
    }
  }

  child.on('message', (message: unknown) => {
    const msg = message as ScannerMessage
    if (!msg || typeof msg !== 'object') return

    switch (msg.type) {
      case 'ready':
        post({ type: 'init', payload: initPayload })
        break
      case 'progress':
        handlers.onProgress?.(msg.progress)
        break
      case 'track-batch':
        handlers.onTracks?.(msg.items)
        break
      case 'done':
        handlers.onDone?.({
          deletedIds: msg.deletedIds,
          scanned: msg.scanned,
          added: msg.added,
          unchanged: msg.unchanged,
          errors: msg.errors,
          durationMs: msg.durationMs
        })
        finish({
          deletedIds: msg.deletedIds,
          scanned: msg.scanned,
          added: msg.added,
          unchanged: msg.unchanged,
          errors: msg.errors,
          durationMs: msg.durationMs
        })
        break
      case 'error':
        console.error('[library] 扫描进程报错:', msg.message, msg.filePath ?? '')
        handlers.onError?.(msg.message)
        finish(null)
        break
      default:
        break
    }
  })

  child.on('exit', (code: number) => {
    if (settled) return
    console.warn('[library] 扫描进程退出，code =', code)
    if (code !== 0) handlers.onError?.(`扫描进程异常退出（code ${code}）`)
    finish(null)
  })

  return {
    cancel: () => {
      post({ type: 'cancel' })
      // 子进程正在同步解析大文件时可能收不到消息，给 3s 宽限后强杀
      setTimeout(() => {
        if (!settled) finish(null)
      }, 3000)
    },
    done
  }
}
