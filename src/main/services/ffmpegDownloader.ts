/**
 * FFmpeg 自动下载与安装服务 (主进程)
 *
 * 检测系统是否已安装 FFmpeg 解码库（DLL），
 * 如缺失则自动从镜像站下载预编译的 FFmpeg 共享库并注册到进程 PATH。
 *
 * FFmpeg DLL 存放路径:
 *   开发环境: <项目>/resources/ffmpeg/
 *   生产环境: <可执行文件>/resources/ffmpeg/
 *
 * 需要的 DLL (FFmpeg 7.x):
 *   - avcodec-61.dll   (解码/编码)
 *   - avformat-61.dll  (容器格式)
 *   - avutil-59.dll    (工具函数)
 *   - swresample-5.dll (音频重采样)
 *   - swscale-8.dll    (视频缩放，可能不需要但包含)
 */

import { app } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, createWriteStream, readdirSync } from 'fs';
import { spawn } from 'child_process';
import { is } from '@electron-toolkit/utils';
import { EventEmitter } from 'events';

// ======== 常量定义 ========

/// 必需的最小 DLL 集合
const REQUIRED_DLLS = [
  'avcodec-61',
  'avformat-61',
  'avutil-59',
  'swresample-5',
];

/// FFmpeg Windows 共享库下载源（BtbN FFmpeg-Builds 镜像）
const FFMPEG_DOWNLOAD_URLS = [
  // 主镜像：GitHub Releases
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-shared-7.1.zip',
  // 备用镜像
  'https://ghp.ci/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-shared-7.1.zip',
];

// ======== 类型定义 ========

/// FFmpeg 安装状态
export type FfmpegStatus = 'not-installed' | 'downloading' | 'extracting' | 'verifying' | 'ready' | 'error';

/// 下载进度信息
export interface FfmpegDownloadProgress {
  status: FfmpegStatus;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  speedBps: number;
  estimatedSeconds: number;
  error?: string;
}

/// 安装结果
export interface FfmpegInstallResult {
  success: boolean;
  dllPath: string;
  status: FfmpegStatus;
  error?: string;
  dllsFound: string[];
  missingDlls: string[];
}

// ======== 事件发射器 ========

/// FFmpeg 安装进度事件发射器
export const ffmpegInstallerEvents = new EventEmitter();

// ======== 路径计算 ========

/**
 * 获取 FFmpeg DLL 存放目录
 * @returns FFmpeg 库目录的绝对路径
 */
export function getFfmpegDllDir(): string {
  // 统一使用 resources/ffmpeg 目录
  const basePath = is.dev
    ? join(app.getAppPath(), '..', 'resources', 'ffmpeg')
    : join(process.resourcesPath, 'ffmpeg');

  return basePath;
}

/**
 * 获取 FFmpeg 临时下载目录
 * @returns 临时下载目录的绝对路径
 */
function getFfmpegTempDir(): string {
  return join(app.getPath('temp'), 'such-pc-ng-ffmpeg');
}

// ======== 检测函数 ========

/**
 * 检查指定目录中是否存在必需的 FFmpeg DLL
 * @param dirPath DLL 目录路径
 * @returns 安装结果：success, dllsFound, missingDlls
 */
export function checkFfmpegDlls(dirPath: string): FfmpegInstallResult {
  if (!existsSync(dirPath)) {
    return {
      success: false,
      dllPath: dirPath,
      status: 'not-installed',
      dllsFound: [],
      missingDlls: [...REQUIRED_DLLS],
    };
  }

  const files = readdirSync(dirPath).map(f => f.toLowerCase());
  const dllsFound: string[] = [];
  const missingDlls: string[] = [];

  for (const dllName of REQUIRED_DLLS) {
    const found = files.some(f => f.startsWith(dllName.toLowerCase()) && f.endsWith('.dll'));
    if (found) {
      dllsFound.push(dllName);
    } else {
      missingDlls.push(dllName);
    }
  }

  const success = missingDlls.length === 0;

  return {
    success,
    dllPath: dirPath,
    status: success ? 'ready' : 'not-installed',
    dllsFound,
    missingDlls,
  };
}

