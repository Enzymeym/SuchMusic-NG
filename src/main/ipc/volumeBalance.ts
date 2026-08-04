/**
 * 音量平衡（本地响度分析）IPC 处理器
 *
 * 使用 native 解码器一次性解码整首歌曲为 PCM，再通过 EBU R128 分析器
 * 增量计算集成响度（LUFS）。单首歌曲内存占用约 84MB（4 分钟立体声），可接受。
 */

import { ipcMain } from 'electron'
import { loadNativeDecoder } from '../services/nativeDecoder'
import { LoudnessAnalyzer } from '../services/loudnessAnalyzer'

export function registerVolumeBalanceHandlers(): void {
  ipcMain.handle('volume-balance:analyze-file', async (_event, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'filePath 无效' }
    }

    const { decode_audio_to_pcm } = loadNativeDecoder()

    let decoded: { sample_rate: number; channels: number; data: number[] }
    try {
      decoded = decode_audio_to_pcm(filePath)
    } catch (error) {
      console.error('[VolumeBalance] 解码失败:', filePath, error)
      return { success: false, error: `解码失败: ${String(error)}` }
    }

    if (!decoded || !Array.isArray(decoded.data) || decoded.data.length === 0) {
      return { success: false, error: '解码结果为空' }
    }

    const analyzer = new LoudnessAnalyzer()
    analyzer.pushChunk({
      sampleRate: decoded.sample_rate ?? 44_100,
      channels: decoded.channels ?? 2,
      data: decoded.data
    })

    const lufs = analyzer.getIntegratedLoudness()
    if (lufs === null || !Number.isFinite(lufs)) {
      return { success: false, error: '无法计算响度（音频过短或全部为静音）' }
    }

    return { success: true, lufs: Math.round(lufs * 10) / 10 }
  })
}
