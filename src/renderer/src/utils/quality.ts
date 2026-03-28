export const formatQuality = (bitrate?: number, sampleRate?: number): string => {
  if (!bitrate && !sampleRate) return ''
  const kbps = bitrate ? bitrate / 1000 : 0
  const khz = sampleRate ? sampleRate / 1000 : 0

  if (khz >= 88.2 || kbps >= 2500) return 'Hi-Res'
  if (kbps >= 800) return 'SQ'
  if (kbps >= 192) return 'HQ'
  return 'LQ'
}

export const calculateBitrate = (size: number, duration: number): number => {
  if (!size || !duration || duration <= 0) return 0
  return (size * 8) / duration
}
