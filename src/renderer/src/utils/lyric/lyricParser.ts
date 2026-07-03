import { parseQrc, parseTTML, decryptQrcHex } from '@applemusic-like-lyrics/lyric'
import type { LyricLine as CoreLyricLine, LyricWord as CoreLyricWord } from '@applemusic-like-lyrics/core'
import { parseLrc as parseBetterLrc } from './ParseLrc'

/**
 * LRC/YRC 歌词元数据头匹配正则
 * 匹配 [ti:] [ar:] [al:] [by:] [offset:] [kana:] [roma:] 等待剥离的头信息
 */
const METADATA_HEADER_REGEX = /^\[(ti|ar|al|by|offset|kana|roma):/

/**
 * 剥离歌词内容中的元数据头信息
 * 过滤掉 [ti:] [ar:] [al:] [by:] [offset:] [kana:] [roma:] 开头的行
 * 保留真正的歌词行（YRC 的 [数字,数字] 和 LRC 的 [mm:ss.xx]）
 * @param content 原始歌词文本（可能包含元数据头）
 * @returns 去除元数据头后的干净歌词文本
 */
export function stripLyricMetadata(content: string): string {
  if (!content) return ''
  const lines = content.split(/\r?\n/)
  const cleanedLines = lines.filter((line) => {
    const trimmed = line.trim()
    if (!trimmed) return false
    if (METADATA_HEADER_REGEX.test(trimmed)) return false
    return true
  })
  return cleanedLines.join('\n')
}

/**
 * 将解析后的翻译歌词按行顺序合并到主歌词行中
 * @param mainLines 主歌词行数组（已解析）
 * @param translatedContent 翻译歌词文本（LRC 格式，可选）
 * @returns 合并了 translatedLyric 的歌词行数组
 */
function mergeTranslatedLyrics(mainLines: CoreLyricLine[], translatedContent?: string): CoreLyricLine[] {
  if (!translatedContent) return mainLines

  const cleanedTranslated = stripLyricMetadata(translatedContent)
  if (!cleanedTranslated) return mainLines

  let translatedLines: CoreLyricLine[] = []
  try {
    translatedLines = parseBetterLrc(cleanedTranslated) as CoreLyricLine[]
  } catch {
    return mainLines
  }

  const maxLen = Math.min(mainLines.length, translatedLines.length)
  for (let i = 0; i < maxLen; i++) {
    const translatedText = translatedLines[i].words[0]?.word ?? ''
    if (translatedText) {
      mainLines[i] = { ...mainLines[i], translatedLyric: translatedText }
    }
  }

  return mainLines
}

/**
 * 自定义 YRC 逐字歌词解析器
 * QQ 音乐 YRC 格式: [行起始ms,行时长ms]词1(词1起始ms,词1时长ms)词2(词2起始ms,词2时长ms)...
 * 替代 AMLL WASM parseYrc（该函数对此格式变体返回空 words）
 * @param content 剥离元数据后的 YRC 纯文本
 * @returns CoreLyricLine 数组（含逐字时间戳）
 */
function parseYrcCustom(content: string): CoreLyricLine[] {
  const rawLines = content.split(/\r?\n/)
  const result: CoreLyricLine[] = []

  // 匹配行级时间戳: [数字,数字]
  const lineTimeRegex = /^\[(\d+),(\d+)\]/
  // 匹配词级时间戳: (数字,数字) — 全局匹配同一行中的所有词时间戳
  const wordTimeRegex = /\((\d+),(\d+)\)/g

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue

    const lineMatch = lineTimeRegex.exec(trimmed)
    if (!lineMatch) continue

    const lineStart = parseInt(lineMatch[1], 10)
    const lineDuration = parseInt(lineMatch[2], 10)
    const lineEnd = lineStart + lineDuration

    // 去掉行级时间戳，得到词+词级时间戳的文本
    const textPart = trimmed.slice(lineMatch[0].length)

    // 找到所有词级时间戳，提取之间的文本作为词
    const words: CoreLyricWord[] = []
    let lastIndex = 0
    let wordMatch: RegExpExecArray | null
    wordTimeRegex.lastIndex = 0

    while ((wordMatch = wordTimeRegex.exec(textPart)) !== null) {
      const wordStart = parseInt(wordMatch[1], 10)
      const wordDuration = parseInt(wordMatch[2], 10)
      const wordEnd = wordStart + wordDuration

      // 词文本：从上一个时间戳结束位置到当前时间戳起始位置
      const wordText = textPart.slice(lastIndex, wordMatch.index)

      if (wordText) {
        words.push({
          word: wordText,
          startTime: wordStart,
          endTime: wordEnd,
          romanWord: '',
          obscene: false
        })
      }

      lastIndex = wordMatch.index + wordMatch[0].length
    }

    // 处理无词级时间戳的兜底：整行作为一个词
    if (words.length === 0 && textPart) {
      words.push({
        word: textPart,
        startTime: lineStart,
        endTime: lineEnd,
        romanWord: '',
        obscene: false
      })
    }

    result.push({
      words,
      startTime: lineStart,
      endTime: lineEnd,
      translatedLyric: '',
      romanLyric: '',
      isBG: false,
      isDuet: false
    })
  }

  return result
}

