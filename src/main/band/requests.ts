/**
 * SuchMusic 手环通信 · 请求-响应登记与超时重试（Windows 端）
 *
 * 对齐设计文档 §3.11：
 * - 请求超时 reqTimeoutMs = 3000；
 * - 超时 / E_LINK 时**同 id**重试 ≤2 次，退避 300ms / 900ms；
 * - E_UNSUPPORTED / E_BADREQ 不重试。
 *
 * 设计说明：重试在同一 Promise 上完成——超时且可重试时调用 `onResend`
 * 让调用方重发**同一 id** 的信封，并重启计时器；最终成功/失败都收尾同一个 Promise。
 *
 * 约束：本文件不得引用任何 Electron API；定时器可注入以便单测确定性。
 */

import { REQ_TIMEOUT_MS, retryBackoffMs, shouldRetry } from './protocol'

/** 定时器抽象，便于测试注入。 */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** 默认使用宿主全局定时器。 */
export const defaultScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** 带错误码的 Error。 */
export interface BandRequestError extends Error {
  code?: string
  id?: string
}

/** 一次挂起请求的内部记录。 */
interface Pending<T> {
  id: string
  method: string
  attempts: number
  timer: unknown
  resolve: (value: T) => void
  reject: (error: BandRequestError) => void
}

/** 重试判定结果。 */
export interface RetryDecision {
  retry: boolean
  /** 下一次重试前的退避毫秒数（retry=false 时为 0） */
  delayMs: number
}

/**
 * 挂起请求登记表：负责超时、重试调度与 resolve/reject。
 */
export class RequestTracker<T = unknown> {
  private readonly pending = new Map<string, Pending<T>>()

  constructor(
    private readonly timeoutMs: number = REQ_TIMEOUT_MS,
    private readonly scheduler: Scheduler = defaultScheduler,
    /**
     * 重发回调：参数为 (id, method, nextAttempt)。
     * 调用方需以**同一 id** 重发信封；返回后计时器将按退避重启。
     */
    private readonly onResend?: (id: string, method: string, nextAttempt: number) => void
  ) {}

  /** 当前挂起请求数量。 */
  get size(): number {
    return this.pending.size
  }

  /** 是否已有同 id 的挂起请求。 */
  has(id: string): boolean {
    return this.pending.has(id)
  }

  /** 某挂起请求已尝试的次数（含首次）；不存在返回 0。 */
  attempts(id: string): number {
    return this.pending.get(id)?.attempts ?? 0
  }

  /**
   * 登记一个请求并启动超时计时。
   * @param attempts 已尝试次数（含首次），默认 1
   */
  track(id: string, method: string, attempts = 1): Promise<T> {
    this.clear(id)
    return new Promise<T>((resolve, reject) => {
      const entry: Pending<T> = { id, method, attempts, timer: null, resolve, reject }
      this.pending.set(id, entry)
      this.arm(entry)
    })
  }

  /** 为一条挂起请求启动（或重启）超时计时。 */
  private arm(entry: Pending<T>): void {
    entry.timer = this.scheduler.setTimeout(() => {
      const current = this.pending.get(entry.id)
      if (current !== entry) return
      this.onTimeout(entry)
    }, this.timeoutMs)
  }

  /**
   * 超时处理（§3.11）：可重试时**先按退避等待**（300ms / 900ms）再以**同一 id** 重发，
   * 并重启超时计时；否则最终以 `E_TIMEOUT` 收尾。
   *
   * 关键：退避必须真正生效——旧实现算出了退避时长却立即重发（实际间隔≈超时值），
   * 这里改为「先等退避，再重发」。退避期间仍可被 `resolve` / `reject` 打断。
   */
  private onTimeout(entry: Pending<T>): void {
    const decision = decideRetry('E_TIMEOUT', entry.attempts)
    if (decision.retry && this.onResend) {
      entry.attempts += 1
      entry.timer = this.scheduler.setTimeout(() => {
        const current = this.pending.get(entry.id)
        if (current !== entry) return
        this.onResend?.(entry.id, entry.method, entry.attempts)
        this.arm(entry)
      }, decision.delayMs)
      return
    }

    this.pending.delete(entry.id)
    const error: BandRequestError = new Error(`请求超时：${entry.method} (${entry.id})`)
    error.code = 'E_TIMEOUT'
    error.id = entry.id
    entry.reject(error)
  }

  /** 成功收尾：清计时器并 resolve。 */
  resolve(id: string, value: T): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.scheduler.clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.resolve(value)
    return true
  }

  /** 失败收尾：清计时器并 reject。 */
  reject(id: string, code: string, message: string): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.scheduler.clearTimeout(entry.timer)
    this.pending.delete(id)
    const error: BandRequestError = new Error(message)
    error.code = code
    error.id = id
    entry.reject(error)
    return true
  }

  /** 仅清除计时器与登记（不 resolve / reject）。 */
  clear(id: string): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.scheduler.clearTimeout(entry.timer)
    this.pending.delete(id)
  }

  /** 全部失败收尾（断线时调用）。 */
  rejectAll(code: string, message: string): void {
    for (const id of [...this.pending.keys()]) {
      this.reject(id, code, message)
    }
  }
}

/**
 * 纯函数：根据错误码与已尝试次数判定是否重试及退避时长（§3.11）。
 * `attempts` 为已尝试次数（含首次）。
 */
export function decideRetry(code: string, attempts: number): RetryDecision {
  if (!shouldRetry(code, attempts)) return { retry: false, delayMs: 0 }
  return { retry: true, delayMs: retryBackoffMs(attempts) }
}
