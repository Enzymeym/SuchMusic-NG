/**
 * 原生模块（NAPI / .node）统一加载器
 *
 * 把散落在 audioEngineService / wasapiService / mediaControlService /
 * tagReaderService / nativeDecoder 中的路径探测逻辑收敛到一处，避免各服务
 * 各自维护一份候选目录列表而产生行为差异。
 *
 * 设计要点：
 * 1. 只搜索 `<name>.node`。Windows 下 cargo 产出的 `*.dll` 是 PE 文件，
 *    但 Node 只把 `.node` 注册为原生扩展名，`require('*.dll')` 会被当作
 *    JavaScript 解析并抛出 "Invalid or unexpected token"。历史代码把
 *    `.dll` 也列进候选，只会制造误导性日志，这里彻底去掉。
 * 2. 唯一事实来源是 `resources/native/`：本地构建脚本会把 cargo 产物
 *    重命名为 `.node` 拷到该目录，打包时再由 electron-builder 的
 *    extraResources 拷到 `<resources>/native`。不再回退到 cargo 的
 *    target/ 目录，防止意外加载到 debug 构建或半成品产物。
 * 3. 失败时给出「人类可读的短错误」+「完整候选路径写日志」，
 *    不再把几十行路径塞进用户可见的提示里。
 * 4. 不做「失败结果缓存」。历史实现把首次失败缓存成一条与真实原因无关的
 *    固定文案，导致设置页显示的错误与实际情况不符。
 */

import { app } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';

export interface NativeLoadResult<T = any> {
  /** 加载成功的模块对象 */
  module: T;
  /** 实际加载的绝对路径 */
  path: string;
}

export interface NativeLoadOptions {
  /** 模块名，用于日志与错误信息，如 'WASAPI' */
  label: string;
  /** 候选文件名（按优先级排序），例如 ['audio_napi.node'] */
  filenames: string[];
  /** 必须存在的导出名 */
  requiredExports?: string[];
  /** requiredExports 的命中要求，默认 'all'（全部命中） */
  exportMode?: 'all' | 'any';
  /** 额外的搜索目录（插入到默认目录之前，优先级更高） */
  extraDirs?: string[];
}

type NativeLoadFailure =
  | { kind: 'not-found'; searched: string[] }
  | { kind: 'invalid-exports'; path: string; missing: string[]; exports: string };

/** 最近一次探测失败的详情（供 loadNativeModule 生成错误信息） */
let lastFailure: NativeLoadFailure | null = null;

/** 最近一次探测使用过的候选目录（供日志输出） */
let lastSearchDirs: string[] = [];

/**
 * 计算原生模块的候选搜索目录（按优先级从高到低）
 *
 * 覆盖三种运行形态：
 * - 打包后：extraResources 将 resources/native 拷到 `<resources>/native`
 * - 开发环境：electron-vite 打包后 __dirname 指向 out/main，app.getAppPath() 为项目根
 * - 子进程 / cwd 不确定：回退 process.cwd()
 */
export function getNativeSearchDirs(extraDirs: string[] = []): string[] {
  const dirs: string[] = [];
  const push = (dir?: string | null): void => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };

  for (const dir of extraDirs) push(dir);

  // 打包后：<install>/resources/native
  if (process.resourcesPath) push(join(process.resourcesPath, 'native'));

  let root = '';
  try {
    root = app.getAppPath();
  } catch {
    root = '';
  }

  if (root) {
    push(join(root, 'resources', 'native'));
    push(join(root, 'native'));
    push(join(root, 'resources'));
  }

  // asar 内 __dirname = <app.asar>/out/main
  try {
    push(join(__dirname, '..', '..', 'resources', 'native'));
    push(join(__dirname, '..', '..', '..', 'resources', 'native'));
    push(join(__dirname, '..', '..', 'native'));
  } catch {
    /* __dirname 不可用时忽略 */
  }

  const cwd = typeof process.cwd === 'function' ? process.cwd() : '';
  if (cwd) {
    push(join(cwd, 'resources', 'native'));
    push(join(cwd, 'native'));
  }

  return dirs;
}