/**
 * 将歌词内容解析为 CoreLyricLine 数组
 * 自动检测歌词格式（TTML / QRC / YRC / LRC），剥离元数据头后解析
 * @param content 歌词文本（主歌词）
 * @param translatedContent 翻译歌词文本（LRC 格式，可选）
 * @returns 包含翻译信息的 CoreLyricLine 数组
 */
export function parseLyricsToCore(content: string, translatedContent?: string): CoreLyricLine[] {
  if (!content) return []

  let lrc = typeof content === 'string' ? content : String(content)

  // 将歌词标签中的字面 \n 转义序列转换为实际换行符
  lrc = lrc.replace(/\\n/g, '\n')

  lrc = lrc.trim()

  if (!lrc) return []

  let lines: any[] = []

  try {
    lrc = stripLyricMetadata(lrc)

    if (!lrc) return []

    // TTML
    if (lrc.includes('<tt') && lrc.includes('xmlns="http://www.w3.org/ns/ttml"')) {
      console.log('[lyricParser] 检测到 TTML 格式')
      lines = parseTTML(lrc).lines
    }
    // QRC (Hex)
    else if (/^[0-9a-fA-F]+$/.test(lrc) && lrc.length > 100) {
      console.log('[lyricParser] 检测到 QRC Hex 格式')
      try {
        const decrypted = decryptQrcHex(lrc)
        lines = parseQrc(decrypted)
      } catch {
        // ignore
      }
    }
    // QRC (XML)
    else if (lrc.startsWith('<?xml') && lrc.includes('<Qrc')) {
      console.log('[lyricParser] 检测到 QRC XML 格式')
      lines = parseQrc(lrc)
    }
    // YRC (Guess by content)
    else if (/\(\d+,\d+\)/.test(lrc)) {
      console.log('[lyricParser] 检测到 YRC 逐字歌词格式')
      const yrcLinesCount = (lrc.match(/\(\d+,\d+\)/g) || []).length
      console.log(`[lyricParser] YRC 词级时间戳数量: ${yrcLinesCount}, 首行预览: ${lrc.split('\n')[0]?.substring(0, 100)}`)
      lines = parseYrcCustom(lrc)
      console.log(`[lyricParser] YRC 解析完成: ${lines.length} 行, 首行词数: ${lines[0]?.words?.length || 0}`)
    }
    // 检测是否包含 LRC 时间戳 [mm:ss.xx]
    else if (/\[\d{1,2}:\d{1,2}/.test(lrc)) {
      console.log('[lyricParser] 未检测到特殊格式，回退到 LRC 解析')
      console.log(`[lyricParser] 内容首行预览: ${lrc.split('\n')[0]?.substring(0, 100)}`)
      lines = parseBetterLrc(lrc)
    }
    // 纯文本歌词（无 LRC 时间戳）：按换行拆分，均匀分配时间
    else {
      console.log('[lyricParser] 检测到纯文本歌词，按行拆分')
      const plainLines = lrc
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
      const lineDuration = 5000 // 每行 5 秒
      lines = plainLines.map((text, i) => ({
        words: [
          {
            word: text,
            romanWord: '',
            startTime: i * lineDuration,
            endTime: (i + 1) * lineDuration,
            obscene: false
          }
        ],
        startTime: i * lineDuration,
        endTime: (i + 1) * lineDuration,
        translatedLyric: '',
        romanLyric: '',
        isBG: false,
        isDuet: false
      }))
    }

    const coreLines: CoreLyricLine[] = lines.map((line) => ({
      words: line.words.map(
        (w): CoreLyricWord => ({
          word: w.word,
          romanWord: w.romanWord ?? '',
          startTime: w.startTime,
          endTime: w.endTime,
          obscene: false
        })
      ),
      startTime: line.startTime,
      endTime: line.endTime,
      translatedLyric: line.translatedLyric ?? '',
      romanLyric: line.romanLyric ?? '',
      isBG: line.isBG ?? false,
      isDuet: line.isDuet ?? false
    }))

    return mergeTranslatedLyrics(coreLines, translatedContent)
  } catch (e) {
    console.error('Lyric parse failed:', e)
    return []
  }
}
