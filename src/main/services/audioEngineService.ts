/**
 * Rust 音频引擎服务
 * 用于 Electron 主进程中调用 Rust NAPI 模块
 */

import { ipcMain } from 'electron';
import { join } from 'path';



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
let engineIdCounter = 0;

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

  // 尝试多个路径（使用 .node 后缀，Node.js 才能正确加载）
  const possiblePaths = [
    // 路径 1: 生产环境 - electron-builder extraResources 将 native/ 拷贝到 resources/native/
    join(process.resourcesPath!, 'native', 'audio_napi.node'),
    // 路径 2: 开发环境 - 基于 __dirname
    join(__dirname, '..', '..', '..', 'resources', 'native', 'audio_napi.node'),
    // 路径 3: 开发环境 - 基于 process.cwd()
    join(process.cwd(), 'resources', 'native', 'audio_napi.node'),
    // 路径 4: 开发环境 - Rust 构建目录
    join(process.cwd(), 'native', 'rust-audio-engine', 'target', 'release', 'audio_napi.node'),
    join(process.cwd(), 'native', 'rust-audio-engine', 'target', 'debug', 'audio_napi.node'),
  ];

  const fs = require('fs');

  for (const modulePath of possiblePaths) {
    if (fs.existsSync(modulePath)) {
      console.log('[AudioEngine] Found:', modulePath);
      try {
        nativeModule = require(modulePath);
        console.log('[AudioEngine] Loaded successfully!');
        console.log('[AudioEngine] Exports:', Object.keys(nativeModule));

        if (!nativeModule.AudioEngine) {
          throw new Error('Missing AudioEngine export');
        }

        return nativeModule;
      } catch (error: any) {
        console.error('[AudioEngine] Failed to load:', modulePath, error.message);
      }
    }
  }

  console.error('[AudioEngine] No valid native module found');
  throw new Error('Audio engine module load failed: module not found');
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
 * 销毁所有引擎实例
 */
export function destroyAllEngines(): void {
  engines.forEach((engine) => {
    try {
      engine.reset();
    } catch (e) {
      console.warn('[AudioEngine] 重置引擎失败:', e);
    }
  });
  engines.clear();
  console.log('[AudioEngine] 销毁所有引擎实例');
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
 * 注册音频引擎 IPC 处理器
 */
export function registerAudioEngineHandlers(): void {
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
      return { success: true, trackInfo };
    } catch (error) {
      console.error('[AudioEngine] 加载文件失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 播放
  ipcMain.handle('audio-engine:play', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      engine.play();
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
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 暂停失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 停止
  ipcMain.handle('audio-engine:stop', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
      engine.stop();
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 停止失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 跳转
  ipcMain.handle('audio-engine:seek', async (_event, engineId: string, positionMs: number) => {
    try {
      const engine = getEngine(engineId);
      engine.seek(positionMs);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 跳转失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 设置音量
  ipcMain.handle('audio-engine:set-volume', async (_event, engineId: string, volume: number) => {
    try {
      const engine = getEngine(engineId);
      engine.setVolume(volume);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置音量失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 获取音量
  ipcMain.handle('audio-engine:get-volume', async () => {
    return { success: true, volume: 1.0 };
  });

  // 设置循环模式
  ipcMain.handle('audio-engine:set-loop-mode', async (_event, engineId: string, mode: LoopMode) => {
    try {
      const engine = getEngine(engineId);
      const modeMap: Record<string, number> = { none: 0, one: 1, all: 2 };
      engine.setLoopMode(modeMap[mode] ?? 0);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置循环模式失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 获取循环模式
  ipcMain.handle('audio-engine:get-loop-mode', async () => {
    return { success: true, mode: 'none' as LoopMode };
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
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置 EQ 状态失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('audio-engine:is-eq-enabled', async () => {
    return { success: true, enabled: true };
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

  ipcMain.handle('audio-engine:set-compressor-enabled', async () => {
    return { success: true };
  });

  ipcMain.handle('audio-engine:is-compressor-enabled', async () => {
    return { success: true, enabled: true };
  });

  ipcMain.handle('audio-engine:set-compressor', async (_event, engineId: string, params: CompressorParamsJs) => {
    try {
      const engine = getEngine(engineId);
      const rustParams = {
        thresholdDb: params.thresholdDb,
        ratio: params.ratio,
        attackMs: params.attackMs,
        releaseMs: params.releaseMs,
        kneeDb: params.kneeDb
      };
      engine.setCompressor(rustParams);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置压缩器参数失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('audio-engine:get-compressor', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
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

  ipcMain.handle('audio-engine:get-compressor-gain-reduction', async () => {
    return { success: true, gainReduction: 0 };
  });

  // === 限制器控制 ===

  ipcMain.handle('audio-engine:set-limiter-enabled', async () => {
    return { success: true };
  });

  ipcMain.handle('audio-engine:is-limiter-enabled', async () => {
    return { success: true, enabled: true };
  });

  ipcMain.handle('audio-engine:set-limiter', async (_event, engineId: string, params: LimiterParamsJs) => {
    try {
      const engine = getEngine(engineId);
      const rustParams = {
        ceilingDb: params.ceilingDb,
        releaseMs: params.releaseMs
      };
      engine.setLimiter(rustParams);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置限制器参数失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('audio-engine:get-limiter', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
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

  ipcMain.handle('audio-engine:get-limiter-gain-reduction', async () => {
    return { success: true, gainReduction: 0 };
  });

  // === 等响度控制 ===

  ipcMain.handle('audio-engine:set-loudness', async (_event, engineId: string, params: LoudnessParamsJs) => {
    try {
      const engine = getEngine(engineId);
      engine.setLoudness(params);
      return { success: true };
    } catch (error) {
      console.error('[AudioEngine] 设置等响度参数失败:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('audio-engine:get-loudness', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
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
      const currentParams = engine.getLoudness();
      engine.setLoudness({ ...currentParams, enabled });
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
      const params = engine.getLoudness();
      return { success: true, enabled: params?.enabled ?? false };
    } catch (error) {
      console.error('[AudioEngine] 获取等响度启用状态失败:', error);
      return { success: false, error: String(error), enabled: false };
    }
  });

  // === 生命周期 ===

  ipcMain.handle('audio-engine:reset', async (_event, engineId: string) => {
    try {
      const engine = getEngine(engineId);
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
