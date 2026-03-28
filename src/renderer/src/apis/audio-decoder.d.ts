// 解码后的 PCM 音频数据结构，对应 Rust 中的 DecodedAudio
export interface DecodedAudio {
  // 采样率（Hz）
  sample_rate: number
  // 声道数
  channels: number
  // 交错布局的 PCM 浮点采样数据（f64 -> number）
  data: number[]
}

// 渲染进程中用于解码音频的 API 约定
export interface AudioDecoderApi {
  // 传入本地音频文件路径，返回解码后的 PCM 数据
  decodeAudio(filePath: string): Promise<DecodedAudio>
}

