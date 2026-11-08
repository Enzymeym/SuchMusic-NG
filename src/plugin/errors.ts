/**
 * v2 插件错误码
 *
 * 与音源插件的 `SourcePluginError` **语义对齐但类型独立**：`src/plugin` 不能反向
 * 依赖 `src/main`，因此这里自带一份。两边都以字符串 `code` 暴露给渲染层，
 * IPC 层只看 `err.code`，所以不需要共同基类。
 */
export type PluginErrorCode =
  /** 没有任何已启用插件能处理该音源 */
  | 'NO_PLUGIN'
  /** 命中插件但被停用 */
  | 'PLUGIN_DISABLED'
  /** 命中插件但加载失败 / 已移除 */
  | 'PLUGIN_ERROR'
  /** 插件不具备该能力 */
  | 'UNSUPPORTED_ACTION'
  /** 插件执行时抛错或超时 */
  | 'RESOLVE_FAILED'

export class PluginHostError extends Error {
  readonly code: PluginErrorCode

  constructor(code: PluginErrorCode, message: string) {
    super(message)
    this.name = 'PluginHostError'
    this.code = code
  }
}
