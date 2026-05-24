// 提取图片主色与中性色的工具函数（纯前端实现）

/**
 * 图片颜色调色板接口
 * @property main - 主色（高饱和度）
 * @property secondary - 次主色
 * @property third - 第三色
 * @property neutral - 中性色（灰度/低饱和）
 * @property neutralVariant - 中性色变体（亮/暗）
 */
export interface ImageColorPalette {
  main: string
  secondary: string
  third: string
  neutral: string
  neutralVariant: string
}

/**
 * 提取颜色选项接口
 * @property isLightMode - 是否为浅色模式，浅色模式下会自动调整颜色以保证可读性
 * @property brightnessThreshold - 亮度阈值，默认 0.6，超过此值的颜色会被压暗
 * @property saturationBoost - 饱和度提升系数，默认 1.3，用于提升低饱和度颜色
 * @property darkenFactor - 压暗系数，默认 0.75，用于降低过亮颜色的亮度
 * @property minSaturation - 最小饱和度阈值，默认 0.3，低于此值会提升饱和度
 */
export interface ExtractColorOptions {
  isLightMode?: boolean
  brightnessThreshold?: number
  saturationBoost?: number
  darkenFactor?: number
  minSaturation?: number
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

/**
 * 将 RGB 转为 HSL（0-1）
 * @param r - 红色通道值（0-255）
 * @param g - 绿色通道值（0-255）
 * @param b - 蓝色通道值（0-255）
 * @returns 返回包含 h（色相）、s（饱和度）、l（亮度）的对象
 */
const rgbToHsl = (r: number, g: number, b: number) => {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let s = 0
  let h = 0

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0)
        break
      case g:
        h = (b - r) / d + 2
        break
      case b:
        h = (r - g) / d + 4
        break
    }
    h /= 6
  }

  return { h, s, l }
}

/**
 * 将 HSL 转为 RGB
 * @param h - 色相（0-1）
 * @param s - 饱和度（0-1）
 * @param l - 亮度（0-1）
 * @returns 返回包含 r、g、b 的对象（0-255）
 */
const hslToRgb = (h: number, s: number, l: number) => {
  let r: number, g: number, b: number

  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255)
  }
}

// 计算两个颜色的欧氏距离（RGB 空间）
const colorDistance = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

/**
 * 将 RGB 转为 #rrggbb
 * @param r - 红色通道值（0-255）
 * @param g - 绿色通道值（0-255）
 * @param b - 蓝色通道值（0-255）
 * @returns 返回 hex 颜色字符串
 */
const rgbToHex = (r: number, g: number, b: number) => {
  const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * 将 hex 颜色转为 RGB
 * @param hex - hex 颜色字符串（支持 #rgb 或 #rrggbb 格式）
 * @returns 返回包含 r、g、b 的对象，转换失败返回 null
 */
const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  let s = hex.trim()
  if (s.startsWith('#')) s = s.slice(1)
  if (s.length === 3) {
    s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
  }
  if (s.length !== 6) return null
  const r = parseInt(s.slice(0, 2), 16)
  const g = parseInt(s.slice(2, 4), 16)
  const b = parseInt(s.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
  return { r, g, b }
}

/**
 * 在浅色模式下调整颜色，通过压暗和增加饱和度来保证可读性
 * @param hexColor - 原始 hex 颜色字符串
 * @param options - 调整选项
 * @returns 返回调整后的 hex 颜色字符串
 */
export const adjustColorForLightMode = (
  hexColor: string,
  options?: ExtractColorOptions
): string => {
  const {
    brightnessThreshold = 0.5,
    saturationBoost = 1.5,
    darkenFactor = 0.6,
    minSaturation = 0.35
  } = options || {}

  const rgb = hexToRgb(hexColor)
  if (!rgb) return hexColor

  // 转换为 HSL
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b)

  // 如果亮度超过阈值，按比例压暗
  if (hsl.l > brightnessThreshold) {
    const excessBrightness = hsl.l - brightnessThreshold
    const darkenAmount = excessBrightness * (1 - darkenFactor)
    hsl.l = Math.max(0.15, hsl.l - darkenAmount)
  }

  // 如果饱和度低于阈值，提升饱和度
  if (hsl.s < minSaturation) {
    hsl.s = Math.min(1, hsl.s * saturationBoost)
  }

  // 转换回 RGB
  const newRgb = hslToRgb(hsl.h, hsl.s, hsl.l)

  return rgbToHex(newRgb.r, newRgb.g, newRgb.b)
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

/**
 * 从图片中提取主色、中性色等调色板信息
 * @param src - 图片源，可以是 URL 字符串或 HTMLImageElement
 * @param options - 提取选项，包含浅色模式调整参数
 * @returns 返回包含主色、次主色、第三色、中性色等的调色板对象
 */
export const extractImageColors = async (
  src: string | HTMLImageElement,
  options?: ExtractColorOptions
): Promise<ImageColorPalette> => {
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

  // 提取原始颜色
  let mainHex = rgbToHex(mainColor.r, mainColor.g, mainColor.b)
  let secondaryHex = rgbToHex(secondaryColor.r, secondaryColor.g, secondaryColor.b)
  let thirdHex = rgbToHex(thirdColor.r, thirdColor.g, thirdColor.b)

  // 如果是浅色模式，对主色、次主色、第三色应用颜色调整
  if (options?.isLightMode) {
    mainHex = adjustColorForLightMode(mainHex, options)
    secondaryHex = adjustColorForLightMode(secondaryHex, options)
    thirdHex = adjustColorForLightMode(thirdHex, options)
  }

  return {
    main: mainHex,
    secondary: secondaryHex,
    third: thirdHex,
    neutral: rgbToHex(neutralColor.r, neutralColor.g, neutralColor.b),
    neutralVariant: neutralVariantHex
  }
}

