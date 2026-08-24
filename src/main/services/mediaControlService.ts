/**
 * 系统媒体控制服务
 * 通过原生 NAPI 模块接入系统媒体会话：
 * - Windows SMTC（System Media Transport Controls）
 * - macOS Now Playing（MPNowPlayingInfoCenter）
 * - Linux MPRIS（Media Player Remote Interfacing Specification）
 */

import { app, ipcMain } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { getMainWindow } from '../windows/mainWindow';

// 类型定义
export interface MediaControlStatus {
  title?: string;
  artist?: string;
  album?: string;
  cover?: string; // data: | http(s): | 本地文件路径 | blob:(渲染层先转 data:)
  durationMs?: number;
  playing: boolean;
  positionMs?: number;
}

export type MediaControlCommand =
  | 'play'
  | 'pause'
  | 'toggle'
  | 'next'
  | 'prev'
  | 'stop'
  | 'seek'
  | 'seekRelative'
  | 'setVolume';

// IPC 通道
const CHANNEL_UPDATE = 'media-control:update';
const CHANNEL_GET_STATUS = 'media-control:get-status';
const CHANNEL_COMMAND = 'media-control:command';

// 命令去重窗口（毫秒）
const COMMAND_DEDUP_MS = 200;

/** 原生模块实例 */
let nativeModule: any = null;
/** MediaControl 实例 */
let nativeMediaControl: any = null;
/** 是否已初始化 */
let initialized = false;

/** 当前状态缓存（合并最近一次完整状态） */
let currentStatus: MediaControlStatus | null = null;
/** 上一次实际下发给原生模块的元数据字段缓存（按字段增量比对） */
let lastMetadataSent: {
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  durationMs?: number;
} | null = null;
/** 上一次下发的播放状态 */
let lastPlayingSent: boolean | null = null;
/** 上一次下发的位置 */
let lastPositionSent: number | null = null;

/** 命令去重缓存：key = `${command}:${value}`，value = 时间戳 */
const commandDedupMap = new Map<string, number>();
/** 封面缓存目录 */
let coverDir: string | null = null;

/**
 * 加载原生模块（多路径探测 + try/catch + 失败降级）
 * @returns 原生模块或 null（不可用时降级，应用照常运行）
 */
function loadNativeModule(): any {
  if (nativeModule) {
    return nativeModule;
  }

  // 收集可能包含原生模块的目录，兼容多种运行形态：
  // - 生产环境：extraResources 将 resources/native 拷贝到 <resources>/native（app.asar 外）
  // - 开发环境（electron-vite 打包后 __dirname 指向 out/main）：app.getAppPath() 为项目根
  // - 动态运行（cwd 不确定）：回退 process.cwd()
  const root = app.getAppPath();

  const candidateDirs = [
    process.resourcesPath && join(process.resourcesPath, 'native'),
    join(root, 'resources', 'native'),
    join(root, 'resources'),
    join(root, 'native', 'rust-audio-engine', 'target', 'release'),
    join(root, 'native', 'rust-audio-engine', 'target', 'debug'),
    process.cwd() && join(process.cwd(), 'resources', 'native'),
    // 兼容旧的非打包目录结构
    __dirname && join(__dirname, '..', '..', 'resources', 'native'),
    __dirname && join(__dirname, '..', '..', '..', 'resources', 'native'),
  ].filter(Boolean) as string[];

  const candidateFilenames = ['media_control_napi.node', 'media_control_napi.dll'];
  const possiblePaths: string[] = [];
  for (const dir of candidateDirs) {
    for (const file of candidateFilenames) {
      possiblePaths.push(join(dir, file));
    }
  }

  for (const modulePath of possiblePaths) {
    if (existsSync(modulePath)) {
      try {
        const mod = require(modulePath);
        if (!mod.MediaControl) {
          throw new Error('Missing MediaControl export');
        }
        nativeModule = mod;
        console.log('[MediaControl] 原生模块加载成功:', modulePath);
        return nativeModule;
      } catch (error: any) {
        console.warn('[MediaControl] 原生模块加载失败:', modulePath, error?.message ?? error);
        nativeModule = null;
      }
    }
  }

  console.warn('[MediaControl] 未找到可用的原生模块，系统媒体控制降级为禁用状态');
  return null;
}

/**
 * 获取封面缓存目录（确保存在）
 */
