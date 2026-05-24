import { decodeName } from './util'

// https://github.com/lyswhut/lx-music-desktop/issues/296#issuecomment-683285784
const enc_key = new Uint8Array(
  [0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69]
)

const decodeLyric = async (str) => {
  if (!str.length) return ''
  
  // 使用atob解码base64
  const binaryString = atob(str)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  
  // 跳过前4个字节
  const buf_str = bytes.subarray(4)
  
  // XOR解密
  for (let i = 0, len = buf_str.length; i < len; i++) {
    buf_str[i] = buf_str[i] ^ enc_key[i % 16]
  }
  
  // 使用浏览器原生 DecompressionStream 进行 zlib 解压
  // zlib 格式：2字节头 + deflate数据 + 4字节Adler-32校验
  const deflateData = buf_str.subarray(2) // 跳过 zlib 头
  const decompressedStream = new Blob([deflateData])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  const result = await new Response(decompressedStream).text()
  return result
}

const headExp = /^.*\[id:\$\w+\]\n/

const parseLyric = (str) => {
  str = str.replace(/\r/g, '')
  if (headExp.test(str)) str = str.replace(headExp, '')
  const trans = str.match(/\[language:([\w=\\\/+]+)\]/)
  let lyric
  let rlyric
  let tlyric
  if (trans) {
    str = str.replace(/\[language:[\w=\\\/+]+\]\n/, '')
    // 使用atob解码base64
    const transBinaryString = atob(trans[1])
    const transBytes = new Uint8Array(transBinaryString.length)
    for (let i = 0; i < transBinaryString.length; i++) {
      transBytes[i] = transBinaryString.charCodeAt(i)
    }
    const json = JSON.parse(new TextDecoder().decode(transBytes))
    for (const item of json.content) {
      switch (item.type) {
        case 0:
          rlyric = item.lyricContent
          break
        case 1:
          tlyric = item.lyricContent
          break
      }
    }
  }
  let i = 0
  let crlyric = str.replace(/\[((\d+),\d+)\].*/g, (str) => {
    const result = str.match(/\[((\d+),\d+)\].*/)
    const lineStartTime = parseInt(result[2]) // 行开始时间
    let time = lineStartTime
    const ms = time % 1000
    time /= 1000
    const m = parseInt(time / 60)
      .toString()
      .padStart(2, '0')
    time %= 60
    const s = parseInt(time).toString().padStart(2, '0')
    time = `${m}:${s}.${ms}`
    if (rlyric) rlyric[i] = `[${time}]${rlyric[i]?.join('') ?? ''}`
    if (tlyric) tlyric[i] = `[${time}]${tlyric[i]?.join('') ?? ''}`
    i++

    // 保持原始的 [start,duration] 格式，将相对时间戳转换为绝对时间戳
    const processedStr = str.replace(/<(\d+),(\d+),(\d+)>/g, (match, start, duration, param) => {
      const absoluteStart = lineStartTime + parseInt(start)
      return `(${absoluteStart},${duration},${param})`
    })

    return processedStr
  })
  rlyric = rlyric ? rlyric.join('\n') : ''
  tlyric = tlyric ? tlyric.join('\n') : ''
  // 保留完整的时间戳格式 (startTime,duration,param)
  crlyric = crlyric.replace(/<(\d+,\d+,\d+)>/g, '($1)')
  crlyric = decodeName(crlyric)
  lyric = crlyric.replace(/\(\d+,\d+,\d+\)/g, '')
  rlyric = decodeName(rlyric)
  tlyric = decodeName(tlyric)
  return {
    lyric,
    tlyric,
    rlyric,
    crlyric
  }
}

export const decodeKrc = async (data) => {
  return decodeLyric(data).then(parseLyric)
}
