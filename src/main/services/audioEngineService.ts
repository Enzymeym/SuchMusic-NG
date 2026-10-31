/**
 * Rust 音频引擎服务
 * 用于 Electron 主进程中调用 Rust NAPI 模块
 */

import { BrowserWindow, ipcMain } from 'electron';
import { readFile } from 'fs/promises';
import { loadNativeModule as loadNative } from './nativeModuleLoader';
import { resolveWasapiDeviceId } from './wasapiService';



// 类型定义
export interface AudioEngineConfig {
  sampleRate?: number;
  bufferSize?: number;
  channels?: number;
  enableEq?: boolean;
  enableCompressor?: boolean;
  enableLimiter?: boolean;
  enableLoudness?: boolean;
}

export interface TrackInfo {
  durationMs: number;
  sampleRate: number;
  channels: number;
  format: string;
  bitsPerSample?: number;
}

export interface EqBandSettingsJs {
  frequency: number;
  preGain: number;
  postGain: number;
  preQ: number;
  postQ: number;
  bandType: 'lowShelf' | 'highShelf' | 'peaking' | 'notch';
}

export interface CompressorParamsJs {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  kneeDb: number;
}

export interface LimiterParamsJs {
  ceilingDb: number;
  releaseMs: number;
}

export interface LoudnessParamsJs {
  enabled: boolean;
  compensation: number;
  referenceLoudness: number;
  direction: 'low' | 'high' | 'both';
}

export type LoopMode = 'none' | 'one' | 'all';
export type EngineState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped';

// 引擎实例存储
const engines = new Map<string, any>();
// 轨道信息存储 (用于音频输出桥接)
const engineTracks = new Map<string, { sampleRate: number; channels: number; bitsPerSample?: number }>();
// 音频输出桥接存储 (WASAPI)
const engineOutputs = new Map<string, {
  outputEngine: any;
  interval: ReturnType<typeof setInterval> | null;
  /** 播放进度推送定时器（替代渲染进程的 IPC 轮询） */
  progressTimer: ReturnType<typeof setInterval> | null;
  stopped: boolean;
  paused: boolean;
}>();

// 引擎状态追踪
const engineVolumes = new Map<string, number>();
const engineLoopModes = new Map<string, LoopMode>();
const engineEqEnabled = new Map<string, boolean>();
const engineCompressorEnabled = new Map<string, boolean>();
const engineLimiterEnabled = new Map<string, boolean>();

/** 跟踪哪些 WebContents 设置了 FFT 回调，用于自动清理 */
const engineToWebContents = new Map<string, Electron.WebContents>();

/**
 * 引擎创建者（WebContents）。
 *
 * 用于两件事：
 * 1. 紧急停止按窗口隔离——桌面歌词 / 任务栏控制等副窗口卸载时，不能连带把
 *    主窗口正在播放的引擎停掉；
 * 2. 窗口销毁时回收其引擎，避免渲染进程重载后主进程残留孤儿引擎。
 */
const engineOwners = new Map<string, Electron.WebContents>();

let engineIdCounter = 0;

/** 用户选择的音频输出配置（由渲染进程通过 IPC 同步） */
let currentOutputMode: 'webaudio' | 'wasapi-shared' | 'wasapi-exclusive' = 'wasapi-shared';
let currentOutputDeviceId: string = '';

/**
 * 生成唯一引擎 ID
 * @returns 引擎 ID
 */
function generateEngineId(): string {
  return `engine_${++engineIdCounter}_${Date.now()}`;
}

/**
 * 加载 native 模块
 *
 * 统一走 nativeModuleLoader：路径解析、候选目录、错误信息与
 * wasapiService / mediaControlService / tagReaderService 保持一致。
 * AudioEngine（解码）与 WasapiOutputEngine（输出）任一并存即可用，
 * 因此这里使用 'any' 模式。
 */
let nativeModule: any = null;

function loadNativeModule(): any {
  if (nativeModule) return nativeModule;
  const { module } = loadNative({
    label: 'AudioEngine',
    filenames: ['audio_napi.node'],
    requiredExports: ['AudioEngine', 'WasapiOutputEngine'],
    exportMode: 'any'
  });
  nativeModule = module;
  return nativeModule;
}

/**
 * DSP 默认开关。
 *
 * EQ 与压缩器是纯音质修饰：EQ 每块要跑 10 段双联滤波器，压缩器分声道处理，
 * 对「原样播放」毫无必要，且都会带来可观的 CPU 开销，故默认关闭。
 * 限制器成本极低（一次逐帧包络）但能防止 0 dBFS 母带削波，保留开启。
 */
const DSP_DEFAULTS = {
  enableEq: false,
  enableCompressor: false,
  enableLimiter: true,
  enableLoudness: false
} as const

/**
 * 创建音频引擎实例
 * @param config 引擎配置（缺省字段走 DSP_DEFAULTS，而非原生模块内部的兜底值）
 * @returns 引擎实例 ID
 */
