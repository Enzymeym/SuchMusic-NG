// ============================================================
// 首次设置向导相关类型
// ============================================================

/**
 * 设置向导步骤配置接口
 * 定义首次启动时初始设置向导的每个步骤
 */
export interface SetupWizardStep {
  /** 步骤唯一标识 */
  id: string
  /** 步骤标题 */
  title: string
  /** 步骤副标题/简短描述 */
  subtitle: string
  /** 步骤图标类名（mingcute 图标） */
  icon: string
  /** 是否可跳过此步骤 */
  skippable: boolean
}

/**
 * 设置向导状态
 */
export interface SetupWizardState {
  /** 当前步骤索引 */
  currentStepIndex: number
  /** 向导是否已完成 */
  isCompleted: boolean
  /** 向导是否正在显示 */
  isActive: boolean
}

/**
 * 主题色预设选项
 */
export interface ThemeColorPreset {
  /** 预设名称 */
  label: string
  /** 预设标识值 */
  value: string
  /** 颜色十六进制值 */
  color: string
}

/**
 * 主题色预设列表
 */
export const THEME_COLOR_PRESETS: ThemeColorPreset[] = [
  { label: '默认蓝', value: 'default', color: '#2C8EFD' },
  { label: '清新绿', value: 'green', color: '#2fd16c' },
  { label: '活力橙', value: 'orange', color: '#f0a020' },
  { label: '少女粉', value: 'pink', color: '#f472b6' },
  { label: '葡萄紫', value: 'purple', color: '#8b5cf6' },
  { label: '深邃青', value: 'teal', color: '#14b8a6' },
  { label: '热情红', value: 'red', color: '#ef4444' },
  { label: '暗夜灰', value: 'slate', color: '#64748b' }
]

/** EQ 预设选项 */
export interface EqPreset {
  label: string
  value: string
  description: string
  /** 10 段均衡器增益值 */
  gains: number[]
}

/**
 * EQ 预设列表
 */
export const EQ_PRESETS: EqPreset[] = [
  { label: '无效果', value: 'flat', description: '不改变原始音色', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { label: '流行', value: 'pop', description: '突出人声，适合流行音乐', gains: [2, 3, 4, 2, 0, -1, -1, 0, 2, 3] },
  { label: '摇滚', value: 'rock', description: '强化低频与高频，适合摇滚', gains: [5, 4, 2, 0, -1, -2, 0, 2, 4, 5] },
  { label: '古典', value: 'classical', description: '平衡自然，适合古典音乐', gains: [1, 2, 3, 2, 1, 0, 1, 2, 1, 0] },
  { label: '电子', value: 'electronic', description: '超重低音与清晰高频', gains: [6, 5, 1, -2, -3, -2, 1, 3, 5, 6] },
  { label: '人声增强', value: 'vocal', description: '提升中频使人声更清晰', gains: [1, 1, 3, 5, 4, 3, 2, 1, 1, 1] },
  { label: '低音增强', value: 'bass', description: '强化低频鼓点和贝斯', gains: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0] },
  { label: '高音增强', value: 'treble', description: '提升高频细节和空间感', gains: [0, 0, 0, 0, 0, 0, 1, 2, 4, 6] }
]

/**
 * 设置向导步骤配置列表
 */
export const SETUP_WIZARD_STEPS: SetupWizardStep[] = [
  {
    id: 'welcome',
    title: '欢迎使用 Such',
    subtitle: '一款精致的本地音乐播放器，为你带来卓越的听觉享受',
    icon: 'mgc_celebrate_line',
    skippable: false
  },
  {
    id: 'theme',
    title: '选择主题色',
    subtitle: '挑选你喜欢的颜色，打造专属的音乐空间',
    icon: 'mgc_palette_line',
    skippable: false
  },
  {
    id: 'audio-engine',
    title: '音频引擎',
    subtitle: '选择适合你设备的音频输出模式，获得最佳音质',
    icon: 'mgc_speaker_line',
    skippable: false
  },
  {
    id: 'feature-1',
    title: '新功能更新',
    subtitle: '本次版本带来了诸多体验优化',
    icon: 'mgc_sparkles_line',
    skippable: true
  },
  {
    id: 'feature-2',
    title: '新功能更新',
    subtitle: '更强大的音频播放能力',
    icon: 'mgc_headphone_line',
    skippable: true
  },
  {
    id: 'feature-3',
    title: '新功能更新',
    subtitle: '更灵活的音乐管理方式',
    icon: 'mgc_folder_star_line',
    skippable: true
  },
  {
    id: 'feature-4',
    title: '准备就绪',
    subtitle: '一切就绪，开始享受音乐吧',
    icon: 'mgc_rocket_line',
    skippable: false
  }
]

/**
 * 设置向导 localStorage 存储键名
 */
export const SETUP_WIZARD_STORAGE_KEY = 'such-setup-wizard-state'
