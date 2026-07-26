/**
 * 统一音频输出模式管理器
 *
 * 管理三种音频输出模式之间的切换：
 * 1. Web Audio — 使用浏览器内置 AudioContext（跨平台默认）
 * 2. WASAPI Shared — 通过 WASAPI 共享模式输出（仅 Windows）
 * 3. WASAPI Exclusive — 通过 WASAPI 独占模式输出（仅 Windows，最低延迟、bit-perfect）
 *
 * 模式切换策略：
 * - Web Audio 模式跨平台可用，非 Windows 平台唯一选项
 * - WASAPI 仅在 Windows 平台可用
 * - 独占模式需要独占设备，切换时将停止当前播放
 * - 独占模式失败自动回退到共享模式
 * - WASAPI 失败自动回退到 Web Audio
 */

/// 音频输出模式类型
export type AudioOutputMode = 'webaudio' | 'wasapi-shared' | 'wasapi-exclusive';

// ====== 平台检测 ======

/** 是否运行在 Windows 平台 */
export function isWindowsPlatform(): boolean {
  return (typeof process !== 'undefined' && process.platform === 'win32')
    || (typeof navigator !== 'undefined' && (navigator?.userAgent?.includes('Windows') ?? false));
}

/** 获取当前平台可用的音频输出模式列表 */
export function getAvailableOutputModes(): AudioOutputMode[] {
  if (isWindowsPlatform()) {
    return ['webaudio', 'wasapi-shared', 'wasapi-exclusive'];
  }
  return ['webaudio'];
}

/** 获取平台默认音频输出模式 */
export function getDefaultOutputMode(): AudioOutputMode {
  return isWindowsPlatform() ? 'wasapi-shared' : 'webaudio';
}

/// 音频设备信息接口
export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
  deviceType: 'render' | 'capture';
}

/// WASAPI 引擎状态
interface WasapiEngineState {
  engineId: string | null;
  isRunning: boolean;
  isReady: boolean;
  deviceName: string;
  mode: string;
}

/**
 * 安全获取 WASAPI API
 * 如果 API 未注入则返回 null
 */
function getWasapiApi() {
  try {
    return (window as any).api?.wasapi ?? null;
  } catch {
    return null;
  }
}

/**
 * 清洗 Rust N-API 错误消息，提取人类可读部分
 *
 * 原始格式可能是嵌套的 Rust Debug 输出，例如：
 *   "Error: 创建 WASAPI 客户端失败: InitializationError(\"...\")"
 * 此函数提取最内层的可读消息，同时保留错误码描述。
 */
export function cleanRustError(raw: string): string {
  // 移除 N-API Error 包装前缀，如 "Error: 创建 WASAPI 客户端失败: "
  let cleaned = raw.replace(/^Error:\s*创建\s+WASAPI\s+客户端失败:\s*/, '');

  // 移除 Rust enum Debug wrapper，如 InitializationError("...") → "..."
  // 匹配: EnumName("content") 其中 content 不包含未转义的引号
  cleaned = cleaned.replace(/^\w+\("([^"]*)"\)$/, '$1');

  return cleaned || raw;
}

/**
 * 音频输出模式管理器类
 *
 * 提供统一的音频输出接口，自动处理 WASAPI 模式之间的切换。
 *
 * # 使用示例
 *
 * ```typescript
 * const manager = new AudioOutputModeManager();
 *
 * // 枚举设备
 * const devices = await manager.enumerateDevices();
 *
 * // 切换到 WASAPI 独占模式
 * await manager.switchMode('wasapi-exclusive', { sampleRate: 44100, channels: 2 });
 *
 * // 输出音频数据
 * await manager.outputAudio(pcmData, 2, 44100);
 * ```
 */
export class AudioOutputModeManager {
  /** 当前输出模式 */
  private currentMode: AudioOutputMode = getDefaultOutputMode();

  /** WASAPI 引擎状态 */
  private wasapiState: WasapiEngineState = {
    engineId: null,
    isRunning: false,
    isReady: false,
    deviceName: '',
    mode: 'Exclusive',
  };

  /** 模式切换回调 */
  private onModeChanged: ((mode: AudioOutputMode) => void) | null = null;

  /** WASAPI 是否检测为可用（模块已加载且导出正确） */
  private wasapiDetected: boolean = false;

  /** WASAPI 不可用原因（首次检测时记录） */
  private wasapiUnavailableReason: string = '';

  /**
   * 安全获取 WASAPI API 客户端
   * @throws 如果 API 未注入则抛出错误
   */
  private getApi() {
    const api = getWasapiApi();
    if (!api) throw new Error('WASAPI API 未就绪');
    return api;
  }