export function createAudioEngine(config?: AudioEngineConfig): string {
  try {
    const native = loadNativeModule();
    const engineId = generateEngineId();

    const engine = new native.AudioEngine({ ...DSP_DEFAULTS, ...(config ?? {}) });
    engines.set(engineId, engine);
    console.log('[AudioEngine] 创建引擎实例:', engineId);
    return engineId;
  } catch (error) {
    console.error('[AudioEngine] 创建引擎失败:', error);
    throw error;
  }
}

/**
 * 获取音频引擎实例
 * @param engineId 引擎 ID
 */
function getEngine(engineId: string): any {
  const engine = engines.get(engineId);
  if (!engine) {
    throw new Error(`引擎 ${engineId} 不存在`);
  }
  return engine;
}

/**
 * 销毁音频引擎实例
 * @param engineId 引擎 ID
 */
export function destroyAudioEngine(engineId: string): void {
  stopOutput(engineId);
  engineTracks.delete(engineId);
  engineVolumes.delete(engineId);
  engineLoopModes.delete(engineId);
  engineEqEnabled.delete(engineId);
  engineCompressorEnabled.delete(engineId);
  engineLimiterEnabled.delete(engineId);
  engineOwners.delete(engineId);
  const engine = engines.get(engineId);
  if (engine) {
    try {
      engine.reset();
    } catch (e) {
      console.warn('[AudioEngine] 重置引擎失败:', e);
    }
    engines.delete(engineId);
    console.log('[AudioEngine] 销毁引擎实例:', engineId);
  }
}

/**
 * 销毁所有引擎实例（包括 WASAPI 输出引擎）
 */
export function destroyAllEngines(): void {
  // 清理所有输出桥接（WASAPI 输出引擎）
  for (const engineId of engineOutputs.keys()) {
    stopOutput(engineId);
  }
  engineOutputs.clear();
  engineTracks.clear();

  // 清理解码引擎
  engines.forEach((engine) => {
    try {
      engine.stop();
      engine.reset();
    } catch (e) {
      console.warn('[AudioEngine] 重置引擎失败:', e);
    }
  });
  engines.clear();

  // 清理其余按引擎 ID 索引的映射，避免残留引用
  engineVolumes.clear();
  engineLoopModes.clear();
  engineEqEnabled.clear();
  engineCompressorEnabled.clear();
  engineLimiterEnabled.clear();
  engineToWebContents.clear();
  engineOwners.clear();

  console.log('[AudioEngine] 已销毁所有引擎实例');
}

/**
 * 紧急停止音频输出的可选项
 */
export interface EmergencyStopOptions {
  /**
   * 是否同时销毁引擎实例。
   * - 页面卸载（刷新 / 关闭窗口）：true，渲染进程马上重建，不销毁会残留孤儿引擎；
   * - HMR 热更新（`vite:beforeUpdate`）：false，preload 上下文不会重建，
   *   其缓存的 engineId 必须继续有效，否则之后每次调用都会报「引擎 xxx 不存在」。
   */
  destroy?: boolean;
}

/**
 * 紧急停止音频输出（供渲染进程 HMR / beforeunload 调用）
 * 使用 ipcMain.on 确保 fire-and-forget，不依赖渲染进程等待响应
 *
 * 按窗口隔离：桌面歌词 / 任务栏控制等副窗口卸载时，只处理该窗口自己创建的引擎，
 * 不能连带停掉主窗口正在播放的音频。
 *
 * @param owner 调用方 WebContents；省略表示所有引擎（应用退出等全局场景）
 * @param options 是否销毁引擎实例，见 EmergencyStopOptions
 */
export function emergencyStopAll(
  owner?: Electron.WebContents | null,
  options: EmergencyStopOptions = {}
): void {
  const shouldDestroy = options.destroy === true;
  const targets = owner
    ? [...engines.keys()].filter((engineId) => engineOwners.get(engineId) === owner)
    : [...engines.keys()];

  for (const engineId of targets) {
    if (shouldDestroy) {
      destroyAudioEngine(engineId);
      continue;
    }
    // 只停止：保留引擎实例（渲染进程缓存的 engineId 继续有效）与轨道信息
    // （startOutput 依赖 engineTracks 建桥接，清掉会导致后续 play 静默返回）
    stopOutput(engineId);
    const engine = engines.get(engineId);
    if (!engine) continue;
    try {
      engine.stop();
      engine.reset();
    } catch (e) {
      console.warn('[AudioEngine] 紧急停止引擎失败:', e);
    }
  }

  if (!owner || shouldDestroy) {
    // 全局停止 / 页面卸载：同时清理 wasapiService 的独立 WASAPI 探测引擎
    try {
      const { destroyAllWasapiEngines } = require('./wasapiService');
      destroyAllWasapiEngines();
    } catch (e) {
      // wasapiService 可能未加载
    }
  }

  console.log(
    `[AudioEngine] 紧急停止音频输出完成（${owner ? '当前窗口' : '全部'}，引擎 ${targets.length} 个，${shouldDestroy ? '已销毁' : '仅停止'}）`
  );
}

/**
 * 转换 EQ 频段类型
 */
