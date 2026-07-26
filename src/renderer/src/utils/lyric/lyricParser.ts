import { parseQrc, parseTTML, decryptQrcHex } from '@applemusic-like-lyrics/lyric'
import type { LyricLine as CoreLyricLine, LyricWord as CoreLyricWord } from '@applemusic-like-lyrics/core'
import { parseLrc as parseBetterLrc } from './ParseLrc'

/**
 * LRC/YRC 歌词元数据头匹配正则
 * 匹配 [ti:] [ar:] [al:] [by:] [offset:] [kana:] [roma:] 等待剥离的头信息
 */
const METADATA_HEADER_REGEX = /^\[(ti|ar|al|by|offset|kana|roma):/

/**
 * YRC JSON 元数据行匹配正则
 * 网易云 YRC 内容可能包含 {"t":毫秒,"c":[...]} 格式的歌曲元信息（作曲、编曲等）
 */
const YRC_JSON_META_REGEX = /^\{"t":\d+,"c":/

/**
 * 剥离歌词内容中的元数据头信息
 * 过滤掉 [ti:] [ar:] [al:] [by:] [offset:] [kana:] [roma:] 开头的行
 * 以及 YRC JSON 元数据行（{"t":...,"c":[...]}）
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
    if (YRC_JSON_META_REGEX.test(trimmed)) return false
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
 * 网易云 YRC 格式: [行起始ms,行时长ms](词1起始ms,词1时长ms,flag)词1(词2起始ms,词2时长ms,flag)词2...
 * QQ 音乐 YRC 格式: [行起始ms,行时长ms]词1(词1起始ms,词1时长ms)词2...
 * 替代 AMLL WASM parseYrc（该函数对此格式变体返回空 words）
 * @param content 剥离元数据后的 YRC 纯文本
 * @returns CoreLyricLine 数组（含逐字时间戳）
 */
function parseYrcCustom(content: string): CoreLyricLine[] {
  const rawLines = content.split(/\r?\n/)
  const result: CoreLyricLine[] = []

  // 匹配行级时间戳: [数字,数字]
  const lineTimeRegex = /^\[(\d+),(\d+)\]/
  // 匹配词级时间戳（网易云带 flag，QQ 不带 flag）
  const wordTimeRegexGlobal = /\((\d+),(\d+)(?:,\d+)?\)/g

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

    // 使用 matchAll 获取所有词级时间戳（避免 exec + g flag 的 lastIndex 追踪问题）
    const wordMatches = [...textPart.matchAll(wordTimeRegexGlobal)]

    const words: CoreLyricWord[] = []

    if (wordMatches.length > 0) {
      // 检测格式：网易云格式以 '(' 开头（文本在时间戳之后），QQ 格式以文本开头
      const isNeteaseFormat = textPart.startsWith('(')

      if (isNeteaseFormat) {
        // 网易云: (wordStart,wordDuration,flag)word1(wordStart,wordDuration,flag)word2...
        // 文本在每个时间戳 ')' 之后，直到下一个时间戳 '(' 之前
        for (let i = 0; i < wordMatches.length; i++) {
          const match = wordMatches[i]
          const wordStart = parseInt(match[1], 10)
          const wordDuration = parseInt(match[2], 10)

          const textStart = match.index! + match[0].length
          const textEnd =
            i + 1 < wordMatches.length ? wordMatches[i + 1].index! : textPart.length
          const wordText = textPart.slice(textStart, textEnd)

          if (wordText) {
            words.push({
              word: wordText,
              startTime: wordStart,
              endTime: wordStart + wordDuration,
              romanWord: '',
              obscene: false
            })
          }
        }
      } else {
        // QQ: 词1(wordStart,wordDuration)词2(wordStart,wordDuration)...
        // 文本在每个时间戳 '(' 之前
        let lastEnd = 0
        for (const match of wordMatches) {
          const wordStart = parseInt(match[1], 10)
          const wordDuration = parseInt(match[2], 10)

          const wordText = textPart.slice(lastEnd, match.index)
          lastEnd = match.index! + match[0].length

          if (wordText) {
            words.push({
              word: wordText,
              startTime: wordStart,
              endTime: wordStart + wordDuration,
              romanWord: '',
              obscene: false
            })
          }
        }
      }
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
