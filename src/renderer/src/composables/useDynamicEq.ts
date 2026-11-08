import { ref, watch, onScopeDispose, effectScope } from 'vue'
import { useSettingsStore } from '../stores/settingsStore'
import { usePlayerStore } from '../stores/playerStore'
import { audioEngine } from '../audio/audio-engine'
import {
  DynamicEqEngine,
  aggregateBandLevels,
  SHAPE_TARGETS,
  EFFICIENCY_PRESETS,
  type DynamicEqShape
} from '../audio/dynamic-eq'
import { useAudioEngine, type DynamicEqParams } from './useAudioEngine'

/**
 * useDynamicEq — 动态 EQ 运行器（动态延伸 + 分析微调）
 *
 * 1. 不静态套用走势：启用时曲线仍等于用户基准，delta 从 0 起；
 * 2. 播放中由分析循环推进 DynamicEqEngine，delta 逐步延伸向走势目标
 *    （按效果强度缩放）并叠加逐曲自适应微调；
 * 3. 每拍经统一写入路径 setEqGains(base + delta) 下发（写 eqBands + DSP），
 *    曲线图实时显示正在"生长"的修正曲线；
 * 4. 停止 / 切换后端时恢复基准曲线。
 *
 * 全局单例（effectScope detached），两个音效面板入口共用。
 */

/** 定时器最小节拍（ms）：实际分析间隔由效率档决定，这里只定轮询粒度 */
const TICK_MS = 30

