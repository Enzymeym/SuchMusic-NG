import { nativeImage, NativeImage } from 'electron'
import * as zlib from 'zlib'

const SIZE = 20

/** CRC32 计算（用于 PNG chunk） */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crcInput = Buffer.concat([typeBuffer, data])
  const crcVal = Buffer.alloc(4)
  crcVal.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([length, typeBuffer, data, crcVal])
}

/** 将 RGBA 像素数据编码为 PNG Buffer */
function rgbaToPng(pixels: Buffer, w: number, h: number): Buffer {
  // 构建滤波后的像素数据（每行前加一个 filter type 0 = None）
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0
    pixels.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4)
  }

  const compressed = zlib.deflateSync(raw)

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(w, 0)
  ihdrData.writeUInt32BE(h, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 6 // color type: RGBA
  ihdrData[10] = 0 // compression
  ihdrData[11] = 0 // filter
  ihdrData[12] = 0 // interlace

  return Buffer.concat([
    signature,
    createChunk('IHDR', ihdrData),
    createChunk('IDAT', compressed),
    createChunk('IEND', Buffer.alloc(0))
  ])
}

/** 设置像素颜色（RGBA 顺序） */
function setPixel(pixels: Buffer, x: number, y: number, r: number, g: number, b: number, a: number): void {
  const idx = (y * SIZE + x) * 4
  pixels[idx] = r
  pixels[idx + 1] = g
  pixels[idx + 2] = b
  pixels[idx + 3] = a
}

/** 填充矩形区域 */
function fillRect(pixels: Buffer, x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPixel(pixels, x + dx, y + dy, r, g, b, a)
    }
  }
}

/** 根据图标类型生成像素数据 */
function generatePixels(type: 'play' | 'pause' | 'prev' | 'next'): Buffer {
  const pixels = Buffer.alloc(SIZE * SIZE * 4, 0)
  const W = 0xff // white

  switch (type) {
    case 'play': {
      // 三角形指向右: (5,3) -> (5,17) -> (17,10)
      const x0 = 5, y0 = 3, x1 = 5, y1 = 17, x2 = 17, y2 = 10
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (pointInTriangle(x + 0.5, y + 0.5, x0, y0, x1, y1, x2, y2)) {
            setPixel(pixels, x, y, W, W, W, 255)
          }
        }
      }
      break
    }
    case 'pause': {
      fillRect(pixels, 5, 3, 4, 14, W, W, W, 255)
      fillRect(pixels, 11, 3, 4, 14, W, W, W, 255)
      break
    }
    case 'prev': {
      // 右向三角形 (从 (16,3) 到 (16,17) 到 (7,10))
      const x0 = 16, y0 = 3, x1 = 16, y1 = 17, x2 = 7, y2 = 10
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (pointInTriangle(x + 0.5, y + 0.5, x0, y0, x1, y1, x2, y2)) {
            setPixel(pixels, x, y, W, W, W, 255)
          }
        }
      }
      // 左侧竖线
      fillRect(pixels, 3, 3, 3, 14, W, W, W, 255)
      break
    }
    case 'next': {
      // 左向三角形 (从 (5,3) 到 (5,17) 到 (14,10))
      const x0 = 5, y0 = 3, x1 = 5, y1 = 17, x2 = 14, y2 = 10
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (pointInTriangle(x + 0.5, y + 0.5, x0, y0, x1, y1, x2, y2)) {
            setPixel(pixels, x, y, W, W, W, 255)
          }
        }
      }
      // 右侧竖线
      fillRect(pixels, 14, 3, 3, 14, W, W, W, 255)
      break
    }
  }

  return pixels
}

/** 判断点是否在三角形内（重心坐标法） */
function pointInTriangle(px: number, py: number, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): boolean {
  const d1 = sign(px, py, x0, y0, x1, y1)
  const d2 = sign(px, py, x1, y1, x2, y2)
  const d3 = sign(px, py, x2, y2, x0, y0)
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0)
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0)
  return !(hasNeg && hasPos)
}

function sign(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  return (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2)
}

let cachedIcons: Record<string, NativeImage> | null = null

/** 获取所有缩略图图标 */
export function getThumbnailIcons(): Record<string, NativeImage> {
  if (cachedIcons) return cachedIcons

  cachedIcons = {}
  const types: Array<'play' | 'pause' | 'prev' | 'next'> = ['play', 'pause', 'prev', 'next']
  for (const type of types) {
    const pixels = generatePixels(type)
    const pngBuffer = rgbaToPng(pixels, SIZE, SIZE)
    cachedIcons[type] = nativeImage.createFromBuffer(pngBuffer, { width: SIZE, height: SIZE })
  }

  return cachedIcons
}
