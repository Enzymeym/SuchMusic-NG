/**
 * WASAPI 音频输出服务 (主进程)
 *
 * 管理 WASAPI 独占/共享模式音频输出引擎实例。
 * 提供设备枚举、模式切换、直接音频输出功能。
 *
 * 架构：
 * ┌──────────────┐     ┌──────────────┐
 * │ 解码引擎      │────▶│ 处理链 (EQ等) │
 * │   Symphonia    │   │              │
 * └──────────────┘     └──────┬───────┘
 *                              │ PCM f32
 *                    ┌─────────▼─────────┐
 *                    │ 输出模式路由器     │
 *                    ├───────────────────┤
 *                    │   WASAPI   │
 *                    └─────────┴─────────┘
 */

import { ipcMain } from 'electron';
import { loadNativeModule as loadNative } from './nativeModuleLoader';

// 类型定义
export interface WasapiDeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
  deviceType: string;
}

export interface WasapiOutputConfig {
  sampleRate: number;
  channels: number;
  mode: 'Shared' | 'Exclusive';
  deviceId?: string;
}

// WASAPI 引擎实例存储
const wasapiEngines = new Map<string, any>();
let wasapiEngineIdCounter = 0;

/**
 * 生成唯一引擎 ID
 * @returns 引擎 ID
 */
function generateWasapiEngineId(): string {
  return `wasapi_${++wasapiEngineIdCounter}_${Date.now()}`;
}

/**
 * 加载 native 模块
 *
 * 通过统一的 nativeModuleLoader 解析路径。历史实现有两个缺陷：
 * 1. 用 `nativeModuleLoadAttempted` 把「首次失败」缓存成一条固定文案，
 *    导致后续调用抛出的错误与真实原因无关（设置页因此显示误导性提示）；
 * 2. 把 `audio_napi.dll` 也列为候选 —— Node 不把 `.dll` 注册为原生扩展名，
 *    require 它只会得到 "Invalid or unexpected token"。
 */
let nativeModule: any = null;

function loadNativeModule(): any {
  if (nativeModule) return nativeModule;
  const { module } = loadNative({
    label: 'WASAPI',
    filenames: ['audio_napi.node'],
    requiredExports: ['WasapiOutputEngine']
  });
  nativeModule = module;
  return nativeModule;
}

/**
 * 创建 WASAPI 输出引擎实例
 * @returns 引擎实例 ID
 */
export function createWasapiEngine(): string {
  const native = loadNativeModule();
  const engineId = generateWasapiEngineId();
  const engine = new native.WasapiOutputEngine();
  wasapiEngines.set(engineId, engine);
  console.log('[WASAPI] 创建引擎实例:', engineId);
  return engineId;
}

/**
 * 获取 WASAPI 引擎实例
 * @param engineId 引擎 ID
 */
function getWasapiEngine(engineId: string): any {
  const engine = wasapiEngines.get(engineId);
  if (!engine) {
    throw new Error(`WASAPI 引擎 ${engineId} 不存在`);
  }
  return engine;
}

/**
 * 销毁 WASAPI 引擎实例
 * @param engineId 引擎 ID
 */
export function destroyWasapiEngine(engineId: string): void {
  const engine = wasapiEngines.get(engineId);
  if (engine) {
    try { engine.stop(); } catch (e) {}
    try { engine.reset(); } catch (e) {}
    wasapiEngines.delete(engineId);
    console.log('[WASAPI] 销毁引擎实例:', engineId);
  }
}

/**
 * 销毁所有 WASAPI 引擎实例（紧急停止用）
 */
export function destroyAllWasapiEngines(): void {
  for (const [_engineId, engine] of wasapiEngines) {
    try { engine.stop(); } catch (e) {}
    try { engine.reset(); } catch (e) {}
  }
  wasapiEngines.clear();
  console.log('[WASAPI] 已销毁所有引擎实例');
}

/**
 * 注册 WASAPI IPC 处理器
 */
export function registerWasapiHandlers(): void {
  console.log('[WASAPI] 注册 IPC handlers...');

  // 枚举设备
  ipcMain.handle('wasapi:enumerate-devices', async () => {
    try {
      const native = loadNativeModule();
      const tempEngine = new native.WasapiOutputEngine();
      const devices: WasapiDeviceInfo[] = tempEngine.enumerateDevices();
      tempEngine.reset();
      return { success: true, devices };
    } catch (error) {
      return { success: false, error: String(error), devices: [] };
    }
  });

  // 创建并初始化
  ipcMain.handle('wasapi:create', async (
    _event,
    sampleRate: number,
    channels: number,
    mode: 'Shared' | 'Exclusive',
    deviceId?: string
  ) => {
    try {
      const native = loadNativeModule();
      const engineId = generateWasapiEngineId();
      const engine = new native.WasapiOutputEngine();

      engine.create(sampleRate, channels, mode, deviceId ?? null);
      wasapiEngines.set(engineId, engine);

      return {
        success: true,
        engineId,
        deviceName: engine.getDeviceName(),
        mode
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 销毁
  ipcMain.handle('wasapi:destroy', async (_event, engineId: string) => {
    destroyWasapiEngine(engineId);
    return { success: true };
  });

  // 启动
  ipcMain.handle('wasapi:start', async (_event, engineId: string) => {
    try {
      getWasapiEngine(engineId).start();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 停止
  ipcMain.handle('wasapi:stop', async (_event, engineId: string) => {
    try {
      getWasapiEngine(engineId).stop();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 输出音频数据
  ipcMain.handle('wasapi:output-audio', async (
    _event,
    engineId: string,
    data: number[],
    channels: number,
    sampleRate: number
  ) => {
    try {
      getWasapiEngine(engineId).outputAudio(data, channels, sampleRate);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 刷新缓冲区
  ipcMain.handle('wasapi:flush', async (_event, engineId: string) => {
    try {
      getWasapiEngine(engineId).flush();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 获取状态
  ipcMain.handle('wasapi:get-state', async (_event, engineId: string) => {
    try {
      const engine = getWasapiEngine(engineId);
      return {
        success: true,
        isRunning: engine.isRunning(),
        isReady: engine.isReady(),
        mode: engine.getMode(),
        deviceName: engine.getDeviceName(),
        position: engine.getPosition()
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 获取版本
  ipcMain.handle('wasapi:get-version', async () => {
    try {
      const native = loadNativeModule();
      return { success: true, version: native.getWasapiVersion() };
    } catch (error) {
      return { success: false, error: String(error), version: '' };
    }
  });

  console.log('[WASAPI] IPC handlers 已注册');
}

export default {
  createWasapiEngine,
  destroyWasapiEngine,
  registerWasapiHandlers,
};
