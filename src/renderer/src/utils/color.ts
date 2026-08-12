/**
 * 颜色工具函数（集中管理 hex/RGB 解析、混合、亮度计算）
 *
 * 统一原先分散在 settingsStore / usePlayerTheme / PlayerBar / AppSidebar /
 * AudioVisualizer / imageColors 中的多份重复实现，行为与各调用点原实现保持一致。
 */

export interface RGB {
  r: number
  g: number
  b: number
}

/**
 * 将 hex 颜色转为 RGB
 * @param hex - hex 颜色字符串（支持 #rgb 或 #rrggbb 格式）
 * @returns 包含 r、g、b 的对象，解析失败返回 null
 */
export const hexToRgb = (hex: string): RGB | null => {
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
 * 将 RGB 转为 #rrggbb
 * @param r - 红色通道值（0-255）
 * @param g - 绿色通道值（0-255）
 * @param b - 蓝色通道值（0-255）
 * @returns hex 颜色字符串
 */
export const rgbToHex = (r: number, g: number, b: number): string => {
  const toHex = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * 计算颜色亮度（0-1），使用感知亮度公式
 * @param hex - hex 颜色字符串
 * @returns 亮度值（0-1），解析失败返回 null
 */
export const getBrightness = (hex: string): number | null => {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255
}

/**
 * 简单混合两个十六进制颜色
 * @param color1 - 第一个颜色
 * @param color2 - 第二个颜色
 * @param weight - 混合权重（0-1），决定 color1 的占比
 * @returns 混合后的 hex 颜色
 */
export const mixHexColor = (color1: string, color2: string, weight: number): string => {
  const clamp = (v: number): number => Math.max(0, Math.min(255, v))
  const parse = (color: string): { r: number; g: number; b: number } => {
    let c = color.replace('#', '')
    if (c.length === 3) {
      c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]
    }
    if (c.length !== 6) return { r: 255, g: 255, b: 255 }
    return {
      r: parseInt(c.slice(0, 2), 16),
      g: parseInt(c.slice(2, 4), 16),
      b: parseInt(c.slice(4, 6), 16)
    }
  }
  const a = parse(color1)
  const b = parse(color2)
  const t = Math.max(0, Math.min(1, weight))
  const r = clamp(a.r * t + b.r * (1 - t))
  const g = clamp(a.g * t + b.g * (1 - t))
  const bVal = clamp(a.b * t + b.b * (1 - t))
  const toHex = (n: number): string => Math.round(n).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(bVal)}`
}

/**
 * 将颜色与黑色混合，调暗颜色
 * @param hex - 十六进制颜色字符串
 * @param weight - 混合权重（0-1），值越大颜色越暗
 * @returns 混合后的颜色
 */
export const mixWithBlack = (hex: string, weight: number): string =>
  mixHexColor(hex, '#000000', 1 - weight)

/**
 * 将颜色与白色混合，提亮颜色
 * @param hex - 十六进制颜色字符串
 * @param weight - 混合权重（0-1），值越大颜色越亮
 * @returns 混合后的颜色
 */
export const mixWithWhite = (hex: string, weight: number): string =>
  mixHexColor(hex, '#ffffff', 1 - weight)

/**
 * 将 hex 颜色转为 rgba 字符串
 * @param hex - 十六进制颜色字符串
 * @param alpha - 透明度（0-1）
 * @returns rgba 颜色字符串
 */
export const hexToRgba = (hex: string, alpha: number): string => {
  const rgb = hexToRgb(hex)
  if (!rgb) return `rgba(255, 255, 255, ${alpha})`
  const a = Math.min(Math.max(alpha, 0), 1)
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`
}
