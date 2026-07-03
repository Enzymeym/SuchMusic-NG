/**
 * FFmpeg 音频引擎服务 (主进程)
 * 作为第二个音频引擎，与 symphonia Rust 引擎共存，
 * 主要用于支持 DSF/DSD/DFF 等 symphonia 不支持的格式。
 * 
 * 架构说明：
 * - symphonia 引擎：处理主流格式 (MP3/FLAC/AAC/WAV/OGG/Opus)
 * - FFmpeg 引擎：处理扩展格式 (DSF/DFF/WavPack/APE/DTS 等)
 * - 两个引擎共享相同的音效处理链（处理链在 Web Audio API 层）
 */

import { ipcMain } from 'electron';
import { join } from 'path';
import { registerFfmpegPath } from './ffmpegDownloader';

// FFmpeg 流信息接口
export interface FfmpegStreamInfo {
  sampleRate: number;
  channels: number;
  durationMs: number;
  format: string;
  bitrate?: number;
  codecName: string;
  codecLongName: string;
  sampleFormat: string;
  dsdParams?: {
    dsdRate: number;
    isOneBit: boolean;
    pcmSampleRate: number;
    bitrate: number;
  } | null;
}

// FFmpeg 解码帧接口
export interface FfmpegDecodedFrame {
  samples: number[];
  channels: number;
  sampleRate: number;
  frameIndex: number;
  timestampMs: number;
  isEof: boolean;
}

// 引擎实例存储
const ffmpegEngines = new Map<string, any>();
let ffmpegEngineIdCounter = 0;

/**
 * 生成唯一引擎 ID
 * @returns 引擎 ID 字符串
 */
function generateFfmpegEngineId(): string {
  return `ffmpeg_engine_${++ffmpegEngineIdCounter}_${Date.now()}`;
}

/**
 * 加载 FFmpeg native 模块
 */
let ffmpegNativeModule: any = null;
function loadFfmpegNativeModule(): any {
  if (ffmpegNativeModule) {
    return ffmpegNativeModule;
  }

  // 注册 FFmpeg DLL 路径到进程 PATH（必须在 require 之前）
  registerFfmpegPath();

  console.log('[FFmpegEngine] 开始加载 FFmpeg native 模块...');

  const possiblePaths = [
    // 路径 1: 生产环境 - electron-builder extraResources 将 native/ 拷贝到 resources/native/
    join(process.resourcesPath!, 'native', 'audio_napi.node'),
    // 路径 2: 开发环境 - 基于 __dirname
    join(__dirname, '..', '..', '..', 'resources', 'native', 'audio_napi.node'),
    // 路径 3: 开发环境 - 基于 process.cwd()
    join(process.cwd(), 'resources', 'native', 'audio_napi.node'),
    // 路径 4: 开发环境 - Rust 构建目录
    join(process.cwd(), 'native', 'rust-audio-engine', 'target', 'debug', 'audio_napi.node'),
    join(process.cwd(), 'native', 'rust-audio-engine', 'target', 'release', 'audio_napi.node'),
  ];

  const fs = require('fs');

  for (const modulePath of possiblePaths) {
    if (fs.existsSync(modulePath)) {
      console.log('[FFmpegEngine] Found:', modulePath);
      try {
        ffmpegNativeModule = require(modulePath);
        console.log('[FFmpegEngine] Loaded successfully!');
        console.log('[FFmpegEngine] Exports:', Object.keys(ffmpegNativeModule));

        if (!ffmpegNativeModule.FfmpegAudioEngine) {
          throw new Error('Missing FfmpegAudioEngine export');
        }

        return ffmpegNativeModule;
      } catch (error: any) {
        console.error('[FFmpegEngine] Failed to load:', modulePath, error.message);
      }
    }
  }

  console.error('[FFmpegEngine] No valid native module found');
  throw new Error('FFmpeg engine module load failed: module not found');
}

/**
 * 创建 FFmpeg 音频引擎实例
 * @returns 引擎实例 ID
 */
