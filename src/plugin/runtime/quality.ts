/**
 * 音质归一化
 *
 * v2 插件在 `register({ sources })` 里声明自己支持的音质档位。宿主只在这个
 * 集合内选择，避免出现「插件只有 192k，宿主却按 320k 请求」的必然失败。
 */
export const QUALITY_ORDER = [
  '128k',
  '192k',
  '320k',
  'flac',
  'flac24bit',
  'hires',
  'atmos',
  'atmos_plus',
  'master'
] as const

function rank(quality: string): number {
  const idx = QUALITY_ORDER.indexOf(quality.toLowerCase() as (typeof QUALITY_ORDER)[number])
  return idx < 0 ? -1 : idx
}

/**
 * 在插件声明的音质集合里挑一个最接近请求值的档位。
 *
 * 规则：完全命中 → 用它；否则取「不高于请求值」里最高的；都没有则取插件支持的最低档。
 */
export function pickDeclaredQuality(declared: string[], requested: string): string {
  const list = declared.map((q) => q.toLowerCase()).filter(Boolean)
  if (list.length === 0) return requested
  const want = requested.toLowerCase()
  if (list.includes(want)) return want
  if (rank(want) < 0) return list[0]

  const wantRank = rank(want)
  let best: string | null = null
  for (const q of list) {
    const r = rank(q)
    if (r < 0) continue
    if (r <= wantRank && (best === null || r > rank(best))) best = q
  }
  if (best) return best
  // 全部高于请求值 → 取最低的一档
  return list.reduce((low, q) => (rank(q) < rank(low) || rank(low) < 0 ? q : low), list[0])
}
