/**
 * SuchMusic 手环通信 · 主进程桥接（WS ↔ IPC ↔ 渲染进程）
 *
 * 职责：
 * - 持有 BandWsClient 单例与本地配置；
 * - 把连接状态 / 事件推送给渲染进程（webContents.send）；
 * - 向渲染进程暴露 connect / disconnect / request / 配置读写。
 *
 * 对齐设计文档 §4.3「通路」：
 * Windows(Vue) → preload IPC → main ws-client → 手机 BandWsServer。
 */

import { getMainWindow } from '../windows/mainWindow'
import {
  DEFAULT_BAND_CONFIG,
  buildWsUrl,
  loadBandConfig,
  normalizeBandConfig,
  saveBandConfig,
  type BandConfig
} from './config'
import { BandWsClient, type BandClientStatus } from './ws-client'
import type { JsonObject } from './protocol'

/** 推送通道：连接状态。 */
export const BAND_STATUS_CHANNEL = 'band:status'
/** 推送通道：手机侧事件（player.* / lyric.* / sys.error ...）。 */
export const BAND_EVENT_CHANNEL = 'band:event'

/** 推送给渲染进程的统一事件体。 */
export interface BandEventMessage {
  event: string
  payload: JsonObject
}

export class BandBridge {
  private readonly client = new BandWsClient()
  private config: BandConfig = { ...DEFAULT_BAND_CONFIG }
  private initialized = false

  /**
   * 初始化：加载配置并（可选）自动连接。
   * 默认关闭时不做任何网络行为（§3.12 / §4.3）。
   */
  async init(): Promise<void> {
    this.config = await loadBandConfig()
    this.wireClient()
    this.initialized = true

    if (this.config.enabled && this.config.host) {
      await this.startConnection()
    } else {
      this.pushStatus()
    }
  }

  /** 读取当前配置（含令牌；仅本机渲染进程可见）。 */
  getConfig(): BandConfig {
    return { ...this.config }
  }

  /** 读取连接状态。 */
  getStatus(): BandClientStatus {
    return this.client.getStatus()
  }

  /**
   * 更新配置（局部合并）；地址/启用状态变化会触发重连。
   */
  async updateConfig(partial: Partial<BandConfig>): Promise<BandConfig> {
    const previous = this.config
    const merged = normalizeBandConfig({ ...this.config, ...partial })
    this.config = await saveBandConfig(merged)

    const endpointChanged =
      previous.host !== this.config.host ||
      previous.port !== this.config.port ||
      previous.path !== this.config.path ||
      previous.token !== this.config.token ||
      previous.pairCode !== this.config.pairCode

    if (!this.config.enabled) {
      this.client.disconnect()
    } else if (endpointChanged || previous.enabled !== this.config.enabled) {
      await this.startConnection()
    }
    this.pushStatus()
    return this.getConfig()
  }

  /** 建立连接（需要已配置 host）。 */
  async connect(): Promise<BandClientStatus> {
    if (!this.config.host) {
      this.pushEvent('sys.error', { code: 'E_BADREQ', message: '尚未配置手机端地址' })
      return this.client.getStatus()
    }
    if (!this.config.enabled) {
      this.config = await saveBandConfig({ ...this.config, enabled: true })
    }
    await this.startConnection()
    return this.client.getStatus()
  }

  /** 断开连接。 */
  disconnect(): BandClientStatus {
    this.client.disconnect()
    this.pushStatus()
    return this.client.getStatus()
  }

  /** 发送一次 RPC 请求（§3.5）。 */
  async request(method: string, payload: JsonObject = {}): Promise<JsonObject> {
    return this.client.request(method, payload)
  }

  /** 释放资源（应用退出时调用）。 */
  dispose(): void {
    this.client.disconnect()
    this.client.removeAllListeners()
    this.initialized = false
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  private async startConnection(): Promise<void> {
    this.pushStatus()
    await this.client.connect({
      url: buildWsUrl(this.config),
      pairCode: this.config.pairCode,
      token: this.config.token
    })
  }

  private wireClient(): void {
    // 任何情况下都注册 'error' 监听，避免 EventEmitter 抛出未捕获异常
    this.client.on('error', (error) => {
      this.pushEvent('sys.error', { code: error.code, message: error.message })
      this.pushStatus()
    })
    this.client.on('status', () => this.pushStatus())
    this.client.on('event', (event: string, payload: JsonObject) => {
      this.pushEvent(event, payload)
    })
    this.client.on('snapshot', (payload: JsonObject) => {
      // 兜底重同步快照（§3.11 state.get）
      this.pushEvent('state.snapshot', payload)
    })
    this.client.on('xfer', (kind: string, tid: string, text: string) => {
      this.pushEvent('xfer.complete', { kind, tid, text })
    })
    this.client.on('log', (message: string) => {
      // 日志中不包含令牌（URL 已去除查询串）
      console.log(`[band] ${message}`)
    })
  }

  private pushStatus(): void {
    this.send(BAND_STATUS_CHANNEL, this.client.getStatus())
  }

  private pushEvent(event: string, payload: JsonObject): void {
    const message: BandEventMessage = { event, payload }
    this.send(BAND_EVENT_CHANNEL, message)
  }

  /** 向主窗口渲染进程推送；窗口未就绪时静默丢弃。 */
  private send(channel: string, payload: unknown): void {
    if (!this.initialized) return
    const window = getMainWindow()
    if (!window || window.isDestroyed()) return
    try {
      window.webContents.send(channel, payload)
    } catch {
      // 窗口正在销毁时忽略
    }
  }
}

let bridgeSingleton: BandBridge | null = null

/** 获取（惰性创建）全局桥接单例。 */
export function getBandBridge(): BandBridge {
  if (!bridgeSingleton) bridgeSingleton = new BandBridge()
  return bridgeSingleton
}
