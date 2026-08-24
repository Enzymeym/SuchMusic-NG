/**
 * Rust 音频引擎服务
 * 用于 Electron 主进程中调用 Rust NAPI 模块
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { readFile } from 'fs/promises';



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
const engineOutputs = new Map<string, { outputEngine: any; interval: ReturnType<typeof setInterval> | null; stopped: boolean; paused: boolean }>();

// 引擎状态追踪
const engineVolumes = new Map<string, number>();
const engineLoopModes = new Map<string, LoopMode>();
const engineEqEnabled = new Map<string, boolean>();
const engineCompressorEnabled = new Map<string, boolean>();
const engineLimiterEnabled = new Map<string, boolean>();

/** 缓存已解码的音频数据（Buffer），用于暂停后恢复无需重新解码 */
const decodedAudioCache = new Map<string, Buffer>();

/** 预解码 Promise：load 时启动异步解码，play 时直接 await 结果 */
const decodePromises = new Map<string, Promise<Buffer | null>>();

/** 跟踪哪些 WebContents 设置了 FFT 回调，用于自动清理 */
const engineToWebContents = new Map<string, Electron.WebContents>();

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
 */
let nativeModule: any = null;
function loadNativeModule(): any {
  if (nativeModule) {
    return nativeModule;
  }

  console.log('[AudioEngine] 开始加载 native 模块...');

  // 收集可能包含原生模块的目录，兼容多种运行形态：
  // - 生产环境：extraResources 将 resources/native 拷贝到 <resources>/native（app.asar 外）
  // - 开发环境（electron-vite 打包后 __dirname 指向 out/main）：app.getAppPath() 为项目根
  // - 动态运行（cwd 不确定）：回退 process.cwd()
  const root = app.getAppPath();
  const fs = require('fs');

  const candidateDirs = [
    process.resourcesPath && join(process.resourcesPath, 'native'),
    join(root, 'resources', 'native'),
    join(root, 'resources'),
    join(root, 'native', 'rust-audio-engine', 'target', 'debug'),
    join(root, 'native', 'rust-audio-engine', 'target', 'release'),
    // napi_build::setup() 会在 crate 根目录生成 audio_napi.node
    join(root, 'native', 'rust-audio-engine', 'audio-napi'),
    process.cwd() && join(process.cwd(), 'resources', 'native'),
  ].filter(Boolean) as string[];

  let candidateDirsWithRuntimeDir: string[] = [];
  try {
    // __dirname 在打包后为 out/main，向上两级即项目根；兼容旧的非打包目录结构
    candidateDirsWithRuntimeDir = [
      join(__dirname, '..', '..', 'resources', 'native'),
      join(__dirname, '..', '..', '..', 'resources', 'native'),
    ];
  } catch {
    candidateDirsWithRuntimeDir = [];
  }

  const candidateFilenames = ['audio_napi.node', 'audio_napi.dll'];
  const possiblePaths: string[] = [];
  for (const dir of candidateDirs) {
    for (const file of candidateFilenames) {
      possiblePaths.push(join(dir, file));
    }
  }
  for (const dir of candidateDirsWithRuntimeDir) {
    for (const file of candidateFilenames) {
      possiblePaths.push(join(dir, file));
    }
  }

  for (const modulePath of possiblePaths) {
    if (fs.existsSync(modulePath)) {
      console.log('[AudioEngine] Found:', modulePath);
      try {
        nativeModule = require(modulePath);
        console.log('[AudioEngine] Loaded successfully!');
        console.log('[AudioEngine] Exports:', Object.keys(nativeModule));

        if (!nativeModule.AudioEngine && !nativeModule.WasapiOutputEngine) {
          throw new Error('Missing AudioEngine/WasapiOutputEngine export');
        }

        return nativeModule;
      } catch (error: any) {
        console.error('[AudioEngine] Failed to load:', modulePath, error.message);
      }
    }
  }

  console.error('[AudioEngine] No valid native module found');
  throw new Error(
    'Audio engine module load failed: module not found. Please run npm run build:native (or npm run dev) to compile the Rust native module.'
  );
}

/**
 * 创建音频引擎实例
 * @param config 引擎配置
 * @returns 引擎实例 ID
 */
