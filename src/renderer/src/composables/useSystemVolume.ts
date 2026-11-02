import { ref, watch } from 'vue'
import { audioEngine } from '../audio/audio-engine'
import { useAudioEngine } from './useAudioEngine'

/**
 * 系统音量轮询（低频增压 / 低音量补偿共用）
 * ===========================================
 *
 * 只要有任一功能需要「系统主音量」就以 500ms 间隔拉取 Windows 系统音量
 * （audio-napi getSystemVolume，<1ms 的廉价 COM 调用），平滑后推给音频引擎：
 *   - 低频增压力度联动：Web Audio 链内部按 vbVolumeFactor 换算 wet，
 *     WASAPI 由 audio-engine 重发解析后的 (wetGain, gamma, sigma)；
 *   - 低音量补偿：实际响度 = 软件音量 × 系统音量，DSP 按该值计算高低频提升，
 *     界面上的「补偿基准」也读同一口径。
 *
 * 平滑策略：EMA(α=0.25)，τ ≈ 轮询间隔 × 4 ≈ 2s，力度变化缓入缓出；
 * 死区（2 个百分点）由 DSP 链侧处理，这里只做平滑。
 * 首次成功读到的值直接对齐，避免启动时从旧值缓慢爬升。
 *
 * 获取失败（非 Windows / 无默认设备）时 available = false，
 * 低频增压按「联动不可用」处理（factor = 1.0 固定档位），
 * 低音量补偿回退为只按软件音量。
 */

const POLL_INTERVAL_MS = 500
/** EMA 平滑系数：每次轮询向新值移动 25% */
const EMA_ALPHA = 0.25

/** 系统音量是否可读：null = 尚未探测，false = 不可用（联动按关闭处理） */
const available = ref<boolean | null>(null)
/** 最近一次读到的原始系统音量（0..1），供 UI 显示 */
const systemVolume = ref(1)
/** EMA 平滑后的系统音量（实际下发的值） */
const smoothedVolume = ref(1)

let timer: ReturnType<typeof setInterval> | null = null
/** 已收到的有效采样数；0 表示首次（直接对齐不平滑） */
let sampleCount = 0

async function pollOnce(): Promise<void> {
  try {
    const api = (globalThis as any).window?.api?.audioEngine
    const res = api && typeof api.getSystemVolume === 'function' ? await api.getSystemVolume() : null
    const v: unknown = res?.success ? res.volume : null
    if (typeof v === 'number' && Number.isFinite(v)) {
      available.value = true
      systemVolume.value = Math.min(1, Math.max(0, v))
      smoothedVolume.value =
        sampleCount === 0
          ? systemVolume.value
          : smoothedVolume.value + EMA_ALPHA * (systemVolume.value - smoothedVolume.value)
      sampleCount++
      audioEngine.setVirtualBassSystemVolume(smoothedVolume.value)
      audioEngine.setLoudnessSystemVolume(smoothedVolume.value)
    } else {
      available.value = false
      // 读不到系统音量：低音量补偿回退为只按软件音量
      audioEngine.setLoudnessSystemVolume(null)
    }
  } catch {
    available.value = false
    audioEngine.setLoudnessSystemVolume(null)
  }
}

function startPolling(): void {
  if (timer) return
  sampleCount = 0
  void pollOnce()
  timer = setInterval(() => {
    void pollOnce()
  }, POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  // 停止轮询说明两个功能都不再需要系统音量，补偿基准退回软件音量
  audioEngine.setLoudnessSystemVolume(null)
}

let watched = false

/** 确保轮询启停与「低频增压联动 / 低音量补偿」状态联动（模块级单例，只挂一次） */
function ensureStateWatch(): void {
  if (watched) return
  watched = true
  const { virtualBass, loudness } = useAudioEngine()
  watch(
    () =>
      (virtualBass.value.enabled && virtualBass.value.followSystemVolume) ||
      loudness.value.followVolume === true,
    (active) => {
      if (active) startPolling()
      else stopPolling()
    },
    { immediate: true }
  )
}

/**
 * 读取系统音量联动状态。
 * 轮询由 useAudioEngine 的 virtualBass 状态驱动，本函数只暴露只读状态供 UI 显示。
 */
export function useSystemVolume() {
  ensureStateWatch()
  return { available, systemVolume, smoothedVolume }
}