function convertEqBandType(type: string): number {
  const typeMap: Record<string, number> = {
    'lowShelf': 0,
    'highShelf': 1,
    'peaking': 2,
    'notch': 3
  };
  return typeMap[type] ?? 2;
}

/**
 * 转换 EQ 设置到 Rust 格式
 * @param settings - EQ 频段设置
 * @returns 转换后的 Rust 格式参数
 */
function convertEqSettings(settings: Partial<EqBandSettingsJs>) {
  return {
    frequency: settings.frequency ?? 1000,
    preGain: settings.preGain ?? 0,
    postGain: settings.postGain ?? 0,
    preQ: settings.preQ ?? 1,
    postQ: settings.postQ ?? 1,
    bandType: convertEqBandType(settings.bandType ?? 'peaking')
  };
}

/**
 * 创建音频输出引擎（根据用户选择的输出模式创建对应引擎）
 * 
 * 智能采样率策略：对于 ≤ 48kHz 且 ≤ 16bit 的源文件，直接使用源采样率，
 * 避免对低质量音频做无意义升采样。
 */
function createOutputEngine(native: any, sampleRate: number, channels: number): any | null {
  // Web Audio 模式：不需要 WASAPI 输出引擎，由渲染进程直接播放
  if (currentOutputMode === 'webaudio') {
    console.log(`[AudioEngine] Web Audio 模式，跳过原生输出引擎`);
    return null;
  }

  // WASAPI 模式
  const wasapiMode = currentOutputMode === 'wasapi-exclusive' ? 'Exclusive' : 'Shared';
  // 自动选择输出设备：记录为空或设备已失效（外置声卡拔出等）时回退默认设备，
  // 否则原生层会因为「用户明确指定设备」而不做回退，直接创建失败导致无声。
  let deviceId = resolveWasapiDeviceId(currentOutputDeviceId);
  if (deviceId !== (currentOutputDeviceId || null)) {
    currentOutputDeviceId = deviceId ?? '';
  }

  try {
    const eng = new native.WasapiOutputEngine();
    eng.create(sampleRate, channels, wasapiMode, deviceId);
    eng.start();
    const actualRate: number = eng.getSampleRate?.() ?? sampleRate;
    if (actualRate !== sampleRate) {
      console.log(`[AudioEngine] WASAPI ${wasapiMode} 音频输出已启动 (请求${sampleRate}Hz → 协商${actualRate}Hz, ${channels}ch)`);
    } else {
      console.log(`[AudioEngine] WASAPI ${wasapiMode} 音频输出已启动 (${sampleRate}Hz, ${channels}ch)`);
    }
    return eng;
  } catch (e: any) {
    // 指定设备仍失败（被独占占用 / 格式不支持）时，最后再试一次系统默认设备
    if (deviceId) {
      console.warn(`[AudioEngine] 指定设备初始化失败，尝试默认设备: ${e?.message}`);
      try {
        const fallbackEng = new native.WasapiOutputEngine();
        fallbackEng.create(sampleRate, channels, wasapiMode, null);
        fallbackEng.start();
        currentOutputDeviceId = '';
        console.log(`[AudioEngine] WASAPI ${wasapiMode} 已回退到默认设备输出`);
        return fallbackEng;
      } catch (fallbackError: any) {
        console.error('[AudioEngine] 默认设备同样不可用:', fallbackError?.message);
      }
    }
    console.error('[AudioEngine] WASAPI 不可用:', e.message);
    return null;
  }
}

/**
 * 启动流式音频输出桥接
 * 从 Rust 流式解码线程的 RingAudioBuffer 读取 PCM，推送到 WASAPI
 * 首次用 outputAudio 初始化缓冲区，后续用 appendAudio 追加（避免 set_all 重置位置导致卡顿）
 * @param startWallClock 首帧推送后是否启动墙钟计时（seek 场景为 true，首播场景 play() 已启动则为 false）
 */
