import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  type SetupWizardStep,
  SETUP_WIZARD_STEPS,
  SETUP_WIZARD_STORAGE_KEY,
  THEME_COLOR_PRESETS,
  EQ_PRESETS
} from '../types/onboarding'
import { useSettingsStore } from './settingsStore'

/**
 * 首次设置向导状态管理 Store
 * 负责管理首次启动时的初始设置流程：
 * 主题色选择、音效配置、本地音乐导入
 */
export const useSetupWizardStore = defineStore('setupWizard', () => {
  // --- State ---

  /** 当前步骤索引 */
  const currentStepIndex = ref(0)

  /** 向导是否已全部完成 */
  const isCompleted = ref(false)

  /** 向导是否正在显示 */
  const isActive = ref(false)

  /** 向导步骤配置列表 */
  const steps = ref<SetupWizardStep[]>([...SETUP_WIZARD_STEPS])

  /** 用户选择的主题色预设值 */
  const selectedThemePreset = ref(THEME_COLOR_PRESETS[0].value)

  /** 用户自定义的主题色（颜色选择器） */
  const customThemeColor = ref(THEME_COLOR_PRESETS[0].color)

  /** 用户选择的 EQ 预设值 */
  const selectedEqPreset = ref(EQ_PRESETS[0].value)

  /** 是否启用均衡器 */
  const eqEnabled = ref(false)

  /** 是否启用音频可视化 */
  const visualizerEnabled = ref(true)

  /** 是否已从 localStorage 加载过状态 */
  let isLoaded = false

  // --- Getters ---

  /** 总步骤数 */
  const totalSteps = computed(() => steps.value.length)

  /** 当前步骤配置 */
  const currentStep = computed<SetupWizardStep | null>(() => {
    if (currentStepIndex.value < 0 || currentStepIndex.value >= steps.value.length) {
      return null
    }
    return steps.value[currentStepIndex.value]
  })

  /** 是否是最后一步 */
  const isLastStep = computed(() => currentStepIndex.value === steps.value.length - 1)

  /** 当前主题色预设对象 */
  const currentPreset = computed(() => {
    if (selectedThemePreset.value === 'custom') {
      return { label: '自定义', value: 'custom', color: customThemeColor.value }
    }
    return (
      THEME_COLOR_PRESETS.find((p) => p.value === selectedThemePreset.value) ||
      THEME_COLOR_PRESETS[0]
    )
  })

  /** 当前应用的最终颜色 */
  const activeColor = computed(() => {
    if (selectedThemePreset.value === 'custom') return customThemeColor.value
    return currentPreset.value.color
  })

  /** 当前 EQ 预设对象 */
  const currentEqPreset = computed(() => {
    return EQ_PRESETS.find((p) => p.value === selectedEqPreset.value) || EQ_PRESETS[0]
  })

  // --- Actions ---

  /**
   * 从 localStorage 加载向导完成状态
   * 在应用初始化时调用
   */
  const loadState = (): void => {
    if (isLoaded) return
    isLoaded = true

    try {
      const stored = localStorage.getItem(SETUP_WIZARD_STORAGE_KEY)
      if (stored) {
        const data = JSON.parse(stored)
        if (data.isCompleted !== undefined) {
          isCompleted.value = data.isCompleted
        }
      }
    } catch (e) {
      console.error('加载设置向导状态失败', e)
    }
  }

  /** 保存完成状态到 localStorage */
  const saveState = (): void => {
    try {
      localStorage.setItem(
        SETUP_WIZARD_STORAGE_KEY,
        JSON.stringify({ isCompleted: isCompleted.value })
      )
    } catch (e) {
      console.error('保存设置向导状态失败', e)
    }
  }

  /** 开始设置向导 */
  const start = (): void => {
    currentStepIndex.value = 0
    isActive.value = true
  }

  /** 下一步 */
  const next = (): void => {
    if (currentStepIndex.value < steps.value.length - 1) {
      currentStepIndex.value++
    }
  }

  /** 上一步 */
  const prev = (): void => {
    if (currentStepIndex.value > 0) {
      currentStepIndex.value--
    }
  }

  /** 设置主题色预设 */
  const setThemePreset = (value: string): void => {
    selectedThemePreset.value = value
    const preset = THEME_COLOR_PRESETS.find((p) => p.value === value)
    if (preset) {
      customThemeColor.value = preset.color
    }
  }

  /** 设置自定义主题色 */
  const setCustomThemeColor = (color: string): void => {
    customThemeColor.value = color
    selectedThemePreset.value = 'custom'
  }

  /** 设置 EQ 预设 */
  const setEqPreset = (value: string): void => {
    selectedEqPreset.value = value
    if (value !== 'flat') {
      eqEnabled.value = true
    }
  }

  /**
   * 应用用户选择的所有设置到 settingsStore
   * 在向导完成时调用，将用户的初始配置写入正式设置
   */
  const applySettings = (): void => {
    const settingsStore = useSettingsStore()

    // 应用主题色
    settingsStore.appearance.themeColorPreset = selectedThemePreset.value
    settingsStore.appearance.customThemeColor = activeColor.value

    // 应用均衡器
    if (eqEnabled.value) {
      settingsStore.playback.eqEnabled = true
      settingsStore.playback.eqPreset = selectedEqPreset.value
      settingsStore.playback.eqGains = [...currentEqPreset.value.gains]
    }

    // 应用可视化
    settingsStore.playback.visualizerEnabled = visualizerEnabled.value
  }

  /**
   * 完成向导并应用设置
   * 保存完成状态到 localStorage
   */
  const complete = (): void => {
    applySettings()
    isCompleted.value = true
    isActive.value = false
    saveState()
  }

  /**
   * 跳过向导（不应用设置）
   * 标记为已完成，用户后续可在设置中调整
   */
  const skip = (): void => {
    isCompleted.value = true
    isActive.value = false
    saveState()
  }

  /** 跳过当前可跳过的步骤 */
  const skipCurrentStep = (): void => {
    next()
  }

  // 初始化加载
  loadState()

  return {
    // state
    currentStepIndex,
    isCompleted,
    isActive,
    steps,
    selectedThemePreset,
    customThemeColor,
    selectedEqPreset,
    eqEnabled,
    visualizerEnabled,
    // getters
    totalSteps,
    currentStep,
    isLastStep,
    currentPreset,
    activeColor,
    currentEqPreset,
    // actions
    start,
    next,
    prev,
    setThemePreset,
    setCustomThemeColor,
    setEqPreset,
    applySettings,
    complete,
    skip,
    skipCurrentStep,
    saveState
  }
})
