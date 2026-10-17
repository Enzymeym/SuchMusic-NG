/**
 * 音源插件子系统入口
 */
export * from './types'
export { sourceRegistry, SourcePluginRegistry } from './registry'
export type { ResolveDispatchResult, SourceNotice, LoadOptions } from './registry'
export { LxSourceHost } from './lxHost'
export { CeruSourceHost, crLyricToResult } from './ceruHost'

import { sourceRegistry } from './registry'

/** 启动时加载已保存的音源插件 */
export async function loadAllSavedSourcePlugins(): Promise<void> {
  await sourceRegistry.loadSavedPlugins()
}