export function createFfmpegEngine(): string {
  try {
    const native = loadFfmpegNativeModule();
    const engineId = generateFfmpegEngineId();

    const engine = new native.FfmpegAudioEngine();
    ffmpegEngines.set(engineId, engine);
    console.log('[FFmpegEngine] 创建引擎实例:', engineId);
    return engineId;
  } catch (error) {
    console.error('[FFmpegEngine] 创建引擎失败:', error);
    throw error;
  }
}

/**
 * 获取 FFmpeg 引擎实例
 * @param engineId 引擎 ID
 */
function getFfmpegEngine(engineId: string): any {
  const engine = ffmpegEngines.get(engineId);
  if (!engine) {
    throw new Error(`FFmpeg 引擎 ${engineId} 不存在`);
  }
  return engine;
}

/**
 * 销毁 FFmpeg 引擎实例
 * @param engineId 引擎 ID
 */
export function destroyFfmpegEngine(engineId: string): void {
  const engine = ffmpegEngines.get(engineId);
  if (engine) {
    try {
      engine.reset();
    } catch (e) {
      console.warn('[FFmpegEngine] 重置引擎失败:', e);
    }
    ffmpegEngines.delete(engineId);
    console.log('[FFmpegEngine] 销毁引擎实例:', engineId);
  }
}

/**
 * FFmpeg 格式的扩展名列表（symphonia 不支持的格式）
 */
const FFMPEG_EXCLUSIVE_EXTENSIONS = [
  'dsf', 'dff',      // DSD 格式
  'wv', 'wavpack',   // WavPack
  'ape', 'mac',      // Monkey's Audio
  'ac3',             // AC-3
  'dts',             // DTS
  'thd', 'truehd',   // TrueHD
  'aiff', 'aif',     // AIFF
  'wma',             // WMA
  'tta',             // TTA
];

/**
 * 检查文件扩展名是否需要 FFmpeg 引擎
 * @param filePath 文件路径
 * @returns true 表示需要 FFmpeg
 */
export function requiresFfmpeg(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return FFMPEG_EXCLUSIVE_EXTENSIONS.includes(ext);
}

/**
 * 注册 FFmpeg 音频引擎 IPC 处理器
 */
