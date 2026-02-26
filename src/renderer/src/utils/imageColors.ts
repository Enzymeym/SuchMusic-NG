// 提取图片主色与中性色的工具函数（纯前端实现）

export interface ImageColorPalette {
  main: string // 主色（高饱和度）
  secondary: string // 次主色
  third: string // 第三色
  neutral: string // 中性色（灰度/低饱和）
  neutralVariant: string // 中性色变体（亮/暗）
}

interface BucketStat {
  rSum: number
  gSum: number
  bSum: number
  count: number
}

interface BucketColor {
  r: number
  g: number
  b: number
  count: number
  saturation: number
  lightness: number
}

const MAX_SAMPLE_SIZE = 96 // 降采样边长，控制计算量
const COLOR_QUANT_SHIFT = 3 // 每通道量化位移（8->5bit）

// 将 RGB 转为 HSL（0-1）
const rgbToHsl = (r: number, g: number, b: number) => {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let s = 0

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  }

  return { s, l }
}

// 计算两个颜色的欧氏距离（RGB 空间）
const colorDistance = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

// 将 RGB 转为 #rrggbb
const rgbToHex = (r: number, g: number, b: number) => {
  const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

// 从 ImageData 中量化颜色并统计直方图
const buildColorBuckets = (imageData: ImageData, sampleStep = 2): BucketColor[] => {
  const { width, height, data } = imageData
  const buckets = new Map<number, BucketStat>()

  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const idx = (y * width + x) * 4
      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]
      const a = data[idx + 3]

      // 忽略完全透明像素
      if (a < 32) continue

      const rQ = r >> COLOR_QUANT_SHIFT
      const gQ = g >> COLOR_QUANT_SHIFT
      const bQ = b >> COLOR_QUANT_SHIFT
      const key = (rQ << 10) | (gQ << 5) | bQ

      let stat = buckets.get(key)
      if (!stat) {
        stat = { rSum: 0, gSum: 0, bSum: 0, count: 0 }
        buckets.set(key, stat)
      }
      stat.rSum += r
      stat.gSum += g
      stat.bSum += b
      stat.count++
    }
  }

  const result: BucketColor[] = []
  for (const stat of buckets.values()) {
    const r = stat.rSum / stat.count
    const g = stat.gSum / stat.count
    const b = stat.bSum / stat.count
    const { s, l } = rgbToHsl(r, g, b)
    result.push({
      r,
      g,
      b,
      count: stat.count,
      saturation: s,
      lightness: l
    })
  }

  return result
}

// 按重要性排序颜色（先按出现次数，再按中等亮度优先）
const sortByDominance = (colors: BucketColor[]) => {
  return [...colors].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    const center = 0.5
    const aDist = Math.abs(a.lightness - center)
    const bDist = Math.abs(b.lightness - center)
    return aDist - bDist
  })
}

// 从排序后的颜色列表中选取若干互相差异较大的颜色
const pickDistinctColors = (colors: BucketColor[], maxCount: number, minDistance = 40): BucketColor[] => {
  const picked: BucketColor[] = []
  for (const c of colors) {
    if (!picked.length) {
      picked.push(c)
      if (picked.length >= maxCount) break
      continue
    }
    const tooClose = picked.some((p) => colorDistance(p, c) < minDistance)
    if (!tooClose) {
      picked.push(c)
      if (picked.length >= maxCount) break
    }
  }
  return picked
}

// 根据中性色生成一个亮度略有差异的变体
const deriveNeutralVariant = (neutral: BucketColor | null): string => {
  if (!neutral) return '#808080'
  let factor = neutral.lightness > 0.5 ? 0.75 : 1.25
  factor = Math.max(0.2, Math.min(1.8, factor))
  const r = Math.max(0, Math.min(255, neutral.r * factor))
  const g = Math.max(0, Math.min(255, neutral.g * factor))
  const b = Math.max(0, Math.min(255, neutral.b * factor))
  return rgbToHex(r, g, b)
}

// 将任意图片源加载为 HTMLImageElement（带跨域处理）
export const loadImageSafe = (src: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // 优先尝试 anonymous 模式，兼容支持 CORS 的图片源
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => {
      // 第一次失败后尝试移除 crossOrigin 再试一次（某些本地/文件协议场景）
      const img2 = new Image()
      img2.onload = () => resolve(img2)
      img2.onerror = (e) => reject(e)
      img2.src = src
    }
    img.src = src
  })
}