/**
 * 检查 FFmpeg DLL 是否已安装
 * @returns 安装结果
 */
export function checkFfmpegInstalled(): FfmpegInstallResult {
  return checkFfmpegDlls(getFfmpegDllDir());
}

// ======== 注册 PATH ========

/**
 * 将 FFmpeg DLL 目录添加到进程 PATH 环境变量
 *
 * 必须在加载 audio_napi.node 之前调用，
 * 以便 Rust ffmpeg-next crate 能找到 DLL。
 */
export function registerFfmpegPath(): void {
  const dllDir = getFfmpegDllDir();

  // 只在目录存在且包含 DLL 时才注册
  if (!existsSync(dllDir)) return;

  const checkResult = checkFfmpegDlls(dllDir);
  if (!checkResult.success) return;

  const currentPath = process.env.PATH || '';
  if (!currentPath.includes(dllDir)) {
    process.env.PATH = `${dllDir};${currentPath}`;
    console.log('[FFmpeg] DLL 路径已注册到 PATH:', dllDir);
  }
}

// ======== 下载函数 ========

/**
 * 下载并安装 FFmpeg 共享库
 *
 * 处理流程：
 * 1. 创建临时目录
 * 2. 下载 FFmpeg 压缩包
 * 3. 解压提取 DLL
 * 4. 验证 DLL 完整性
 * 5. 移动到目标目录
 * 6. 注册到 PATH
 *
 * @returns 安装结果
 */
export async function downloadAndInstallFfmpeg(): Promise<FfmpegInstallResult> {
  const dllDir = getFfmpegDllDir();
  const tempDir = getFfmpegTempDir();

  console.log('[FFmpeg] 开始自动下载安装...');
  console.log('[FFmpeg] 目标目录:', dllDir);
  console.log('[FFmpeg] 临时目录:', tempDir);

  // 先检查是否已安装
  const existing = checkFfmpegDlls(dllDir);
  if (existing.success) {
    console.log('[FFmpeg] 已安装，跳过下载');
    registerFfmpegPath();
    return existing;
  }

  // 确保目录存在
  try {
    if (!existsSync(dllDir)) mkdirSync(dllDir, { recursive: true });
    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
  } catch (err) {
    return {
      success: false,
      dllPath: dllDir,
      status: 'error',
      error: `创建目录失败: ${err}`,
      dllsFound: existing.dllsFound,
      missingDlls: existing.missingDlls,
    };
  }

  // 发送开始下载事件
  ffmpegInstallerEvents.emit('progress', {
    status: 'downloading',
    downloadedBytes: 0,
    totalBytes: 0,
    percent: 0,
    speedBps: 0,
    estimatedSeconds: 0,
  } as FfmpegDownloadProgress);

  try {
    // 使用 Node.js 原生 fetch 下载
    const downloadUrl = FFMPEG_DOWNLOAD_URLS[0];
    const zipPath = join(tempDir, 'ffmpeg-shared.zip');

    console.log('[FFmpeg] 下载 URL:', downloadUrl);
    console.log('[FFmpeg] 保存路径:', zipPath);

    // 管理网络请求超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300_000); // 5 分钟超时

    let response: Response;
    try {
      response = await fetch(downloadUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'such-pc-ng/1.0',
        },
      });
    } catch (fetchErr: any) {
      clearTimeout(timeoutId);
      throw new Error(`网络请求失败: ${fetchErr.message}`);
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error('无法读取响应流');
    }

    // 流式写入文件并报告进度
    const fileStream = createWriteStream(zipPath);
    let downloadedBytes = 0;
    let lastReportTime = Date.now();
    let lastReportBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        fileStream.write(Buffer.from(value));
        downloadedBytes += value.length;

        // 每秒报告一次进度
        const now = Date.now();
        if (now - lastReportTime >= 1000) {
          const speedBps = downloadedBytes - lastReportBytes;
          const percent = contentLength > 0 ? (downloadedBytes / contentLength) * 100 : 0;
          const estimatedSeconds = speedBps > 0
            ? (contentLength - downloadedBytes) / speedBps
            : 0;

          ffmpegInstallerEvents.emit('progress', {
            status: 'downloading',
            downloadedBytes,
            totalBytes: contentLength,
            percent: Math.round(percent),
            speedBps,
            estimatedSeconds: Math.round(estimatedSeconds),
          } as FfmpegDownloadProgress);

          lastReportTime = now;
          lastReportBytes = downloadedBytes;
        }
      }
    } finally {
      fileStream.end();
    }

    console.log('[FFmpeg] 下载完成:', (downloadedBytes / 1024 / 1024).toFixed(1), 'MB');

    // 解压
    ffmpegInstallerEvents.emit('progress', {
      status: 'extracting',
      downloadedBytes,
      totalBytes: contentLength,
      percent: 100,
      speedBps: 0,
      estimatedSeconds: 0,
    } as FfmpegDownloadProgress);

    await extractFfmpegDlls(zipPath, dllDir);

    // 注册 PATH
    registerFfmpegPath();

    console.log('[FFmpeg] 安装完成');

    ffmpegInstallerEvents.emit('progress', {
      status: 'ready',
      downloadedBytes,
      totalBytes: contentLength,
      percent: 100,
      speedBps: 0,
      estimatedSeconds: 0,
    } as FfmpegDownloadProgress);

    return checkFfmpegDlls(dllDir);
  } catch (err: any) {
    console.error('[FFmpeg] 下载安装失败:', err);

    ffmpegInstallerEvents.emit('progress', {
      status: 'error',
      downloadedBytes: 0,
      totalBytes: 0,
      percent: 0,
      speedBps: 0,
      estimatedSeconds: 0,
      error: err.message,
    } as FfmpegDownloadProgress);

    return {
      success: false,
      dllPath: dllDir,
      status: 'error',
      error: err.message,
      dllsFound: [],
      missingDlls: [...REQUIRED_DLLS],
    };
  }
}

