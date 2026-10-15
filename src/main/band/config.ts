/**
 * SuchMusic 手环通信 · 本地配置（Windows 端 · 主进程）
 *
 * 配置项：是否启用、手机端地址（host/port/path）、配对令牌、配对码。
 * 对齐设计文档 §3.12 / §4.3：**默认关闭**，仅局域网，明文存本地（不写入日志）。
 */

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

/** 手环中继配置（§4.3）。 */
export interface BandConfig {
  /** 是否启用「与手机中继通信」，默认 false */
  enabled: boolean
  /** 手机端局域网地址（IP 或主机名） */
  host: string
  /** 手机端 BandWsServer 监听端口 */
  port: number
  /** WebSocket 路径 */
  path: string
  /** 会话令牌（明文存本地，禁止写入日志） */
  token: string
  /** 6 位配对码（首次握手用） */
  pairCode: string
}

/** 默认配置：关闭、端口 8787、路径 /suchmusic（§4.3）。 */
export const DEFAULT_BAND_CONFIG: BandConfig = {
  enabled: false,
  host: '',
  port: 8787,
  path: '/suchmusic',
  token: '',
  pairCode: ''
}

/** 配置文件路径：userData/band.json。 */
function configPath(): string {
  return join(app.getPath('userData'), 'band.json')
}

/** 将任意值规整为合法配置，字段缺失/非法时回落到默认值。 */
export function normalizeBandConfig(raw: unknown): BandConfig {
  const source = (raw ?? {}) as Partial<BandConfig>
  const host = typeof source.host === 'string' ? source.host.trim() : DEFAULT_BAND_CONFIG.host

  let port = DEFAULT_BAND_CONFIG.port
  if (typeof source.port === 'number' && Number.isFinite(source.port)) {
    const rounded = Math.floor(source.port)
    if (rounded > 0 && rounded <= 65535) port = rounded
  }

  let path = typeof source.path === 'string' && source.path.length > 0 ? source.path : DEFAULT_BAND_CONFIG.path
  if (!path.startsWith('/')) path = `/${path}`

  return {
    enabled: source.enabled === true,
    host,
    port,
    path,
    token: typeof source.token === 'string' ? source.token : '',
    pairCode: typeof source.pairCode === 'string' ? source.pairCode : ''
  }
}

/** 读取配置；文件不存在或损坏时回落到默认值。 */
export async function loadBandConfig(): Promise<BandConfig> {
  try {
    const text = await fs.readFile(configPath(), 'utf8')
    return normalizeBandConfig(JSON.parse(text))
  } catch {
    return { ...DEFAULT_BAND_CONFIG }
  }
}

/** 写入配置（明文 JSON）。 */
export async function saveBandConfig(config: BandConfig): Promise<BandConfig> {
  const normalized = normalizeBandConfig(config)
  await fs.writeFile(configPath(), JSON.stringify(normalized, null, 2), 'utf8')
  return normalized
}

/**
 * 由配置拼装 WebSocket URL，例如 ws://192.168.1.5:8787/suchmusic?token=<令牌>。
 *
 * 依据基线 `docs/ARCH-手环通信.md` §4.3.1：手机端在 **WS 升级前**校验令牌
 * （`request.uri.queryParameters['token']` 或 `Authorization: Bearer`），校验失败即
 * 以 HTTP 401 拒绝、**不升级**。故令牌必须随**升级请求**携带——在此放入 URL 查询串：
 *
 *   ws://<host>:<port><path>?token=<encodeURIComponent(token)>
 *
 * 令牌同时仍冗余放入 `sys.hello.payload.token`（§4.3 兼容），但**升级前**必须带。
 *
 * 拼接注意：`config.path` 可能已含查询串（如 `/suchmusic?a=1`），需稳妥追加，
 * 不得出现重复 `?`、`?&` 或 `//`；无令牌时不追加任何查询串（保持干净 URL）。
 * 令牌经 `encodeURIComponent` 编码；打印前由 `sanitizeUrl` 脱敏（§3.12）。
 */
export function buildWsUrl(config: BandConfig): string {
  const base = `ws://${config.host}:${config.port}${config.path}`
  if (!config.token) return base
  // path 已带查询串时用 `&` 连接；若 path 恰好以 `?` / `&` 结尾，则不再补分隔符。
  let separator = base.includes('?') ? '&' : '?'
  if (base.endsWith('?') || base.endsWith('&')) separator = ''
  return `${base}${separator}token=${encodeURIComponent(config.token)}`
}
