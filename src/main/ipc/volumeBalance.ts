/**
 * 音量平衡（本地响度分析）IPC 处理器
 *
 * 优先使用 native 流式解码（decode_audio_stream）分块喂给 EBU R128 分析器，
 * 内存占用恒定在「单块 2048 帧」量级。
 *
 * 旧实现一次性 decode_audio_to_pcm 把整首歌解成 `Vec<f64>` → JS `number[]`，
 * 4 分钟立体声约 2100 万样本，Rust 侧 Vec 与 JS 数组各占约 170MB，
 * 渲染层并发 2 时峰值可达 600MB+。整曲解码仅作为流式不可用时的兜底。
 *
 * ⚠️ `decode_audio_stream`（resources/native/symphonia_napi_decoder.node）在特定环境
 * 会「回调若干块后彻底停住、且不置 finished」（离线复现：3 秒 FLAC 只收到 7 块，300 秒
 * WAV 收到 602 块）。该接口此前在渲染层没有任何调用方，所以线上一直未暴露。
 * 因此这里把流式做成「试探 + 熔断」：首块超时或中途停摆即判定不可用，本进程后续
 * 全部直接走整曲解码，绝不会出现「每首歌先白等 10 秒再回退」。
 */

import { ipcMain } from 'electron'
import { loadNativeDecoder } from '../services/nativeDecoder'
import { LoudnessAnalyzer } from '../services/loudnessAnalyzer'

/** 首块超时：解码器启动后迟迟不回调，说明流式路径不可用 */
const STREAM_FIRST_CHUNK_TIMEOUT_MS = 2_500
/** 中途停摆超时：正常解码块间隔是毫秒级，4 秒没有任何数据即判定卡死 */
const STREAM_IDLE_TIMEOUT_MS = 4_000
/** 与 native 侧一致的分块帧数（用于识别「末块」） */
const FRAMES_PER_CHUNK = 2048

/**
 * 流式解码熔断开关：连续多个文件都判定流式不可用后，本进程后续文件直接走整曲解码，
 * 避免「每个文件都要等一次超时」的放大效应。用「连续」而不是「一次」，
 * 是为了让单个损坏文件不至于把整个会话的流式路径永久关掉。
 */
const STREAM_FAIL_STREAK_LIMIT = 2
let streamDisabled = false
let streamFailStreak = 0

/**
 * 流式解码并增量累计响度。
 * @returns true=流式成功完成；false=需要回退整曲解码
 */
function analyzeByStream(filePath: string, analyzer: LoudnessAnalyzer): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (streamDisabled) {
      resolve(false)
      return
    }

    let decodeStream: ReturnType<typeof loadNativeDecoder>['decode_audio_stream']
    try {
      decodeStream = loadNativeDecoder().decode_audio_stream
    } catch {
      resolve(false)
      return
    }
    if (typeof decodeStream !== 'function') {
      resolve(false)
      return
    }

    let settled = false
    let gotChunk = false
    let lastDataAt = Date.now()
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearInterval(watchdog)
      if (ok) {
        streamFailStreak = 0
      } else {
        streamFailStreak++
        if (streamFailStreak >= STREAM_FAIL_STREAK_LIMIT && !streamDisabled) {
          streamDisabled = true
          console.warn(
            `[VolumeBalance] 流式解码连续 ${streamFailStreak} 次不可用，本次运行后续文件改用整曲解码:`,
            filePath
          )
        }
      }
      resolve(ok)
    }
    const watchdog = setInterval(() => {
      const limit = gotChunk ? STREAM_IDLE_TIMEOUT_MS : STREAM_FIRST_CHUNK_TIMEOUT_MS
      if (Date.now() - lastDataAt > limit) finish(false)
    }, 500)
    // 看门狗不应阻止进程退出
    watchdog.unref?.()

    try {
      decodeStream(filePath, (chunkRaw: unknown) => {
        if (settled) return
        const chunk = chunkRaw as {
          sample_rate?: number
          sampleRate?: number
          channels?: number
          data?: number[]
          finished?: boolean
        } | null
        const data = Array.isArray(chunk?.data) ? chunk!.data! : []
        const channels = Math.max(1, Number(chunk?.channels) || 2)
        if (data.length > 0) {
          gotChunk = true
          lastDataAt = Date.now()
          analyzer.pushChunk({
            sampleRate: Number(chunk?.sample_rate ?? chunk?.sampleRate) || 44_100,
            channels,
            data
          })
        }
        // 与 audio.ts 的流式判据一致：native 标记 finished，或出现未满块
        const isLast = !!chunk?.finished || (data.length > 0 && data.length < FRAMES_PER_CHUNK * channels)
        if (isLast) finish(true)
      })
    } catch {
      finish(false)
    }
  })
}

/** 兜底：整曲解码后一次性分析（内存峰值高，仅在流式不可用时使用） */
function analyzeFullDecode(filePath: string): number | null {
  const { decode_audio_to_pcm } = loadNativeDecoder()
  const decoded = decode_audio_to_pcm(filePath)
  if (!decoded || !Array.isArray(decoded.data) || decoded.data.length === 0) return null
  const analyzer = new LoudnessAnalyzer()
  analyzer.pushChunk({
    sampleRate: decoded.sample_rate ?? 44_100,
    channels: decoded.channels ?? 2,
    data: decoded.data
  })
  return analyzer.getIntegratedLoudness()
}

export function registerVolumeBalanceHandlers(): void {
  ipcMain.handle('volume-balance:analyze-file', async (_event, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'filePath 无效' }
    }

    // 优先流式：内存恒定；失败（native 不支持 / 解码出错 / 超时）再回退整曲解码
    const streamAnalyzer = new LoudnessAnalyzer()
    let lufs: number | null = null
    if (await analyzeByStream(filePath, streamAnalyzer)) {
      lufs = streamAnalyzer.getIntegratedLoudness()
    }

    if (lufs === null || !Number.isFinite(lufs)) {
      try {
        lufs = analyzeFullDecode(filePath)
      } catch (error) {
        console.error('[VolumeBalance] 解码失败:', filePath, error)
        return { success: false, error: `解码失败: ${String(error)}` }
      }
    }

    if (lufs === null || !Number.isFinite(lufs)) {
      return { success: false, error: '无法计算响度（音频过短或全部为静音）' }
    }

    return { success: true, lufs: Math.round(lufs * 10) / 10 }
  })
}
