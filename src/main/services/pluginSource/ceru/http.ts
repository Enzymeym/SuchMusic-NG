/**
 * 澜音 Ceru v2 HTTP 能力
 *
 * 实现 `ctx.http.request` / `ctx.http.create`，以及 SDK 的 `createHttpClient`。
 * 与洛雪不同，澜音的 HTTP 受权限系统约束：每次请求需携带 `permissionKey` 与 `operation`。
 *
 * 参考：https://ceru.docs.shiqianjiang.cn/guide/plugins/v2/http.html
 */
import { withTimeout } from '../sandbox'

/** 宿主内的操作上下文 */
export interface OperationContext {
  id: string
  deadlineAt: number
  signal: AbortSignal
  connectionId?: string
  userIntent?: { kind: 'user-intent'; id: string }
}

/** 单次 HTTP 请求参数 */
export interface HttpRequestInput {
  url: string
  method?: string
  headers?: Record<string, string>
  /** URL 查询参数（与 url 上的已有 query 合并） */
  query?: Record<string, any>
  /** JSON 请求体 */
  json?: any
  /** 表单请求体（application/x-www-form-urlencoded） */
  form?: Record<string, any>
  /** 原始请求体（优先级低于 json/form） */
  body?: any
  timeoutMs?: number
  permissionKey?: string
  operation?: OperationContext
  /** 非 2xx 是否抛错（默认 true，与澜音一致） */
  throwOnError?: boolean
  /** 外部注入的中止信号（旧版 httpFetch 使用） */
  signal?: AbortSignal
  /** 默认请求头 */
  baseHeaders?: Record<string, string>
}

/** HTTP 响应（同时提供 body/data 两种别名，兼容不同插件写法） */
export interface HttpResponse {
  status: number
  statusCode: number
  statusText: string
  statusMessage: string
  headers: Record<string, string>
  /** 原始文本 */
  body: string
  /** content-type 为 JSON 时的解析结果，否则与 body 相同 */
  data: any
  /** 解析后的 JSON（非 JSON 时抛错） */
  json<T = any>(): T
  text(): string
}

/** 构造 HTTP 响应对象 */
function buildResponse(
  status: number,
  statusText: string,
  headers: Record<string, string>,
  text: string
): HttpResponse {
  const contentType = headers['content-type'] || ''
  let data: any = text
  if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  return {
    status,
    statusCode: status,
    statusText,
    statusMessage: statusText,
    headers,
    body: text,
    data,
    json: <T = any>() => (typeof data === 'string' ? JSON.parse(data) : data) as T,
    text: () => text
  }
}

/** 拼接 query 参数 */
function appendQuery(url: string, query?: Record<string, any>): string {
  if (!query) return url
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
  if (!entries.length) return url
  const search = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return url + (url.includes('?') ? '&' : '?') + search
}

/** 合并外部中止信号 */
function mergeSignal(inner: AbortSignal, outer?: AbortSignal): AbortSignal {
  if (!outer) return inner
  const ac = new AbortController()
  const abort = (): void => ac.abort()
  if (inner.aborted || outer.aborted) {
    ac.abort()
    return ac.signal
  }
  inner.addEventListener('abort', abort, { once: true })
  outer.addEventListener('abort', abort, { once: true })
  return ac.signal
}

/**
 * 执行一次 HTTP 请求
 * @param input 请求参数
 * @param authorize 权限校验钩子（宿主注入，可空）
 */
