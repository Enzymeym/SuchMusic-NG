// 解码后的 PCM 音频数据结构，对应 Rust 中的 DecodedAudio
export interface DecodedAudio {
  // 采样率（Hz）
  sample_rate: number
  // 声道数
  channels: number
  // 交错布局的 PCM 浮点采样数据（f64 -> number）
  data: number[]
}

// 流式解码时的音频数据块结构
export interface AudioStreamChunk {
  // 采样率（Hz）
  sampleRate: number
  // 声道数
  channels: number
  // 一小段交错布局的 PCM 浮点采样数据
  data: number[]
  // 是否为最后一块
  finished: boolean
}

// 渲染进程中用于解码音频的 API 约定
export interface AudioDecoderApi {
  // 传入本地音频文件路径，返回解码后的 PCM 数据
  decodeAudio(filePath: string): Promise<DecodedAudio>
  // 启动流式解码，持续通过回调接收数据块
  startStream(
    filePath: string,
    onChunk: (chunk: AudioStreamChunk) => void
  ): void
  // 停止当前流式解码
  stopStream(): void
}
