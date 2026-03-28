import { computed, watchEffect } from 'vue'
import type { ComputedRef } from 'vue'
import { darkTheme, useOsTheme } from 'naive-ui'
import type { GlobalTheme } from 'naive-ui'
import { useSettingsStore } from '../stores/settingsStore'

// 自动根据系统设置切换 Naive UI 深浅色主题
export interface AutoNaiveTheme {
  // 是否为深色模式
  isDark: ComputedRef<boolean>
  // 提供给 NConfigProvider 的主题对象
  theme: ComputedRef<GlobalTheme | null>
}

// 在组件中调用，获得自动深浅色主题
export function useAutoNaiveTheme(): AutoNaiveTheme {
  // 监听系统深浅色模式（light / dark）
  const osThemeRef = useOsTheme()
  const settingsStore = useSettingsStore()

  // 当前是否为深色模式：优先使用设置中的主题模式
  const isDark = computed(() => {
    const mode = settingsStore.appearance.themeMode
    if (mode === 'dark') return true
    if (mode === 'light') return false
    return osThemeRef.value === 'dark'
  })

  // NConfigProvider 需要的 theme：深色时使用 darkTheme，浅色时为 null
  const theme = computed<GlobalTheme | null>(() => (isDark.value ? darkTheme : null))

  // 同步到 document，用于全局样式和组件内自定义逻辑
  watchEffect(() => {
    const mode = isDark.value ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', mode)
    window.dispatchEvent(new CustomEvent('theme-change', { detail: mode }))
  })

  return {
    isDark,
    theme
  }
}