  /**
   * 检查 WASAPI 是否可用（每次调用都重新探测）
   */
  async probeWasapiAvailability(): Promise<{ available: boolean; reason: string }> {
    if (this.wasapiDetected) return { available: true, reason: '' };

    try {
      const api = getWasapiApi();
      if (!api) {
        this.wasapiUnavailableReason = 'WASAPI API 未注入（preload 可能未加载）';
        return { available: false, reason: this.wasapiUnavailableReason };
      }
      const checkResult = await api.enumerateDevices();
      if (checkResult.success) {
        this.wasapiDetected = true;
        // 清除之前的错误缓存
        this.wasapiUnavailableReason = '';
        return { available: true, reason: '' };
      }
      this.wasapiUnavailableReason = cleanRustError(checkResult.error || '未知错误');
      return { available: false, reason: this.wasapiUnavailableReason };
    } catch (err) {
      this.wasapiUnavailableReason = cleanRustError(String(err));
      return { available: false, reason: this.wasapiUnavailableReason };
    }
  }

  /**
   * 获取当前输出模式
   *
   * # 返回值
   * 返回当前模式: 'webaudio' | 'wasapi-shared' | 'wasapi-exclusive'
   */
  getMode(): AudioOutputMode {
    return this.currentMode;
  }

  /**
   * 检查是否为 WASAPI 模式
   *
   * # 返回值
   * 返回 true 如果当前在使用 WASAPI
   */
  isWasapiMode(): boolean {
    return this.currentMode === 'wasapi-shared' || this.currentMode === 'wasapi-exclusive';
  }

  /**
   * 检查是否为 Web Audio 模式
   *
   * # 返回值
   * 返回 true 如果当前在使用 Web Audio
   */
  isWebAudioMode(): boolean {
    return this.currentMode === 'webaudio';
  }

  /**
   * 检查是否为独占模式
   *
   * # 返回值
   * 返回 true 如果当前在 WASAPI 独占模式
   */
  isExclusiveMode(): boolean {
    return this.currentMode === 'wasapi-exclusive';
  }

  /**
   * 获取 WASAPI 引擎 ID（仅在 WASAPI 模式有效）
   *
   * # 返回值
   * 返回引擎 ID，如果不是 WASAPI 模式返回 null
   */
  getWasapiEngineId(): string | null {
    return this.wasapiState.engineId;
  }

  /**
   * 枚举所有音频输出设备
   *
   * # 返回值
   * 返回设备信息数组
   */
  async enumerateDevices(): Promise<AudioDevice[]> {
    if (!isWindowsPlatform()) return [];  // 非 Windows 平台无 WASAPI 设备

    try {
      const api = getWasapiApi();
      if (!api) return [];
      const result = await api.enumerateDevices();
      if (result.success && result.devices) {
        return result.devices.map((d: any) => ({
          id: d.id,
          name: d.name,
          isDefault: d.isDefault,
          deviceType: d.deviceType as 'render' | 'capture',
        }));
      }
      // 仅首次记录不可用原因，不反复刷日志
      if (!this.wasapiUnavailableReason) {
        this.wasapiUnavailableReason = result.error || '未知错误';
      }
      return [];
    } catch (err) {
      if (!this.wasapiUnavailableReason) {
        this.wasapiUnavailableReason = String(err);
      }
      return [];
    }
  }

  /**
   * 切换到指定音频输出模式
   *
   * # 参数
   * - `mode`: 目标输出模式
   * - `config`: 音频配置（WASAPI 模式需要）
   *   - `sampleRate`: 采样率 (Hz)
   *   - `channels`: 声道数
   *   - `deviceId`: 目标设备 ID (可选)
   *
   * # 返回值
   * 成功返回 { success: true }，失败返回 { success: false, error }
   */
  async switchMode(
    mode: AudioOutputMode,
    config?: {
      sampleRate?: number;
      channels?: number;
      deviceId?: string;
    }
  ): Promise<{ success: boolean; error?: string }> {
    // 先停止当前 WASAPI 会话
    if (this.wasapiState.engineId) {
      await this.stopWasapi();
      await this.destroyWasapi();
    }

    // Web Audio 模式（跨平台，无需 Rust 端初始化）
    if (mode === 'webaudio') {
      this.currentMode = 'webaudio';
      this.onModeChanged?.('webaudio');
      return { success: true };
    }

    // WASAPI 模式切换
    const sampleRate = config?.sampleRate ?? 44100;
    const channels = config?.channels ?? 2;
    const wasapiMode = mode === 'wasapi-exclusive' ? 'Exclusive' : 'Shared';

    try {
      const api = getWasapiApi();
      if (!api) return { success: false, error: 'WASAPI API 未就绪' };
      const result = await api.create(
        sampleRate,
        channels,
        wasapiMode,
        config?.deviceId
      );

      if (result.success && result.engineId) {
        this.wasapiState = {
          engineId: result.engineId,
          isRunning: false,
          isReady: true,
          deviceName: result.deviceName ?? '',
          mode: result.mode ?? wasapiMode,
        };
        this.currentMode = mode;
        this.wasapiDetected = true;
        // 清除之前的错误缓存
        this.wasapiUnavailableReason = '';

        // 如果独占模式失败（底层自动回退到共享模式），更新当前模式
        if (mode === 'wasapi-exclusive' && result.mode === 'Shared') {
          console.warn('[AudioOutput] 独占模式初始化失败，已自动回退到共享模式');
          this.currentMode = 'wasapi-shared';
        }

        this.onModeChanged?.(this.currentMode);
        return { success: true };
      }

      // 记录失败原因并回退到 Web Audio
      this.wasapiUnavailableReason = cleanRustError(result.error || '未知错误');
      console.warn('[AudioOutput] WASAPI 不可用:', this.wasapiUnavailableReason);
      this.currentMode = 'webaudio';
      this.onModeChanged?.('webaudio');
      return { success: false, error: this.wasapiUnavailableReason };
    } catch (err) {
      const msg = cleanRustError(String(err));
      this.wasapiUnavailableReason = msg;
      console.warn('[AudioOutput] WASAPI 不可用:', msg);
      this.currentMode = 'webaudio';
      this.onModeChanged?.('webaudio');
      return { success: false, error: msg };
    }
  }

