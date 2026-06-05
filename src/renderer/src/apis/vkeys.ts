import axios from 'axios'

/**
 * QQ音乐 VKeys API 歌词响应结构
 * @property lrc - LRC 格式标准歌词
 * @property trans - LRC 格式翻译歌词
 * @property yrc - YRC 格式逐字歌词（含词级时间戳）
 */
export interface QQMusicLyricResponse {
  lrc: string
  trans: string
  yrc: string
}

const VKEYS_BASE_URL = 'https://api.vkeys.cn'

/**
 * 通过 VKeys API 获取 QQ 音乐的歌词、翻译和逐字歌词
 * 优先使用 IPC 代理请求（绕过 CORS），失败时回退到直接 axios 请求
 * @param mid QQ音乐歌曲 ID
 * @returns 包含 lrc/trans/yrc 的歌词对象，请求失败时各字段为空字符串
 */
export const fetchQQMusicLyric = async (mid: string): Promise<QQMusicLyricResponse> => {
  const emptyResult: QQMusicLyricResponse = { lrc: '', trans: '', yrc: '' }

  console.log(`[VKeys] ========== 开始获取 QQ 音乐歌词 ==========`)
  console.log(`[VKeys] 歌曲ID: ${mid}`)

  try {
    const url = `${VKEYS_BASE_URL}/v2/music/tencent/lyric?mid=${mid}`
    console.log(`[VKeys] 请求 URL: ${url}`)

    let data: any = null

    if (window.electron && window.electron.ipcRenderer) {
      try {
        console.log(`[VKeys] 尝试通过 IPC 代理请求...`)
        const result = await window.electron.ipcRenderer.invoke('proxy:request', {
          url,
          method: 'GET'
        })
        if (result.success) {
          data = result.data
          console.log(`[VKeys] IPC 代理请求成功`)
        } else {
          console.error(`[VKeys] IPC 代理请求失败:`, result.error)
        }
      } catch (e) {
        console.error(`[VKeys] IPC 代理调用异常:`, e)
      }
    }

    if (!data) {
      console.log(`[VKeys] IPC 代理未返回数据，回退到直接 axios 请求...`)
      const res = await axios.get(url)
      data = res.data
      console.log(`[VKeys] 直接 axios 请求完成`)
    }

    if (!data) {
      console.warn(`[VKeys] 未获取到任何响应数据`)
      return emptyResult
    }

    const extractLyric = (raw: any): string => {
      if (!raw) return ''
      if (typeof raw === 'string') return raw
      if (typeof raw.lyric === 'string') return raw.lyric
      return ''
    }

    if (data.code === 200 && data.data) {
      const body = data.data
      const lrc = extractLyric(body.lrc)
      const trans = extractLyric(body.trans)
      const yrc = extractLyric(body.yrc)

      console.log(`[VKeys] ========== 歌词获取成功 ==========`)
      console.log(`[VKeys] YRC 逐字歌词: ${yrc ? `✓ (${yrc.split('\n').length} 行, ${yrc.length} 字符)` : '✗ 无'}`)
      console.log(`[VKeys] LRC 标准歌词: ${lrc ? `✓ (${lrc.split('\n').length} 行, ${lrc.length} 字符)` : '✗ 无'}`)
      console.log(`[VKeys] 翻译歌词:     ${trans ? `✓ (${trans.split('\n').length} 行, ${trans.length} 字符)` : '✗ 无'}`)

      return { lrc, trans, yrc }
    }

    const lrc = extractLyric(data.lrc)
    const trans = extractLyric(data.trans)
    const yrc = extractLyric(data.yrc)

    console.log(`[VKeys] ========== 歌词获取完成（code=${data.code}）==========`)
    console.log(`[VKeys] YRC: ${yrc ? '✓' : '✗'} | LRC: ${lrc ? '✓' : '✗'} | 翻译: ${trans ? '✓' : '✗'}`)

    return { lrc, trans, yrc }
  } catch (error) {
    console.error(`[VKeys] 获取 QQ 音乐歌词失败:`, error)
    return emptyResult
  }
}
