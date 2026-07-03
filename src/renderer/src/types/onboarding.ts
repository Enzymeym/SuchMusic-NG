/**
 * 引导步骤配置接口
 * 定义每个引导步骤的目标元素、提示内容和位置等
 */
export interface OnboardingStep {
  /** 步骤唯一标识 */
  id: string
  /** 步骤标题 */
  title: string
  /** 步骤描述文本 */
  description: string
  /** 目标元素的 CSS 选择器，用于定位高亮区域 */
  targetSelector: string
  /**
   * 提示框相对于目标元素的显示位置
   * 自动布局模式下会根据可用空间智能调整
   */
  placement: 'top' | 'bottom' | 'left' | 'right' | 'auto'
  /**
   * 高亮区域的 padding（像素），用于扩大聚焦区域
   * 使高亮框比目标元素稍大，视觉效果更好
   */
  spotlightPadding?: number
  /** 步骤图标类名（mingcute 图标） */
  icon?: string
}

/**
 * 引导进度状态
 */
export interface OnboardingState {
  /** 当前步骤索引（从 0 开始） */
  currentStepIndex: number
  /** 是否已完成全部引导 */
  isCompleted: boolean
  /** 是否正在显示引导 */
  isActive: boolean
  /** 所有引导步骤 */
  steps: OnboardingStep[]
}

/**
 * 引导步骤配置列表
 * 定义首次用户引导的全部步骤
 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'sidebar',
    title: '侧边栏导航',
    description:
      '在这里可以快速切换不同页面：首页发现音乐、管理您的歌单、浏览本地音乐文件、查看最近播放记录。点击左上角按钮可以折叠侧边栏获得更大视野。',
    targetSelector: '.sidebar',
    placement: 'right',
    spotlightPadding: 8,
    icon: 'mgc_menu_line'
  },
  {
    id: 'search',
    title: '全局搜索',
    description:
      '在搜索框中输入关键词，可以同时搜索本地音乐、在线歌曲、歌手和歌单。支持模糊搜索和智能联想，快速找到您想听的音乐。',
    targetSelector: '.search-bar',
    placement: 'bottom',
    spotlightPadding: 4,
    icon: 'mgc_search_line'
  },
  {
    id: 'settings',
    title: '设置中心',
    description:
      '点击齿轮图标打开设置面板，您可以在这里调整外观主题、播放偏好、音源选择、歌词显示等个性化配置，让 Such Music 更符合您的使用习惯。',
    targetSelector: '.right-controls .action-btn',
    placement: 'bottom',
    spotlightPadding: 4,
    icon: 'mgc_settings_3_line'
  },
  {
    id: 'player-bar',
    title: '播放控制栏',
    description:
      '底部播放栏是音乐播放的核心控制区。您可以播放/暂停、切换上下曲、调整音量、查看当前播放进度。点击封面区域可以展开完整的播放器页面，享受沉浸式的音乐体验。',
    targetSelector: '.footer',
    placement: 'top',
    spotlightPadding: 8,
    icon: 'mgc_music_fill'
  },
  {
    id: 'playlist-queue',
    title: '播放列表与队列',
    description:
      '在播放栏右侧可以查看和管理当前播放队列。您可以添加歌曲到队列、调整播放顺序、切换播放模式（列表循环/单曲循环/随机播放），灵活控制您的聆听体验。',
    targetSelector: '.footer',
    placement: 'top',
    spotlightPadding: 8,
    icon: 'mgc_playlist_line'
  }
]

/**
 * localStorage 存储键名
 */
export const ONBOARDING_STORAGE_KEY = 'such-onboarding-state'

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
    id: 'theme',
    title: '选择主题色',
    subtitle: '挑选你喜欢的颜色，打造专属的音乐空间',
    icon: 'mgc_palette_line',
    skippable: false
  },
  {
    id: 'sound',
    title: '音效设置',
    subtitle: '选择适合的均衡器预设，优化听感体验',
    icon: 'mgc_equalizer_line',
    skippable: false
  },
  {
    id: 'local-music',
    title: '导入本地音乐',
    subtitle: '选择音乐文件夹，将本地歌曲加入曲库',
    icon: 'mgc_folder_2_line',
    skippable: true
  },
  {
    id: 'done',
    title: '准备就绪',
    subtitle: '一切就绪，开始享受音乐吧',
    icon: 'mgc_celebrate_line',
    skippable: false
  }
]

/**
 * 设置向导 localStorage 存储键名
 */
export const SETUP_WIZARD_STORAGE_KEY = 'such-setup-wizard-state'
