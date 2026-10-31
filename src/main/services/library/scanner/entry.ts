/**
 * scanner 子进程入口（由主进程 `utilityProcess.fork` 启动）。
 *
 * 为什么值得单开一个进程：单文件解析里的原生 `readTags` 是**同步** N-API 调用，
 * 放在 `ipcMain.handle` 里会直接堵住主进程事件循环 —— 托盘、SMTC、窗口消息
 * 在整库扫描期间全部卡住。挪到子进程后，主进程只负责「收批 → 写库」。
 *
 * 职责边界：
 * - 本进程 **不碰 SQLite**（多进程写同一个库会撞 WAL 锁），只做遍历 / 解析 / 落封面文件；
 * - 也不做任何目录猜测：原生模块路径由主进程通过 init 消息传入。
 */
import type {
  ScannerCommand,
  ScannerInitPayload,
  ScannerMessage,
  ScannedTrack
} from '../../../../shared/library/types'
import { pathKey, toPosixPath } from '../../../../shared/library/normalize'
import { loadTagReaderFromPath } from '../../tagReaderCore'
import { walkRoots, type WalkedFile } from './walk'
import { readTagsForFiles } from './tagStage'

interface ParentPortLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

// utilityProcess 里 `process.parentPort` 一定存在；主进程上下文里它是 null
const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort

if (!parentPort) {
  console.error('[scanner] 该文件只能在 utilityProcess 中运行')
  process.exit(1)
}

let cancelled = false
let running = false
let lastProgressAt = 0

function send(message: ScannerMessage): void {
  try {
    parentPort!.postMessage(message)
  } catch (error) {
    console.error('[scanner] 消息发送失败:', error)
  }
}

function reportProgress(
  phase: 'walk' | 'tags' | 'finalize',
  scanned: number,
  tagged: number,
  total: number | undefined,
  currentPath?: string,
  force = false
): void {
  const now = Date.now()
  if (!force && now - lastProgressAt < 250) return
  lastProgressAt = now
  send({ type: 'progress', progress: { phase, scanned, tagged, total, currentPath } })
}

async function runScan(payload: ScannerInitPayload): Promise<void> {
  const startedAt = Date.now()

  const known = new Map<string, { size: number; mtimeMs: number }>()
  for (const [id, size, mtimeMs] of payload.known) {
    known.set(id, { size, mtimeMs })
  }

  const seen = new Set<string>()
  const changed: WalkedFile[] = []
  let scanned = 0
  let unchanged = 0

  const walkResult = await walkRoots({
    roots: payload.roots,
    isCancelled: () => cancelled,
    onFile: (file) => {
      const id = pathKey(file.filePath)
      if (seen.has(id)) return
      seen.add(id)
      scanned++
      const prev = known.get(id)
      if (prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs) {
        unchanged++
        return
      }
      changed.push(file)
    },
    onDir: () => reportProgress('walk', scanned, 0, undefined)
  })

  reportProgress('walk', scanned, 0, changed.length, undefined, true)

  let tagged = 0
  let tagErrors = 0
  if (!cancelled && changed.length > 0) {
    const reader = loadTagReaderFromPath(payload.nativePath)
    const result = await readTagsForFiles(changed, {
      reader,
      coversDir: payload.coversDir,
      nativeBatchSize: payload.batchSize,
      emitSize: payload.batchSize * 4,
      isCancelled: () => cancelled,
      onProgress: (done, total, currentPath) =>
        reportProgress('tags', scanned, done, total, currentPath),
      onTracks: (tracks: ScannedTrack[]) => {
        send({ type: 'track-batch', items: tracks })
      }
    })
    tagged = result.tagged
    tagErrors = result.errors
  }

  reportProgress('finalize', scanned, tagged, changed.length, undefined, true)

  /**
   * 差集删除只在「完整走完」时才可靠。
   * 中途取消或某个根整体跳过时若照样算差集，会把整库当成「已删除」清空。
   */
  let deletedIds: string[] = []
  if (!cancelled) {
    const skipped = new Set(walkResult.skippedRoots.map((r) => toPosixPath(r).replace(/\/+$/, '')))
    const activeRoots = payload.roots
      .map((r) => toPosixPath(r).replace(/\/+$/, ''))
      .filter((r) => !skipped.has(r))
    if (activeRoots.length > 0) {
      for (const id of known.keys()) {
        if (seen.has(id)) continue
        if (activeRoots.some((root) => id === root || id.startsWith(`${root}/`))) {
          deletedIds.push(id)
        }
      }
    }
  }

  send({
    type: 'done',
    deletedIds,
    scanned,
    added: changed.length,
    unchanged,
    errors: walkResult.errors + tagErrors,
    durationMs: Date.now() - startedAt
  })
}

parentPort.on('message', (event) => {
  const command = event?.data as ScannerCommand | undefined
  if (!command || typeof command !== 'object') return

  if (command.type === 'cancel') {
    cancelled = true
    return
  }

  if (command.type === 'init') {
    if (running) return
    running = true
    void runScan(command.payload)
      .catch((error) => {
        send({
          type: 'error',
          message: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        running = false
      })
  }
})

send({ type: 'ready' })
