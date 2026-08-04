/**
 * 起始点分析模型 IPC 处理器
 *
 * 为渲染进程提供 onnxruntime-web 所需的 WASM 二进制。
 * 生产环境渲染进程通过 file:// 加载，无法 fetch 相对路径的 .wasm 文件，
 * 因此由主进程读取后通过 IPC 传输（renderer 端写入 ort.env.wasm.wasmBinary）。
 *
 * 路径解析：
 * - 开发/打包后 onnxruntime-web 均为生产依赖，位于 app 目录的
 *   node_modules/onnxruntime-web/dist/ 下（asar 内，fs 可透明读取）。
 */

import { app, ipcMain } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'

/** WASM 文件读取缓存，避免每次请求重复读盘（约 13.5MB） */
let cachedWasm: Buffer | null = null

/** 解析 onnxruntime-web 的 WASM 二进制路径 */
function resolveWasmPath(): string {
  return join(
    app.getAppPath(),
    'node_modules',
    'onnxruntime-web',
    'dist',
    'ort-wasm-simd-threaded.wasm'
  )
}

/** 读取 WASM 二进制（首次读盘后缓存） */
async function getWasmBinary(): Promise<Buffer> {
  if (!cachedWasm) {
    cachedWasm = await readFile(resolveWasmPath())
  }
  return cachedWasm
}

export function registerAnalyzerHandlers(): void {
  ipcMain.handle('analyzer:get-wasm-binary', async () => {
    try {
      return await getWasmBinary()
    } catch (e) {
      console.error('[Analyzer] 读取 onnxruntime WASM 失败:', e)
      return null
    }
  })
}