// 将远程图片拉取为 dataURL，尽量绕过 canvas 跨域污染问题
export const fetchImageAsDataURL = async (src: string): Promise<string> => {
  const resp = await fetch(src, { mode: 'cors' })
  if (!resp.ok) {
    throw new Error(`fetch image failed: ${resp.status}`)
  }
  const blob = await resp.blob()
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = (e) => reject(e)
    reader.readAsDataURL(blob)
  })
}

// 从图片中提取主色、中性色等调色板信息
export const extractImageColors = async (src: string | HTMLImageElement): Promise<ImageColorPalette> => {
  let img: HTMLImageElement

  if (typeof src === 'string') {
    img = await loadImageSafe(src)
  } else {
    img = src
  }

  // 创建画布并降采样绘制图片
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('canvas 2d context not available')
  }

  const naturalWidth = img.naturalWidth || img.width
  const naturalHeight = img.naturalHeight || img.height
  if (!naturalWidth || !naturalHeight) {
    throw new Error('image has no valid size')
  }

  let targetWidth = naturalWidth
  let targetHeight = naturalHeight
  if (Math.max(naturalWidth, naturalHeight) > MAX_SAMPLE_SIZE) {
    if (naturalWidth >= naturalHeight) {
      targetWidth = MAX_SAMPLE_SIZE
      targetHeight = Math.round((naturalHeight / naturalWidth) * MAX_SAMPLE_SIZE)
    } else {
      targetHeight = MAX_SAMPLE_SIZE
      targetWidth = Math.round((naturalWidth / naturalHeight) * MAX_SAMPLE_SIZE)
    }
  }

  canvas.width = targetWidth
  canvas.height = targetHeight
  ctx.clearRect(0, 0, targetWidth, targetHeight)
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight)

  let imageData: ImageData
  try {
    imageData = ctx.getImageData(0, 0, targetWidth, targetHeight)
  } catch (e) {
    // 如果因为跨域导致 canvas 被污染，尝试通过 fetch -> dataURL 的方式重试
    if (typeof src === 'string') {
      const dataUrl = await fetchImageAsDataURL(src)
      const img2 = await loadImageSafe(dataUrl)
      canvas.width = img2.naturalWidth || img2.width
      canvas.height = img2.naturalHeight || img2.height
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img2, 0, 0, canvas.width, canvas.height)
      try {
        imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      } catch (e2) {
        throw new Error('failed to read image data (maybe strict CORS), consider using a proxy')
      }
    } else {
      throw new Error('failed to read image data from canvas')
    }
  }

  const buckets = buildColorBuckets(imageData, 2)
  if (!buckets.length) {
    // 兜底返回一组默认颜色，避免调用方崩溃
    return {
      main: '#808080',
      secondary: '#606060',
      third: '#a0a0a0',
      neutral: '#808080',
      neutralVariant: '#a0a0a0'
    }
  }

  // 按饱和度和亮度区分彩色与中性色
  const chromatic: BucketColor[] = []
  const neutralList: BucketColor[] = []

  for (const c of buckets) {
    // 过滤极端亮/暗像素，避免全黑/全白干扰主色
    if (c.lightness < 0.05 || c.lightness > 0.95) continue
    if (c.saturation < 0.2) {
      neutralList.push(c)
    } else {
      chromatic.push(c)
    }
  }

  const chromaticSorted = sortByDominance(chromatic)
  const neutralSorted = sortByDominance(neutralList)

  const pickedChromatic = pickDistinctColors(chromaticSorted, 3, 45)
  const mainColor = pickedChromatic[0] ?? chromaticSorted[0] ?? buckets[0]
  const secondaryColor = pickedChromatic[1] ?? pickedChromatic[0] ?? mainColor
  const thirdColor = pickedChromatic[2] ?? pickedChromatic[1] ?? secondaryColor

  const neutralColor = neutralSorted[0] ?? mainColor
  const neutralVariantHex = deriveNeutralVariant(neutralSorted[1] ?? neutralColor)

  return {
    main: rgbToHex(mainColor.r, mainColor.g, mainColor.b),
    secondary: rgbToHex(secondaryColor.r, secondaryColor.g, secondaryColor.b),
    third: rgbToHex(thirdColor.r, thirdColor.g, thirdColor.b),
    neutral: rgbToHex(neutralColor.r, neutralColor.g, neutralColor.b),
    neutralVariant: neutralVariantHex
  }
}

