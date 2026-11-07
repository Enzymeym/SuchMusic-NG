/**
 * 组装注入沙箱的 `such` 对象
 *
 * 这里是插件能看到的唯一入口。原则：
 * - 每个受授权约束的方法都先过 `requireGrant()`，声明与能力必须对得上
 * - 不做隐式兜底：参数不合法就抛错，错误信息要能让插件作者直接定位
 */
import type { SettingValue } from '../../shared/plugin/types'
import type {
  PlaylistOpRequest,
  PlaylistOpResponse,
  SensitiveOperation,
  SuchPluginHeader,
  SuchRegisterDeclaration
} from '../types'
import type { ConfirmQueue } from './confirm'
import { requireGrant } from './grant'
import type { PluginLogRing } from './logs'
import type { PluginSettingsStore } from './settings'
import type { PluginStorage } from './storage'
import { buildSystemApi } from './suchSystem'

export { requireGrant }

/** `such.request` 的可选项 */
export interface SuchRequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string | Uint8Array | ArrayBuffer
  timeout?: number
  responseType?: 'text' | 'json' | 'arraybuffer'
}

/** 插件动作 handler */
export type SuchHandler = (payload: any) => unknown

/** 构建 `such` 所需的宿主上下文 */
export interface SuchApiContext {
  pluginId: string
  header: SuchPluginHeader
  appVersion: string
  locale: string
  logs: PluginLogRing
  storage: PluginStorage
  settings: PluginSettingsStore
  confirm: ConfirmQueue
  /** 收集 register 声明 */
  onRegister: (decl: SuchRegisterDeclaration) => void
  /** 收集动作 handler */
  onAction: (action: string, handler: SuchHandler) => void
  /** 推送通知到 UI */
  notify: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void
  /** 歌单操作往返（main → renderer） */
  playlistOp: (req: PlaylistOpRequest) => Promise<PlaylistOpResponse>
  /** 写入音频标签 */
  writeAudioMeta: (filePath: string, tags: Record<string, unknown>) => Promise<boolean>
  /** 请求一次敏感操作确认 */
  requestConfirm: (
    pluginName: string,
    operation: SensitiveOperation,
    detail: string
  ) => Promise<boolean>
}

const REQUEST_TIMEOUT_MS = 30_000
const REQUEST_MAX_BYTES = 10 * 1024 * 1024

/** `such.request` 实现 */
export async function suchRequest(
  ctx: SuchApiContext,
  url: string,
  options: SuchRequestOptions = {}
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  requireGrant(ctx, 'network')

  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('such.request 只接受 http(s) 完整 URL')
  }

  const timeout = Math.min(Math.max(options.timeout ?? REQUEST_TIMEOUT_MS, 1000), 60_000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body as BodyInit | undefined,
      signal: controller.signal
    })

    const buf = await res.arrayBuffer()
    if (buf.byteLength > REQUEST_MAX_BYTES) {
      throw new Error(`响应过大（${buf.byteLength} 字节，上限 ${REQUEST_MAX_BYTES}）`)
    }

    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headers[key] = value
    })

    let body: unknown = buf
    if (options.responseType === 'arraybuffer') {
      body = buf
    } else {
      const text = Buffer.from(buf).toString('utf-8')
      if (options.responseType === 'json') {
        try {
          body = JSON.parse(text)
        } catch {
          // 非法 JSON 原样返回文本，让插件自己判断业务错误
          body = text
        }
      } else {
        body = text
      }
    }

    return { status: res.status, headers, body }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new Error(`请求超时（${timeout}ms）：${url}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** 构建 `such` 对象 */
export function buildSuchApi(ctx: SuchApiContext): Record<string, any> {
  const api: Record<string, any> = {
    // ---------- 宿主信息 ----------
    pluginId: ctx.pluginId,
    apiLevel: ctx.header.apiLevel,
    appVersion: ctx.appVersion,
    locale: ctx.locale,

    // ---------- 注册 ----------
    register(decl: SuchRegisterDeclaration): void {
      if (!decl || typeof decl !== 'object') {
        throw new Error('such.register 需要一个对象参数')
      }
      ctx.onRegister(decl)
    },

    /** 注册音源动作 handler */
    on(action: string, handler: SuchHandler): void {
      if (typeof action !== 'string' || !action) {
        throw new Error('such.on 的第一个参数必须是动作名')
      }
      if (typeof handler !== 'function') {
        throw new Error(`such.on("${action}") 的第二个参数必须是函数`)
      }
      ctx.onAction(action, handler)
    },

    // ---------- 存储 ----------
    storage: {
      get: (key: string) => ctx.storage.get(key),
      set: (key: string, value: unknown) => ctx.storage.set(key, value),
      remove: (key: string) => ctx.storage.remove(key),
      keys: () => ctx.storage.keys()
    },

    // ---------- 设置 ----------
    getSetting(key?: string): SettingValue | Record<string, SettingValue> | undefined {
      return key === undefined ? ctx.settings.all() : ctx.settings.get(key)
    },
    onSettingChange(handler: (value: SettingValue, key: string) => void): void {
      if (typeof handler !== 'function') throw new Error('onSettingChange 需要一个函数')
      ctx.settings.onChange((key, value) => handler(value, key))
    },

    // ---------- 网络 ----------
    request: (url: string, options?: SuchRequestOptions) => suchRequest(ctx, url, options),

    // ---------- 日志 ----------
    log: {
      debug: (...args: unknown[]) => ctx.logs.push('debug', args),
      info: (...args: unknown[]) => ctx.logs.push('info', args),
      warn: (...args: unknown[]) => ctx.logs.push('warn', args),
      error: (...args: unknown[]) => ctx.logs.push('error', args)
    },

    // ---------- 通知 ----------
    notify(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
      requireGrant(ctx, 'ui')
      const text = String(message ?? '').trim()
      if (!text) return
      ctx.notify(text.slice(0, 1000), type)
    }
  }

  // system / playlist / utils 由独立模块拼装，避免单文件过长
  Object.assign(api, buildSystemApi(ctx))

  return api
}
