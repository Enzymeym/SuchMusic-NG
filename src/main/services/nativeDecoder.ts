import { tryLoadNativeModule as tryLoadNative } from './nativeModuleLoader'

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

/**
 * 加载本地 native 解码插件（symphonia_napi_decoder.node）
 *
 * 历史实现按「开发 → native/」「生产 → resources/native/」二选一，导致开发
 * 环境长期加载的是 native/ 下的旧构建（2.27MB / 2 月），与随包发布的
 * resources/native 版本（2.05MB / 7 月）行为不一致。现统一由
 * nativeModuleLoader 按候选目录顺序探测，优先使用 resources/native。
 */
export function loadNativeDecoder(): {
  decode_audio_to_pcm: (path: string) => DecodedAudio
  decode_audio_stream: ((path: string, cb: (chunk: unknown) => void) => void) | null
} {
  const loaded = tryLoadNative<NativeDecoderModule>({
    label: 'symphonia_napi_decoder',
    filenames: ['symphonia_napi_decoder.node']
  })

  if (!loaded) {
    console.error('加载本地解码器失败：未找到 symphonia_napi_decoder.node')
    return notAvailable()
  }

  try {
    const decodeFn = resolveDecodeFn(loaded.module)
    const decodeStreamFn = resolveDecodeStreamFn(loaded.module)
    return { decode_audio_to_pcm: decodeFn, decode_audio_stream: decodeStreamFn }
  } catch (error) {
    console.error('加载本地解码器失败:', error)
    return notAvailable()
  }
}

// 降级处理：返回抛出错误的函数，而不是让应用崩溃
function notAvailable(): {
  decode_audio_to_pcm: (path: string) => DecodedAudio
  decode_audio_stream: ((path: string, cb: (chunk: unknown) => void) => void) | null
} {
  return {
    decode_audio_to_pcm: () => {
      throw new Error('Native decoder not available')
    },
    decode_audio_stream: null
  }
}
