/**
 * 封面图与 Blob URL 相关的纯函数。
 *
 * 从 `stores/localMusicStore` 抽出（原实现内联在 store 里），供列表、最近播放等
 * 多个场景复用，避免各处重复实现导致 blob URL 泄漏。
 */

/**
 * 将 base64 封面转换为 Blob URL。
 * Blob URL 是短引用字符串（~50 字节），避免 100–300KB 的 base64 常驻响应式内存。
 * @returns 失败返回空字符串
 */
export function base64ToBlobUrl(base64: string, mimeType: string): string {
  try {
    const binaryStr = atob(base64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }
    return URL.createObjectURL(new Blob([bytes], { type: mimeType || 'image/jpeg' }))
  } catch {
    return ''
  }
}

/**
 * 将图片 Blob URL 缩小为正方形缩略图 Blob URL（WebP，失败回退 JPEG）。
 *
 * 列表封面显示仅几十像素，若直接用原图（可能 1000×1000+）按原尺寸解码，
 * 每张位图可达数 MB；缩略图后仅 ~size×size。
 * @returns 失败返回空字符串（调用方回退到原图）
 */
export async function createThumbnailBlobUrl(
  src: string,
  size = 128,
  quality = 0.82
): Promise<string> {
  try {
    const res = await fetch(src)
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) return ''
      const side = Math.min(bmp.width, bmp.height)
      ctx.drawImage(
        bmp,
        (bmp.width - side) / 2,
        (bmp.height - side) / 2,
        side,
        side,
        0,
        0,
        size,
        size
      )
      return await new Promise<string>((resolve) => {
        canvas.toBlob(
          (b) => {
            if (b) {
              resolve(URL.createObjectURL(b))
              return
            }
            // 个别环境不支持 WebP 编码时回退 JPEG，避免缩略图整体失效
            canvas.toBlob((b2) => resolve(b2 ? URL.createObjectURL(b2) : ''), 'image/jpeg', quality)
          },
          'image/webp',
          quality
        )
      })
    } finally {
      bmp.close()
    }
  } catch {
    return ''
  }
}
