/**
 * Such 插件系统类型定义
 */

// ==================== 权限类型 ====================

/** 插件可声明的权限 */
export type PluginPermission = 'local_program' | 'file_system' | 'fetch' | 'app_info' | 'playlist'

// ==================== 插件元数据 (window.source) ====================

/** 插件元数据 —— 即 window.source 赋值的对象结构 */
export interface SuchPluginManifest {
  /** 唯一标识，大写字母+下划线 */
  id: string
  /** 显示名称 */
  name: string
  /** 语义化版本号 */
  version: string
  /** 作者 */
  author: string
  /** 图标 URL */
  icon?: string
  /** 功能描述 */
  description?: string
  /** 权限声明 */
  permissions?: PluginPermission[]
  /** 是否为 UI 插件（有 uiSchema 时须为 true） */
  isUIWidget?: boolean
  /** JSON UI Schema —— 定义插件前端界面 */
  uiSchema?: PluginUISchema

  // ========== 生命周期 ==========
  /** 插件初始化，加载后调用一次 */
  initialization?: (this: SuchPluginInstance) => void

  // ========== 自定义方法（插件可自由扩展） ==========
  [method: string]: any
}

// ==================== 插件实例 ====================

/** 插件加载后的运行时实例 */
export interface SuchPluginInstance extends SuchPluginManifest {
  /** 运行时属性 */
  props: Record<string, any>
  /** 插件文件路径 */
  filePath: string
  /** 当前状态 */
  state: PluginState

  // ========== UI 方法 ==========
  /** 渲染插件 UI（仅 UI 插件） */
  render?: (this: SuchPluginInstance) => any
  /** 更新属性并触发重渲染 */
  setProps: (partialProps: Record<string, any>) => void
  /** 向宿主触发事件 */
  emit: (eventName: string, ...args: any[]) => void
}

// ==================== 插件状态 ====================

export enum PluginState {
  /** 已加载，未初始化 */
  Loaded = 'loaded',
  /** 初始化完成，正常运行 */
  Running = 'running',
  /** 发生错误 */
  Error = 'error',
  /** 已卸载 */
  Unloaded = 'unloaded'
}

// ==================== 宿主 API 接口 ====================

/** 敏感操作确认请求 */
export interface ConfirmRequest {
  /** 插件 ID */
  pluginId: string
  /** 插件名称 */
  pluginName: string
  /** 操作类型 */
  operation: 'execProgram' | 'execTerminal' | 'fileOp' | 'playlistOp' | 'writeMeta'
  /** 操作详情（展示给用户） */
  detail: string
  /** 操作唯一标识，用于匹配响应 */
  requestId: string
}

/** 批量敏感操作确认请求 */
export interface BatchConfirmRequest {
  /** 插件 ID */
  pluginId: string
  /** 插件名称 */
  pluginName: string
  /** 批量操作列表 */
  operations: BatchConfirmItem[]
  /** 批量请求唯一标识 */
  requestId: string
}

/** 批量确认中的单个操作项 */
export interface BatchConfirmItem {
  /** 操作内部 ID（用于匹配各独立 promise） */
  opId: string
  /** 操作类型 */
  operation: ConfirmRequest['operation']
  /** 操作详情 */
  detail: string
}

/** 批量敏感操作确认响应 */
export interface BatchConfirmResponse {
  /** 匹配的 requestId */
  requestId: string
  /** 是否全部确认 */
  confirmed: boolean
  /** 被拒绝的操作 ID 列表（confirmed=false 时生效） */
  rejectedOpIds?: string[]
  /** 是否本次会话不再询问 */
  skipSession: boolean
}

/** 敏感操作确认响应 */
export interface ConfirmResponse {
  /** 匹配的 requestId */
  requestId: string
  /** 是否确认 */
  confirmed: boolean
  /** 是否本次会话不再询问 */
  skipSession: boolean
}

// ==================== 文件操作类型 ====================

/** 文件操作类型 */
export type FileOperation = 'read' | 'write' | 'copy' | 'delete' | 'exists' | 'listDir'

// ==================== 插件管理 Store 类型 ====================

/** 插件 Store 中的插件条目 */
export interface PluginEntry {
  /** 插件元数据 */
  manifest: SuchPluginManifest
  /** 文件路径 */
  filePath: string
  /** 当前状态 */
  state: PluginState
  /** 是否为当前活跃插件 */
  isActive: boolean
}

// ==================== JSON UI Schema 类型 ====================

/** 插件 UI Schema 根节点 */
export interface PluginUISchema {
  /** 页面标题（可选） */
  title?: string
  /** UI 区块列表 */
  sections: UISection[]
}

/** UI 区块 */
export interface UISection {
  /** 区块标题 */
  title?: string
  /** 区块描述 */
  description?: string
  /** 字段列表 */
  fields?: UIField[]
  /** 操作按钮 */
  actions?: UIAction[]
}

/** UI 字段类型 */
export type UIFieldType = 'input' | 'text' | 'log' | 'tag' | 'image' | 'select'

/** UI 按钮样式 */
export type UIButtonVariant = 'primary' | 'default' | 'warning' | 'error'

/** UI 字段定义 */
export interface UIField {
  /** 字段类型 */
  type: UIFieldType
  /** 字段唯一标识，对应插件 props 中的 key */
  key: string
  /** 显示标签 */
  label?: string
  /** 占位符 */
  placeholder?: string
  /** 是否只读 */
  readonly?: boolean
  /** 关联的 emit 事件（如 browse） */
  action?: string
  /** 图片宽度（仅 image 类型） */
  width?: number
  /** 图片高度（仅 image 类型） */
  height?: number
}

/** UI 操作按钮 */
export interface UIAction {
  /** 按钮类型 */
  type: 'button'
  /** 显示文字 */
  label: string
  /** 调用的插件方法名 */
  method: string
  /** 按钮样式 */
  variant?: UIButtonVariant
}

// ==================== 歌单操作类型 ====================

/** 歌单曲目 */
export interface PlaylistTrackInfo {
  id?: string | number | null
  title: string
  artist: string
  album?: string
  cover?: string
  filePath?: string
  durationMs?: number
  source?: string
  sourceSongId?: string | number
}

/** 歌单操作请求 (main → renderer) */
export interface PlaylistOpRequest {
  requestId: string
  pluginId: string
  pluginName: string
  action: 'createPlaylist' | 'addToPlaylist' | 'updatePlaylistSettings' | 'listPlaylists'
  params: Record<string, any>
}

/** 歌单操作响应 (renderer → main) */
export interface PlaylistOpResponse {
  requestId: string
  success: boolean
  error?: string
  result?: any
}

