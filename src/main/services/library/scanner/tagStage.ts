/**
 * 标签读取阶段（scanner 子进程内运行）。
 *
 * 性能上有三个关键决策：
 * 1. **批量读一手标签**：优先用原生 `readMany`，一次 N-API 跨越读一批文件，
 *    数量级上的差别来自「不再有 N 次 IPC 往返 + N 次模块边界调用」。
 * 2. **封面字节就地落盘**：只把 sha1 回传，避免大对象序列化。
 * 3. **能力探测**：有些版本的 `readMany` 会忽略 `includeCover`。用首个文件
 *    同时跑 readMany / readTags 对比一次，就能判定是否需要「补一次单文件读」，
 *    避免整库重复读两遍。
 */
import type { ScannedTrack } from '../../../../shared/library/types'
import { readManyTagsWith, readTagsWith, type NativeTagReader } from '../../tagReaderCore'
import { resolveAudioMeta } from '../../audioMetaResolver'
import { writeCoverFile } from './coverWriter'
import { buildTrackFromResolved, buildTrackFromTags } from './trackBuilder'
import type { WalkedFile } from './walk'

export interface TagStageOptions {
  reader: NativeTagReader | null
  coversDir: string
  /** 单批文件数：原生 readMany 一次读多少个文件（受封面内存峰值约束） */
  nativeBatchSize: number
  /** 攒够多少条再回传一次 */
  emitSize: number
  isCancelled: () => boolean
  onProgress: (tagged: number, total: number, currentPath?: string) => void
  onTracks: (tracks: ScannedTrack[], added: number) => void
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * 探测 `readMany` 是否真的带封面。
 *
 * 判定逻辑：找一个文件同时跑 readMany 与 readTags（都带 includeCover）。
 * - readMany 有封面 → 支持
 * - readMany 没封面但 readTags 有 → 不支持，后续走「批量读文本 + 单文件补封面」
 * - 两者都没有 → 该文件本来没封面，无法判定，乐观认为支持（代价只是漏封面，
 *   而悲观会让整库多读一遍，选前者）
 */
async function probeCoverCapability(reader: NativeTagReader | null, filePath?: string): Promise<boolean> {
  if (!reader || !filePath) return false
  try {
    const [many] = await readManyTagsWith(reader, [filePath], { includeCover: true })
    if (many?.cover) return true
    const single = await readTagsWith(reader, filePath, { includeCover: true })
    if (single?.cover) {
      console.warn('[scanner] readMany 不返回封面，降级为「批量文本 + 单文件补封面」')
      return false
    }
    return true
  } catch {
    return true
  }
}

/**
 * 读取一批文件的标签并产出曲目。
 * @returns 成功产出的曲目数
 */
export async function readTagsForFiles(
  files: WalkedFile[],
  options: TagStageOptions
): Promise<{ tagged: number; errors: number }> {
  const total = files.length
  if (total === 0) return { tagged: 0, errors: 0 }

  const coverCapable = await probeCoverCapability(options.reader, files[0]?.filePath)
  let tagged = 0
  let errors = 0
  let buffer: ScannedTrack[] = []

  const flush = (): void => {
    if (buffer.length === 0) return
    options.onTracks(buffer, buffer.length)
    buffer = []
  }

  for (const batch of chunk(files, Math.max(1, options.nativeBatchSize))) {
    if (options.isCancelled()) break

    const paths = batch.map((f) => f.filePath)
    const tagsList = options.reader
      ? await readManyTagsWith(options.reader, paths, { includeCover: coverCapable })
      : batch.map(() => null)

    for (let i = 0; i < batch.length; i++) {
      if (options.isCancelled()) break
      const file = batch[i]
      const tags = tagsList[i] ?? null
      try {
        if (!tags) {
          // 原生读不了（非 Windows 平台 / 不支持的容器）→ 走完整解析链
          const meta = await resolveAudioMeta(file.filePath, {
            includeCover: true,
            coverFormat: 'raw',
            reader: options.reader
          })
          const cover = meta.coverData
            ? await writeCoverFile(options.coversDir, meta.coverData.data)
            : null
          buffer.push(buildTrackFromResolved(file, meta, cover))
        } else {
          let coverData = tags.cover?.data
          if (!coverData && !coverCapable && options.reader) {
            // readMany 不返回封面 → 单文件补读一次（只读头部，代价可控）
            const single = await readTagsWith(options.reader, file.filePath, {
              includeCover: true
            })
            coverData = single?.cover?.data
          }
          const cover = coverData ? await writeCoverFile(options.coversDir, coverData) : null
          buffer.push(buildTrackFromTags(file, tags, cover, undefined))
        }
        tagged++
      } catch (error) {
        errors++
        console.warn('[scanner] 读取标签失败:', file.filePath, error)
      }

      options.onProgress(tagged, total, file.filePath)
      if (buffer.length >= Math.max(1, options.emitSize)) flush()
    }
  }

  flush()
  return { tagged, errors }
}