function getCoverDir(): string {
  if (!coverDir) {
    coverDir = join(app.getPath('userData'), 'media-covers');
    mkdirSync(coverDir, { recursive: true });
  }
  return coverDir;
}

/**
 * 封面本地化：
 * - data: URL → 解码为 Buffer 写入固定文件，返回文件路径
 * - http(s): / 本地绝对路径 → 原样透传
 * - 空串 / asset 相对 URL 等 → 返回空字符串（表示无封面）
 */
function localizeCover(cover?: string): string {
  if (!cover) return '';

  // data: URL → 解码并落盘为文件，原生模块通过文件路径读取
  if (cover.startsWith('data:')) {
    try {
      const match = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(cover);
      if (!match) return '';
      const mime = (match[1] || '').toLowerCase();
      const ext =
        mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'bin';
      const buffer = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8');
      const filePath = join(getCoverDir(), `current-cover.${ext}`);
      writeFileSync(filePath, buffer);
      return filePath;
    } catch (error: any) {
      console.warn('[MediaControl] 写入封面文件失败，降级为空封面:', error?.message ?? error);
      return '';
    }
  }

  // http(s): URL → 原样透传（由原生模块自行下载）
  if (/^https?:\/\//i.test(cover)) {
    return cover;
  }

  // 本地绝对路径（Windows 盘符 / UNC / Unix 绝对路径 / file://）→ 原样透传
  if (cover.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(cover) || cover.startsWith('/')) {
    return cover;
  }

  // 其余（空串 / asset 相对 URL 等）→ 无封面
  return '';
}

/**
 * 原生 MediaCommand（CommandType PascalCase 字符串）→ 应用 MediaControlCommand 映射
 * @param cmd 原生回调传入的 MediaCommand 对象（含 command 及可选字段）
 * @returns 映射后的命令与数值；无法映射时返回 null（忽略）
 */
function mapNativeCommand(cmd: any): { command: MediaControlCommand; value?: number } | null {
  switch (cmd?.command) {
    case 'Play':
      return { command: 'play' };
    case 'Pause':
      return { command: 'pause' };
    case 'Toggle':
      return { command: 'toggle' };
    case 'Next':
      return { command: 'next' };
    case 'Previous':
      return { command: 'prev' };
    case 'Stop':
      return { command: 'stop' };
    case 'Seek':
      return { command: 'seekRelative', value: cmd.seekDirection === 'backward' ? -10000 : 10000 };
    case 'SeekBy':
      return {
        command: 'seekRelative',
        value: (cmd.seekDirection === 'backward' ? -1 : 1) * (cmd.seekAmountMs ?? 10000),
      };
    case 'SetPosition':
      return typeof cmd.positionMs === 'number' ? { command: 'seek', value: cmd.positionMs } : null;
    case 'SetVolume':
      return typeof cmd.volume === 'number' ? { command: 'setVolume', value: cmd.volume } : null;
    case 'OpenUri':
    case 'Raise':
    case 'Quit':
    default:
      return null;
  }
}

/**
 * 统一命令入口（原生模块命令回调与 Linux globalShortcut 兜底共用）
 * 200ms 内相同命令去重后转发给主窗口渲染进程
 * @param command 媒体控制命令
 * @param value 可选数值参数（seek / setVolume 等）
 */
export function dispatchMediaCommand(command: MediaControlCommand, value?: number): void {
  const key = `${command}:${value ?? ''}`;
  const now = Date.now();
  const last = commandDedupMap.get(key);
  if (last !== undefined && now - last < COMMAND_DEDUP_MS) {
    return;
  }
  commandDedupMap.set(key, now);

  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(CHANNEL_COMMAND, { command, value });
  }
}

/**
 * 渲染进程上报媒体状态时的处理逻辑（按字段增量下发给原生模块）
 * @param status 渲染进程上报的媒体状态
 */
