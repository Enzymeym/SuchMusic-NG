export const formatQuality = (
  bitrate?: number,
  sampleRate?: number,
  bitsPerSample?: number
): string => {
  if (!bitrate && !sampleRate && !bitsPerSample) return ''
  const kbps = bitrate ? bitrate / 1000 : 0
  const khz = sampleRate ? sampleRate / 1000 : 0

  // 24bit 及以上直接算 Hi-Res：无损高码率常见 kbps 并不高（如 24bit/48kHz FLAC）
  if (khz >= 88.2 || kbps >= 2500 || (bitsPerSample ?? 0) >= 24) return 'Hi-Res'
  if (kbps >= 800) return 'SQ'
  if (kbps >= 192) return 'HQ'
  return 'LQ'
}

/**
 * 技术参数文案，用于文件夹/歌曲详情等需要「说清楚这到底是什么文件」的地方。
 * 例：`FLAC · 24bit/96kHz · 2304kbps`
 */
export const formatTechSpec = (track: {
  codec?: string
  bitsPerSample?: number
  sampleRate?: number
  bitrate?: number
}): string => {
  const parts: string[] = []
  if (track.codec) parts.push(track.codec)
  if (track.bitsPerSample && track.sampleRate) {
    parts.push(`${track.bitsPerSample}bit/${Math.round(track.sampleRate / 100) / 10}kHz`)
  } else if (track.sampleRate) {
    parts.push(`${Math.round(track.sampleRate / 100) / 10}kHz`)
  }
  if (track.bitrate) parts.push(`${Math.round(track.bitrate / 1000)}kbps`)
  return parts.join(' · ')
}

export const calculateBitrate = (size: number, duration: number): number => {
  if (!size || !duration || duration <= 0) return 0
  return (size * 8) / duration
}