/**
 * 从 ZIP 文件中解压提取 FFmpeg DLL
 *
 * 由于 `ffmpeg-shared` 包中包含 bin/ DLL/ include/ 等，
 * 我们只需要 bin/ 目录下的 *.dll 文件。
 *
 * 使用 PowerShell 的 Expand-Archive 解压（Windows 内置），
 * 然后在解压后的目录中搜索 DLL。
 *
 * @param zipPath ZIP 文件路径
 * @param targetDir 目标 DLL 目录
 */
async function extractFfmpegDlls(zipPath: string, targetDir: string): Promise<void> {
  const tempDir = getFfmpegTempDir();
  const extractDir = join(tempDir, 'extracted');

  console.log('[FFmpeg] 解压中...');

  return new Promise((resolve, reject) => {
    // 使用 PowerShell 解压
    const psScript = `
      $ErrorActionPreference = "Stop";
      if (Test-Path "${extractDir}") { Remove-Item -Recurse -Force "${extractDir}" };
      Expand-Archive -Path "${zipPath}" -DestinationPath "${extractDir}" -Force;
      $dlls = Get-ChildItem -Path "${extractDir}" -Recurse -Filter "*.dll" |
        Where-Object { $_.Name -match "^(avcodec|avformat|avutil|swresample|swscale)-" };
      foreach ($dll in $dlls) {
        Copy-Item $dll.FullName "${targetDir}" -Force;
        Write-Output "Copied: $($dll.Name)";
      }
      Write-Output "SUCCESS";
    `;

    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive',
      '-Command', psScript,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number) => {
      console.log('[FFmpeg] 解压输出:', stdout);

      if (code === 0 && stdout.includes('SUCCESS')) {
        console.log('[FFmpeg] DLL 提取完成');
        resolve();
      } else {
        // 如果 PowerShell 解压失败，尝试使用 Node.js 手动搜索
        console.warn('[FFmpeg] PowerShell 解压失败，使用备用方案');
        if (stderr) console.warn('[FFmpeg] stderr:', stderr);
        manualExtractDlls(zipPath, extractDir, targetDir)
          .then(resolve)
          .catch(reject);
      }
    });

    proc.on('error', (err: Error) => {
      reject(new Error(`PowerShell 启动失败: ${err.message}`));
    });
  });
}

