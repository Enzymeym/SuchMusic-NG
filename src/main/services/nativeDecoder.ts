import { tryLoadNativeModule as tryLoadNative } from './nativeModuleLoader'

/**
 * 解码后的 PCM 音频数据。
 *
 * `data` 的实际形态取决于加载到的二进制版本：
 * - 新二进制（2026-10 之后）：`Buffer`（Node `Buffer` / `Uint8Array`），内容是
 *   **f32 小端原始字节**，每采样 4 字节。这是零逐元素转换的通道，用 `normalizePcmData`
 *   取出 `Float32Array` 视图即可，不要自己 `Array.from`。
 * - 旧二进制：`number[]`（`Vec<f64>` 逐元素转来的 JS 数组）。仅作兼容保留。
 */
export interface DecodedAudio {
  sample_rate?: number
  sampleRate?: number
  channels: number
  data: unknown
}

/** 归一化后的 PCM 数据（交错布局，单声道或立体声） */
export type NormalizedPcm = Float32Array | number[]

/**
 * 把原生侧返回的 PCM 载荷统一成可按下标读取的形式。
 *
 * 注意 `Array.isArray` 对 `Float32Array` / `Buffer` **恒为 false** —— 历史上多处用它
 * 做「有没有数据」的判据，切到二进制载荷后会静默把音频当成空数组。一律走这里。
 */
export function normalizePcmData(data: unknown): NormalizedPcm | null {
  if (!data) return null
  if (Array.isArray(data)) return data as number[]
  if (data instanceof ArrayBuffer) {
    return new Float32Array(data)
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView
    if (view instanceof Float32Array) return view

    // Buffer / Uint8Array：f32 小端字节流
    const byteLength = view.byteLength - (view.byteLength % 4)
    if (byteLength <= 0) return new Float32Array(0)

    const buffer = view.buffer
    const offset = view.byteOffset
    // `new Float32Array(buffer, offset)` 要求 offset 4 字节对齐；
    // Buffer 池化分配的偏移不保证对齐，未对齐时拷一份再取视图。
    if (offset % 4 === 0) {
      return new Float32Array(buffer, offset, byteLength / 4)
    }
    const aligned = new ArrayBuffer(byteLength)
    new Uint8Array(aligned).set(new Uint8Array(buffer, offset, byteLength))
    return new Float32Array(aligned)
  }
  return null
}

/** 取采样率（兼容 snake_case / camelCase 两种导出风格） */
export function getSampleRate(
  audio: { sample_rate?: number; sampleRate?: number } | null | undefined,
  fallback = 44_100
): number {
  const value = Number(audio?.sample_rate ?? audio?.sampleRate)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// native 模块导出结构定义
export interface NativeDecoderModule {
  decode_audio_to_pcm?: (path: string) => DecodedAudio | Promise<DecodedAudio>
  decodeAudioToPcm?: (path: string) => DecodedAudio | Promise<DecodedAudio>
  decode_audio_stream?: (path: string, cb: (chunk: unknown) => void) => void
  decodeAudioStream?: (path: string, cb: (chunk: unknown) => void) => void
  default?: NativeDecoderModule
}

export interface NativeDecoder {
  /**
   * 整曲解码。新二进制的实现是 `AsyncTask`，返回 Promise；
   * 旧二进制同步返回对象 —— 一律用 `await` 调用，两种都成立。
   */
  decode_audio_to_pcm: (path: string) => DecodedAudio | Promise<DecodedAudio>
  decode_audio_stream: ((path: string, cb: (chunk: unknown) => void) => void) | null
}

/** 从 native 模块中解析出真正的解码函数 */
function resolveDecodeFn(
  nativeModule: NativeDecoderModule
): (path: string) => DecodedAudio | Promise<DecodedAudio> {
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

/** 从 native 模块中解析出流式解码函数（如果存在） */
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
 * 成功加载的模块实例缓存。
 *
 * `require()` 本身有路径级缓存，但历史实现每次调用都会重新走一遍「候选目录探测 +
 * existsSync + 打印日志」，响度分析每个文件调两次 → 终端里刷出一串「加载成功」，
 * 看起来像重复加载/泄漏。这里缓存成功结果（**不缓存失败**，失败仍允许下次重试）。
 */
let cachedDecoder: NativeDecoder | null = null

/**
 * 加载本地 native 解码插件（symphonia_napi_decoder.node）
 *
 * 历史实现按「开发 → native/」「生产 → resources/native/」二选一，导致开发
 * 环境长期加载的是 native/ 下的旧构建（2.27MB / 2 月），与随包发布的
 * resources/native 版本（2.05MB / 7 月）行为不一致。现统一由
 * nativeModuleLoader 按候选目录顺序探测，优先使用 resources/native。
 */
export function loadNativeDecoder(): NativeDecoder {
  if (cachedDecoder) return cachedDecoder

  const loaded = tryLoadNative<NativeDecoderModule>({
    label: 'symphonia_napi_decoder',
    filenames: ['symphonia_napi_decoder.node']
  })

  if (!loaded) {
    console.error('加载本地解码器失败：未找到 symphonia_napi_decoder.node')
    return notAvailable()
  }

  try {
    cachedDecoder = {
      decode_audio_to_pcm: resolveDecodeFn(loaded.module),
      decode_audio_stream: resolveDecodeStreamFn(loaded.module)
    }
    return cachedDecoder
  } catch (error) {
    console.error('加载本地解码器失败:', error)
    return notAvailable()
  }
}

/** 清空缓存（原生模块重新编译后热更、或单测需要重载时使用） */
export function resetNativeDecoderCache(): void {
  cachedDecoder = null
}

// 降级处理：返回抛出错误的函数，而不是让应用崩溃
function notAvailable(): NativeDecoder {
  return {
    decode_audio_to_pcm: () => {
      throw new Error('Native decoder not available')
    },
    decode_audio_stream: null
  }
}