function createDynamicEqRunner() {
  const engineApi = useAudioEngine()
  const settingsStore = useSettingsStore()
  const playerStore = usePlayerStore()

  const dynamicEqEngine = new DynamicEqEngine()

  /** 最新一帧频谱（Web Audio: dB 域；WASAPI: [0,1] 线性域） */
  let latestSpectrum: Float32Array | ArrayLike<number> | null = null
  let latestIsLinear = false
  let latestNyquist = 22050
  let spectrumHasNewData = false

  /** WASAPI fft 回调退订函数 */
  let unsubscribeFft: (() => void) | null = null

  /** 定时器 */
  let timerId: ReturnType<typeof setInterval> | null = null
  let lastTickAt = 0

  /** 是否正在运行（enabled 且已挂上数据源） */
  const running = ref(false)

  /**
   * 用户基准曲线快照（启用动态 EQ 时的 eqBands preGain）。
   * 用户在运行期间拖曲线 / 调 EQ 强度时，改动会换算并入该快照。
   */
  let baseGains: number[] = new Array(10).fill(0)

  /**
   * 最近一次由 runner 写入 eqBands 的增益（标记用）。
   * 统一写入路径后，eqBands 的变化有两种来源：
   * - runner 自己的写入（lastApplied 完全一致）→ 忽略，避免 delta 回灌基准形成反馈；
   * - 用户编辑（拖频点 / EQ 强度 / 切预设）→ 换算并入基准快照。
   */
  let lastApplied: number[] | null = null

  /** 实时修正摘要（dB），供 UI tag 读数：低频 = 前三段均值，高频 = 后三段均值 */
  const deltaSummary = ref({ low: 0, high: 0 })

  // ====== 数据源 ======

  function readWebAudioSpectrum(): void {
    const spec = audioEngine.readAnalysisSpectrumDb()
    if (spec) {
      latestSpectrum = spec
      latestIsLinear = false
      latestNyquist = audioEngine.getSampleRate() / 2
      spectrumHasNewData = true
    }
  }

  function subscribeWasapiSpectrum(): void {
    if (unsubscribeFft) return
    const api = (window as any).api?.audioEngine
    // 引擎尚不存在时暂不订阅，下一拍重试（ensureEngineId 会按需创建）
    if (!api?.getEngineId?.()) return
    unsubscribeFft = audioEngine.onFftData((spectrum: number[]) => {
      if (!Array.isArray(spectrum) || spectrum.length === 0) return
      latestSpectrum = spectrum
      latestIsLinear = true
      latestNyquist = audioEngine.getSampleRate() / 2
      spectrumHasNewData = true
    })
  }

  function unsubscribeSpectrum(): void {
    if (unsubscribeFft) {
      unsubscribeFft()
      unsubscribeFft = null
    }
    latestSpectrum = null
    spectrumHasNewData = false
  }

  // ====== 增益下发 ======

  /** 当前走势目标向量 */
  function currentShapeTarget(): number[] {
    const shape = engineApi.dynamicEq.value.shape as DynamicEqShape
    return SHAPE_TARGETS[shape] ?? SHAPE_TARGETS.bassBoost
  }

  /** 补齐到 10 段的增益数组 */
  const pad10 = (arr: ArrayLike<number>) =>
    Array.from({ length: 10 }, (_, i) =>
      typeof arr[i] === 'number' && Number.isFinite(arr[i]) ? arr[i] : 0
    )

  /**
   * 统一写入路径：经 composable setEqGains 写 eqBands（UI 曲线始终显示
   * 实际生效曲线）+ 下发 DSP。拖频点 / EQ 强度 / 动态修正全部同源，
   * 不再有"曲线显示 A、实际 DSP 是 B"的双源打架。
   */
  function writeGains(gains: number[]): void {
    lastApplied = [...gains]
    engineApi.setEqGains(gains)
  }

  /**
   * 下发 base + delta（delta 内含走势延伸 + 分析微调）。
   * 注意：走势不静态套用，delta 从 0 起随分析逐步延伸，
   * 因此曲线是"逐渐长成走势"，而不是开启瞬间跳到走势曲线。
   */
  function applyDeltaGains(delta: number[]): void {
    writeGains(baseGains.map((g, i) => g + (delta[i] ?? 0)))
  }

  /** 恢复用户基准曲线（停止 / 模式切换时），经统一写入路径同步 UI 曲线 */
  function restoreBaseGains(): void {
    writeGains([...baseGains])
  }

  // ====== 主循环 ======

  function tick(): void {
    const params = engineApi.dynamicEq.value
    const now = Date.now()
    const cfg = EFFICIENCY_PRESETS[Math.min(5, Math.max(1, params.efficiency)) - 1]
    if (now - lastTickAt < cfg.intervalMs) return
    lastTickAt = now

    // 不判断播放状态：静音门（算法层 < -60dB 冻结 delta）已能兜底空闲/暂停，
    // 而引擎/Store 的播放标志在多后端下并不可靠（Web Audio 的 state.isPlaying
    // 恒为 false 曾导致分析循环完全不运行）。

    if (!latestSpectrum || !spectrumHasNewData) {
      // Web Audio 主动拉取；WASAPI 等 IPC 推送（无新数据时跳过本拍）
      if (!isWebAudioModeActive()) {
        // 引擎可能晚于开关就绪：未订阅成功时每拍重试一次
        if (!unsubscribeFft) subscribeWasapiSpectrum()
        return
      }
      readWebAudioSpectrum()
      if (!latestSpectrum) return
    }
    spectrumHasNewData = false

    const levels = aggregateBandLevels(latestSpectrum, latestIsLinear, latestNyquist)
    if (!levels) return

    const delta = dynamicEqEngine.update(levels, now)
    applyDeltaGains(delta)

    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length
    deltaSummary.value = {
      low: avg(delta.slice(0, 3)),
      high: avg(delta.slice(7, 10))
    }
  }

  function isWebAudioModeActive(): boolean {
    return settingsStore.playback.audioOutputMode === 'webaudio'
  }

  // ====== 启停 ======

  function syncEngineConfig(params: DynamicEqParams): void {
    dynamicEqEngine.setStrength(params.strength)
    dynamicEqEngine.setEfficiency(params.efficiency)
    dynamicEqEngine.setShapeTarget(currentShapeTarget())
  }

  function start(): void {
    if (timerId !== null) return
    // 动态 EQ 依赖均衡器生效：EQ 关闭时自动开启
    if (!engineApi.eqEnabled.value) {
      engineApi.setEqEnabled(true)
    }
    // 捕获用户基准曲线快照（delta 全部叠加在它之上）
    baseGains = pad10(engineApi.eqBands.value.map((b: any) => b?.preGain))
    syncEngineConfig(engineApi.dynamicEq.value)
    dynamicEqEngine.reset()
    // 切数据源：先退订旧的，再按当前模式订阅
    unsubscribeSpectrum()
    if (!isWebAudioModeActive()) subscribeWasapiSpectrum()
    lastTickAt = 0
    timerId = setInterval(tick, TICK_MS)
    running.value = true
    // 起始态 = 基准曲线（delta 0）。走势不静态套用，
    // 由分析循环在播放中把曲线逐步延伸到走势。
    applyDeltaGains(new Array(10).fill(0))
  }

  function stop(): void {
    if (timerId !== null) {
      clearInterval(timerId)
      timerId = null
    }
    unsubscribeSpectrum()
    running.value = false
    deltaSummary.value = { low: 0, high: 0 }
    dynamicEqEngine.reset()
    // 恢复启用动态 EQ 前的基准曲线（含 UI）
    restoreBaseGains()
  }

  // ====== 响应式联动 ======

  // 参数变化：enabled 切启停；shape/strength/efficiency 热更新
  watch(
    () => ({ ...engineApi.dynamicEq.value }),
    (params, old) => {
      if (params.enabled) {
        if (!timerId) {
          start()
        } else if (old) {
          if (
            params.shape !== old.shape ||
            params.strength !== old.strength ||
            params.efficiency !== old.efficiency
          ) {
            // 换走势 / 调强度：不重置 delta，让曲线从当前值平滑延伸向新目标
            // （重置会先塌回基准再重新长，观感突兀）
            syncEngineConfig(params)
          }
        }
      } else if (timerId) {
        stop()
      }
    },
    { deep: true }
  )

  // 输出模式切换：恢复基准 → 重新挂数据源
  watch(
    () => settingsStore.playback.audioOutputMode,
    () => {
      if (timerId) {
        // 换后端：停掉旧循环（会恢复 base），立即以新后端重启
        stop()
        start()
      }
    }
  )

  // eqBands 变化时分流处理：
  // - runner 自己的写入（与 lastApplied 一致）→ 忽略，防止 delta 回灌基准；
  // - 用户编辑（拖频点 / EQ 强度 / 切预设）→ 并入基准快照 base = eqBands − delta，
  //   并立即按新基准重写下发，保证 UI 与 DSP 一致、手调不丢失不回跳。
  watch(
    () => engineApi.eqBands.value.map((b: any) => b?.preGain ?? 0).join(','),
    () => {
      if (timerId === null) return
      const cur = pad10(engineApi.eqBands.value.map((b: any) => b?.preGain))
      if (
        lastApplied &&
        cur.length === lastApplied.length &&
        cur.every((v, i) => Math.abs(v - lastApplied![i]) < 1e-6)
      ) {
        return // runner 自己的写入
      }
      const delta = dynamicEqEngine.getDelta()
      baseGains = cur.map((g, i) => g - (delta[i] ?? 0))
      // 立即重写：用户编辑 + 当前修正一次性下发（下次 tick 前先保证一致）
      writeGains(baseGains.map((g, i) => g + (delta[i] ?? 0)))
    }
  )

  // 播放状态变化时清空频谱缓存，避免旧数据残响（静音门兜底，双保险）
  watch(
    () => playerStore.isPlaying,
    (playing) => {
      if (!playing) spectrumHasNewData = false
    }
  )

  onScopeDispose(() => {
    if (timerId) stop()
  })

  return {
    running,
    deltaSummary,
    /** 显式启停（UI 开关直接调用，不依赖 watch 触发） */
    start,
    stop,
    setParams: (params: Partial<DynamicEqParams>) => engineApi.setDynamicEqParams(params)
  }
}

const dynamicEqScope = effectScope(true)
let shared: ReturnType<typeof createDynamicEqRunner> | null = null

/** 动态 EQ 运行器（全局单例） */
export function useDynamicEq(): ReturnType<typeof createDynamicEqRunner> {
  if (!shared) {
    shared = dynamicEqScope.run(() => createDynamicEqRunner()) ?? null
  }
  return shared as ReturnType<typeof createDynamicEqRunner>
}

export default useDynamicEq
