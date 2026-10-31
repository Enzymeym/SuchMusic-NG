/**
 * 封面自定义协议 `such-cover://`。
 *
 * 为什么不用 `file://` 直连：把绝对路径暴露给渲染层既不利于将来收紧
 * `webSecurity`，也没法在一个 URL 上区分「缩略图 / 原图」两种尺寸需求。
 * 协议层还能集中做内存合并（同一张图被 10 个列表项同时请求时只解码一次）。
 *
 * URL 形态（`standard:true` 要求必须带 host）：
 *   such-cover://cover/<hash>.<ext>?size=thumb|full
 */
import { nativeImage, protocol } from 'electron'
import { promises as fs } from 'fs'
import { extname } from 'path'
import { COVER_HOST, COVER_SCHEME } from '../../../shared/library/channels'
import { ensureCoverDirs, resolveCoverFile, thumbFilePath } from './coverStore'

const THUMB_SIZE = 256
const THUMB_QUALITY = 82
/** 同时生成的缩略图上限：解码+缩放是 CPU 活，并发太高会卡住主线程 */
const THUMB_CONCURRENCY = 4

/** 必须在对 app ready 之前调用，且只能调用一次 */
export function registerCoverScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: COVER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

function notFound(): Response {
  return new Response('cover not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  })
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

/**
 * 直接读盘返回原图。
 *
 * 不用 `net.fetch(pathToFileURL(file))`：那条路依赖 file: 协议在 net 栈里的可见性，
 * 一旦拿不到响应，`?size=full` 的封面就整体失效（播放页大图、SMTC 都会空）。
 * 封面都是几十 KB~几 MB 的小文件，一次读取比走一遍 URL loader 更可控。
 */
async function fileResponse(file: string): Promise<Response> {
  try {
    const data = await fs.readFile(file)
    if (data.byteLength === 0) return notFound()
    return new Response(toArrayBuffer(data), {
      headers: {
        'content-type': MIME_BY_EXT[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=31536000, immutable'
      }
    })
  } catch {
    return notFound()
  }
}

/** 同一 hash 的并发请求合并成一次生成任务 */
const thumbJobs = new Map<string, Promise<Buffer | null>>()
let activeThumbs = 0
const thumbQueue: Array<() => void> = []

async function withThumbSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeThumbs >= THUMB_CONCURRENCY) {
    await new Promise<void>((resolve) => thumbQueue.push(resolve))
  }
  activeThumbs++
  try {
    return await fn()
  } finally {
    activeThumbs--
    thumbQueue.shift()?.()
  }
}

/**
 * 生成正方形缩略图。
 *
 * 先 crop 再 resize —— `nativeImage.resize` 同时给宽高会直接拉伸变形，
 * 而封面绝大多数不是正方形。
 */
async function buildThumbnail(hash: string, sourceFile: string): Promise<Buffer | null> {
  const target = thumbFilePath(hash, THUMB_SIZE)
  try {
    const cached = await fs.readFile(target)
    if (cached.byteLength > 0) return cached
  } catch {
    // 未命中，继续生成
  }

  return withThumbSlot(async () => {
    // 等锁期间可能已被别的请求生成
    try {
      const cached = await fs.readFile(target)
      if (cached.byteLength > 0) return cached
    } catch {
      /* ignore */
    }

    const image = nativeImage.createFromPath(sourceFile)
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    if (width <= 0 || height <= 0) return null

    const side = Math.min(width, height)
    const squared =
      width === height
        ? image
        : image.crop({
            x: Math.floor((width - side) / 2),
            y: Math.floor((height - side) / 2),
            width: side,
            height: side
          })
    const resized =
      side > THUMB_SIZE ? squared.resize({ width: THUMB_SIZE, height: THUMB_SIZE, quality: 'good' }) : squared
    const buffer = resized.toJPEG(THUMB_QUALITY)
    if (!buffer || buffer.byteLength === 0) return null

    try {
      await fs.writeFile(target, buffer)
    } catch (error) {
      console.warn('[cover] 缩略图写盘失败:', target, error)
    }
    return buffer
  })
}

async function handleCoverRequest(request: Request): Promise<Response> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return notFound()
  }
  if (url.hostname !== COVER_HOST) return notFound()

  const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  const match = /^([a-f0-9]{8,64})\.([a-z0-9]{2,5})$/i.exec(name)
  if (!match) return notFound()

  const hash = match[1]
  const ext = match[2]
  const size = url.searchParams.get('size') === 'full' ? 'full' : 'thumb'

  const file = await resolveCoverFile(hash, ext)
  if (!file) return notFound()

  if (size === 'full') {
    return fileResponse(file)
  }

  const thumb = await (thumbJobs.get(hash) ??
    (() => {
      const job = buildThumbnail(hash, file).finally(() => thumbJobs.delete(hash))
      thumbJobs.set(hash, job)
      return job
    })())

  if (!thumb) {
    // 解码失败（webp/gif/bmp 的 nativeImage 支持不稳定）→ 原图兜底，绝不给 404
    return fileResponse(file)
  }

  return new Response(toArrayBuffer(thumb), {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable'
    }
  })
}

/** 必须在 app ready 之后调用 */
export function attachCoverProtocol(): void {
  void ensureCoverDirs()
  protocol.handle(COVER_SCHEME, (request) => handleCoverRequest(request))
}
