import { ref, reactive, onMounted, onUnmounted, computed } from 'vue'
import { rustAudioAdapter } from '../audio/rust-audio-adapter'

/**
 * EQ 频段设置
 */
export interface EqBandSettings {
  frequency: number;
  preGain: number;
  postGain: number;
  preQ: number;
  postQ: number;
  bandType?: 'lowShelf' | 'highShelf' | 'peaking' | 'notch';
}

/**
 * 压缩器参数
 */
export interface CompressorParams {
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  knee: number;
}

/**
 * 限制器参数
 */
export interface LimiterParams {
  ceiling: number;
  release: number;
}

/**
 * 等响度参数
 */
export interface LoudnessParams {
  enabled: boolean;
  compensation: number;
  referenceLoudness: number;
  direction: 'low' | 'high' | 'both';
}

/**
 * 音效预设
 */
export interface SoundEffectPreset {
  id: string;
  name: string;
  eqEnabled: boolean;
  eqBands: EqBandSettings[];
  compressorEnabled: boolean;
  compressor: CompressorParams;
  limiterEnabled: boolean;
  limiter: LimiterParams;
  loudness: LoudnessParams;
}

/**
 * 音频引擎状态
 */
export interface AudioEngineState {
  isInitialized: boolean;
  isPlaying: boolean;
  currentState: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped';
  volume: number;
  loopMode: 'none' | 'one' | 'all';
  position: number;
  duration: number;
}

/**
 * 音效预设存储键名
 */
const PRESETS_STORAGE_KEY = 'sound-effect-presets';

/**
 * 默认预设列表
 */
