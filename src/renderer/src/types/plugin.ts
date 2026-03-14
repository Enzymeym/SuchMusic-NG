/**
 * 插件系统类型定义
 * @author SuchMusic Plugin System
 */

/**
 * 插件信息
 */
export interface PluginInfo {
  /** 插件名称 */
  name: string
  /** 插件版本 */
  version: string
  /** 插件作者 */
  author: string
  /** 插件描述 */
  description?: string
  /** 插件主页 */
  homepage?: string
  /** 其他自定义字段 */
  [key: string]: any
}

/**
 * 插件音源
 */
export interface PluginSource {
  /** 音源ID */
  id: string
  /** 音源名称 */
  name: string
  /** 支持的音质列表 */
  qualities: string[]
  /** 其他自定义字段 */
  [key: string]: any
}

/**
 * 下拉选项
 */
export interface PluginConfigDropdownItem {
  /** 选项ID */
  id: string
  /** 选项显示标签 */
  label: string
  /** 其他自定义字段 */
  [key: string]: any
}

/**
 * 配置项验证规则
 */
export interface PluginConfigValidation {
  /** 正则表达式模式 */
  pattern?: string
  /** 验证失败提示信息 */
  message?: string
  /** 最小值（数字类型） */
  min?: number
  /** 最大值（数字类型） */
  max?: number
}

/**
 * 插件配置项定义
 */
export interface PluginConfigItem {
  /** 配置项ID */
  id: string
  /** 配置项名称 */
  name: string
  /** 配置项描述 */
  description?: string
  /** 控件类型 */
  type: 'input' | 'switch' | 'dropdown' | 'number' | 'radio' | 'checkbox' | 'textarea' | 'password' | 'default'
  /** 下拉选项（type为dropdown/radio/checkbox时有效） */
  dropdown?: PluginConfigDropdownItem[]
  /** 默认值 */
  defaultValue?: any
  /** 变更时调用的插件方法名 */
  emit?: string
  /** 占位提示文本 */
  placeholder?: string
  /** 是否必填 */
  required?: boolean
  /** 是否禁用 */
  disabled?: boolean
  /** 输入类型（type为input时有效） */
  inputType?: 'text' | 'password' | 'email' | 'url' | 'tel'
  /** 文本域行数（type为textarea时有效） */
  rows?: number
  /** 验证规则 */
  validation?: PluginConfigValidation
  /** 描述是否显示在tooltip中 */
  descriptionInTooltip?: boolean
}

/**
 * 插件定义
 */
export interface Plugin {
  /** 插件ID */
  id: string
  /** 插件代码 */
  code: string
  /** 插件信息 */
  info: PluginInfo
  /** 支持的音源 */
  sources: PluginSource[]
  /** 配置UI定义 */
  configUI: PluginConfigItem[]
  /** 插件状态 */
  status: 'uninitialized' | 'active' | 'inactive' | 'error'
  /** 插件配置 */
  config?: Record<string, any>
  /** 错误信息 */
  error?: string
}

/**
 * 插件导入结果
 */
export interface PluginImportResult {
  /** 是否取消 */
  canceled?: boolean
  /** 错误信息 */
  error?: string
  /** 导入的插件 */
  plugin?: Plugin
}

/**
 * 插件验证结果
 */
export interface PluginValidationResult {
  /** 是否验证通过 */
  valid: boolean
  /** 错误信息 */
  error?: string
  /** 插件信息 */
  info?: PluginInfo
  /** 支持的音源 */
  sources?: PluginSource[]
}

/**
 * 插件运行时API
 */
export interface PluginRuntimeApi {
  /** 环境 */
  env: string
  /** 版本 */
  version: string
  /** 工具函数 */
  utils: {
    buffer: {
      from: (data: string | ArrayBuffer, encoding?: string) => any
      bufToString: (buffer: any, encoding?: string) => string
    }
    crypto: {
      md5: (str: string) => string
      aesEncrypt: (data: any, mode: string, key: string | any, iv?: string | any) => any
      randomBytes: (size: number) => any
      rsaEncrypt: (data: string, key: string) => string
    }
  }
  /** HTTP请求 */
  request: (url: string, options?: any) => Promise<any>
  /** 通知中心 */
  NoticeCenter: (type: string, data: any) => void
  /** 获取插件配置 */
  getPluginConfig: (pluginId: string, key: string) => Promise<any>
  /** 设置插件配置 */
  setPluginConfig: (pluginId: string, key: string, value: any) => Promise<void>
}

/**
 * 音乐信息
 */
export interface MusicInfo {
  /** 歌曲ID */
  id: string
  /** 歌曲名称 */
  name: string
  /** 歌手 */
  singer: string
  /** 音源 */
  source: string
  /** 时长 */
  interval?: string
  /** 元数据 */
  metaData?: any
  /** 音质 */
  quality?: string
}

/**
 * 插件方法
 */
export interface PluginMethods {
  /** 获取音乐URL */
  musicUrl: (source: string, musicInfo: MusicInfo, quality: string) => Promise<string>
  /** 获取封面 */
  getPic?: (source: string, musicInfo: MusicInfo) => Promise<string>
  /** 获取歌词 */
  getLyric?: (source: string, musicInfo: MusicInfo) => Promise<string>
  /** 配置变更回调 */
  [key: string]: any
}
