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

import { app, ipcMain } from 'electron';
import { join } from 'path';

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
 * 返回 native 模块对象，如果 WASAPI 导出缺失则抛出明确错误
 */
let nativeModule: any = null;
let nativeModuleLoadAttempted = false;

function loadNativeModule(): any {
  if (nativeModule) return nativeModule;
  if (nativeModuleLoadAttempted) {
    throw new Error('WASAPI 原生模块不可用：模块未包含 WasapiOutputEngine 导出（需要重新编译 audio_napi.node）');
  }

  nativeModuleLoadAttempted = true;
  console.log('[WASAPI] 开始加载 native 模块...');

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

  let loadedModule: any = null;
  const triedPaths: string[] = [];

  for (const modulePath of possiblePaths) {
    triedPaths.push(modulePath);
    if (fs.existsSync(modulePath)) {
      console.log('[WASAPI] Found:', modulePath);
      try {
        loadedModule = require(modulePath);
        if (!loadedModule) {
          console.warn('[WASAPI] ⚠️ 模块加载失败');
          continue;
        }
        console.log('[WASAPI] Loaded, exports:', Object.keys(loadedModule));

        if (!loadedModule.WasapiOutputEngine) {
          console.warn('[WASAPI] ⚠️ 当前 audio_napi.node 未包含 WasapiOutputEngine 导出');
          console.warn('[WASAPI] ⚠️ 这意味着 WASAPI 绑定尚未编译进原生模块');
          console.warn('[WASAPI] ⚠️ 请重新构建 Rust 原生模块以启用 WASAPI 功能');
          throw new Error(
            'WASAPI 原生模块未编译：audio_napi.node 缺少 WasapiOutputEngine 导出。' +
            '请在 native/rust-audio-engine 目录执行 cargo build 重新编译后重试。'
          );
        }

        nativeModule = loadedModule;
        console.log('[WASAPI] ✅ WasapiOutputEngine 导出确认可用');
        return nativeModule;
      } catch (error: any) {
        console.error('[WASAPI] Failed to load:', modulePath, error.message);
        // 不要在这里 throw，继续尝试其他路径或给出明确错误
      }
    }
  }

  const errMsg = loadedModule
    ? 'WASAPI 原生模块未编译：audio_napi.node 缺少 WasapiOutputEngine 导出。请在 native/rust-audio-engine 目录执行 cargo build 重新编译后重试。'
    : 'WASAPI 原生模块未找到：audio_napi.node 文件不存在。请运行 npm run build:native（或 npm run dev）编译 Rust 原生模块。已尝试以下路径：\n  - ' +
      triedPaths.join('\n  - ');
  throw new Error(errMsg);
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
