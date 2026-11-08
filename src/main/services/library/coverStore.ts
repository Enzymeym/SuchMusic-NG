/**
 * 封面文件仓库。
 *
 * 布局（`userData/covers/`）：
 *   <hash>.<ext>          原图，按内容 sha1 去重（同一张专辑封面全库只存一份）
 *   thumbs/<hash>@256.jpg 缩略图，首次请求时由主进程用 nativeImage 生成
 *
 * 之所以按内容哈希而不是按曲目路径命名：一张 500KB 的专辑封面在 1 万首曲库里
 * 可能被引用上千次，按路径存会直接撑爆磁盘，也会让「重启后封面全丢」的问题
 * 变成「重启后重新解码上千张图」。
 */
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const THUMB_DIR_NAME = 'thumbs'

let coversDirCache = ''
let thumbsDirCache = ''

/** 封面根目录（惰性取，`app.name` 设置之后才有效） */
export function getCoversDir(): string {
  if (!coversDirCache) coversDirCache = join(app.getPath('userData'), 'covers')
  return coversDirCache
}

export function getThumbsDir(): string {
  if (!thumbsDirCache) thumbsDirCache = join(getCoversDir(), THUMB_DIR_NAME)
  return thumbsDirCache
}

export async function ensureCoverDirs(): Promise<void> {
  await fs.mkdir(getThumbsDir(), { recursive: true })
}

/** 内容哈希：取 sha1 前 16 位，碰撞概率对本地曲库可以忽略，文件名也短 */
export function hashCoverBytes(data: Uint8Array): string {
  return createHash('sha1').update(Buffer.from(data)).digest('hex').slice(0, 16)
}

export function coverFileName(hash: string, ext: string): string {
  const safeExt = (ext || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg'
  return `${hash}.${safeExt}`
}

export function coverFilePath(hash: string, ext: string): string {
  return join(getCoversDir(), coverFileName(hash, ext))
}

export function thumbFilePath(hash: string, size = 256): string {
  return join(getThumbsDir(), `${hash}@${size}.jpg`)
}

/** 解析封面 URL 里的 hash+ext 为磁盘路径；文件不存在返回 null */
export async function resolveCoverFile(hash: string, ext: string): Promise<string | null> {
  if (!/^[a-f0-9]{8,64}$/i.test(hash)) return null
  const file = coverFilePath(hash, ext)
  try {
    const stat = await fs.stat(file)
    return stat.isFile() ? file : null
  } catch {
    return null
  }
}

/**
 * 清理没有任何曲目引用的封面文件。
 *
 * 不清理的话目录只增不减：反复重扫、编辑标签换封面都会留下孤儿。
 * @returns 删除的文件数
 */
export async function gcCovers(referenced: Set<string>): Promise<number> {
  let removed = 0
  const dirs = [getCoversDir(), getThumbsDir()]

  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (name === THUMB_DIR_NAME) continue
      const hash = name.split('.')[0].split('@')[0]
      if (referenced.has(hash)) continue
      try {
        await fs.unlink(join(dir, name))
        removed++
      } catch {
        // 被占用/已删除，忽略
      }
    }
  }
  return removed
}