/** 展开成完整的候选文件路径列表 */
function buildCandidatePaths(opts: NativeLoadOptions): string[] {
  const dirs = getNativeSearchDirs(opts.extraDirs);
  lastSearchDirs = dirs;
  const paths: string[] = [];
  for (const dir of dirs) {
    for (const name of opts.filenames) {
      const p = join(dir, name);
      if (!paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

/** 枚举模块实际导出的键，便于诊断 */
function describeExports(mod: any): string {
  try {
    return Object.keys(mod ?? {}).join(', ') || '(无导出)';
  } catch {
    return '(无法读取导出)';
  }
}

/**
 * 尝试加载原生模块，失败时返回 null（不抛异常）
 *
 * 用于允许优雅降级的场景，例如音频解码器缺失时回退到其它解码路径。
 */
export function tryLoadNativeModule<T = any>(opts: NativeLoadOptions): NativeLoadResult<T> | null {
  const required = opts.requiredExports ?? [];
  const mode = opts.exportMode ?? 'all';
  const candidates = buildCandidatePaths(opts);

  let invalidAt: { path: string; missing: string[]; exports: string } | null = null;

  for (const modulePath of candidates) {
    if (!existsSync(modulePath)) continue;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(modulePath) as T;
      if (!mod) continue;

      const missing = required.filter((key) => typeof (mod as any)[key] === 'undefined');
      const satisfied =
        required.length === 0 ? true : mode === 'all' ? missing.length === 0 : missing.length < required.length;

      if (!satisfied) {
        console.warn(
          `[native:${opts.label}] 已找到 ${modulePath}，但缺少所需导出 [${missing.join(', ')}]`
        );
        console.warn(`[native:${opts.label}] 该模块实际导出：${describeExports(mod)}`);
        invalidAt = { path: modulePath, missing, exports: describeExports(mod) };
        continue;
      }

      console.log(`[native:${opts.label}] 加载成功：${modulePath}`);
      if (required.length > 0) {
        console.log(`[native:${opts.label}] 导出：${describeExports(mod)}`);
      }
      lastFailure = null;
      return { module: mod, path: modulePath };
    } catch (error: any) {
      console.warn(`[native:${opts.label}] 加载失败：${modulePath} — ${error?.message ?? error}`);
    }
  }

  lastFailure = invalidAt
    ? {
        kind: 'invalid-exports',
        path: invalidAt.path,
        missing: invalidAt.missing,
        exports: invalidAt.exports
      }
    : { kind: 'not-found', searched: candidates };

  return null;
}

/**
 * 加载原生模块；失败时抛出简短、可操作的错误
 */
export function loadNativeModule<T = any>(opts: NativeLoadOptions): NativeLoadResult<T> {
  const result = tryLoadNativeModule<T>(opts);
  if (result) return result;

  // 完整候选路径只写日志，不污染用户可见的提示
  console.error(`[native:${opts.label}] 候选目录：\n  - ${lastSearchDirs.join('\n  - ')}`);

  const hint = '请运行 `npm run build:native`（或 `npm run dev`）重新编译原生模块后重启应用。';

  if (lastFailure && lastFailure.kind === 'invalid-exports') {
    console.error(`[native:${opts.label}] 候选文件：\n  - ${lastFailure.path}`);
    throw new Error(
      `${opts.label} 原生模块版本过旧：${lastFailure.path} 缺少导出 [${lastFailure.missing.join(
        ', '
      )}]（实际导出：${lastFailure.exports}）。${hint}`
    );
  }

  const searched = lastFailure && lastFailure.kind === 'not-found' ? lastFailure.searched : [];
  if (searched.length > 0) {
    console.error(`[native:${opts.label}] 候选文件：\n  - ${searched.join('\n  - ')}`);
  }

  throw new Error(
    `${opts.label} 原生模块缺失：未找到 ${opts.filenames.join(' / ')}。${hint}`
  );
}
