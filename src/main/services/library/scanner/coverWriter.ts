/**
 * 封面落盘（scanner 子进程内运行）。
 *
 * 只写文件、只回哈希，**绝不把图片字节传回主进程**：
 * 一条 200 条记录的消息若各带一张 500KB 封面，结构化克隆会瞬间复制上百 MB，
 * 两个进程各留一份峰值，Mojo 通道也吃不消。
 */
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { sniffImageMime, type CoverMime } from '../../../utils/imageSniff'

const MIME_TO_EXT: Record<CoverMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif'
}

export interface CoverRef {
  hash: string
  ext: string
}

/**
 * 按内容哈希写盘；已存在则直接复用（同专辑封面天然去重）。
 * 返回 null 表示字节不是可识别的图片，调用方按「无封面」处理。
 */
export async function writeCoverFile(
  coversDir: string,
  data: Uint8Array | undefined | null
): Promise<CoverRef | null> {
  if (!data || data.byteLength === 0) return null
  const mime = sniffImageMime(data)
  if (!mime) return null

  const hash = createHash('sha1').update(Buffer.from(data)).digest('hex').slice(0, 16)
  const ext = MIME_TO_EXT[mime]
  const target = join(coversDir, `${hash}.${ext}`)

  try {
    await fs.access(target)
    return { hash, ext }
  } catch {
    // 文件不存在，继续写
  }

  try {
    await fs.writeFile(target, Buffer.from(data))
    return { hash, ext }
  } catch (error) {
    console.warn('[scanner] 封面写盘失败:', target, error)
    return null
  }
}
