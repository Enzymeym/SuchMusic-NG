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
 * 由配置拼装 WebSocket URL，例如 ws://192.168.1.5:8787/suchmusic。
 *
 * 注意：会话令牌**不**放入 URL 查询串，而是经 `sys.hello.payload.token` 传递，
 * 以避免令牌出现在任何日志 / 错误信息中（§3.12）。若手机端要求 URL 鉴权，
 * 请在此处按需追加，并同步移除对日志的打印。
 */
export function buildWsUrl(config: BandConfig): string {
  return `ws://${config.host}:${config.port}${config.path}`
}
