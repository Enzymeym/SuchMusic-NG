import { parseYrc, parseQrc, parseTTML, decryptQrcHex } from '@applemusic-like-lyrics/amll-lyric'
import type { LyricLine as CoreLyricLine, LyricWord as CoreLyricWord } from '@applemusic-like-lyrics/amll-lyric'
import { parseLrc as parseBetterLrc } from './ParseLrc'

export function parseLyricsToCore(content: string): CoreLyricLine[] {
  if (!content) return []
  const lrc = content.trim()
  let lines: any[] = []

  try {
    // TTML
    if (lrc.includes('<tt') && lrc.includes('xmlns="http://www.w3.org/ns/ttml"')) {
      lines = parseTTML(lrc).lines
    }
    // QRC (Hex)
    else if (/^[0-9a-fA-F]+$/.test(lrc) && lrc.length > 100) {
      try {
        const decrypted = decryptQrcHex(lrc)
        lines = parseQrc(decrypted)
      } catch {
        // ignore
      }
    }
    // QRC (XML)
    else if (lrc.startsWith('<?xml') && lrc.includes('<Qrc')) {
      lines = parseQrc(lrc)
    }
    // YRC (Guess by content)
    else if (/\(\d+,\d+\)/.test(lrc)) {
      lines = parseYrc(lrc)
    }
    // Other cases fallback to LRC
    else {
      lines = parseBetterLrc(lrc)
    }

    // Convert to core structure
    return lines.map((line) => ({
      words: line.words.map(
        (w): CoreLyricWord => ({
          word: w.word,
          romanWord: w.romanWord ?? '',
          startTime: w.startTime,
          endTime: w.endTime,
        })
      ),
      startTime: line.startTime,
      endTime: line.endTime,
      translatedLyric: line.translatedLyric ?? '',
      romanLyric: line.romanLyric ?? '',
      isBG: line.isBG ?? false,
      isDuet: line.isDuet ?? false
    }))
  } catch (e) {
    console.error('Lyric parse failed:', e)
    return []
  }
}