export function createAudioEngine(config?: AudioEngineConfig): string {
  try {
    const native = loadNativeModule();
    const engineId = generateEngineId();

    const engine = new native.AudioEngine(config || {});
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

  // 清理缓存
  decodedAudioCache.clear();
  decodePromises.clear();

  console.log('[AudioEngine] 已销毁所有引擎实例');
}

/**
 * 紧急停止所有音频输出（供前端重启时调用）
 * 使用 ipcMain.on 确保 fire-and-forget，不依赖渲染进程等待响应
 */
export function emergencyStopAll(): void {
  destroyAllEngines();

  // 同时清理 wasapiService 的独立 WASAPI 引擎
  try {
    const { destroyAllWasapiEngines } = require('./wasapiService');
    destroyAllWasapiEngines();
  } catch (e) {
    // wasapiService 可能未加载
  }

  console.log('[AudioEngine] 紧急停止所有音频输出完成');
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
  const deviceId = currentOutputDeviceId || null;

  // Web Audio 模式：不需要 WASAPI 输出引擎，由渲染进程直接播放
  if (currentOutputMode === 'webaudio') {
    console.log(`[AudioEngine] Web Audio 模式，跳过原生输出引擎`);
    return null;
  }

  // WASAPI 模式
  try {
    const wasapiMode = currentOutputMode === 'wasapi-exclusive' ? 'Exclusive' : 'Shared';
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

      // 尽可能多读，维持输出端缓冲
      const readSize = Math.min(availableSamples, sampleRate * channels * 2); // 最多 2 秒
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

  engineOutputs.set(engineId, { outputEngine, interval, stopped: false, paused: false });
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
        if (engine && typeof engine.setFftCallback === 'function') {
          engine.setFftCallback(() => {});
        }
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
    if (!engine || typeof engine.setFftCallback !== 'function') return;
    // 传入空函数清空回调，停止从 Rust 端推送 FFT 数据
    engine.setFftCallback(() => {});
    // 清理 WebContents 追踪
    const wc = engineToWebContents.get(engineId);
    if (wc && !wc.isDestroyed()) {
      wc.removeAllListeners('destroyed');
    }
    engineToWebContents.delete(engineId);
  });

  // 创建引擎
  ipcMain.handle('audio-engine:create', async (_event, config?: AudioEngineConfig) => {
    try {
      const engineId = createAudioEngine(config);
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

      // 清除旧缓存（新文件加载时失效）
      decodedAudioCache.delete(engineId);
      decodePromises.delete(engineId);

      return { success: true, trackInfo };
    } catch (error) {
      console.error('[AudioEngine] 加载文件失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 解码全部并返回处理后的 PCM 数据（异步版本，用于 Web Audio 模式）
  ipcMain.handle('audio-engine:decode-processed', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      if (typeof engine.decodeAllProcessedAsync !== 'function') {
        // 回退到同步版本
        if (typeof engine.decodeAllProcessed !== 'function') {
          return { success: false, error: 'decodeAllProcessed 方法不可用' };
        }
        const buffer: Buffer = engine.decodeAllProcessed();
        const track = engineTracks.get(engineId);
        if (!track) {
          return { success: false, error: '缺少轨道信息，请先调用 load' };
        }
        return {
          success: true,
          data: buffer, // Buffer 通过 Electron IPC 结构化克隆传输，无需转数组
          sampleRate: track.sampleRate,
          channels: track.channels,
        };
      }
      // 异步解码，不阻塞主进程事件循环
      const buffer: Buffer = await engine.decodeAllProcessedAsync();
      const track = engineTracks.get(engineId);
      if (!track) {
        return { success: false, error: '缺少轨道信息，请先调用 load' };
      }
      console.log(`[AudioEngine] Web Audio 解码完成: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
      return {
        success: true,
        data: buffer, // Buffer 通过 Electron IPC 结构化克隆传输
        sampleRate: track.sampleRate,
        channels: track.channels,
      };
    } catch (error) {
      console.error('[AudioEngine] 解码失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 解码前 N 个采样（快速获取开头 PCM，用于渐进式播放）
  ipcMain.handle('audio-engine:decode-partial', async (_event, engineId: string, targetSamples: number) => {
    try {
      const engine = getEngine(engineId);
      if (typeof engine.decodePartial !== 'function') {
        return { success: false, error: 'decodePartial 方法不可用' };
      }
      const buffer: Buffer = engine.decodePartial(Math.round(targetSamples));
      const track = engineTracks.get(engineId);
      if (!track) {
        return { success: false, error: '缺少轨道信息，请先调用 load' };
      }
      console.log(`[AudioEngine] Web Audio 部分解码: ${(buffer.length / 1024 / 1024).toFixed(1)} MB (${targetSamples} samples)`);
      return {
        success: true,
        data: buffer,
        sampleRate: track.sampleRate,
        channels: track.channels,
        isPartial: true,
      };
    } catch (error) {
      console.error('[AudioEngine] 部分解码失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 播放 / 恢复（缓存命中走快速切片路径，首次播放走流式解码）
  ipcMain.handle('audio-engine:play', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);

      const track = engineTracks.get(engineId);
      if (!track) {
        // 无轨道信息时由 Rust 引擎自行管理
        engine.play();
        startOutput(engineId, engine);
        return { success: true };
      }

      const { sampleRate, channels } = track;

      // === 缓存命中：直接切片推送（seek / 暂停恢复 场景） ===
      let allData = decodedAudioCache.get(engineId);
      if (allData && allData.length > 0) {
        let currentMs = 0;
        try { currentMs = engine.getPositionMs(); } catch {}

        const sampleOffset = Math.floor((currentMs / 1000) * sampleRate * channels);
        const byteOffset = sampleOffset * 4;
        const remaining = byteOffset < allData.length ? allData.slice(byteOffset) : allData;

        const existing = engineOutputs.get(engineId);
        let outputEngine = existing?.outputEngine ?? null;

        if (outputEngine) {
          try { outputEngine.flush(); } catch {}
          try { outputEngine.start(); } catch {}
        } else {
          const native = loadNativeModule();
          outputEngine = createOutputEngine(native, sampleRate, channels);
        }

        if (outputEngine) {
          outputEngine.outputAudio(remaining, channels, sampleRate);
          if (!existing || existing.stopped) {
            engineOutputs.set(engineId, { outputEngine, interval: null, stopped: false, paused: false });
          } else {
            existing.outputEngine = outputEngine;
            existing.stopped = false;
            existing.paused = false;
          }
        }

        try { engine.playOneShot(); } catch { engine.play(); }
        return { success: true };
      }

      // === 首次播放：流式解码 ===
      // Rust 流式线程逐帧解码 → RingAudioBuffer → startOutput 桥接 → WASAPI 输出
      engine.play(); // 启动流式解码线程
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

  // 恢复播放（委托给统一的 play handler）
  ipcMain.handle('audio-engine:resume', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      const track = engineTracks.get(engineId);
      if (!track) return { success: false, error: '无轨道信息' };

      const { sampleRate, channels } = track;
      const allData = decodedAudioCache.get(engineId);

      if (allData && allData.length > 0) {
        // 从当前位置切片 Buffer（每采样 4 字节），只推送剩余数据
        const currentMs: number = engine.getPositionMs?.() ?? engine.get_position?.() ?? 0;
        const sampleOffset = Math.floor((currentMs / 1000) * sampleRate * channels);
        const byteOffset = sampleOffset * 4;
        const remaining = byteOffset < allData.length ? allData.slice(byteOffset) : Buffer.alloc(0);

        if (remaining.length > 0) {
          // 复用暂停时保留的输出引擎（避免重建引入爆音）
          const existing = engineOutputs.get(engineId);
          let outputEngine = existing?.outputEngine ?? null;

          if (!outputEngine) {
            // 引擎不存在时创建新的（兜底）
            const native = loadNativeModule();
            outputEngine = createOutputEngine(native, sampleRate, channels);
          } else {
            // 复用已有引擎：重新启动并推送数据（set_all 触发淡入）
            try { outputEngine.start(); } catch {}
          }

          if (outputEngine) {
            outputEngine.outputAudio(remaining, channels, sampleRate);
            engineOutputs.set(engineId, { outputEngine, interval: null, stopped: false, paused: false });
          }
        }
      }

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
      decodedAudioCache.delete(engineId);
      decodePromises.delete(engineId);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 停止失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 跳转（优化：缓存命中时使用轻量级 setPositionMs 避免 decode-and-discard）
  ipcMain.handle('audio-engine:seek', async (_event, engineId: string, positionMs: number) => {
    try {
      const engine = getEngine(engineId);
      // 先刷新输出缓冲区，避免播放旧数据
      const output = engineOutputs.get(engineId);
      if (output) {
        try { output.outputEngine.flush(); } catch {}
      }

      // 缓存命中 → 轻量级位置更新（无需重新解码文件）
      if (decodedAudioCache.has(engineId)) {
        if (typeof engine.setPositionMs === 'function') {
          engine.setPositionMs(positionMs);
        } else {
          engine.seek(positionMs);
        }
      } else {
        // 流式模式（无缓存）→ 完整 seek（重置解码器 + 跳过帧）
        engine.seek(positionMs);
      }
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

      const hasCache = decodedAudioCache.has(engineId);

      // 1. 统一停止旧输出桥接（清理 interval + 停止 + reset 输出引擎）
      stopOutput(engineId);

      // 2. 更新位置追踪（缓存用轻量 setPositionMs，流式用 seek）
      if (hasCache && typeof engine.setPositionMs === 'function') {
        engine.setPositionMs(positionMs);
      } else {
        engine.seek(positionMs);
      }

      // 3. 推送音频数据
      if (hasCache) {
        // 缓存模式：切片推送
        const { sampleRate, channels } = track;
        const allData = decodedAudioCache.get(engineId)!;
        const sampleOffset = Math.floor((positionMs / 1000) * sampleRate * channels);
        const byteOffset = sampleOffset * 4;
        const remaining = byteOffset < allData.length ? allData.slice(byteOffset) : allData;

        const native = loadNativeModule();
        const outputEngine = createOutputEngine(native, sampleRate, channels);
        if (outputEngine) {
          outputEngine.outputAudio(remaining, channels, sampleRate);
          engineOutputs.set(engineId, { outputEngine, interval: null, stopped: false, paused: false });
        }
        try { engine.playOneShot(); } catch { engine.play(); }
      } else {
        // 流式模式：启动解码线程并重启桥接，墙钟在首帧推送时启动确保进度同步
        engine.play();
        startOutput(engineId, engine, true);
      }

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
    try {
      const engine = getEngine(engineId);
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
    try {
      const engine = getEngine(engineId);
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

  // 紧急停止全部音频输出（fire-and-forget，不依赖渲染进程响应）
  // 前端重启 / HMR / beforeunload 时调用
  ipcMain.on('audio-engine:emergency-stop-all', () => {
    emergencyStopAll();
  });

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
