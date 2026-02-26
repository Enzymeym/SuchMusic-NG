import { ipcMain, type IpcMainEvent } from 'electron'
import { promises as fs } from 'fs'
import { loadNativeDecoder } from '../services/nativeDecoder'

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
}
