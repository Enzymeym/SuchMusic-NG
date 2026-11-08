/**
 * Such 插件系统 —— 跨进程共享类型（v2）
 *
 * 硬约束：本文件同时被 `tsconfig.node.json` 与 `tsconfig.web.json` include，
 * 因此只能声明 **type**，不允许任何值导出（const / class / enum 都不行），
 * 也不允许 import `node:*` 或 `electron`。
 * 主进程侧的运行时类型见 `src/plugin/types.ts`。
 */

// ==================== 权限（@grant） ====================

/**
 * 插件可申请的授权项，通过脚本头的 `@grant` 声明。
 *
 * - `network`：`such.request`
 * - `ui`：`such.notify`
 * - `playlist`：`such.playlist.*`
 * - `system`：`such.system.*`（执行程序 / 读写文件 / 写音频标签），每次调用需用户确认
 */
export type PluginGrant = 'network' | 'ui' | 'playlist' | 'system'

/** 合法的授权项清单（用于校验 `@grant`，运行时校验用值，见 plugin/header.ts） */
export type KnownPluginGrant = PluginGrant

// ==================== 插件头 ====================

/** 从脚本 JSDoc 头解析出的元信息 */
export interface SuchPluginHeader {
  /** 显示名称（必填） */
  name: string
  /** 插件作者声明的稳定 id（必填） */
  id: string
  /** 语义化版本（必填） */
  version: string
  description?: string
  author?: string
  homepage?: string
  /** 所需最低 API 级别（必填） */
  apiLevel: number
  /** 申请的授权项 */
  grants: string[]
  /** 更新地址 */
  updateUrl?: string
}

// ==================== 插件摘要 ====================

/** 插件声明的单个音源能力 */
export interface V2SourceSummary {
  /** 插件内的音源 key（跨版本必须稳定） */
  key: string
  /** 显示名称 */
  name: string
  /** 声明的动作：musicUrl / musicSearch / musicLyric / musicPic */
  actions: string[]
  /** 声明的音质（128k / 320k / flac / flac24bit / hires / ...） */
  qualities: string[]
}

/** 插件运行状态 */
export type V2PluginState = 'running' | 'disabled' | 'error'

/** 设置模态框与插件列表消费的插件摘要 */
export interface V2PluginSummary {
  /** 宿主内唯一 id，形如 `v2.such.qq-9ab12c` */
  id: string
  /** 插件头里声明的 `@id`（可能与其他宿主生态撞车，仅用于展示） */
  headerId: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  apiLevel: number
  grants: PluginGrant[]
  filePath: string
  enabled: boolean
  state: V2PluginState
  error?: string
  /** 声明的音源（设置里用于展示能力） */
  sources: V2SourceSummary[]
  /** 声明了几项用户设置（0 表示该插件没有可配置项） */
  settingCount: number
  /** `@updateUrl` 指向的远端版本高于本地时填充 */
  updateAlert?: { log?: string; updateUrl?: string }
}

// ==================== 设置 schema ====================

/** 设置项基类字段 */
interface SettingFieldBase {
  key: string
  label: string
  description?: string
}

/** 开关 */
export interface SwitchSettingField extends SettingFieldBase {
  type: 'switch'
  default?: boolean
}

/** 数字 */
export interface NumberSettingField extends SettingFieldBase {
  type: 'number'
  default?: number
  min?: number
  max?: number
  step?: number
}

/** 文本 */
export interface TextSettingField extends SettingFieldBase {
  type: 'text'
  default?: string
  placeholder?: string
  /** 多行文本 */
  multiline?: boolean
  /** 密码类输入（UI 掩码） */
  secret?: boolean
}

/** 下拉选择 */
export interface SelectSettingField extends SettingFieldBase {
  type: 'select'
  default?: string
  options: { label: string; value: string }[]
}

/** 插件声明的用户设置项（由设置模态框渲染为表单） */
export type SettingField =
  | SwitchSettingField
  | NumberSettingField
  | TextSettingField
  | SelectSettingField

/** 设置值（与控件类型对应） */
export type SettingValue = string | number | boolean | null

// ==================== 搜索源目录 ====================

/** 可搜索来源所属生态 */
export type SearchSourceKind = 'v2' | 'lx' | 'ceru'

/**
 * 搜索页「插件」分类下的一个可搜索来源。
 *
 * `key` 是稳定唯一键，渲染层原样回传用于路由：
 * - v2：`v2:<pluginId>:<sourceKey>`
 * - ceru：`ceru:<pluginId>:<providerId>`
 */
export interface SearchSource {
  key: string
  kind: SearchSourceKind
  pluginId: string
  /** 传给宿主的音源 key（v2 声明的 key / 洛雪平台 key / 澜音 providerId） */
  sourceKey: string
  /** 澜音 provider id（v2 / 洛雪为空） */
  providerId?: string
  /** 二级下拉展示的源名称 */
  label: string
  /** 归属插件名（用于二级下拉副标题） */
  pluginName: string
  qualities: string[]
  enabled: boolean
  state: V2PluginState
}

// ==================== 通知 / 日志 ====================

/** 主进程 → 渲染层的插件通知（`plugin:notice`） */
export interface PluginNotice {
  type:
    | 'loaded'
    | 'removed'
    | 'enabled'
    | 'disabled'
    | 'error'
    | 'notify'
    | 'updateAlert'
  pluginId: string
  pluginName?: string
  message?: string
  /** notify 分支的样式 */
  notifyType?: 'success' | 'error' | 'warning' | 'info'
  [k: string]: unknown
}

/** 插件日志条目 */
export interface PluginLogEntry {
  /** 时间戳（毫秒） */
  t: number
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}