export function registerFfmpegEngineHandlers(): void {
  console.log('[FFmpegEngine] 注册 IPC handlers...');

  // 创建引擎
  ipcMain.handle('ffmpeg-engine:create', async () => {
    try {
      const engineId = createFfmpegEngine();
      return { success: true, engineId };
    } catch (error) {
      console.error('[FFmpegEngine] 创建引擎失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 销毁引擎
  ipcMain.handle('ffmpeg-engine:destroy', async (_event, engineId: string) => {
    try {
      destroyFfmpegEngine(engineId);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 加载文件
  ipcMain.handle('ffmpeg-engine:load', async (_event, engineId: string, filePath: string) => {
    try {
      const engine = getFfmpegEngine(engineId);
      const streamInfo: FfmpegStreamInfo = engine.loadFile(filePath);
      return { success: true, streamInfo };
    } catch (error) {
      console.error('[FFmpegEngine] 加载文件失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 从内存数据加载
  ipcMain.handle('ffmpeg-engine:load-data', async (_event, engineId: string, buffer: ArrayBuffer) => {
    try {
      const engine = getFfmpegEngine(engineId);
      const streamInfo: FfmpegStreamInfo = engine.loadData(Buffer.from(buffer));
      return { success: true, streamInfo };
    } catch (error) {
      console.error('[FFmpegEngine] 加载数据失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 解码一帧
  ipcMain.handle('ffmpeg-engine:decode-frame', async (_event, engineId: string) => {
    try {
      const engine = getFfmpegEngine(engineId);
      const frame: FfmpegDecodedFrame | null = engine.decodeFrame();
      return { success: true, frame };
    } catch (error) {
      console.error('[FFmpegEngine] 解码帧失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 解码全部
  ipcMain.handle('ffmpeg-engine:decode-all', async (_event, engineId: string) => {
    try {
      const engine = getFfmpegEngine(engineId);
      const samples: number[] = engine.decodeAll();
      return { success: true, samples };
    } catch (error) {
      console.error('[FFmpegEngine] 解码全部失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 跳转
  ipcMain.handle('ffmpeg-engine:seek', async (_event, engineId: string, positionMs: number) => {
    try {
      const engine = getFfmpegEngine(engineId);
      engine.seek(positionMs);
      return { success: true };
    } catch (error) {
      console.error('[FFmpegEngine] Seek 失败:', error);
      return { success: false, error: String(error) };
    }
  });

  // 获取状态
  ipcMain.handle('ffmpeg-engine:get-state', async (_event, engineId: string) => {
    try {
      const engine = getFfmpegEngine(engineId);
      const state = engine.getState();
      const stateNames = ['idle', 'loaded', 'playing', 'paused', 'stopped', 'error'];
      return { success: true, state: stateNames[state] ?? 'idle' };
    } catch (error) {
      return { success: false, error: String(error), state: 'idle' };
    }
  });

  // 设置播放
  ipcMain.handle('ffmpeg-engine:play', async (_event, engineId: string) => {
    try {
      const engine = getFfmpegEngine(engineId);
      engine.setPlaying();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 设置暂停
  ipcMain.handle('ffmpeg-engine:pause', async (_event, engineId: string) => {
    try {
      const engine = getFfmpegEngine(engineId);
      engine.setPaused();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 设置停止
  ipcMain.handle('ffmpeg-engine:stop', async (_event, engineId: string) => {
    try {
      const engine = getFfmpegEngine(engineId);
      engine.setStopped();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 重置
  ipcMain.handle('ffmpeg-engine:reset', async (_event, engineId: string) => {
    try {
      const engine = getFfmpegEngine(engineId);
      engine.reset();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 获取流信息
  ipcMain.handle('ffmpeg-engine:get-stream-info', async (_event, engineId: string) => {
    try {
      const engine = getFfmpegEngine(engineId);
      const info = engine.getStreamInfo();
      return { success: true, info };
    } catch (error) {
      return { success: false, error: String(error), info: null };
    }
  });

  // 获取 DSD 参数
  ipcMain.handle('ffmpeg-engine:get-dsd-params', async (_event, engineId: string) => {
    try {
      const engine = getFfmpegEngine(engineId);
      const params = engine.getDsdParams();
      return { success: true, params };
    } catch (error) {
      return { success: false, error: String(error), params: null };
    }
  });

  // 检查格式支持
  ipcMain.handle('ffmpeg-engine:is-format-supported', async (_event, extension: string) => {
    try {
      const native = loadFfmpegNativeModule();
      const supported = native.FfmpegAudioEngine.isFormatSupported(extension);
      return { success: true, supported };
    } catch (error) {
      return { success: false, error: String(error), supported: false };
    }
  });

  // 是否 FFmpeg 独占
  ipcMain.handle('ffmpeg-engine:is-exclusive', async (_event, extension: string) => {
    try {
      const native = loadFfmpegNativeModule();
      const exclusive = native.FfmpegAudioEngine.isFfmpegExclusive(extension);
      return { success: true, exclusive };
    } catch (error) {
      return { success: false, error: String(error), exclusive: false };
    }
  });

  // 获取版本
  ipcMain.handle('ffmpeg-engine:get-version', async () => {
    try {
      const native = loadFfmpegNativeModule();
      const version = native.getFfmpegVersion();
      return { success: true, version };
    } catch (error) {
      return { success: false, error: String(error), version: '' };
    }
  });

  console.log('[FFmpegEngine] IPC handlers 已注册');
}

export default {
  createFfmpegEngine,
  destroyFfmpegEngine,
  requiresFfmpeg,
  registerFfmpegEngineHandlers,
};