function handleUpdate(_event: Electron.IpcMainEvent, status: MediaControlStatus): void {
  // 合并/更新当前状态缓存
  currentStatus = { ...(currentStatus ?? {}), ...status };

  if (!nativeMediaControl) return;

  try {
    const coverUrl = localizeCover(currentStatus.cover);

    // 元数据：任一字段变化才调用 setMetadata（传入当前全部元数据字段）
    const metadataChanged =
      lastMetadataSent === null ||
      lastMetadataSent.title !== currentStatus.title ||
      lastMetadataSent.artist !== currentStatus.artist ||
      lastMetadataSent.album !== currentStatus.album ||
      lastMetadataSent.coverUrl !== coverUrl ||
      lastMetadataSent.durationMs !== currentStatus.durationMs;
    if (metadataChanged) {
      nativeMediaControl.setMetadata({
        title: currentStatus.title,
        artist: currentStatus.artist,
        album: currentStatus.album,
        coverUrl,
        durationMs: currentStatus.durationMs,
      });
      lastMetadataSent = {
        title: currentStatus.title,
        artist: currentStatus.artist,
        album: currentStatus.album,
        coverUrl,
        durationMs: currentStatus.durationMs,
      };
    }

    // 播放状态：仅变化时调用 setPlaybackState
    const playing = !!currentStatus.playing;
    if (lastPlayingSent === null || lastPlayingSent !== playing) {
      nativeMediaControl.setPlaybackState(playing ? 'Playing' : 'Paused');
      lastPlayingSent = playing;
    }

    // 播放位置：变化时单独调用 setPosition
    if (
      typeof currentStatus.positionMs === 'number' &&
      (lastPositionSent === null || lastPositionSent !== currentStatus.positionMs)
    ) {
      nativeMediaControl.setPosition(currentStatus.positionMs);
      lastPositionSent = currentStatus.positionMs;
    }
  } catch (error: any) {
    console.warn('[MediaControl] 更新媒体状态失败:', error?.message ?? error);
  }
}

/**
 * 查询当前媒体状态（ipcMain.handle）
 */
function handleGetStatus(): MediaControlStatus {
  return currentStatus ?? { playing: false };
}

/**
 * 初始化系统媒体控制服务
 * 加载原生模块、附加主窗口、注册 IPC 处理器
 */
export function initMediaControl(): void {
  if (initialized) {
    return;
  }

  const native = loadNativeModule();
  if (!native) {
    // 原生模块不可用：降级，应用照常运行
    return;
  }

  try {
    // 获取主窗口句柄（Windows 需要；其他平台忽略）
    const win = getMainWindow();
    let hwnd: string | undefined;
    if (win && process.platform === 'win32') {
      try {
        const hwndBuf = win.getNativeWindowHandle();
        hwnd = Buffer.from(hwndBuf).readBigUInt64LE(0).toString();
      } catch (error: any) {
        console.warn('[MediaControl] 获取窗口句柄失败:', error?.message ?? error);
      }
    }

    const mc = new native.MediaControl({
      displayName: 'Such Music',
      dbusName: 'com.mym.suchmusic',
      hwnd: hwnd ? Number(hwnd) : undefined,
    });

    // 必须先注册命令回调，再 attach（原生 attach 依赖命令处理器）
    mc.setCommandHandler((cmd: any) => {
      const mapped = mapNativeCommand(cmd);
      if (mapped) {
        dispatchMediaCommand(mapped.command, mapped.value);
      }
    });

    try {
      mc.attach();
    } catch (error: any) {
      // attach 失败记警告但不崩溃（降级）
      console.warn('[MediaControl] attach 失败，系统媒体控制以降级模式运行:', error?.message ?? error);
    }

    nativeMediaControl = mc;

    // 注册 IPC 处理器
    ipcMain.on(CHANNEL_UPDATE, handleUpdate);
    ipcMain.handle(CHANNEL_GET_STATUS, handleGetStatus);

    initialized = true;
    console.log('[MediaControl] 系统媒体控制已初始化');
  } catch (error: any) {
    console.warn('[MediaControl] 初始化失败，系统媒体控制不可用:', error?.message ?? error);
    nativeMediaControl = null;
  }
}

/**
 * 销毁系统媒体控制服务
 * 调用 detach、移除 IPC 监听、清空缓存与实例，允许再次 init
 */
export function destroyMediaControl(): void {
  if (nativeMediaControl) {
    try {
      nativeMediaControl.detach();
    } catch (error: any) {
      console.warn('[MediaControl] detach 失败:', error?.message ?? error);
    }
  }

  ipcMain.removeListener(CHANNEL_UPDATE, handleUpdate);
  ipcMain.removeHandler(CHANNEL_GET_STATUS);

  // 清空缓存与实例
  currentStatus = null;
  lastMetadataSent = null;
  lastPlayingSent = null;
  lastPositionSent = null;
  commandDedupMap.clear();
  nativeMediaControl = null;
  nativeModule = null;
  initialized = false;

  console.log('[MediaControl] 系统媒体控制已销毁');
}
