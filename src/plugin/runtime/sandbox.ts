/**
 * 插件沙箱（洛雪 LX / 澜音 Ceru / Such v2 共用）
 *
 * 使用 node:vm 创建隔离上下文，仅注入白名单全局。
 * 明确**不注入** require / process / module / fs / Electron API，
 * 降低第三方插件（用户主动安装、视为半可信）触达宿主的能力面。
 *
 * 说明：vm 提供的是隔离而非强安全边界，不能防范蓄意的沙箱逃逸；
 *       本模块的目标是阻止「直接、无意的」宿主 API 访问。
 *
 * 本文件原本位于 main/services/pluginSource/sandbox.ts，为让 v2 插件运行时
 * 复用同一份实现（而非复制分叉）而迁到 src/plugin/runtime，原路径已改为
 * 一行 re-export，lxHost / ceruHost 与既有测试无需改动。
 */
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import zlib from 'node:zlib'

export interface Sandbox {
  /** 沙箱全局对象（contextify 后与上下文内 globalThis 对应） */
  readonly global: Record<string, any>
  /** 在沙箱内执行一段脚本（适合洛雪这类无参脚本） */
  run(code: string, filename: string, timeoutMs?: number): void
  /** 编译一个函数，函数内自由变量的全局查找落在沙箱上下文 */
  compile(code: string, params: string[], filename: string): (...args: any[]) => any
  /** 清理沙箱内插件创建的所有定时器，防止 disable 后仍回调 */
  clearTimers(): void
}

/**
 * 全局白名单档位
 *
 * - `source`：洛雪 / 澜音。插件脚本习惯直接用 Buffer / crypto / zlib，保持原样。
 * - `v2`：Such v2。移除 crypto / Buffer / zlib 等「能力型」全局，
 *   只经 `such.utils.*` 暴露 —— 否则 `@grant` 声明会被白名单架空。
 */
export type SandboxGlobalPreset = 'source' | 'v2'

export interface SandboxOptions {
  /** 额外注入的全局（如 洛雪的 lx、澜音的 exports/definePlugin、v2 的 such 等） */
  extra?: Record<string, any>
  /** 日志转发：宿主可据此把 console 输出投递给 UI */
  onLog?: (level: 'log' | 'warn' | 'error', args: any[]) => void
  /** 全局白名单档位，默认 `source` */
  globals?: SandboxGlobalPreset
  /** 日志前缀里展示的标签，默认 `Source` */
  logScope?: string
}

/** 构建白名单全局对象 */
function buildWhitelistGlobal(
  pluginId: string,
  timers: Set<ReturnType<typeof setTimeout>>,
  options: SandboxOptions
): Record<string, any> {
  const wrapTimer = (fn: typeof setTimeout) =>
    ((cb: any, ms?: number, ...rest: any[]) => {
      const handle = fn(
        (...a: any[]) => {
          timers.delete(handle as any)
          if (typeof cb === 'function') cb(...a)
        },
        ms,
        ...rest
      )
      timers.add(handle as any)
      return handle as any
    }) as unknown as typeof setTimeout

  const wrapInterval = (fn: typeof setInterval) =>
    ((cb: any, ms?: number, ...rest: any[]) => {
      const handle = fn(cb, ms, ...rest)
      timers.add(handle as any)
      return handle as any
    }) as unknown as typeof setInterval

  const scope = options.logScope ?? 'Source'
  const safe =
    (level: 'log' | 'warn' | 'error') =>
    (...args: any[]): void => {
      // 主进程日志 + 转发给宿主
      ;(console[level] as (...a: any[]) => void)(`[${scope}:${pluginId}]`, ...args)
      options.onLog?.(level, args)
    }

  /** 与生态无关的基础能力：网络、编码、定时器、日志 */
  const base: Record<string, any> = {
    fetch,
    Headers,
    Request,
    Response,
    FormData,
    Blob,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    atob,
    btoa,
    structuredClone,
    // 定时器（托管，便于 dispose 时清理）
    setTimeout: wrapTimer(setTimeout),
    clearTimeout,
    setInterval: wrapInterval(setInterval),
    clearInterval,
    queueMicrotask,
    // 日志
    console: {
      log: safe('log'),
      info: safe('log'),
      warn: safe('warn'),
      error: safe('error'),
      debug: safe('log')
    }
  }

  // v2：能力型全局不放行，统一走 such.utils.*
  if (options.globals === 'v2') return base

  return {
    ...base,
    crypto: webcrypto,
    Buffer,
    zlib
  }
}

/** 创建插件沙箱 */
export function createSandbox(pluginId: string, options: SandboxOptions = {}): Sandbox {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const globalObject: Record<string, any> = {
    ...buildWhitelistGlobal(pluginId, timers, options),
    ...(options.extra ?? {})
  }

  const context = vm.createContext(globalObject, { name: `plugin:${pluginId}` })

  return {
    global: globalObject,
    run(code, filename, timeoutMs) {
      vm.runInContext(code, context, {
        filename,
        timeout: timeoutMs ?? 5000,
        // 不启用 displayErrors：避免把宿主栈信息带入插件错误
        displayErrors: false
      })
    },
    compile(code, params, filename) {
      const fn = vm.compileFunction(code, params, {
        parsingContext: context,
        filename
      })
      return fn as unknown as (...args: any[]) => any
    },
    clearTimers() {
      for (const handle of timers) {
        try {
          clearTimeout(handle as any)
          clearInterval(handle as any)
        } catch {
          // 忽略
        }
      }
      timers.clear()
    }
  }
}

/** 带超时的 Promise 包装：用于约束插件回调（init / 解析 / 请求）耗时 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = '操作超时'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * 判断一个值是否为 thenable。
 *
 * 跨 realm（vm 上下文）时 `instanceof Promise` 恒为 false，必须按鸭子类型判断，
 * 否则插件返回的 Promise 会被当成普通对象，导致「解析结果永远拿不到」。
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as any).then === 'function'
  )
}

/** 等待插件回调结果：兼容同步返回值与跨 realm 的 Promise */
export function awaitResult<T>(value: unknown): Promise<T> {
  return isThenable(value) ? Promise.resolve(value as PromiseLike<T>) : Promise.resolve(value as T)
}
