/**
 * SuchMusic 手环通信模块入口（Windows 端 · 主进程）
 *
 * 对外导出协议纯逻辑、分片、去重与桥接，供 IPC 层与测试引用。
 */

export * from './protocol'
export * from './chunk'
export * from './dedup'
export * from './requests'
export * from './config'
export * from './link-error'
export {
  BandBridge,
  getBandBridge,
  BAND_STATUS_CHANNEL,
  BAND_EVENT_CHANNEL,
  type BandEventMessage
} from './band-bridge'
export {
  BandWsClient,
  getWebSocketCtor,
  sanitizeUrl,
  type BandClientState,
  type BandClientStatus,
  type BandConnectOptions
} from './ws-client'
