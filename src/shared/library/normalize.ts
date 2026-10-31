/**
 * 路径与文本归一化。**不得引入任何 Node / Electron API**，因为渲染进程也会用到。
 */

/**
 * 统一成正斜杠路径，并去掉多余的分隔符与尾部分隔符。
 *
 * - Windows 的 `C:\Music\a.flac` 与 `C:/Music/a.flac` 视为同一路径
 * - 保留盘符与 UNC 前缀的大小写，只做分隔符层面的归一化
 * - 不解析 `..`，扫描得到的都是绝对路径
 */
export function toPosixPath(input: string): string {
  if (!input) return ''
  let p = input.replace(/\\/g, '/')
  // 保留 UNC 前缀 `//server/share`，只压缩 3 个以上连续斜杠
  p = p.replace(/\/{3,}/g, '//')
  p = p.replace(/(.)\/+$/, '$1')
  // NFC：macOS 上 HFS+ 返回 NFD，中文/带音标文件名会因此对不上
  return typeof p.normalize === 'function' ? p.normalize('NFC') : p
}

/** 盘符路径或 UNC 路径（大小写不敏感的文件系统） */
export function isCaseInsensitivePath(input: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(input) || /^\\\\/.test(input)
}

/**
 * 路径键：作为曲目主键与去重依据。
 *
 * 大小写不敏感文件系统上折叠大小写，避免用户把同一个目录以不同大小写
 * 加进扫描根后出现两份曲目。
 */
export function pathKey(input: string): string {
  const posix = toPosixPath(input)
  return isCaseInsensitivePath(input) ? posix.toLowerCase() : posix
}

/** 取父目录（Posix 语义，根目录返回空串） */
export function parentOf(posixPath: string): string {
  const p = posixPath
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return ''
  // `C:/` 这种盘符根
  if (/^[a-zA-Z]:$/.test(p.slice(0, idx))) return p.slice(0, idx + 1)
  return p.slice(0, idx)
}

/** 取最后一段目录名 */
export function baseName(posixPath: string): string {
  const p = posixPath.replace(/\/+$/, '')
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(idx + 1) : p
}

/** 全角 → 半角，同时处理全角空格 */
function toHalfWidth(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code === 0x3000) {
      out += ' '
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0)
    } else {
      out += input[i]
    }
  }
  return out
}

/**
 * 搜索用的文本归一化：
 * 全角转半角、去零宽字符、小写、空白折叠。
 *
 * 保留标点与中文字符本身 —— 用户会搜「七里香」也会搜「jay chou」，
 * 去掉标点反而会让「Don't Stop」这类标题搜不到。
 */
export function normalizeSearchText(input: string): string {
  if (!input) return ''
  return toHalfWidth(input)
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}
