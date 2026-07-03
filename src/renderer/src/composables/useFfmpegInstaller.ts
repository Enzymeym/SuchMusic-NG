/**
 * FFmpeg 解码器安装管理器 (渲染进程)
 *
 * 管理 FFmpeg DLL 的检测、下载和安装流程。
 * 提供状态查询、安装触发、进度监听等功能。
 *
 * 使用方式：
 * ```typescript
 * const installer = useFfmpegInstaller();
 * await installer.checkStatus();         // 检查安装状态
 * await installer.startInstallation();   // 开始自动下载安装
 * ```
 */

import { ref, onUnmounted } from 'vue';

// ======== 类型定义 ========

/// FFmpeg 安装状态
export type FfmpegInstallStatus =
  | 'not-installed'
  | 'downloading'
  | 'extracting'
  | 'verifying'
  | 'ready'
  | 'error';

/// 安装检查结果
export interface FfmpegCheckResult {
  installed: boolean;
  status: FfmpegInstallStatus;
  dllsFound: string[];
  missingDlls: string[];
  error?: string;
}

/// 下载进度信息
export interface FfmpegProgress {
  status: FfmpegInstallStatus;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  speedBps: number;
  estimatedSeconds: number;
  error?: string;
}

/// 安装结果
export interface FfmpegResult {
  success: boolean;
  installed: boolean;
  status: FfmpegInstallStatus;
  error?: string;
}

// ======== Composable ========

/**
 * FFmpeg 安装管理器 composable
 *
 * 提供 FFmpeg 的检测、安装和状态管理功能。
 */
export function useFfmpegInstaller() {
  /// 是否已安装
  const isInstalled = ref(false);
  /// 安装状态
  const status = ref<FfmpegInstallStatus>('not-installed');
  /// 检查中
  const isChecking = ref(false);
  /// 安装中
  const isInstalling = ref(false);
  /// 下载进度
  const progress = ref<FfmpegProgress>({
    status: 'not-installed',
    downloadedBytes: 0,
    totalBytes: 0,
    percent: 0,
    speedBps: 0,
    estimatedSeconds: 0,
  });
  /// 错误信息
  const error = ref<string | null>(null);
  /// 发现的 DLL 列表
  const dllsFound = ref<string[]>([]);
  /// 缺失的 DLL 列表
  const missingDlls = ref<string[]>([]);

  /// 进度/结果监听清理函数
  let progressCleanup: (() => void) | null = null;
  let resultCleanup: (() => void) | null = null;

  /**
   * 安全获取 FFmpeg 安装器 API
   */
  function getApi() {
    try {
      return (window as any).api?.ffmpegInstaller ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 检查 FFmpeg 安装状态
   *
   * # 返回值
   * 返回检测结果
   */
  async function checkStatus(): Promise<FfmpegCheckResult> {
    isChecking.value = true;
    error.value = null;

    try {
      const api = getApi();
      if (!api) {
        error.value = 'FFmpeg 安装器 API 未就绪';
        isChecking.value = false;
        return {
          installed: false,
          status: 'error',
          dllsFound: [],
          missingDlls: [],
          error: error.value,
        };
      }

      const result = await api.check();
      isInstalled.value = result.installed;
      status.value = result.status as FfmpegInstallStatus;
      dllsFound.value = result.dllsFound || [];
      missingDlls.value = result.missingDlls || [];

      if (result.error) {
        error.value = result.error;
      }

      return result as FfmpegCheckResult;
    } catch (err) {
      error.value = String(err);
      status.value = 'error';
      return {
        installed: false,
        status: 'error',
        dllsFound: [],
        missingDlls: [],
        error: String(err),
      };
    } finally {
      isChecking.value = false;
    }
  }

  /**
   * 开始自动下载安装 FFmpeg
   *
   * 通过 IPC 事件流接收进度更新。
   * 安装完成后自动更新状态。
   */
  function startInstallation(): void {
    const api = getApi();
    if (!api) {
      error.value = 'FFmpeg 安装器 API 未就绪';
      return;
    }

    isInstalling.value = true;
    error.value = null;
    progress.value = {
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: 0,
      percent: 0,
      speedBps: 0,
      estimatedSeconds: 0,
    };

    // 清理旧的监听器
    if (progressCleanup) progressCleanup();
    if (resultCleanup) resultCleanup();

    // 监听进度
    progressCleanup = api.onProgress((p: FfmpegProgress) => {
      progress.value = p;
      status.value = p.status;
    });

    // 监听结果
    resultCleanup = api.onResult((result: FfmpegResult) => {
      isInstalling.value = false;

      if (result.success) {
        isInstalled.value = true;
        status.value = 'ready';
      } else {
        isInstalled.value = false;
        status.value = 'error';
        error.value = result.error || '安装失败';
      }

      // 清理监听器
      if (progressCleanup) { progressCleanup(); progressCleanup = null; }
      if (resultCleanup) { resultCleanup(); resultCleanup = null; }
    });

    // 发送安装指令
    api.install();
  }

  /**
   * 格式化字节为人类可读格式
   *
   * # 参数
   * - `bytes`: 字节数
   *
   * # 返回值
   * 返回格式化后的字符串
   */
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * 格式化网速
   *
   * # 参数
   * - `bps`: 每秒字节数
   *
   * # 返回值
   * 返回格式化速度字符串
   */
  function formatSpeed(bps: number): string {
    if (bps < 1024) return `${bps} B/s`;
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  }

  /**
   * 格式化预估剩余时间
   *
   * # 参数
   * - `seconds`: 秒数
   *
   * # 返回值
   * 返回格式化时间字符串
   */
  function formatEta(seconds: number): string {
    if (seconds <= 0) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    if (m > 0) return `${m} 分 ${s} 秒`;
    return `${s} 秒`;
  }

  // 组件卸载时清理监听器
  onUnmounted(() => {
    if (progressCleanup) progressCleanup();
    if (resultCleanup) resultCleanup();
  });

  return {
    // 状态
    isInstalled,
    status,
    isChecking,
    isInstalling,
    progress,
    error,
    dllsFound,
    missingDlls,
    // 方法
    checkStatus,
    startInstallation,
    formatBytes,
    formatSpeed,
    formatEta,
  };
}
