/**
 * SuchMusic 手环通信 · IPC 注册（Windows 端 · 主进程）
 *
 * 通道清单（对齐渲染进程 `useBand.ts`）：
 * - `band:get-config`  → BandConfig
 * - `band:set-config`  → 局部更新并返回最新配置
 * - `band:connect`     → 建立连接
 * - `band:disconnect`  → 断开连接
 * - `band:get-status`  → 连接状态快照
 * - `band:request`     → 发送一次 RPC（method, payload）
 *
 * 推送（主 → 渲染）：`band:status` / `band:event`。
 */

import { ipcMain } from 'electron'
import type { BandConfig } from '../band/config'
import { getBandBridge } from '../band/band-bridge'
import type { JsonObject } from '../band/protocol'

export function registerBandHandlers(): void {
  const bridge = getBandBridge()

  ipcMain.handle('band:get-config', () => bridge.getConfig())

  ipcMain.handle('band:set-config', async (_event, partial: Partial<BandConfig>) => {
    return bridge.updateConfig(partial ?? {})
  })

  ipcMain.handle('band:connect', async () => bridge.connect())

  ipcMain.handle('band:disconnect', () => bridge.disconnect())

  ipcMain.handle('band:get-status', () => bridge.getStatus())

  ipcMain.handle('band:request', async (_event, method: string, payload: JsonObject) => {
    return bridge.request(method, payload ?? {})
  })

  // 启动即初始化：读取配置，仅在用户已开启时自动连接（默认关闭）
  void bridge.init()
}
