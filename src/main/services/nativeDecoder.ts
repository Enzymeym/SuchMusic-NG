import { app } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

// 解码后的 PCM 音频数据结构，需与 Rust 侧保持一致
export interface DecodedAudio {
  sample_rate: number
  channels: number
  data: number[]
}

// native 模块导出结构定义
export interface NativeDecoderModule {
  decode_audio_to_pcm?: (path: string) => DecodedAudio
  decodeAudioToPcm?: (path: string) => DecodedAudio
  decode_audio_stream?: (path: string, cb: (chunk: unknown) => void) => void
  decodeAudioStream?: (path: string, cb: (chunk: unknown) => void) => void
  default?: NativeDecoderModule
}

// 获取 native 插件在当前环境下的实际路径（开发 / 生产）
function getNativeDecoderPath(): string {
  // 开发环境：直接从项目根目录下的 native 目录加载
  if (is.dev) {
    return join(app.getAppPath(), 'native', 'symphonia_napi_decoder.node')
  }

  // 生产环境：从 resourcesPath/ native 目录加载（通过 extraResources 打包过去）
  return join(process.resourcesPath, 'native', 'symphonia_napi_decoder.node')
}

// 从 native 模块中解析出真正的解码函数
function resolveDecodeFn(nativeModule: NativeDecoderModule): (path: string) => DecodedAudio {
  // 兼容 snake_case / camelCase 以及 default 导出两种情况
  const candidate =
    nativeModule.decode_audio_to_pcm ||
    nativeModule.decodeAudioToPcm ||
    nativeModule.default?.decode_audio_to_pcm ||
    nativeModule.default?.decodeAudioToPcm

  if (typeof candidate !== 'function') {
    console.error('[symphonia_napi_decoder] invalid exports:', nativeModule)
    throw new Error('symphonia_napi_decoder.node 未导出有效的解码函数')
  }

  return candidate
}

// 从 native 模块中解析出流式解码函数（如果存在）
function resolveDecodeStreamFn(
  nativeModule: NativeDecoderModule
): ((path: string, cb: (chunk: unknown) => void) => void) | null {
  const candidate =
    nativeModule.decode_audio_stream ||
    nativeModule.decodeAudioStream ||
    nativeModule.default?.decode_audio_stream ||
    nativeModule.default?.decodeAudioStream

  if (typeof candidate !== 'function') {
    return null
  }

  return candidate
}

// 加载本地 native 解码插件（symphonia_napi_decoder.node）
export function loadNativeDecoder(): {
  decode_audio_to_pcm: (path: string) => DecodedAudio
  decode_audio_stream: ((path: string, cb: (chunk: unknown) => void) => void) | null
} {
  const nativePath = getNativeDecoderPath()
  // 使用 require 载入 napi 插件
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try {
    const nativeModule = require(nativePath) as NativeDecoderModule
    const decodeFn = resolveDecodeFn(nativeModule)
    const decodeStreamFn = resolveDecodeStreamFn(nativeModule)
    return { decode_audio_to_pcm: decodeFn, decode_audio_stream: decodeStreamFn }
  } catch (error) {
    console.error('加载本地解码器失败:', error)
    // 降级处理：返回抛出错误的函数，而不是让应用崩溃
    return {
      decode_audio_to_pcm: () => {
        throw new Error('Native decoder not available')
      },
      decode_audio_stream: null
    }
  }
}