/**
 * 备用手动解压方案
 *
 * 在 PowerShell 不可用时的回退方案，
 * 使用 Node.js 原生模块搜索 DLL。
 */
async function manualExtractDlls(
  _zipPath: string,
  _extractDir: string,
  _targetDir: string,
): Promise<void> {
  // 使用 child_process 调用系统的 tar 或 7z
  // 作为最后的回退，这里抛出错误由上层处理
  throw new Error('FFmpeg 解压失败：PowerShell 和备用方案均不可用');
}

// ======== 初始化 ========

/// 标记 FFmpeg 路径是否已注册
let ffmpegPathRegistered = false;

/**
 * 初始化 FFmpeg：检查并注册 DLL 路径
 *
 * 应用启动时调用，不会自动下载。
 * 如需自动下载，调用 downloadAndInstallFfmpeg()
 */
export function initFfmpeg(): void {
  if (ffmpegPathRegistered) return;

  const dllDir = getFfmpegDllDir();
  const checkResult = checkFfmpegDlls(dllDir);

  if (checkResult.success) {
    registerFfmpegPath();
    ffmpegPathRegistered = true;
    console.log('[FFmpeg] 初始化成功，DLL 已就绪');
  } else {
    console.log('[FFmpeg] DLL 未安装，需要下载。缺失:', checkResult.missingDlls);
  }
}

// ======== IPC 处理器 ========

/**
 * 注册 FFmpeg 安装相关的 IPC 处理器
 */
export function registerFfmpegInstallerHandlers(): void {
  const { ipcMain } = require('electron');

  // 检查安装状态 (handle 模式，即时返回)
  ipcMain.handle('ffmpeg-installer:check', async () => {
    try {
      const result = checkFfmpegInstalled();
      return {
        success: true,
        installed: result.success,
        status: result.status,
        dllsFound: result.dllsFound,
        missingDlls: result.missingDlls,
      };
    } catch (err) {
      return {
        success: false,
        installed: false,
        error: String(err),
      };
    }
  });

  // 开始下载安装 (on 模式，流式推送进度)
  ipcMain.on('ffmpeg-installer:install', (event) => {
    const webContents = event.sender;

    // 监听进度事件并转发给渲染进程
    const progressHandler = (progress: FfmpegDownloadProgress) => {
      if (!webContents.isDestroyed()) {
        webContents.send('ffmpeg-installer:progress', progress);
      }
    };

    ffmpegInstallerEvents.on('progress', progressHandler);

    downloadAndInstallFfmpeg()
      .then((result) => {
        ffmpegInstallerEvents.off('progress', progressHandler);
        if (!webContents.isDestroyed()) {
          webContents.send('ffmpeg-installer:result', {
            success: result.success,
            installed: result.success,
            status: result.status,
            error: result.error,
            dllsFound: result.dllsFound,
            missingDlls: result.missingDlls,
          });
        }
      })
      .catch((err) => {
        ffmpegInstallerEvents.off('progress', progressHandler);
        if (!webContents.isDestroyed()) {
          webContents.send('ffmpeg-installer:result', {
            success: false,
            installed: false,
            error: String(err),
          });
        }
      });
  });

  // 获取 FFmpeg 目录
  ipcMain.handle('ffmpeg-installer:get-dir', async () => {
    return { dir: getFfmpegDllDir() };
  });

  console.log('[FFmpeg Installer] IPC handlers 已注册');
}

export default {
  initFfmpeg,
  registerFfmpegPath,
  checkFfmpegInstalled,
  downloadAndInstallFfmpeg,
  registerFfmpegInstallerHandlers,
};
