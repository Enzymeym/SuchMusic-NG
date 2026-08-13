import { ipcMain, app, type IpcMainEvent } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { loadNativeDecoder } from '../services/nativeDecoder'
import { getActiveNeteaseCookie } from '../services/neteaseService'

/** 记录待清理的临时下载文件路径 */
const tempDownloadPaths = new Set<string>()

/** 根据 Content-Type / URL 后缀推断音频扩展名 */
function inferAudioExt(contentType: string | null, url: string): string {
  const mimeMap: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac'
  }
  if (contentType) {
    const type = contentType.split(';')[0].trim().toLowerCase()
    if (mimeMap[type]) return mimeMap[type]
  }
  const pathname = url.split('?')[0]
  const match = /\.([a-z0-9]{2,4})$/i.exec(pathname)
  if (match) return match[1].toLowerCase()
  return 'mp3'
}

export function registerAudioHandlers(): void {
  // 初始化本地音频解码 IPC，调用 native/symphonia_napi_decoder.node
  const { decode_audio_to_pcm, decode_audio_stream } = loadNativeDecoder()

  ipcMain.handle('audio:decode', async (_event, filePath: string) => {
    // 调用本地解码器，将路径交给 Rust NAPI 插件处理
    const result = await decode_audio_to_pcm(filePath)
    return result
  })

  // 流式解码：一边解码一边通过 IPC 推送音频数据块
  ipcMain.on('audio:decode-stream:start', (event, filePath: string) => {
    if (!decode_audio_stream) {
      event.sender.send('audio:decode-stream:error', '当前 native 模块不支持流式解码')
      return
    }

    const webContents = event.sender
    let cancelled = false

    const stopChannel = 'audio:decode-stream:stop'
    const stopHandler = (stopEvent: IpcMainEvent): void => {
      if (stopEvent.sender === webContents) {
        cancelled = true
        webContents.send('audio:decode-stream:stopped')
        ipcMain.removeListener(stopChannel, stopHandler)
      }
    }

    ipcMain.on(stopChannel, stopHandler)

    try {
      decode_audio_stream(filePath, (chunkRaw: unknown) => {
        if (cancelled) return

        const chunk = chunkRaw as {
          sample_rate?: number
          sampleRate?: number
          channels: number
          data: number[]
          finished?: boolean
        }

        const sampleRate = chunk.sample_rate ?? chunk.sampleRate ?? 44_100
        const basePayload = {
          sampleRate,
          channels: chunk.channels,
          data: Array.isArray(chunk.data) ? chunk.data : [],
          finished: !!chunk.finished
        }

        // 兜底：如果 native 没有正确标记 finished，
        // 则当数据块长度小于满块大小时认为是最后一块
        const framesPerChunk = 2048
        const expectedSamplesPerChunk = framesPerChunk * basePayload.channels
        const isLastChunk =
          basePayload.finished ||
          basePayload.data.length < expectedSamplesPerChunk

        const payload = {
          ...basePayload,
          finished: isLastChunk
        }

        webContents.send('audio:decode-stream:chunk', payload)

        if (isLastChunk) {
          webContents.send('audio:decode-stream:finished')
          ipcMain.removeListener(stopChannel, stopHandler)
        }
      })
    } catch (error) {
      console.error('audio:decode-stream failed:', error)
      webContents.send('audio:decode-stream:error', String(error))
      ipcMain.removeListener(stopChannel, stopHandler)
    }
  })

  // 读取本地音频文件为二进制数据，提供给渲染进程创建 Blob URL
  ipcMain.handle('audio:load-file', async (_event, filePath: string) => {
    const data = await fs.readFile(filePath)
    // 仅返回底层 ArrayBuffer，便于在渲染进程直接创建 Blob
    return data.buffer
  })

  // 下载远程音频到临时文件，返回本地路径（供渲染进程在线播放使用）
  ipcMain.handle('audio:download-to-temp', async (_event, url: string) => {
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new Error(`无效的音频地址: ${url}`)
    }
    // 附加登录态：网易云登录后返回的 VIP/高音质 CDN 地址需携带同一 Cookie 才能下载，
    // 否则裸请求会 403 导致「在线音频加载失败」
    const cookie = getActiveNeteaseCookie()
    const headers: Record<string, string> = {}
    if (cookie) headers['Cookie'] = cookie
    headers['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    headers['Referer'] = 'https://music.163.com'
    const resp = await fetch(url, { headers })
    if (!resp.ok) {
      throw new Error(`下载音频失败: HTTP ${resp.status}`)
    }
    const contentType = resp.headers.get('content-type')
    const ext = inferAudioExt(contentType, url)
    const fileName = `ncm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const targetPath = join(app.getPath('temp'), fileName)

    const buf = Buffer.from(await resp.arrayBuffer())
    await fs.writeFile(targetPath, buf)
    tempDownloadPaths.add(targetPath)
    return targetPath
  })

  // 清理播放用临时文件
  ipcMain.handle('audio:cleanup-temp', async (_event, filePath: string) => {
    if (!filePath) return
    tempDownloadPaths.delete(filePath)
    try {
      await fs.unlink(filePath)
    } catch {
      // 文件不存在或已删除时静默忽略
    }
  })
}
