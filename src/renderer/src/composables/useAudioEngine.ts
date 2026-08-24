import { ref, reactive, watch, watchEffect, onScopeDispose } from 'vue'
import { audioEngine } from '../audio/audio-engine'
import { isWebAudioMode } from '../utils/audioOutputModeManager'

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
 * 虚拟低频参数
 */
export interface VirtualBassParams {
  enabled: boolean;
  intensity: number;
  crossoverFreq: number;
}

/**
 * 软限幅器参数
 */
export interface SoftClipperParams {
  enabled: boolean;
  threshold: number;
  makeupGain: number;
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
 * 预设数据结构
 */
export interface Preset {
  id: string;
  name: string;
  builtin: boolean;
  /** EQ 设置 */
  eqEnabled: boolean;
  eqBands: EqBandSettings[];
  /** 压缩器设置 */
  compressorEnabled: boolean;
  compressor: CompressorParams;
  /** 限制器设置 */
  limiterEnabled: boolean;
  limiter: LimiterParams;
  /** 等响度设置 */
  loudness: LoudnessParams;
  /** 虚拟低频设置 */
  virtualBass: VirtualBassParams;
  /** 软限幅器设置 */
  softClipper: SoftClipperParams;
}

/**
 * 音效引擎状态存储键名
 */
const ENGINE_STATE_STORAGE_KEY = 'sound-effect-state';

/**
 * 预设数据存储键名
 */
const PRESETS_STORAGE_KEY = 'sound-effect-presets';

/**
 * 获取全局 audioEngine API
 */
function getAudioEngineAPI() {
  return (window as any).api?.audioEngine;
}

/**
 * 内置预设列表
 * 提供常用的 EQ + 音效组合预设
 */
const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'flat',
    name: '平坦',
    builtin: true,
    eqEnabled: false,
    eqBands: [],
    compressorEnabled: false,
    compressor: { threshold: -24, ratio: 4, attack: 10, release: 100, knee: 6 },
    limiterEnabled: false,
    limiter: { ceiling: -0.3, release: 50 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' },
    virtualBass: { enabled: false, intensity: 50, crossoverFreq: 120 },
    softClipper: { enabled: false, threshold: 2.0, makeupGain: 0 }
  },
  {
    id: 'rock',
    name: '摇滚',
    builtin: true,
    eqEnabled: true,
    eqBands: [
      { frequency: 32, preGain: 4, postGain: 4, preQ: 0.5, postQ: 0.5, bandType: 'lowShelf' },
      { frequency: 64, preGain: 3, postGain: 3, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 125, preGain: -2, postGain: -2, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 250, preGain: -3, postGain: -3, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 500, preGain: 0, postGain: 0, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 1000, preGain: 2, postGain: 2, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 2000, preGain: 4, postGain: 4, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 4000, preGain: -1, postGain: -1, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 8000, preGain: 3, postGain: 3, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 16000, preGain: 4, postGain: 4, preQ: 1, postQ: 1, bandType: 'highShelf' }
    ],
    compressorEnabled: true,
    compressor: { threshold: -18, ratio: 4, attack: 5, release: 80, knee: 4 },
    limiterEnabled: true,
    limiter: { ceiling: -0.3, release: 50 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' },
    virtualBass: { enabled: false, intensity: 50, crossoverFreq: 120 },
    softClipper: { enabled: false, threshold: 2.0, makeupGain: 0 }
  },
  {
    id: 'pop',
    name: '流行',
    builtin: true,
    eqEnabled: true,
    eqBands: [
      { frequency: 32, preGain: -1, postGain: -1, preQ: 0.5, postQ: 0.5, bandType: 'lowShelf' },
      { frequency: 64, preGain: 0, postGain: 0, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 125, preGain: 2, postGain: 2, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 250, preGain: 1, postGain: 1, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 500, preGain: -2, postGain: -2, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 1000, preGain: 2, postGain: 2, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 2000, preGain: 4, postGain: 4, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 4000, preGain: 3, postGain: 3, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 8000, preGain: 2, postGain: 2, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 16000, preGain: -1, postGain: -1, preQ: 1, postQ: 1, bandType: 'highShelf' }
    ],
    compressorEnabled: true,
    compressor: { threshold: -20, ratio: 3, attack: 8, release: 120, knee: 6 },
    limiterEnabled: true,
    limiter: { ceiling: -0.3, release: 50 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' },
    virtualBass: { enabled: false, intensity: 50, crossoverFreq: 120 },
    softClipper: { enabled: false, threshold: 2.0, makeupGain: 0 }
  },
  {
    id: 'jazz',
    name: '爵士',
    builtin: true,
    eqEnabled: true,
    eqBands: [
      { frequency: 32, preGain: 3, postGain: 3, preQ: 0.5, postQ: 0.5, bandType: 'lowShelf' },
      { frequency: 64, preGain: 2, postGain: 2, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 125, preGain: 1, postGain: 1, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 250, preGain: -2, postGain: -2, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 500, preGain: 0, postGain: 0, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 1000, preGain: 1, postGain: 1, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 2000, preGain: 2, postGain: 2, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 4000, preGain: 3, postGain: 3, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 8000, preGain: 2, postGain: 2, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 16000, preGain: 1, postGain: 1, preQ: 1, postQ: 1, bandType: 'highShelf' }
    ],
    compressorEnabled: false,
    compressor: { threshold: -24, ratio: 4, attack: 10, release: 100, knee: 6 },
    limiterEnabled: false,
    limiter: { ceiling: -0.3, release: 50 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' },
    virtualBass: { enabled: false, intensity: 50, crossoverFreq: 120 },
    softClipper: { enabled: false, threshold: 2.0, makeupGain: 0 }
  },
  {
    id: 'classical',
    name: '古典',
    builtin: true,
    eqEnabled: true,
    eqBands: [
      { frequency: 32, preGain: 2, postGain: 2, preQ: 0.5, postQ: 0.5, bandType: 'lowShelf' },
      { frequency: 64, preGain: 1, postGain: 1, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 125, preGain: 1, postGain: 1, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 250, preGain: 0, postGain: 0, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 500, preGain: -1, postGain: -1, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 1000, preGain: 0, postGain: 0, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 2000, preGain: 1, postGain: 1, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 4000, preGain: 2, postGain: 2, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 8000, preGain: 3, postGain: 3, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 16000, preGain: 2, postGain: 2, preQ: 1, postQ: 1, bandType: 'highShelf' }
    ],
    compressorEnabled: false,
    compressor: { threshold: -24, ratio: 4, attack: 10, release: 100, knee: 6 },
    limiterEnabled: false,
    limiter: { ceiling: -0.3, release: 50 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' },
    virtualBass: { enabled: false, intensity: 50, crossoverFreq: 120 },
    softClipper: { enabled: false, threshold: 2.0, makeupGain: 0 }
  },
  {
    id: 'electronic',
    name: '电子',
    builtin: true,
    eqEnabled: true,
    eqBands: [
      { frequency: 32, preGain: 5, postGain: 5, preQ: 0.5, postQ: 0.5, bandType: 'lowShelf' },
      { frequency: 64, preGain: 4, postGain: 4, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 125, preGain: -3, postGain: -3, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 250, preGain: -4, postGain: -4, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 500, preGain: 0, postGain: 0, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 1000, preGain: -2, postGain: -2, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 2000, preGain: 1, postGain: 1, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 4000, preGain: 3, postGain: 3, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 8000, preGain: 4, postGain: 4, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 16000, preGain: 5, postGain: 5, preQ: 1, postQ: 1, bandType: 'highShelf' }
    ],
    compressorEnabled: true,
    compressor: { threshold: -12, ratio: 6, attack: 3, release: 60, knee: 2 },
    limiterEnabled: true,
    limiter: { ceiling: -0.5, release: 30 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' },
    virtualBass: { enabled: true, intensity: 60, crossoverFreq: 100 },
    softClipper: { enabled: true, threshold: 1.5, makeupGain: 2 }
  },
  {
    id: 'vocal',
    name: '人声增强',
    builtin: true,
    eqEnabled: true,
    eqBands: [
      { frequency: 32, preGain: -2, postGain: -2, preQ: 0.5, postQ: 0.5, bandType: 'lowShelf' },
      { frequency: 64, preGain: -1, postGain: -1, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 125, preGain: 0, postGain: 0, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 250, preGain: 3, postGain: 3, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 500, preGain: 3, postGain: 3, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 1000, preGain: 2, postGain: 2, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 2000, preGain: 4, postGain: 4, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 4000, preGain: 3, postGain: 3, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 8000, preGain: 1, postGain: 1, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 16000, preGain: -1, postGain: -1, preQ: 1, postQ: 1, bandType: 'highShelf' }
    ],
    compressorEnabled: true,
    compressor: { threshold: -18, ratio: 3, attack: 10, release: 150, knee: 8 },
    limiterEnabled: false,
    limiter: { ceiling: -0.3, release: 50 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' },
    virtualBass: { enabled: false, intensity: 50, crossoverFreq: 120 },
    softClipper: { enabled: false, threshold: 2.0, makeupGain: 0 }
  },
  {
    id: 'bass_boost',
    name: '低音增强',
    builtin: true,
    eqEnabled: true,
    eqBands: [
      { frequency: 32, preGain: 6, postGain: 6, preQ: 0.5, postQ: 0.5, bandType: 'lowShelf' },
      { frequency: 64, preGain: 5, postGain: 5, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 125, preGain: 3, postGain: 3, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 250, preGain: 0, postGain: 0, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 500, preGain: -2, postGain: -2, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 1000, preGain: -1, postGain: -1, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 2000, preGain: 0, postGain: 0, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 4000, preGain: 0, postGain: 0, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 8000, preGain: 0, postGain: 0, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 16000, preGain: -1, postGain: -1, preQ: 1, postQ: 1, bandType: 'highShelf' }
    ],
    compressorEnabled: false,
    compressor: { threshold: -24, ratio: 4, attack: 10, release: 100, knee: 6 },
    limiterEnabled: true,
    limiter: { ceiling: -1.0, release: 50 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' },
    virtualBass: { enabled: true, intensity: 80, crossoverFreq: 150 },
    softClipper: { enabled: true, threshold: 1.0, makeupGain: 3 }
  },
  {
    id: 'treble_boost',
    name: '高音增强',
    builtin: true,
    eqEnabled: true,
    eqBands: [
      { frequency: 32, preGain: -1, postGain: -1, preQ: 0.5, postQ: 0.5, bandType: 'lowShelf' },
      { frequency: 64, preGain: 0, postGain: 0, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 125, preGain: 0, postGain: 0, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 250, preGain: 0, postGain: 0, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 500, preGain: 1, postGain: 1, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 1000, preGain: 2, postGain: 2, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 2000, preGain: 3, postGain: 3, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 4000, preGain: 4, postGain: 4, preQ: 1.41, postQ: 1.41, bandType: 'peaking' },
      { frequency: 8000, preGain: 5, postGain: 5, preQ: 1, postQ: 1, bandType: 'peaking' },
      { frequency: 16000, preGain: 6, postGain: 6, preQ: 1, postQ: 1, bandType: 'highShelf' }
    ],
    compressorEnabled: false,
    compressor: { threshold: -24, ratio: 4, attack: 10, release: 100, knee: 6 },
    limiterEnabled: false,
    limiter: { ceiling: -0.3, release: 50 },
    loudness: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' },
    virtualBass: { enabled: false, intensity: 50, crossoverFreq: 120 },
    softClipper: { enabled: false, threshold: 2.0, makeupGain: 0 }
  }
]

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

  // 等响度状态（enabled 已合并到 loudness.value.enabled 中，不再使用独立 ref）
  const loudness = ref<LoudnessParams>({
    enabled: false,
    compensation: 1.0,
    referenceLoudness: -20,
    direction: 'both'
  });

  // 虚拟低频状态
  const virtualBass = ref<VirtualBassParams>({
    enabled: false,
    intensity: 50,
    crossoverFreq: 120
  });

  // 软限幅爆音抑制状态
  const softClipper = ref<SoftClipperParams>({
    enabled: false,
    threshold: 2.0,
    makeupGain: 0
  });

  // 预设管理
  const presets = ref<Preset[]>([]);
  const currentPresetId = ref<string>('flat');

  /**
   * 加载所有预设（内置 + 自定义）
   */
  function loadPresets() {
    const customPresets = loadCustomPresets();
    presets.value = [...BUILTIN_PRESETS, ...customPresets];
  }

  /**
   * 从 localStorage 加载自定义预设
   * @returns 自定义预设数组
   */
  function loadCustomPresets(): Preset[] {
    try {
      const stored = localStorage.getItem(PRESETS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return parsed.map((p: any) => ({ ...p, builtin: false }));
        }
      }
    } catch (error) {
      console.error('[useAudioEngine] 加载自定义预设失败:', error);
    }
    return [];
  }

  /**
   * 保存自定义预设到 localStorage
   * @param customPresets - 自定义预设数组
   */
  function saveCustomPresets(customPresets: Preset[]) {
    try {
      localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(customPresets));
    } catch (error) {
      console.error('[useAudioEngine] 保存自定义预设失败:', error);
    }
  }

  /**
   * 判断预设是否为内置预设
   * @param presetId - 预设 ID
   * @returns 是否为内置预设
   */
  function isBuiltinPreset(presetId: string): boolean {
    return BUILTIN_PRESETS.some((p) => p.id === presetId);
  }

  /**
   * 获取当前音效设置快照
   * @returns 当前所有音效参数
   */
  function getCurrentSnapshot(): Omit<Preset, 'id' | 'name' | 'builtin'> {
    return {
      eqEnabled: eqEnabled.value,
      eqBands: eqBands.value.map(b => ({ ...b })),
      compressorEnabled: compressorEnabled.value,
      compressor: { ...compressor.value },
      limiterEnabled: limiterEnabled.value,
      limiter: { ...limiter.value },
      loudness: { ...loudness.value },
      virtualBass: { ...virtualBass.value },
      softClipper: { ...softClipper.value }
    };
  }

  /**
   * 应用预设快照到当前音效
   * @param snapshot - 预设快照数据
   */
  async function applySnapshot(snapshot: Omit<Preset, 'id' | 'name' | 'builtin'>) {
    // 应用 EQ
    if (snapshot.eqBands && snapshot.eqBands.length > 0) {
      eqBands.value = snapshot.eqBands;
      for (let i = 0; i < snapshot.eqBands.length; i++) {
        const band = snapshot.eqBands[i];
        await setEqBand(i, band);
      }
    }
    await setEqEnabled(snapshot.eqEnabled ?? false);

    // 应用压缩器
    if (snapshot.compressor) {
      await setCompressorParams(snapshot.compressor);
    }
    await setCompressorEnabled(snapshot.compressorEnabled ?? false);

    // 应用限制器
    if (snapshot.limiter) {
      await setLimiterParams(snapshot.limiter);
    }
    await setLimiterEnabled(snapshot.limiterEnabled ?? false);

    // 应用等响度
    if (snapshot.loudness) {
      await setLoudnessParams(snapshot.loudness);
    }

    // 应用虚拟低频
    if (snapshot.virtualBass) {
      await setVirtualBassParams(snapshot.virtualBass);
    }

    // 应用软限幅器
    if (snapshot.softClipper) {
      await setSoftClipperParams(snapshot.softClipper);
    }
  }

  /**
   * 应用预设
   * @param presetId - 预设 ID
   */
  async function applyPreset(presetId: string) {
    const allPresets = [...BUILTIN_PRESETS, ...loadCustomPresets()];
    const preset = allPresets.find((p) => p.id === presetId);
    if (!preset) {
      console.warn('[useAudioEngine] 未找到预设:', presetId);
      return;
    }

    await applySnapshot(preset);
    currentPresetId.value = presetId;
    debouncedSaveEngineState();
  }

  /**
   * 将当前设置保存为自定义预设
   * @param name - 预设名称
   */
  async function saveCurrentAsPreset(name: string) {
    const snapshot = getCurrentSnapshot();
    const id = `custom_${Date.now()}`;
    const newPreset: Preset = {
      id,
      name,
      builtin: false,
      ...snapshot
    };

    const customPresets = loadCustomPresets();
    customPresets.push(newPreset);
    saveCustomPresets(customPresets);

    // 重新加载预设列表
    loadPresets();
    currentPresetId.value = id;
    debouncedSaveEngineState();
  }

  /**
   * 删除自定义预设
   * @param presetId - 预设 ID
   */
  function deletePreset(presetId: string) {
    // 不允许删除内置预设
    if (isBuiltinPreset(presetId)) return;

    const customPresets = loadCustomPresets();
    const filtered = customPresets.filter((p) => p.id !== presetId);
    saveCustomPresets(filtered);

    // 重新加载预设列表
    loadPresets();

    // 如果删除的是当前预设，切换到平坦预设
    if (currentPresetId.value === presetId) {
      currentPresetId.value = 'flat';
    }
  }

  /**
   * 加载保存的 currentPresetId
   */
  function loadCurrentPresetId(): string {
    try {
      const stored = localStorage.getItem('sound-effect-current-preset');
      return stored || 'flat';
    } catch {
      return 'flat';
    }
  }

  /**
   * 保存 currentPresetId
   */
  function saveCurrentPresetId() {
    try {
      localStorage.setItem('sound-effect-current-preset', currentPresetId.value);
    } catch (error) {
      console.error('[useAudioEngine] 保存当前预设 ID 失败:', error);
    }
  }

  // 初始化预设列表
  loadPresets();
  currentPresetId.value = loadCurrentPresetId();
  // 监听 currentPresetId 变化并持久化
  watch(currentPresetId, () => saveCurrentPresetId());

  // 增益减少量轮询定时器
  let gainReductionRafId: number | null = null;

  /**
   * 初始化音频引擎
   */
  async function initialize() {
    // Web Audio 模式不需要初始化 Rust 引擎
    if (isWebAudioMode()) {
      // 但需要恢复上次保存的音效状态（Web Audio DSP 链懒加载，参数先入内存，
      // 待首次 doPlay 接线时通过 syncAllParams 应用）
      const savedState = loadEngineState();
      if (savedState) {
        try {
          await applySavedState(savedState);
        } catch (error) {
          console.error('[useAudioEngine] Web Audio 恢复音效状态失败:', error);
        }
      }
      state.isInitialized = true;
      return true;
    }

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
        // 恢复上次保存的音效状态
        const savedState = loadEngineState();
        if (savedState) {
          await applySavedState(savedState);
        }
        startGainReductionPolling();
        console.log('[useAudioEngine] 引擎初始化成功');
        return true;
      } else if (result === true) {
        // 直接返回 true 的情况
        state.isInitialized = true;
        await refreshAllParams();
        // 恢复上次保存的音效状态
        const savedState = loadEngineState();
        if (savedState) {
          await applySavedState(savedState);
        }
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
    if (engineSaveTimer) {
      clearTimeout(engineSaveTimer);
      engineSaveTimer = null;
    }
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
      const isLoudnessEnabled = typeof api.isLoudnessEnabled === 'function'
        ? await api.isLoudnessEnabled()
        : false;
      loudness.value = await api.getLoudness();
      loudness.value.enabled = isLoudnessEnabled;
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
    if (isWebAudioMode()) {
      compressorGR.value = audioEngine.getCompressorGainReduction()
      limiterGR.value = audioEngine.getLimiterGainReduction()
      return
    }
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
    if (gainReductionRafId !== null) return;
    let lastTime = 0;
    const tick = (now: number) => {
      if (gainReductionRafId === null) return;
      if (now - lastTime >= 200) {
        lastTime = now;
        refreshGainReductions();
      }
      gainReductionRafId = requestAnimationFrame(tick);
    };
    gainReductionRafId = requestAnimationFrame(tick);
  }

  /**
   * 停止增益减少量轮询
   */
  function stopGainReductionPolling() {
    if (gainReductionRafId !== null) {
      cancelAnimationFrame(gainReductionRafId);
      gainReductionRafId = null;
    }
  }

  // === 状态持久化 ===

  /**
   * 保存音效引擎当前状态到 localStorage
   * @param snapshot - 可选的预构建快照，避免重复浅拷贝
   */
  function saveEngineState(snapshot?: Record<string, unknown>) {
    try {
      const stateData = snapshot ?? {
        eqEnabled: eqEnabled.value,
        eqBands: eqBands.value,
        compressorEnabled: compressorEnabled.value,
        compressor: compressor.value,
        limiterEnabled: limiterEnabled.value,
        limiter: limiter.value,
        loudness: loudness.value,
        virtualBass: virtualBass.value,
        softClipper: softClipper.value
      };
      localStorage.setItem(ENGINE_STATE_STORAGE_KEY, JSON.stringify(stateData));
    } catch (error) {
      console.error('[useAudioEngine] 保存引擎状态失败:', error);
    }
  }

  /**
   * 防抖保存音效引擎状态
   * @param delayOrSnapshot - 防抖延迟时间（毫秒）或预构建快照对象
   */
  let engineSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function debouncedSaveEngineState(delayOrSnapshot: number | Record<string, unknown> = 300) {
    if (engineSaveTimer) clearTimeout(engineSaveTimer);
    if (typeof delayOrSnapshot === 'object') {
      // 从 watchEffect 传入的预构建快照
      engineSaveTimer = setTimeout(() => {
        saveEngineState(delayOrSnapshot);
      }, 300);
    } else {
      engineSaveTimer = setTimeout(() => {
        saveEngineState();
      }, delayOrSnapshot);
    }
  }

  /**
   * 从 localStorage 加载音效引擎状态
   * @returns 保存的状态，若无则返回 null
   */
  function loadEngineState() {
    try {
      const stored = localStorage.getItem(ENGINE_STATE_STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.error('[useAudioEngine] 加载引擎状态失败:', error);
    }
    return null;
  }

  /**
   * 应用保存的音效引擎状态
   * @param savedState - 保存的状态对象
   */
  async function applySavedState(savedState: any) {
    if (!savedState) return;

    try {
      // 应用 EQ 状态
      if (savedState.eqEnabled !== undefined) {
        await setEqEnabled(savedState.eqEnabled);
      }
      if (savedState.eqBands && Array.isArray(savedState.eqBands)) {
        // 通过 setEqBand 逐个恢复到 Rust API
        for (let i = 0; i < savedState.eqBands.length; i++) {
          const band = savedState.eqBands[i];
          try {
            await setEqBand(i, band);
          } catch (e) {
            console.error(`[useAudioEngine] 恢复 EQ 频段 ${i} 失败:`, e);
          }
        }
      }

      // 应用压缩器状态
      if (savedState.compressorEnabled !== undefined) {
        await setCompressorEnabled(savedState.compressorEnabled);
      }
      if (savedState.compressor) {
        // 通过 setCompressorParams 恢复到 Rust API
        try {
          await setCompressorParams(savedState.compressor);
        } catch (e) {
          console.error('[useAudioEngine] 恢复压缩器参数失败:', e);
        }
      }

      // 应用限制器状态
      if (savedState.limiterEnabled !== undefined) {
        await setLimiterEnabled(savedState.limiterEnabled);
      }
      if (savedState.limiter) {
        try {
          await setLimiterParams(savedState.limiter);
        } catch (e) {
          console.error('[useAudioEngine] 恢复限制器参数失败:', e);
        }
      }

      // 应用等响度状态
      if (savedState.loudness) {
        loudness.value = { ...savedState.loudness };
        try {
          await audioEngine.setLoudnessParams({ ...savedState.loudness });
        } catch (e) {
          console.error('[useAudioEngine] 恢复等响度参数失败:', e);
        }
      }

      // 应用虚拟低频状态
      if (savedState.virtualBass) {
        virtualBass.value = { ...savedState.virtualBass };
      }

      // 应用软限幅器状态
      if (savedState.softClipper) {
        softClipper.value = { ...savedState.softClipper };
      }

      console.log('[useAudioEngine] 已恢复保存的音效状态');
    } catch (error) {
      console.error('[useAudioEngine] 应用保存的状态失败:', error);
    }
  }

  // === EQ 控制 ===

  /**
   * 设置 EQ 启用状态
   * @param enabled - 是否启用
   */
  async function setEqEnabled(enabled: boolean) {
    eqEnabled.value = enabled;
    // 通过 audioEngine 分发（自动选择 Web Audio 或 Rust）
    try {
      await audioEngine.setEqEnabled(enabled);
    } catch (error) {
      console.error('[useAudioEngine] 设置 EQ 启用状态失败:', error);
    }
  }

  /**
   * 设置 EQ 频段
   * @param bandIndex - 频段索引
   * @param settings - 频段设置（部分更新）
   */
  async function setEqBand(bandIndex: number, settings: Partial<EqBandSettings>) {
    if (bandIndex < 0 || bandIndex >= eqBands.value.length) return;

    const updated = { ...eqBands.value[bandIndex], ...settings };
    eqBands.value[bandIndex] = updated;

    // 通过 audioEngine 分发
    try {
      await audioEngine.setEqBand(bandIndex, updated);
    } catch (error) {
      console.error('[useAudioEngine] 设置 EQ 频段失败:', error);
    }
  }

  /**
   * 设置所有 EQ 频段增益
   */
  function setEqGains(gains: number[]) {
    const newBands = eqBands.value.map((band, i) => ({
      ...band,
      preGain: gains[i] ?? 0
    }));
    eqBands.value = newBands;
    audioEngine.setEqGains(gains).catch(() => { /* ignore */ });
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
    try {
      await audioEngine.setCompressorEnabled(enabled);
    } catch (error) {
      console.error('[useAudioEngine] 设置压缩器启用状态失败:', error);
    }
  }

  /**
   * 设置压缩器参数
   * @param params - 压缩器参数
   */
  async function setCompressorParams(params: Partial<CompressorParams>) {
    compressor.value = { ...compressor.value, ...params };
    try {
      await audioEngine.setCompressorParams(compressor.value);
    } catch (error) {
      console.error('[useAudioEngine] 设置压缩器参数失败:', error);
    }
  }

  // === 限制器控制 ===

  /**
   * 设置限制器启用状态
   * @param enabled - 是否启用
   */
  async function setLimiterEnabled(enabled: boolean) {
    limiterEnabled.value = enabled;
    try {
      await audioEngine.setLimiterEnabled(enabled);
    } catch (error) {
      console.error('[useAudioEngine] 设置限制器启用状态失败:', error);
    }
  }

  /**
   * 设置限制器参数
   * @param params - 限制器参数
   */
  async function setLimiterParams(params: Partial<LimiterParams>) {
    limiter.value = { ...limiter.value, ...params };
    try {
      await audioEngine.setLimiterParams(limiter.value);
    } catch (error) {
      console.error('[useAudioEngine] 设置限制器参数失败:', error);
    }
  }

  // === 等响度控制 ===

  /**
   * 设置等响度参数
   * @param params - 等响度参数
   */
  async function setLoudnessParams(params: Partial<LoudnessParams>) {
    loudness.value = { ...loudness.value, ...params };
    try {
      await audioEngine.setLoudnessParams(loudness.value);
    } catch (error) {
      console.error('[useAudioEngine] 设置等响度参数失败:', error);
    }
  }

  /**
   * 设置等响度启用状态
   * @param enabled - 是否启用
   */
  async function setLoudnessEnabled(enabled: boolean) {
    loudness.value.enabled = enabled;
    audioEngine.setLoudnessEnabled(enabled);
  }

  // === 虚拟低频控制 ===

  /**
   * 设置虚拟低频参数
   * @param params - 虚拟低频参数（部分更新）
   */
  async function setVirtualBassParams(params: Partial<VirtualBassParams>) {
    virtualBass.value = { ...virtualBass.value, ...params };
    audioEngine.setVirtualBassParams(virtualBass.value);
  }

  // === 软限幅器控制 ===

  /**
   * 设置软限幅器参数
   * @param params - 软限幅器参数（部分更新）
   */
  async function setSoftClipperParams(params: Partial<SoftClipperParams>) {
    softClipper.value = { ...softClipper.value, ...params };
    audioEngine.setSoftClipperParams(softClipper.value);
  }

  // === 监听音效参数变化，自动保存到 localStorage ===
  // 使用单个 watchEffect 替代 8 个独立 deep watch，减少重复序列化
  watchEffect(() => {
    // 访问所有需要追踪的属性，建立响应式依赖
    const snapshot = {
      eqEnabled: eqEnabled.value,
      eqBands: eqBands.value.map(b => ({ ...b })),
      compressorEnabled: compressorEnabled.value,
      compressor: { ...compressor.value },
      limiterEnabled: limiterEnabled.value,
      limiter: { ...limiter.value },
      loudness: { ...loudness.value },
      virtualBass: { ...virtualBass.value },
      softClipper: { ...softClipper.value }
    }
    // 防抖写入，避免频繁操作时的性能损耗
    debouncedSaveEngineState(snapshot)
  })

  // 组件作用域销毁兜底：即使调用方忘记显式调用 destroy()，
  // 也确保停止增益轮询 rAF 循环并清理防抖定时器，避免残留 60fps 空转与定时器
  onScopeDispose(() => {
    stopGainReductionPolling();
    if (engineSaveTimer) {
      clearTimeout(engineSaveTimer);
      engineSaveTimer = null;
    }
  });

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
    loudness,
    setLoudnessEnabled,
    setLoudnessParams,

    // 虚拟低频
    virtualBass,
    setVirtualBassParams,

    // 软限幅器
    softClipper,
    setSoftClipperParams,

    // 预设管理
    presets,
    currentPresetId,
    applyPreset,
    saveCurrentAsPreset,
    deletePreset,
    isBuiltinPreset,

    // 生命周期
    initialize,
    destroy,
    refreshAllParams
  };
}

export default useAudioEngine;
