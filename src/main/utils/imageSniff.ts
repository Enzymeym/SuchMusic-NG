/**
 * 封面图片的魔数嗅探与最终裁决。
 *
 * 音频标签里声明的图片 MIME 经常是空串、`image/jpg`、`application/octet-stream`
 * 这类脏值（APEv2 甚至只存文件名）。渲染层 `base64ToBlobUrl` 会用这个值构造
 * `new Blob([...], { type })`：type 不可渲染时 `<img>` 与 `createImageBitmap`
 * 都可能直接失败，最终表现成「这首歌没有封面」。
 *
 * 因此封面数据离开主进程之前，必须在这里统一裁决一次 —— 三个解析器
 * （native / music-metadata / 手动嗅探）内部一律不再各自判断 MIME。
 */

export type CoverMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/gif'
  | 'image/bmp'
  | 'image/avif'

/** 允许通过裁决的 MIME（Chromium 都能渲染） */
const ALLOWED_MIMES: ReadonlySet<string> = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif'
])

/** 常见的大小写/别名写法归一化（PNG 的官方别名是 image/apng，这里只认最常用的） */
const MIME_ALIASES: Record<string, CoverMime> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-ms-bmp': 'image/bmp',
  'image/x-bmp': 'image/bmp'
}

/** 魔数判定只需要前 12 字节（AVIF 的 ftyp 需要在 offset 8 处读 4 字节） */
const SNIFF_BYTES = 16

function matchesAscii(buf: Uint8Array, offset: number, ascii: string): boolean {
  if (offset + ascii.length > buf.length) return false
  for (let i = 0; i < ascii.length; i++) {
    if (buf[offset + i] !== ascii.charCodeAt(i)) return false
  }
  return true
}

/**
 * 按魔数判定图片格式。
 * @param buf 图片数据（只看前 16 字节）
 * @returns 识别出的 MIME，无法识别返回 null
 */
export function sniffImageMime(buf: Uint8Array | undefined | null): CoverMime | null {
  if (!buf || buf.length < 12) return null
  const head = buf.length > SNIFF_BYTES ? buf.subarray(0, SNIFF_BYTES) : buf

  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return 'image/png'
  }
  // GIF87a / GIF89a
  if (matchesAscii(head, 0, 'GIF8')) return 'image/gif'
  // BMP: 'BM'
  if (matchesAscii(head, 0, 'BM')) return 'image/bmp'
  // WebP: 'RIFF' + 4 字节长度 + 'WEBP'
  if (matchesAscii(head, 0, 'RIFF') && matchesAscii(head, 8, 'WEBP')) return 'image/webp'
  // AVIF: 4 字节 box 长度 + 'ftyp' + 'avif' / 'avis'
  if (matchesAscii(head, 4, 'ftyp') && matchesAscii(head, 8, 'avif')) return 'image/avif'
  if (matchesAscii(head, 4, 'ftyp') && matchesAscii(head, 8, 'avis')) return 'image/avif'

  return null
}

/** 把声明的 MIME 归一化成允许集内的值；不在允许集返回 null */
function normalizeDeclaredMime(declared: string | undefined): CoverMime | null {
  if (!declared) return null
  // 去掉 "; charset=..." 之类的参数，并统一小写
  const base = declared.split(';')[0].trim().toLowerCase()
  if (!base) return null
  const alias = MIME_ALIASES[base]
  if (alias) return alias
  return ALLOWED_MIMES.has(base) ? (base as CoverMime) : null
}

/**
 * 裁决封面 MIME。
 *
 * 优先级：魔数（唯一可靠的事实）> 声明值（仅当它在允许集内）> 丢弃。
 */
export function resolveCoverMime(
  declared: string | undefined,
  buf: Uint8Array | undefined | null
): CoverMime | null {
  const sniffed = sniffImageMime(buf)
  if (sniffed) return sniffed
  return normalizeDeclaredMime(declared)
}

export interface NormalizedCover {
  mimeType: CoverMime
  base64: string
  bytes: number
}

/** 不编码 base64 的裁决结果：曲库扫描直接拿裸字节落盘，省掉一次编码/解码往返 */
export interface NormalizedCoverRaw {
  mimeType: CoverMime
  data: Uint8Array
  bytes: number
}

/** 低于此值的一律视为畸形封面（只有帧头、没有图像数据） */
export const COVER_MIN_BYTES = 256

/**
 * 轻量预校验：不编码 base64，只判断"这段字节值得当成封面候选吗"。
 *
 * 解析编排里用它决定「是否还需要向其它解析器求证」——若把一个 12 字节的
 * 畸形 APIC 当成有效封面，就会跳过后面的回退，最终在出口被丢弃、整首歌没图。
 */
export function isUsableCoverData(data: Uint8Array | undefined | null): boolean {
  if (!data || data.length < COVER_MIN_BYTES) return false
  return sniffImageMime(data) !== null
}

/**
 * 封面数据的最终出口：MIME 裁决 + 大小闸门 + 一次性 base64。
 *
 * @param declared 标签里声明的 MIME（可能为空/非法）
 * @param data 原始图片字节
 * @param opts.minBytes 低于此值判为畸形封面并丢弃（默认 256，滤掉只有帧头的空 APIC）
 * @param opts.maxBytes 高于此值丢弃（默认 16MB，避免异常数据撑爆 IPC）
 * @returns 通过校验的封面；不通过返回 null，调用方应换下一个候选
 */
export function finalizeCover(
  declared: string | undefined,
  data: Uint8Array | undefined | null,
  opts?: { minBytes?: number; maxBytes?: number }
): NormalizedCover | null {
  const raw = finalizeCoverRaw(declared, data, opts)
  if (!raw) return null
  return {
    mimeType: raw.mimeType,
    base64: Buffer.from(raw.data).toString('base64'),
    bytes: raw.bytes
  }
}

/**
 * 与 `finalizeCover` 同一套裁决，但只返回裸字节。
 *
 * 曲库扫描把封面按内容哈希写进 `userData/covers/`，全程不需要 base64：
 * 1 万首曲库若每张封面都编码一次再解码，纯属把 CPU 和内存浪费在中间态上。
 */
export function finalizeCoverRaw(
  declared: string | undefined,
  data: Uint8Array | undefined | null,
  opts?: { minBytes?: number; maxBytes?: number }
): NormalizedCoverRaw | null {
  if (!data || data.length === 0) return null
  const minBytes = opts?.minBytes ?? COVER_MIN_BYTES
  const maxBytes = opts?.maxBytes ?? 16 * 1024 * 1024
  if (data.length < minBytes || data.length > maxBytes) return null

  const mimeType = resolveCoverMime(declared, data)
  if (!mimeType) return null

  return { mimeType, data, bytes: data.length }
}
