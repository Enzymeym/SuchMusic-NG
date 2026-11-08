/**
 * 递归目录遍历（scanner 子进程内运行）。
 *
 * 三个硬约束：
 * 1. **扇出有上限**：目录队列 + 固定 worker 数，而不是 `Promise.all(子目录)`。
 *    后者在深/宽目录树上会瞬间产生上千个并发 readdir，每个未完成的 Dirent[]
 *    都要驻留内存。
 * 2. **不跟随符号链接**：防环（`~/Music/link -> ~`）与跨卷遍历。
 * 3. **单目录失败不中断**：无权限、文件被删、路径过长都只记一条错误。
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { toPosixPath } from '../../../../shared/library/normalize'
import { extNameOf, isAudioFileName, isExcludedDirName } from '../paths'

export interface WalkedFile {
  filePath: string
  fileName: string
  folderPath: string
  rootPath: string
  relDir: string
  size: number
  mtimeMs: number
}

export interface WalkResult {
  scanned: number
  errors: number
  /** 单个根是否因为不存在/无权限而整体跳过 */
  skippedRoots: string[]
}

export interface WalkOptions {
  roots: string[]
  concurrency?: number
  /** 每处理一个音频文件回调一次（同步，避免回调里挂异步导致背压失控） */
  onFile: (file: WalkedFile) => void
  /** 每遍历完一个目录回调一次，用于刷新进度 */
  onDir?: (dirCount: number) => void
  isCancelled: () => boolean
}

interface QueueItem {
  dir: string
  root: string
}

function relativeToRoot(dir: string, root: string): string {
  if (dir === root) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  return dir.startsWith(prefix) ? dir.slice(prefix.length) : ''
}

export async function walkRoots(options: WalkOptions): Promise<WalkResult> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, 32))
  const result: WalkResult = { scanned: 0, errors: 0, skippedRoots: [] }

  const queue: QueueItem[] = []
  for (const root of options.roots) {
    const posixRoot = toPosixPath(root).replace(/\/+$/, '')
    if (!posixRoot) continue
    try {
      const stat = await fs.stat(posixRoot)
      if (!stat.isDirectory()) {
        result.skippedRoots.push(root)
        continue
      }
      queue.push({ dir: posixRoot, root: posixRoot })
    } catch {
      result.skippedRoots.push(root)
    }
  }

  const processDir = async (item: QueueItem): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(item.dir, { withFileTypes: true })
    } catch {
      result.errors++
      return
    }
    if (options.isCancelled()) return

    const tasks: Array<Promise<void>> = []
    for (const entry of entries) {
      if (options.isCancelled()) return
      const full = toPosixPath(join(item.dir, entry.name))

      // 符号链接一律跳过：既防环，也避免把外接盘/网络盘整卷拖进来
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        if (isExcludedDirName(entry.name)) continue
        queue.push({ dir: full, root: item.root })
        continue
      }
      if (!entry.isFile()) continue
      if (!isAudioFileName(entry.name)) continue

      tasks.push(
        (async () => {
          try {
            const stat = await fs.stat(full)
            if (!stat.isFile()) return
            result.scanned++
            options.onFile({
              filePath: full,
              fileName: entry.name,
              folderPath: item.dir,
              rootPath: item.root,
              relDir: relativeToRoot(item.dir, item.root),
              size: stat.size,
              mtimeMs: Math.round(stat.mtimeMs)
            })
          } catch {
            result.errors++
          }
        })()
      )
    }
    if (tasks.length > 0) await Promise.all(tasks)
  }

  let dirCount = 0
  let active = 0

  await new Promise<void>((resolve) => {
    const pump = (): void => {
      if (options.isCancelled()) {
        if (active === 0) resolve()
        return
      }
      const item = queue.shift()
      if (!item) {
        if (active === 0) resolve()
        return
      }
      active++
      void processDir(item)
        .catch(() => {
          result.errors++
        })
        .finally(() => {
          active--
          dirCount++
          options.onDir?.(dirCount)
          pump()
        })
    }
    for (let i = 0; i < concurrency; i++) pump()
  })

  return result
}

/** 标签里没有编码信息时，按扩展名给一个可读的兜底 */
export function guessCodec(fileName: string): string | undefined {
  switch (extNameOf(fileName)) {
    case '.mp3':
      return 'MP3'
    case '.flac':
      return 'FLAC'
    case '.wav':
      return 'WAV'
    case '.m4a':
    case '.mp4':
    case '.m4b':
    case '.aac':
      return 'AAC'
    case '.ogg':
      return 'OGG'
    case '.opus':
      return 'Opus'
    case '.ape':
      return 'APE'
    case '.wv':
      return 'WavPack'
    case '.aiff':
    case '.aif':
      return 'AIFF'
    default:
      return undefined
  }
}
