import type {
  AudioDecoderApi,
  AudioStreamChunk,
  DecodedAudio
} from './audio-decoder.types'

const CHANNEL_DECODE_AUDIO = 'audio:decode'
const CHANNEL_STREAM_START = 'audio:decode-stream:start'
const CHANNEL_STREAM_STOP = 'audio:decode-stream:stop'
const CHANNEL_STREAM_CHUNK = 'audio:decode-stream:chunk'
const CHANNEL_STREAM_FINISHED = 'audio:decode-stream:finished'
const CHANNEL_STREAM_ERROR = 'audio:decode-stream:error'

// 当前活跃的流式解码回调
let currentStreamHandler: ((chunk: AudioStreamChunk) => void) | null = null

// 监听主进程推送的音频数据块
window.electron.ipcRenderer.on(
  CHANNEL_STREAM_CHUNK,
  (_event, payload: AudioStreamChunk) => {
    if (currentStreamHandler) {
      currentStreamHandler(payload)
    }
  }
)

// 调用主进程中封装的本地解码器（基于 symphonia-napi-decoder）
export const audioDecoderApi: AudioDecoderApi = {
  async decodeAudio(filePath: string): Promise<DecodedAudio> {
    // 通过 Electron 的 ipcRenderer.invoke 调用主进程，实际解码逻辑在主进程中完成
    const result = await window.electron.ipcRenderer.invoke(
      CHANNEL_DECODE_AUDIO,
      filePath
    )

    return result as DecodedAudio
  },

  startStream(filePath: string, onChunk: (chunk: AudioStreamChunk) => void): void {
    // 启动前先停止可能存在的旧流
    this.stopStream()

    currentStreamHandler = onChunk

    // 监听流结束和错误，自动清理回调
    const handleFinished = (): void => {
      currentStreamHandler = null
      window.electron.ipcRenderer.removeListener(
        CHANNEL_STREAM_FINISHED,
        handleFinished
      )
      window.electron.ipcRenderer.removeListener(
        CHANNEL_STREAM_ERROR,
        handleError
      )
    }

    const handleError = (_event: unknown, errorMessage: string): void => {
      console.error('audio:decode-stream error:', errorMessage)
      handleFinished()
    }

    window.electron.ipcRenderer.once(
      CHANNEL_STREAM_FINISHED,
      handleFinished
    )
    window.electron.ipcRenderer.once(CHANNEL_STREAM_ERROR, handleError)

    // 通过 send 向主进程发起流式解码请求
    window.electron.ipcRenderer.send(CHANNEL_STREAM_START, filePath)
  },

  stopStream(): void {
    if (!currentStreamHandler) {
      return
    }

    currentStreamHandler = null
    window.electron.ipcRenderer.send(CHANNEL_STREAM_STOP)
  }
}