  /**
   * 启动 WASAPI 音频流
   *
   * # 返回值
   * 成功返回 { success: true }
   */
  async startWasapi(): Promise<{ success: boolean; error?: string }> {
    if (!this.wasapiState.engineId) {
      return { success: false, error: 'WASAPI 未初始化' };
    }

    try {
      const result = await this.getApi().start(this.wasapiState.engineId);
      if (result.success) {
        this.wasapiState.isRunning = true;
      }
      return result;
    } catch (err) {
      console.error('[AudioOutput] outputAudio 失败:', err);
      return { success: false, error: String(err) };
    }
  }

  /**
   * 停止 WASAPI 音频流
   *
   * # 返回值
   * 成功返回 { success: true }
   */
  async stopWasapi(): Promise<{ success: boolean; error?: string }> {
    if (!this.wasapiState.engineId) {
      return { success: true };
    }

    try {
      const result = await this.getApi().stop(this.wasapiState.engineId);
      this.wasapiState.isRunning = false;
      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * 通过 WASAPI 输出 PCM 音频数据
   *
   * # 参数
   * - `data`: f32 PCM 样本数据（交错格式）
   * - `channels`: 声道数
   * - `sampleRate`: 采样率
   *
   * # 返回值
   * 成功返回 { success: true }
   */
  async outputAudio(
    data: Float32Array | number[],
    channels: number,
    sampleRate: number
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.wasapiState.engineId) {
      return { success: false, error: 'WASAPI 未初始化' };
    }

    const dataArray = data instanceof Float32Array
      ? Array.from(data)
      : data;

    try {
      return await this.getApi().outputAudio(
        this.wasapiState.engineId,
        dataArray,
        channels,
        sampleRate
      );
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * 刷新 WASAPI 缓冲区
   *
   * # 返回值
   * 成功返回 { success: true }
   */
  async flush(): Promise<{ success: boolean; error?: string }> {
    if (!this.wasapiState.engineId) {
      return { success: true };
    }

    try {
      return await this.getApi().flush(this.wasapiState.engineId);
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * 获取 WASAPI 引擎状态
   *
   * # 返回值
   * 返回 WASAPI 引擎状态对象
   */
  async getWasapiState(): Promise<WasapiEngineState> {
    if (!this.wasapiState.engineId) {
      return this.wasapiState;
    }

    try {
      const result = await this.getApi().getState(this.wasapiState.engineId);
      if (result.success) {
        this.wasapiState.isRunning = result.isRunning ?? false;
        this.wasapiState.isReady = result.isReady ?? false;
        this.wasapiState.mode = result.mode ?? this.wasapiState.mode;
        this.wasapiState.deviceName = result.deviceName ?? this.wasapiState.deviceName;
      }
    } catch (err) {
      // 忽略轮询错误
    }

    return this.wasapiState;
  }

  /**
   * 销毁 WASAPI 引擎
   */
  async destroyWasapi(): Promise<void> {
    if (this.wasapiState.engineId) {
      try {
        await this.getApi().destroy(this.wasapiState.engineId);
      } catch (err) {
        console.warn('[AudioOutput] 销毁 WASAPI 引擎失败:', err);
      }
      this.wasapiState = {
        engineId: null,
        isRunning: false,
        isReady: false,
        deviceName: '',
        mode: 'Exclusive',
      };
    }
  }

  /**
   * 设置模式变更回调
   *
   * # 参数
   * - `callback`: 模式变更时的回调函数
   */
  onModeChange(callback: (mode: AudioOutputMode) => void): void {
    this.onModeChanged = callback;
  }

  /**
   * 获取引擎信息描述
   *
   * # 返回值
   * 返回人类可读的引擎描述字符串
   */
  getEngineDescription(): string {
    switch (this.currentMode) {
      case 'webaudio':
        return `Web Audio API（浏览器内置）`;
      case 'wasapi-shared':
        return `WASAPI 共享模式 — ${this.wasapiState.deviceName}`;
      case 'wasapi-exclusive':
        return `WASAPI 独占模式 — ${this.wasapiState.deviceName}`;
      default:
        return '未知';
    }
  }

  /**
   * 释放所有资源
   */
  async dispose(): Promise<void> {
    await this.stopWasapi();
    await this.destroyWasapi();
  }
}
