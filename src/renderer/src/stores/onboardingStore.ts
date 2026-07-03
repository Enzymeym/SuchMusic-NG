import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  type OnboardingStep,
  type OnboardingState,
  ONBOARDING_STEPS,
  ONBOARDING_STORAGE_KEY
} from '../types/onboarding'

/**
 * 引导系统状态管理 Store
 * 负责管理首次用户引导的步骤进度、显示状态和持久化
 */
export const useOnboardingStore = defineStore('onboarding', () => {
  // --- State ---

  /** 当前步骤索引（从 0 开始） */
  const currentStepIndex = ref(0)

  /** 引导是否已全部完成（不再自动弹出） */
  const isCompleted = ref(false)

  /** 引导覆盖层是否正在显示 */
  const isActive = ref(false)

  /** 引导步骤配置列表 */
  const steps = ref<OnboardingStep[]>([...ONBOARDING_STEPS])

  /** 是否已从 localStorage 加载过状态 */
  let isLoaded = false

  // --- Getters ---

  /** 总步骤数 */
  const totalSteps = computed(() => steps.value.length)

  /** 当前步骤配置 */
  const currentStep = computed<OnboardingStep | null>(() => {
    if (currentStepIndex.value < 0 || currentStepIndex.value >= steps.value.length) {
      return null
    }
    return steps.value[currentStepIndex.value]
  })

  /** 是否是第一步 */
  const isFirstStep = computed(() => currentStepIndex.value === 0)

  /** 是否是最后一步 */
  const isLastStep = computed(() => currentStepIndex.value === steps.value.length - 1)

  /** 完成百分比（0-100） */
  const completionPercent = computed(() => {
    if (steps.value.length === 0) return 100
    return Math.round((currentStepIndex.value / steps.value.length) * 100)
  })

  // --- Actions ---

  /**
   * 从 localStorage 加载引导状态
   * 在应用初始化时调用，恢复用户的引导进度
   */
  const loadState = (): void => {
    if (isLoaded) return
    isLoaded = true

    try {
      const stored = localStorage.getItem(ONBOARDING_STORAGE_KEY)
      if (stored) {
        const data = JSON.parse(stored) as Partial<OnboardingState>
        if (data.isCompleted !== undefined) {
          isCompleted.value = data.isCompleted
        }
        if (data.currentStepIndex !== undefined) {
          currentStepIndex.value = data.currentStepIndex
        }
      }
    } catch (e) {
      console.error('加载引导状态失败', e)
    }
  }

  /**
   * 保存当前引导状态到 localStorage
   */
  const saveState = (): void => {
    try {
      localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({
          currentStepIndex: currentStepIndex.value,
          isCompleted: isCompleted.value
        })
      )
    } catch (e) {
      console.error('保存引导状态失败', e)
    }
  }

  /**
   * 开始引导流程
   * 重置步骤并显示引导覆盖层
   */
  const start = (): void => {
    currentStepIndex.value = 0
    isActive.value = true
    isCompleted.value = false
    saveState()
  }

  /** 进入下一步 */
  const next = (): void => {
    if (currentStepIndex.value < steps.value.length - 1) {
      currentStepIndex.value++
    } else {
      complete()
    }
    saveState()
  }

  /** 返回上一步 */
  const prev = (): void => {
    if (currentStepIndex.value > 0) {
      currentStepIndex.value--
      saveState()
    }
  }

  /**
   * 跳转到指定步骤
   * @param index 目标步骤索引
   */
  const goTo = (index: number): void => {
    if (index >= 0 && index < steps.value.length) {
      currentStepIndex.value = index
      saveState()
    }
  }

  /** 标记引导已完成并隐藏覆盖层 */
  const complete = (): void => {
    isCompleted.value = true
    isActive.value = false
    saveState()
  }

  /** 跳过引导（标记为已完成但保留下次手动触发的可能） */
  const skip = (): void => {
    isCompleted.value = true
    isActive.value = false
    saveState()
  }

  /**
   * 重新开始引导
   * 从头开始完整的引导流程
   */
  const restart = (): void => {
    start()
  }

  /** 关闭引导但不标记完成（允许下次应用启动时再次显示） */
  const dismiss = (): void => {
    isActive.value = false
    saveState()
  }

  // 初始化加载状态
  loadState()

  return {
    // state
    currentStepIndex,
    isCompleted,
    isActive,
    steps,
    // getters
    totalSteps,
    currentStep,
    isFirstStep,
    isLastStep,
    completionPercent,
    // actions
    start,
    next,
    prev,
    goTo,
    complete,
    skip,
    restart,
    dismiss,
    saveState
  }
})