export async function performHttpRequest(
  input: HttpRequestInput,
  authorize?: (permissionKey: string | undefined, origin: string) => Promise<void>
): Promise<HttpResponse> {
  if (!input?.url) throw new Error('澜音 http.request 缺少 url')

  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    throw new Error(`澜音 http.request 收到非法 url: ${input.url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('澜音 http.request 仅支持 http/https')
  }
  if (parsed.username || parsed.password) {
    throw new Error('澜音 http.request 不允许在 URL 中携带用户名或密码')
  }

  await authorize?.(input.permissionKey, parsed.origin)

  const headers: Record<string, string> = { ...(input.baseHeaders ?? {}), ...(input.headers ?? {}) }
  const init: RequestInit = {
    method: (input.method || 'GET').toUpperCase(),
    headers
  }

  if (input.json !== undefined) {
    init.body = JSON.stringify(input.json)
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json'
  } else if (input.form !== undefined) {
    init.body = new URLSearchParams(
      Object.entries(input.form).map(([k, v]) => [k, String(v)])
    ).toString()
    if (!hasHeader(headers, 'content-type')) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
  } else if (input.body !== undefined) {
    init.body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body)
  }

  const ac = new AbortController()
  init.signal = mergeSignal(ac.signal, input.signal ?? input.operation?.signal)

  const timeoutMs = input.timeoutMs ?? 20000
  const timer = setTimeout(() => ac.abort(new Error('request timeout')), timeoutMs)

  try {
    const url = appendQuery(parsed.toString(), input.query)
    const resp = await withTimeout(fetch(url, init), timeoutMs + 500, '澜音 http 请求超时')
    const text = await resp.text()
    const respHeaders: Record<string, string> = {}
    resp.headers.forEach((v, k) => {
      respHeaders[k] = v
    })
    const result = buildResponse(resp.status, resp.statusText, respHeaders, text)
    if (input.throwOnError !== false && (resp.status < 200 || resp.status >= 300)) {
      throw Object.assign(new Error(`澜音 http 请求失败: ${resp.status} ${resp.statusText}`), {
        response: result,
        name: 'HttpError',
        origin: parsed.origin,
        status: resp.status
      })
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name)
}

/** `ctx.http.create` 的配置 */
export interface HttpClientOptions {
  baseURL?: string
  permissionKey?: string
  /** 创建时即申请权限 */
  requestPermission?: boolean
  headers?: Record<string, string>
  timeoutMs?: number
  throwOnError?: boolean
}

/** 构造 `ctx.http` 模块 */
export function createHttpModule(deps: {
  authorize: (permissionKey: string | undefined, origin: string) => Promise<void>
}): Record<string, any> {
  const request = (input: HttpRequestInput): Promise<HttpResponse> =>
    performHttpRequest(input, deps.authorize)

  const create = (options: HttpClientOptions = {}): Record<string, any> => {
    const build = (path: string, opts: any = {}): HttpRequestInput => {
      const base = options.baseURL ?? ''
      let url: string
      if (/^https?:\/\//i.test(path)) url = path
      else url = base.replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '')
      return {
        ...opts,
        url,
        permissionKey: opts.permissionKey ?? options.permissionKey,
        timeoutMs: opts.timeoutMs ?? options.timeoutMs,
        throwOnError: opts.throwOnError ?? options.throwOnError,
        baseHeaders: { ...(options.headers ?? {}) },
        headers: { ...(options.headers ?? {}), ...(opts.headers ?? {}) }
      } as HttpRequestInput
    }
    return {
      request: (path: string, opts?: any) => request(build(path, opts)),
      get: <T = any>(path: string, opts?: any) => request(build(path, opts)) as Promise<T>,
      post: <T = any>(path: string, opts?: any) =>
        request(build(path, { method: 'POST', ...opts })) as Promise<T>,
      /** 显式授权（供插件在真正发请求前预申请权限） */
      authorize: (permissionKey?: string, origin?: string) =>
        deps.authorize(
          permissionKey ?? options.permissionKey,
          origin ?? safeOrigin(options.baseURL)
        )
    }
  }

  return {
    request,
    create,
    /** SDK 兼容别名 */
    fetch: (url: string, opts?: any) => request({ ...opts, url })
  }
}

function safeOrigin(url?: string): string {
  if (!url) return ''
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * SDK 的 `createHttpClient(ctxLike, options)` 替身。
 * 澜音正式 SDK 用于让插件在无 ctx 时构造客户端；这里直接复用 ctx.http。
 */
export function createHttpClient(
  ctxLike: { http?: any; permissions?: any },
  options: HttpClientOptions
): Record<string, any> {
  if (ctxLike?.http?.create) {
    const client = ctxLike.http.create(options)
    return {
      request: client.request,
      get: client.get,
      post: client.post,
      authorize: client.authorize
    }
  }
  return createHttpModule({
    authorize: async () => undefined
  }).create(options)
}