const DEFAULT_PRESETS: SoundEffectPreset[] = [
  {
    id: 'flat',
    name: '平坦',
    eqEnabled: false,
    eqBands: [
      { frequency: 31, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 62, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 125, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 250, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 500, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 1000, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 2000, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 4000, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 8000, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 16000, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' }
    ],
    compressorEnabled: true,
    compressor: { threshold: -24, ratio: 4, attack: 10, release: 100, knee: 6 },
    limiterEnabled: true,
    limiter: { ceiling: -0.3, release: 50 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' }
  },
  {
    id: 'pop',
    name: '流行',
    eqEnabled: true,
    eqBands: [
      { frequency: 31, preGain: 2, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 62, preGain: 3, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 125, preGain: 3, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 250, preGain: 1, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 500, preGain: -1, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 1000, preGain: -1, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 2000, preGain: 2, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 4000, preGain: 3, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 8000, preGain: 3, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 16000, preGain: 2, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' }
    ],
    compressorEnabled: true,
    compressor: { threshold: -20, ratio: 3, attack: 5, release: 150, knee: 8 },
    limiterEnabled: true,
    limiter: { ceiling: -0.5, release: 80 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' }
  },
  {
    id: 'rock',
    name: '摇滚',
    eqEnabled: true,
    eqBands: [
      { frequency: 31, preGain: 3, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 62, preGain: 4, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 125, preGain: 2, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 250, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 500, preGain: -1, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 1000, preGain: -1, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 2000, preGain: 1, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 4000, preGain: 3, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 8000, preGain: 4, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 16000, preGain: 3, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' }
    ],
    compressorEnabled: true,
    compressor: { threshold: -18, ratio: 6, attack: 2, release: 80, knee: 4 },
    limiterEnabled: true,
    limiter: { ceiling: -0.3, release: 50 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' }
  },
  {
    id: 'vocal',
    name: '人声',
    eqEnabled: true,
    eqBands: [
      { frequency: 31, preGain: -2, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 62, preGain: -1, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 125, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 250, preGain: 2, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 500, preGain: 3, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 1000, preGain: 3, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 2000, preGain: 2, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 4000, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 8000, preGain: -1, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 16000, preGain: -2, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' }
    ],
    compressorEnabled: true,
    compressor: { threshold: -20, ratio: 3.5, attack: 5, release: 120, knee: 6 },
    limiterEnabled: true,
    limiter: { ceiling: -0.5, release: 70 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' }
  },
  {
    id: 'bass',
    name: '低音增强',
    eqEnabled: true,
    eqBands: [
      { frequency: 31, preGain: 5, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 62, preGain: 4, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 125, preGain: 3, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 250, preGain: 1, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 500, preGain: 0, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 1000, preGain: -1, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 2000, preGain: -2, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 4000, preGain: -3, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 8000, preGain: -4, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' },
      { frequency: 16000, preGain: -5, postGain: 0, preQ: 1.0, postQ: 1.0, bandType: 'peaking' }
    ],
    compressorEnabled: true,
    compressor: { threshold: -22, ratio: 4, attack: 8, release: 100, knee: 5 },
    limiterEnabled: true,
    limiter: { ceiling: -0.3, release: 50 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' }
  }
];

/**
 * 获取全局 audioEngine API
 */
function getAudioEngineAPI() {
  return (window as any).api?.audioEngine;
}

/**
 * 转换压缩器参数为 Rust 引擎格式
 * @param params - 压缩器参数
 * @returns 转换后的 Rust 格式参数
 */
function convertCompressorParams(params: CompressorParams) {
  return {
    thresholdDb: params.threshold ?? -24,
    ratio: params.ratio ?? 4,
    attackMs: params.attack ?? 10,
    releaseMs: params.release ?? 100,
    kneeDb: params.knee ?? 6
  };
}

/**
 * 转换限制器参数为 Rust 引擎格式
 * @param params - 限制器参数
 * @returns 转换后的 Rust 格式参数
 */
function convertLimiterParams(params: LimiterParams) {
  return {
    ceilingDb: params.ceiling ?? -0.3,
    releaseMs: params.release ?? 50
  };
}

/**
 * 转换 EQ 频段类型
 */
function convertEqBandType(type?: string): string {
  const typeMap: Record<string, string> = {
    'lowShelf': 'lowShelf',
    'highShelf': 'highShelf',
    'peaking': 'peaking',
    'notch': 'notch'
  };
  return typeMap[type || 'peaking'] || 'peaking';
}

/**
 * 转换 EQ 频段设置为 Rust 引擎格式
 * @param settings - EQ 频段设置
 * @returns 转换后的 Rust 格式参数
 */
function convertEqBandSettings(settings: Partial<EqBandSettings>) {
  return {
    frequency: settings.frequency ?? 1000,
    preGain: settings.preGain ?? 0,
    postGain: settings.postGain ?? 0,
    preQ: settings.preQ ?? 1,
    postQ: settings.postQ ?? 1,
    bandType: convertEqBandType(settings.bandType)
  };
}

/**
 * useAudioEngine Composable
 * 提供音频引擎的响应式接口
 */
export function useAudioEngine() {
  const api = getAudioEngineAPI();

  // 引擎状态
  const state = reactive<AudioEngineState>({
    isInitialized: false,
    isPlaying: false,
    currentState: 'idle',
    volume: 1.0,
    loopMode: 'none',
    position: 0,
    duration: 0
  });

  // EQ 状态
  const eqEnabled = ref(false);
  const eqBands = ref<EqBandSettings[]>([]);

  // 压缩器状态
  const compressorEnabled = ref(false);
  const compressor = ref<CompressorParams>({
    threshold: -24,
    ratio: 4,
    attack: 10,
    release: 100,
    knee: 6
  });
  const compressorGR = ref(0);

  // 限制器状态
  const limiterEnabled = ref(false);
  const limiter = ref<LimiterParams>({
    ceiling: -0.3,
    release: 50
  });
  const limiterGR = ref(0);

  // 等响度状态
  const loudnessEnabled = ref(false);
  const loudness = ref<LoudnessParams>({
    enabled: false,
    compensation: 1.0,
    referenceLoudness: -20,
    direction: 'both'
  });

  // 预设相关
  const presets = ref<SoundEffectPreset[]>([]);
  const currentPresetId = ref<string>('flat');

  // 增益减少量轮询定时器
  let gainReductionTimer: number | null = null;

  /**
   * 初始化音频引擎
   */
  async function initialize() {
    if (!api) {
      console.warn('[useAudioEngine] audioEngine API 不可用');
      return false;
    }

    try {
      const result = await api.create({
        sampleRate: 44100,
        bufferSize: 512,
        channels: 2,
        enableEq: true,
        enableCompressor: true,
        enableLimiter: true,
        enableLoudness: true
      });

      // 检查结果是否为对象且有 success 属性
      if (result && typeof result === 'object' && result.success) {
        state.isInitialized = true;
        await refreshAllParams();
        startGainReductionPolling();
        console.log('[useAudioEngine] 引擎初始化成功');
        return true;
      } else if (result === true) {
        // 直接返回 true 的情况
        state.isInitialized = true;
        await refreshAllParams();
        startGainReductionPolling();
        console.log('[useAudioEngine] 引擎初始化成功');
        return true;
      } else {
        const errorMsg = result && result.error ? result.error : '未知错误';
        console.error('[useAudioEngine] 初始化失败:', errorMsg);
        return false;
      }
    } catch (error) {
      console.error('[useAudioEngine] 初始化错误:', error);
      return false;
    }
  }

  /**
   * 销毁音频引擎
   */
  async function destroy() {
    stopGainReductionPolling();
    if (api) {
      await api.destroy();
    }
    state.isInitialized = false;
  }

  /**
   * 刷新所有参数
   */
  async function refreshAllParams() {
    if (!api || !state.isInitialized) return;

    try {
      // 刷新 EQ
      eqEnabled.value = await api.isEqEnabled();
      const bands = await api.getEqBands();
      eqBands.value = bands.map((b: any) => ({
        frequency: b.frequency,
        preGain: b.preGain ?? b.pre_gain ?? 0,
        postGain: b.postGain ?? b.post_gain ?? 0,
        preQ: b.preQ ?? b.pre_q ?? 1,
        postQ: b.postQ ?? b.post_q ?? 1,
        bandType: b.bandType ?? b.band_type ?? 'peaking'
      }));

      // 刷新压缩器
      compressorEnabled.value = await api.isCompressorEnabled();
      const compParams = await api.getCompressor();
      compressor.value = {
        threshold: compParams.thresholdDb ?? compParams.threshold_db ?? -24,
        ratio: compParams.ratio ?? 4,
        attack: compParams.attackMs ?? compParams.attack_ms ?? 10,
        release: compParams.releaseMs ?? compParams.release_ms ?? 100,
        knee: compParams.kneeDb ?? compParams.knee_db ?? 6
      };

      // 刷新限制器
      limiterEnabled.value = await api.isLimiterEnabled();
      const limParams = await api.getLimiter();
      limiter.value = {
        ceiling: limParams.ceilingDb ?? limParams.ceiling_db ?? -0.3,
        release: limParams.releaseMs ?? limParams.release_ms ?? 50
      };

      // 刷新等响度
      loudnessEnabled.value = typeof api.isLoudnessEnabled === 'function'
        ? await api.isLoudnessEnabled()
        : false;
      loudness.value = await api.getLoudness();

      // 刷新音量
      state.volume = await api.getVolume();

      // 刷新循环模式
      state.loopMode = await api.getLoopMode();

      // 刷新播放状态
      state.isPlaying = await api.isPlaying();
      state.currentState = await api.getState();
    } catch (error) {
      console.error('[useAudioEngine] 刷新参数错误:', error);
    }
  }

  /**
   * 刷新增益减少量
   */
  async function refreshGainReductions() {
    if (!api || !state.isInitialized) return;

    try {
      compressorGR.value = await api.getCompressorGainReduction();
      limiterGR.value = await api.getLimiterGainReduction();
    } catch (error) {
      // 忽略错误
    }
  }

  /**
   * 开始增益减少量轮询
   */
  function startGainReductionPolling() {
    if (gainReductionTimer !== null) return;
    gainReductionTimer = window.setInterval(refreshGainReductions, 100);
  }

  /**
   * 停止增益减少量轮询
   */
  function stopGainReductionPolling() {
    if (gainReductionTimer !== null) {
      window.clearInterval(gainReductionTimer);
      gainReductionTimer = null;
    }
  }

  // === EQ 控制 ===

  /**
   * 设置 EQ 启用状态
   * @param enabled - 是否启用
   */
  async function setEqEnabled(enabled: boolean) {
    eqEnabled.value = enabled;
    // 应用到 Rust 引擎
    if (state.isInitialized && api) {
      try {
        await api.setEqEnabled(enabled);
      } catch (error) {
        console.error('[useAudioEngine] 设置 EQ 启用状态失败:', error);
      }
    }
    // 应用到 Web Audio API
    rustAudioAdapter.setEqEnabled(enabled);
  }

  /**
   * 设置 EQ 频段
   * @param bandIndex - 频段索引
   * @param settings - 频段设置（部分更新）
   */
  async function setEqBand(bandIndex: number, settings: Partial<EqBandSettings>) {
    if (bandIndex < 0 || bandIndex >= eqBands.value.length) return;

    const current = JSON.parse(JSON.stringify(eqBands.value[bandIndex]));
    const updated = { ...current, ...settings };
    eqBands.value[bandIndex] = updated;

    // 应用到 Rust 引擎
    if (state.isInitialized && api) {
      try {
        await api.setEqBand(bandIndex, convertEqBandSettings(updated));
      } catch (error) {
        console.error('[useAudioEngine] 设置 EQ 频段失败:', error);
      }
    }
    // 应用到 Web Audio API
    rustAudioAdapter.setEqBand(bandIndex, convertEqBandSettings(updated));
  }

  /**
   * 设置所有 EQ 频段增益
   */
  function setEqGains(gains: number[]) {
    if (!state.isInitialized || !api) return;
    const newBands = eqBands.value.map((band, i) => ({
      ...band,
      preGain: gains[i] ?? 0
    }));
    eqBands.value = newBands;
    api?.setEqGains(gains);
  }

  /**
   * 获取频段标签
   */
  function getBandLabel(frequency: number): string {
    if (frequency < 1000) {
      return `${frequency}Hz`;
    }
    return `${frequency / 1000}kHz`;
  }

  // === 压缩器控制 ===

  /**
   * 设置压缩器启用状态
   * @param enabled - 是否启用
   */
  async function setCompressorEnabled(enabled: boolean) {
    compressorEnabled.value = enabled;
    // 应用到 Rust 引擎
    if (state.isInitialized && api) {
      try {
        await api.setCompressorEnabled(enabled);
      } catch (error) {
        console.error('[useAudioEngine] 设置压缩器启用状态失败:', error);
      }
    }
    // 应用到 Web Audio API
    rustAudioAdapter.setCompressorEnabled(enabled);
  }

  /**
   * 设置压缩器参数
   * @param params - 压缩器参数
   */
  async function setCompressorParams(params: Partial<CompressorParams>) {
    const current = JSON.parse(JSON.stringify(compressor.value));
    compressor.value = { ...current, ...params };
    const rustParams = convertCompressorParams(compressor.value);
    // 应用到 Rust 引擎
    if (state.isInitialized && api) {
      try {
        await api.setCompressor(rustParams);
      } catch (error) {
        console.error('[useAudioEngine] 设置压缩器参数失败:', error);
      }
    }
    // 应用到 Web Audio API
    rustAudioAdapter.setCompressor(rustParams);
  }

  // === 限制器控制 ===

  /**
   * 设置限制器启用状态
   * @param enabled - 是否启用
   */
  async function setLimiterEnabled(enabled: boolean) {
    limiterEnabled.value = enabled;
    // 应用到 Rust 引擎
    if (state.isInitialized && api) {
      try {
        await api.setLimiterEnabled(enabled);
      } catch (error) {
        console.error('[useAudioEngine] 设置限制器启用状态失败:', error);
      }
    }
    // Web Audio API 没有原生限制器节点，使用压缩器模拟
  }

  /**
   * 设置限制器参数
   * @param params - 限制器参数
   */
  async function setLimiterParams(params: Partial<LimiterParams>) {
    const current = JSON.parse(JSON.stringify(limiter.value));
    limiter.value = { ...current, ...params };
    const rustParams = convertLimiterParams(limiter.value);
    // 应用到 Rust 引擎
    if (state.isInitialized && api) {
      try {
        await api.setLimiter(rustParams);
      } catch (error) {
        console.error('[useAudioEngine] 设置限制器参数失败:', error);
      }
    }
    // Web Audio API 没有原生限制器节点
  }

  // === 等响度控制 ===

  /**
   * 设置等响度参数
   * @param params - 等响度参数
   */
  async function setLoudnessParams(params: Partial<LoudnessParams>) {
    const current = JSON.parse(JSON.stringify(loudness.value));
    loudness.value = { ...current, ...params };
    // 应用启用状态到 Rust 引擎
    if (state.isInitialized && api) {
      try {
        if (params.enabled !== undefined && typeof api.setLoudnessEnabled === 'function') {
          await api.setLoudnessEnabled(params.enabled);
          loudnessEnabled.value = params.enabled;
        }
        await api.setLoudness({ ...loudness.value });
      } catch (error) {
        console.error('[useAudioEngine] 设置等响度参数失败:', error);
      }
    }
  }

  /**
   * 设置等响度启用状态
   * @param enabled - 是否启用
   */
  async function setLoudnessEnabled(enabled: boolean) {
    loudnessEnabled.value = enabled;
    loudness.value.enabled = enabled;
    if (state.isInitialized && api) {
      try {
        if (typeof api.setLoudnessEnabled === 'function') {
          await api.setLoudnessEnabled(enabled);
        }
        await api.setLoudness({ ...loudness.value });
      } catch (error) {
        console.error('[useAudioEngine] 设置等响度启用状态失败:', error);
      }
    }
  }

  // === 预设管理 ===

  /**
   * 加载预设
   */
  function loadPresets() {
    try {
      const stored = localStorage.getItem(PRESETS_STORAGE_KEY);
      if (stored) {
        const userPresets = JSON.parse(stored);
        presets.value = [...DEFAULT_PRESETS, ...userPresets];
      } else {
        presets.value = [...DEFAULT_PRESETS];
      }
    } catch {
      presets.value = [...DEFAULT_PRESETS];
    }
  }

  /**
   * 保存用户预设到 localStorage
   */
  function saveUserPresets() {
    const userPresets = presets.value.filter(p => !DEFAULT_PRESETS.find(dp => dp.id === p.id));
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(userPresets));
  }

  /**
   * 应用预设
   * @param presetId - 预设 ID
   */
  async function applyPreset(presetId: string) {
    const preset = presets.value.find(p => p.id === presetId);
    if (!preset) return;

    currentPresetId.value = presetId;

    console.log('[useAudioEngine] 应用预设:', presetId, preset);

    // 应用 EQ
    eqBands.value = JSON.parse(JSON.stringify(preset.eqBands));
    await setEqEnabled(preset.eqEnabled);
    // 逐个频段应用到后端
    for (let i = 0; i < preset.eqBands.length; i++) {
      const band = preset.eqBands[i];
      const rustSettings = convertEqBandSettings(band);
      console.log(`[useAudioEngine] 设置 EQ 频段 ${i}:`, rustSettings);
      try {
        await api?.setEqBand(i, rustSettings);
      } catch (error) {
        console.error(`[useAudioEngine] 设置 EQ 频段 ${i} 失败:`, error);
      }
    }

    // 应用压缩器
    compressor.value = { ...preset.compressor };
    await setCompressorEnabled(preset.compressorEnabled);
    const compParams = convertCompressorParams(preset.compressor);
    console.log('[useAudioEngine] 设置压缩器:', compParams);
    try {
      await api?.setCompressor(compParams);
    } catch (error) {
      console.error('[useAudioEngine] 设置压缩器失败:', error);
    }

    // 应用限制器
    limiter.value = { ...preset.limiter };
    await setLimiterEnabled(preset.limiterEnabled);
    const limParams = convertLimiterParams(preset.limiter);
    console.log('[useAudioEngine] 设置限制器:', limParams);
    try {
      await api?.setLimiter(limParams);
    } catch (error) {
      console.error('[useAudioEngine] 设置限制器失败:', error);
    }

    // 应用等响度
    loudness.value = { ...preset.loudness };
    loudnessEnabled.value = preset.loudness.enabled;
    console.log('[useAudioEngine] 设置等响度:', preset.loudness);
    try {
      if (typeof api?.setLoudnessEnabled === 'function') {
        await api?.setLoudnessEnabled(preset.loudness.enabled);
      }
      await api?.setLoudness({ ...preset.loudness });
    } catch (error) {
      console.error('[useAudioEngine] 设置等响度失败:', error);
    }

    console.log('[useAudioEngine] 预设应用完成:', presetId);
  }

  /**
   * 保存当前设置为新预设
   */
  function saveCurrentAsPreset(name: string): string {
    const id = `custom-${Date.now()}`;
    const preset: SoundEffectPreset = {
      id,
      name,
      eqEnabled: eqEnabled.value,
      eqBands: [...eqBands.value],
      compressorEnabled: compressorEnabled.value,
      compressor: { ...compressor.value },
      limiterEnabled: limiterEnabled.value,
      limiter: { ...limiter.value },
      loudness: { ...loudness.value }
    };

    presets.value.push(preset);
    saveUserPresets();
    currentPresetId.value = id;

    return id;
  }

  /**
   * 删除用户预设
   */
  function deletePreset(presetId: string) {
    const index = presets.value.findIndex(p => p.id === presetId);
    if (index === -1) return;

    const preset = presets.value[index];
    if (DEFAULT_PRESETS.find(dp => dp.id === preset.id)) return;

    presets.value.splice(index, 1);
    saveUserPresets();

    if (currentPresetId.value === presetId) {
      currentPresetId.value = 'flat';
    }
  }

  /**
   * 重置为默认设置
   */
  async function resetToDefault() {
    await applyPreset('flat');
  }

  /**
   * 计算属性：是否为内置预设
   */
  function isBuiltinPreset(presetId: string): boolean {
    return DEFAULT_PRESETS.some(p => p.id === presetId);
  }

  // 初始化时加载预设
  loadPresets();

  return {
    // 状态
    state,

    // EQ
    eqEnabled,
    eqBands,
    setEqEnabled,
    setEqBand,
    setEqGains,
    getBandLabel,

    // 压缩器
    compressorEnabled,
    compressor,
    compressorGR,
    setCompressorEnabled,
    setCompressorParams,

    // 限制器
    limiterEnabled,
    limiter,
    limiterGR,
    setLimiterEnabled,
    setLimiterParams,

    // 等响度
    loudnessEnabled,
    loudness,
    setLoudnessEnabled,
    setLoudnessParams,

    // 预设
    presets,
    currentPresetId,
    applyPreset,
    saveCurrentAsPreset,
    deletePreset,
    resetToDefault,
    isBuiltinPreset,

    // 生命周期
    initialize,
    destroy,
    refreshAllParams
  };
}

export default useAudioEngine;
