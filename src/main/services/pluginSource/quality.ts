/**
 * 音质标识归一化与回退
 *
 * 应用内的设置值可能是 128k/192k/320k/flac，而插件声明自己的可用音质列表。
 * 这里把「请求音质」映射到插件实际支持、且不超过请求等级的最高音质。
 */
import { QUALITY_ORDER, type QualityId } from './types'

/** 设为合法 QualityId；未知输入回退 320k */
export function normalizeQuality(input?: string | null): QualityId {
  const v = (input || '').toLowerCase().trim()
  if ((QUALITY_ORDER as string[]).includes(v)) return v as QualityId
  // 应用内的 192k 未纳入插件音质枚举，向上归到 320k
  if (v === '192k') return '320k'
  return '320k'
}

/**
 * 从插件可用音质中选出不超过 requested 的最高项。
 * @param requested 期望音质
 * @param available 插件声明的可用音质
 */
export function pickQuality(requested: QualityId, available?: QualityId[]): QualityId {
  if (!available || available.length === 0) return requested
  const reqIndex = QUALITY_ORDER.indexOf(requested)
  const candidates = available
    .filter((q) => QUALITY_ORDER.includes(q) && QUALITY_ORDER.indexOf(q) <= reqIndex)
    .sort((a, b) => QUALITY_ORDER.indexOf(b) - QUALITY_ORDER.indexOf(a))
  if (candidates.length > 0) return candidates[0]
  // 请求音质低于插件全部可用音质时，退而求其次选最低可用
  const sorted = [...available]
    .filter((q) => QUALITY_ORDER.includes(q))
    .sort((a, b) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b))
  return sorted[0] ?? requested
}