function startOutput(engineId: string, engine: any, startWallClock: boolean = false): void {
  const existing = engineOutputs.get(engineId);
  let outputEngine: any;
  let sampleRate: number;
  let channels: number;

  if (existing?.outputEngine && existing.paused) {
    // 暂停恢复：复用保留的输出引擎
    outputEngine = existing.outputEngine;
    const track = engineTracks.get(engineId)!;
    sampleRate = track.sampleRate;
    channels = track.channels;
    try { outputEngine.start(); } catch {}
    if (existing.interval) clearInterval(existing.interval);
    if (existing.progressTimer) clearInterval(existing.progressTimer);
  } else {
    // 首次播放：创建新引擎
    stopOutput(engineId);
    const native = loadNativeModule();
    const track = engineTracks.get(engineId);
    if (!track) return;
    sampleRate = track.sampleRate;
    channels = track.channels;
    outputEngine = createOutputEngine(native, sampleRate, channels);
  }

  if (!outputEngine) return;

  // 进度推送：由主进程按墙钟计算位置后主动 send 给渲染进程，
  // 免去渲染进程每 250ms 一次 IPC invoke 往返（一首 5 分钟的歌约 1200 次）。
  // getPosition() 只做 Instant::elapsed 运算，不触碰 WASAPI，成本可忽略。
  const PROGRESS_INTERVAL_MS = 250;
  const progressTimer = setInterval(() => {
    const current = engineOutputs.get(engineId);
    if (!current || current.stopped || current.paused) return;
    try {
      const position = typeof engine.getPosition === 'function' ? engine.getPosition() : 0;
      if (!(position > 0)) return;
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send('audio-engine:progress', { engineId, position });
      }
    } catch {
      // 引擎已销毁等情况，静默忽略
    }
  }, PROGRESS_INTERVAL_MS);

  // 每 20ms 推送一次，读取尽可能多的数据以建立缓冲防止欠载
  const BRIDGE_INTERVAL_MS = 20;
  const minFirstChunk = Math.floor(sampleRate * channels * 0.3); // 首块至少 300ms 防止欠载爆音
  let isFirstChunk = !existing?.paused; // 恢复时不是"首块"

  const interval = setInterval(() => {
    try {
      const availableSamples = engine.availableSamples?.() ?? 0;
      if (availableSamples === 0) {
        // 检测 EOF：流式解码已停止且环形缓冲区为空，表示播放完毕
        // 必须确保已经推送过数据（!isFirstChunk），防止 streaming 线程启动
        // 与 bridge 定时器之间的竞态导致误判
        const streamingStopped = engine.isStreaming ? !engine.isStreaming() : false;
        if (streamingStopped && !isFirstChunk) {
          const output = engineOutputs.get(engineId);
          if (output && !output.stopped) {
            output.stopped = true;
            clearInterval(interval);
            clearInterval(progressTimer);
            try {
              const win = BrowserWindow.getAllWindows()[0];
              if (win) win.webContents.send('audio-engine:ended');
            } catch {}
            console.log('[AudioEngine] 播放结束，已发送 ended 事件');
          }
        }
        return;
      }

      // 首块必须积累足够数据，避免输出线程欠载 → 静音 → append 无淡入导致爆音
      // 但如果流式解码已停止（EOF），剩余数据不足也必须推送，否则文件末尾会被静音丢弃
      if (isFirstChunk && availableSamples < minFirstChunk) {
        const streamingStopped = engine.isStreaming ? !engine.isStreaming() : false;
        if (!streamingStopped) return;
      }

      // 单次最多读 0.5 秒：前瞻缓冲由 Rust 侧 AudioDataStore（已回收已播放前缀）
      // 与 WASAPI 自身缓冲共同保证，无需一次搬 2 秒（约 700KB）造成 GC 压力
      const readSize = Math.min(availableSamples, Math.floor(sampleRate * channels * 0.5));
      const floatData = engine.readAudioBuffer(readSize);
      if (!floatData || floatData.length === 0) return;

      // readAudioBuffer 返回 f32 数组/Buffer，转为 Buffer 传给输出引擎
      const data = floatData instanceof Buffer
        ? floatData
        : Buffer.from(new Float32Array(floatData).buffer);

      if (isFirstChunk) {
        outputEngine.outputAudio(data, channels, sampleRate);
        isFirstChunk = false;
        // seek 场景：首帧推送后才启动墙钟，保证进度与实际音频同步
        if (startWallClock) {
          try { engine.playOneShot(); } catch { engine.play(); }
        }
      } else if (typeof outputEngine.appendAudio === 'function') {
        outputEngine.appendAudio(data, channels, sampleRate);
      } else {
        // 旧版 native 模块无 appendAudio，回退到 outputAudio（可能卡顿）
        outputEngine.outputAudio(data, channels, sampleRate);
      }
    } catch (err) {
      console.error('[AudioEngine] 输出桥接错误:', err);
    }
  }, BRIDGE_INTERVAL_MS);

  engineOutputs.set(engineId, { outputEngine, interval, progressTimer, stopped: false, paused: false });
}

/**
 * 停止音频输出桥接
 * @param engineId 引擎 ID
 * @param preserve 为 true 时保留引擎实例供后续恢复（暂停场景）
 */
function stopOutput(engineId: string, preserve: boolean = false): void {
  const output = engineOutputs.get(engineId);
  if (output) {
    output.stopped = true;
    if (output.interval) clearInterval(output.interval);
    if (output.progressTimer) clearInterval(output.progressTimer);
    if (preserve) {
      // 暂停：仅停止播放，保留引擎实例以便恢复
      try { output.outputEngine.stop(); } catch {}
    } else {
      // 彻底停止：销毁引擎
      try { output.outputEngine.stop(); } catch {}
      try { output.outputEngine.reset(); } catch {}
      engineOutputs.delete(engineId);
    }
    console.log('[AudioEngine] 音频输出桥接已停止' + (preserve ? '（引擎保留）' : ''));
  }
}

/**
 * 清空 Rust 侧 FFT 回调。
 *
 * 传入 `null` 才能真正让 Rust 停止计算（原生接口签名是 `Option<FftCallback>`）；
 * 传空函数只是「不推送」，FFT 仍会在解码线程里逐帧执行。
 * 旧版二进制可能不接受 null，此时回退到空函数。
 */
function clearFftCallback(engine: any): void {
  if (!engine || typeof engine.setFftCallback !== 'function') return;
  try {
    engine.setFftCallback(null);
  } catch {
    engine.setFftCallback(() => {});
  }
}

/**
 * 注册音频引擎 IPC 处理器
 */
export function registerAudioEngineHandlers(): void {
  // 读取音频原始文件（用于 Web Audio 模式，由浏览器原生解码）
  ipcMain.handle('audio-engine:read-audio-file', async (_event, filePath: string) => {
    try {
      const buffer = await readFile(filePath)
      console.log(`[AudioEngine] 读取原始音频文件: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`)
      return { success: true, data: buffer }
    } catch (error) {
      console.error('[AudioEngine] 读取文件失败:', error)
      return { success: false, error: String(error) }
    }
  })

  // 同步音频输出配置（由渲染进程在设置变更时调用）
  ipcMain.handle('audio-engine:set-output-config', async (_event, config: {
    mode: 'webaudio' | 'wasapi-shared' | 'wasapi-exclusive';
    deviceId?: string;
  }) => {
    currentOutputMode = config.mode;
    currentOutputDeviceId = config.deviceId ?? '';
    console.log(`[AudioEngine] 输出配置已更新: mode=${currentOutputMode}, deviceId=${currentOutputDeviceId || '默认'}`);
    return { success: true };
  });

  // 设置 FFT 频谱回调（WASAPI 音频可视化）
  ipcMain.on('audio-engine:set-fft-callback', (event, engineId: string) => {
    const engine = engines.get(engineId);
    if (!engine || typeof engine.setFftCallback !== 'function') {
      console.warn('[AudioEngine] 引擎不支持 FFT 回调');
      return;
    }

    // 清理此 WebContents 之前的 FFT 回调，避免旧引用泄漏
    const wc = event.sender;
    if (engineToWebContents.has(engineId)) {
      const oldWc = engineToWebContents.get(engineId)!;
      if (oldWc !== wc && !oldWc.isDestroyed()) {
        oldWc.removeAllListeners('destroyed');
      }
    }
    engineToWebContents.set(engineId, wc);

    // WebContents 销毁时自动清理 FFT 回调
    wc.once('destroyed', () => {
      if (engineToWebContents.get(engineId) === wc) {
        engineToWebContents.delete(engineId);
        clearFftCallback(engine);
      }
    });

    engine.setFftCallback((spectrum: number[]) => {
      try {
        wc.send('audio-engine:fft-data', spectrum);
      } catch (err) {
        // WebContents may be destroyed (e.g., page reload), silently ignore
      }
    });
  });

  // 移除 FFT 频谱回调（停止音频可视化数据推送）
  ipcMain.on('audio-engine:remove-fft-callback', (_event, engineId: string) => {
    const engine = engines.get(engineId);
    if (!engine) return;
    clearFftCallback(engine);
    // 清理 WebContents 追踪
    const wc = engineToWebContents.get(engineId);
    if (wc && !wc.isDestroyed()) {
      wc.removeAllListeners('destroyed');
    }
    engineToWebContents.delete(engineId);
  });

  // 创建引擎
  ipcMain.handle('audio-engine:create', async (event, config?: AudioEngineConfig) => {
    try {
      const engineId = createAudioEngine(config);
      // 记录创建者：窗口销毁时回收其引擎（渲染进程重载后 preload 会重建管理器，
      // 旧引擎若无人回收就会变成孤儿，长期占用环形缓冲与 FFT 分析器）
      engineOwners.set(engineId, event.sender);
      event.sender.once('destroyed', () => {
        if (engineOwners.get(engineId) !== event.sender) return;
        destroyAudioEngine(engineId);
      });
      return { success: true, engineId };
    } catch (error) {
      console.error('[AudioEngine] 创建引擎失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 销毁引擎
  ipcMain.handle('audio-engine:destroy', async (_event, engineId: string) => {
    try {
      stopOutput(engineId);
      engineTracks.delete(engineId);
      destroyAudioEngine(engineId);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 加载文件
  ipcMain.handle('audio-engine:load', async (_event, engineId: string, filePath: string) => {
    try {
      const engine = getEngine(engineId);
      const trackInfo: TrackInfo = engine.loadFile(filePath);
      // 存储轨道信息（用于后续音频输出桥接）
      engineTracks.set(engineId, {
        sampleRate: trackInfo.sampleRate,
        channels: trackInfo.channels,
        bitsPerSample: trackInfo.bitsPerSample
      });
      console.log(`[AudioEngine] 轨道信息: ${trackInfo.sampleRate}Hz, ${trackInfo.channels}ch, ${trackInfo.durationMs}ms`);

      return { success: true, trackInfo };
    } catch (error) {
      console.error('[AudioEngine] 加载文件失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 播放 / 恢复（统一走 Rust 流式解码）
  ipcMain.handle('audio-engine:play', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);

      // Rust 流式线程逐帧解码 → RingAudioBuffer → startOutput 桥接 → WASAPI 输出
      engine.play(); // 启动/恢复流式解码线程
      startOutput(engineId, engine); // 启动桥接，读取 RingAudioBuffer 推送到输出

      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 播放失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 暂停
  ipcMain.handle('audio-engine:pause', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      engine.pause();
      // 暂停时保留输出引擎实例（带淡出 ramp），恢复时复用避免重建
      stopOutput(engineId, true);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 暂停失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 恢复播放（Rust 流式线程从暂停位置继续）
  ipcMain.handle('audio-engine:resume', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      try { engine.playOneShot(); } catch { engine.play(); }
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 恢复失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 停止
  ipcMain.handle('audio-engine:stop', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      engine.stop();
      stopOutput(engineId);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 停止失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 跳转（流式模式：重置解码器并跳过帧）
  ipcMain.handle('audio-engine:seek', async (_event, engineId: string, positionMs: number) => {
    try {
      const engine = getEngine(engineId);
      // 先刷新输出缓冲区，避免播放旧数据
      const output = engineOutputs.get(engineId);
      if (output) {
        try { output.outputEngine.flush(); } catch {}
      }

      engine.seek(positionMs);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 跳转失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 跳转并播放（合并 seek + play 为单次 IPC，减少往返延迟）
  ipcMain.handle('audio-engine:seek-and-play', async (_event, engineId: string, positionMs: number) => {
    try {
      const engine = getEngine(engineId);
      const track = engineTracks.get(engineId);
      if (!track) {
        return { success: false, error: '无轨道信息' };
      }

      // 1. 统一停止旧输出桥接（清理 interval + 停止 + reset 输出引擎）
      stopOutput(engineId);

      // 2. 更新位置追踪（流式 seek：重置解码器 + 跳过帧）
      engine.seek(positionMs);

      // 3. 流式模式：启动解码线程并重启桥接，墙钟在首帧推送时启动确保进度同步
      engine.play();
      startOutput(engineId, engine, true);

      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 跳转播放失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 设置音量
  ipcMain.handle('audio-engine:set-volume', async (_event, engineId: string, volume: number) => {
    try {
      const engine = getEngine(engineId);
      engine.setVolume(volume);
      engineVolumes.set(engineId, volume);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置音量失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 获取音量
  ipcMain.handle('audio-engine:get-volume', async (_event, engineId: string) => {
    return { success: true, volume: engineVolumes.get(engineId) ?? 1.0 };
  });

  // 设置循环模式
  ipcMain.handle('audio-engine:set-loop-mode', async (_event, engineId: string, mode: LoopMode) => {
    try {
      const engine = getEngine(engineId);
      const modeMap: Record<string, number> = { none: 0, one: 1, all: 2 };
      engine.setLoopMode(modeMap[mode] ?? 0);
      engineLoopModes.set(engineId, mode);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置循环模式失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 获取循环模式
  ipcMain.handle('audio-engine:get-loop-mode', async (_event, engineId: string) => {
    return { success: true, mode: engineLoopModes.get(engineId) ?? 'none' };
  });

  // 获取位置
  ipcMain.handle('audio-engine:get-position', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      const position = engine.getPosition();
      return { success: true, position };
    } catch (error) {
      console.error('[AudioEngine] 获取位置失败:', error);
      return { success: false, error: String(error), position: 0 };
    }
  });

  // 是否正在播放
  ipcMain.handle('audio-engine:is-playing', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      const isPlaying = engine.isPlaying();
      return { success: true, isPlaying };
    } catch (error) {
      console.error('[AudioEngine] 获取播放状态失败:', error);
      return { success: false, error: String(error), isPlaying: false };
    }
  });

  // 获取状态
  ipcMain.handle('audio-engine:get-state', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      const stateValue = engine.getState();
      const stateMap: Record<number, EngineState> = {
        0: 'idle',
        1: 'loading',
        2: 'playing',
        3: 'paused',
        4: 'stopped'
      };
      return { success: true, state: stateMap[stateValue] ?? 'idle' };
    } catch (error) {
      console.error('[AudioEngine] 获取状态失败:', error);
      return { success: false, error: String(error), state: 'idle' as EngineState };
    }
  });

  // === EQ 控制 ===

  ipcMain.handle('audio-engine:set-eq-enabled', async (_event, engineId: string, enabled: boolean) => {
    try {
      const engine = getEngine(engineId);
      engine.setEqEnabled(enabled);
      engineEqEnabled.set(engineId, enabled);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置 EQ 状态失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('audio-engine:is-eq-enabled', async (_event, engineId: string) => {
    return { success: true, enabled: engineEqEnabled.get(engineId) ?? true };
  });

  ipcMain.handle('audio-engine:set-eq-band', async (_event, engineId: string, bandIndex: number, settings: Partial<EqBandSettingsJs>) => {
    try {
      const engine = getEngine(engineId);
      const rustSettings = convertEqSettings(settings);
      engine.setEqBand(bandIndex, rustSettings);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置 EQ 频段失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('audio-engine:get-eq-band', async (_event, engineId: string, bandIndex: number) => {
    try {
      const engine = getEngine(engineId);
      const bands = engine.getEqBands();
      const band = bands[bandIndex];
      return { success: true, band };
    } catch (error) {
      console.error('[AudioEngine] 获取 EQ 频段失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('audio-engine:get-eq-bands', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      const bands = engine.getEqBands();
      return { success: true, bands };
    } catch (error) {
      console.error('[AudioEngine] 获取 EQ 频段失败:', error);
      return { success: false, error: String(error), bands: [] };
    }
  });

  ipcMain.handle('audio-engine:set-eq-gains', async (_event, engineId: string, gains: number[]) => {
    try {
      const engine = getEngine(engineId);
      const bands = engine.getEqBands();
      for (let i = 0; i < Math.min(gains.length, bands.length); i++) {
        const band = bands[i];
        // 与 Web Audio DSP 链保持一致：EQ 增益写入 preGain（应用在滤波器前），
        // 避免两种模式下同一滑条语义不一致导致「设置了没效果」
        band.preGain = gains[i];
        band.postGain = gains[i];
        engine.setEqBand(i, band);
      }
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置 EQ 增益失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // === 压缩器控制 ===

  ipcMain.handle('audio-engine:set-compressor-enabled', async (_event, engineId: string, enabled: boolean) => {
    try {
      const engine = getEngine(engineId);
      if (typeof engine.setCompressorEnabled === 'function') {
        engine.setCompressorEnabled(enabled);
      }
      engineCompressorEnabled.set(engineId, enabled);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置压缩器启用状态失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('audio-engine:is-compressor-enabled', async (_event, engineId: string) => {
    return { success: true, enabled: engineCompressorEnabled.get(engineId) ?? true };
  });

  ipcMain.handle('audio-engine:set-compressor', async (_event, engineId: string, params: CompressorParamsJs) => {
    try {
      const engine = getEngine(engineId);
      if (typeof engine.setCompressor === 'function') {
        const rustParams = {
          thresholdDb: params.thresholdDb,
          ratio: params.ratio,
          attackMs: params.attackMs,
          releaseMs: params.releaseMs,
          kneeDb: params.kneeDb
        };
        engine.setCompressor(rustParams);
      }
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置压缩器参数失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('audio-engine:get-compressor', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      if (typeof engine.getCompressor !== 'function') {
        return { success: false, error: 'getCompressor not available', params: { thresholdDb: -24, ratio: 4, attackMs: 10, releaseMs: 100, kneeDb: 6 } };
      }
      const rustParams = engine.getCompressor();
      const params: CompressorParamsJs = {
        thresholdDb: rustParams.thresholdDb ?? rustParams.threshold_db ?? -24,
        ratio: rustParams.ratio ?? 4,
        attackMs: rustParams.attackMs ?? rustParams.attack_ms ?? 10,
        releaseMs: rustParams.releaseMs ?? rustParams.release_ms ?? 100,
        kneeDb: rustParams.kneeDb ?? rustParams.knee_db ?? 6
      };
      return { success: true, params };
    } catch (error) {
      console.error('[AudioEngine] 获取压缩器参数失败:', error);
      return {
        success: false,
        error: String(error),
        params: { thresholdDb: -24, ratio: 4, attackMs: 10, releaseMs: 100, kneeDb: 6 }
      };
    }
  });

  ipcMain.handle('audio-engine:get-compressor-gain-reduction', async (_event, engineId: string) => {
    // 该接口由音效面板高频轮询（约 5 次/秒）。引擎已不存在属于正常时序
    // （窗口卸载 / 引擎被回收），不能按错误刷屏，直接返回 0 由前端自行降级。
    const engine = engines.get(engineId);
    if (!engine) return { success: false, error: `引擎 ${engineId} 不存在`, gainReduction: 0 };
    try {
      const gainReduction = typeof engine.getCompressorGainReduction === 'function' ? engine.getCompressorGainReduction() : 0;
      return { success: true, gainReduction };
    } catch (error) {
      console.error('[AudioEngine] 获取压缩器增益衰减失败:', error);
      return { success: false, error: String(error), gainReduction: 0 };
    }
  });

  // === 限制器控制 ===

  ipcMain.handle('audio-engine:set-limiter-enabled', async (_event, engineId: string, enabled: boolean) => {
    try {
      const engine = getEngine(engineId);
      if (typeof engine.setLimiterEnabled === 'function') {
        engine.setLimiterEnabled(enabled);
      }
      engineLimiterEnabled.set(engineId, enabled);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置限制器启用状态失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('audio-engine:is-limiter-enabled', async (_event, engineId: string) => {
    return { success: true, enabled: engineLimiterEnabled.get(engineId) ?? true };
  });

  ipcMain.handle('audio-engine:set-limiter', async (_event, engineId: string, params: LimiterParamsJs) => {
    try {
      const engine = getEngine(engineId);
      if (typeof engine.setLimiter === 'function') {
        const rustParams = {
          ceilingDb: params.ceilingDb,
          releaseMs: params.releaseMs
        };
        engine.setLimiter(rustParams);
      }
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置限制器参数失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('audio-engine:get-limiter', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      if (typeof engine.getLimiter !== 'function') {
        return { success: false, error: 'getLimiter not available', params: { ceilingDb: -0.3, releaseMs: 50 } };
      }
      const rustParams = engine.getLimiter();
      const params: LimiterParamsJs = {
        ceilingDb: rustParams.ceilingDb ?? rustParams.ceiling_db ?? -0.3,
        releaseMs: rustParams.releaseMs ?? rustParams.release_ms ?? 50
      };
      return { success: true, params };
    } catch (error) {
      console.error('[AudioEngine] 获取限制器参数失败:', error);
      return {
        success: false,
        error: String(error),
        params: { ceilingDb: -0.3, releaseMs: 50 }
      };
    }
  });

  ipcMain.handle('audio-engine:get-limiter-gain-reduction', async (_event, engineId: string) => {
    // 同压缩器：高频轮询接口，引擎不存在属于正常时序，不按错误刷屏
    const engine = engines.get(engineId);
    if (!engine) return { success: false, error: `引擎 ${engineId} 不存在`, gainReduction: 0 };
    try {
      const gainReduction = typeof engine.getLimiterGainReduction === 'function' ? engine.getLimiterGainReduction() : 0;
      return { success: true, gainReduction };
    } catch (error) {
      console.error('[AudioEngine] 获取限制器增益衰减失败:', error);
      return { success: false, error: String(error), gainReduction: 0 };
    }
  });

  // === 等响度控制 ===

  ipcMain.handle('audio-engine:set-loudness', async (_event, engineId: string, params: LoudnessParamsJs) => {
    try {
      const engine = getEngine(engineId);
      if (typeof engine.setLoudness === 'function') {
        engine.setLoudness(params);
      }
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置等响度参数失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('audio-engine:get-loudness', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      if (typeof engine.getLoudness !== 'function') {
        return { success: false, error: 'getLoudness not available', params: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' } };
      }
      const params = engine.getLoudness();
      return { success: true, params };
    } catch (error) {
      console.error('[AudioEngine] 获取等响度参数失败:', error);
      return {
        success: false,
        error: String(error),
        params: { enabled: false, compensation: 1.0, referenceLoudness: -20, direction: 'both' }
      };
    }
  });

  /**
   * 设置等响度启用状态
   * Rust 引擎未单独实现 setLoudnessEnabled，通过 setLoudness 传递 enabled 参数
   */
  ipcMain.handle('audio-engine:set-loudness-enabled', async (_event, engineId: string, enabled: boolean) => {
    try {
      const engine = getEngine(engineId);
      // 获取当前参数，更新 enabled 字段后写回
      if (typeof engine.getLoudness === 'function' && typeof engine.setLoudness === 'function') {
        const currentParams = engine.getLoudness();
        engine.setLoudness({ ...currentParams, enabled });
      }
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置等响度启用状态失败:', error);
      return { success: false, error: String(error) };
    }
  });

  /**
   * 获取等响度是否启用
   * Rust 引擎未单独实现 isLoudnessEnabled，通过 getLoudness 获取 enabled 字段
   */
  ipcMain.handle('audio-engine:is-loudness-enabled', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      const params = typeof engine.getLoudness === 'function' ? engine.getLoudness() : null;
      return { success: true, enabled: params?.enabled ?? false };
    } catch (error) {
      console.error('[AudioEngine] 获取等响度启用状态失败:', error);
      return { success: false, error: String(error), enabled: false };
    }
  });

  // === 生命周期 ===

  // 紧急停止音频输出（fire-and-forget，不依赖渲染进程响应）
  // 前端重启 / HMR / beforeunload 时调用；只处理调用方窗口自己的引擎
  ipcMain.on(
    'audio-engine:emergency-stop-all',
    (event, options?: EmergencyStopOptions | boolean) => {
      // 兼容旧版调用（无参数 / 布尔）：无参数视为页面卸载，销毁引擎
      const opts: EmergencyStopOptions =
        typeof options === 'boolean' ? { destroy: options } : (options ?? { destroy: true });
      emergencyStopAll(event.sender, opts);
    }
  );

  ipcMain.handle('audio-engine:reset', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      stopOutput(engineId);
      engine.reset();
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 重置引擎失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 获取版本
  ipcMain.handle('audio-engine:get-version', async () => {
    try {
      const native = loadNativeModule();
      const version = native.getVersion();
      return { success: true, version };
    } catch (error) {
      console.error('[AudioEngine] 获取版本失败:', error);
      return { success: false, error: String(error), version: { major: 0, minor: 0, patch: 0 } };
    }
  });

  console.log('[AudioEngine] IPC handlers 已注册');
}

export default {
  createAudioEngine,
  destroyAudioEngine,
  destroyAllEngines,
  registerAudioEngineHandlers,
};
