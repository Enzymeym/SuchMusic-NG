import { ref } from 'vue'
import type { Ref } from 'vue'
import type { GlobalThemeOverrides } from 'naive-ui'

// 基础主题配置：统一设置全局基础圆角与默认字体
const baseThemeOverrides: GlobalThemeOverrides = {
  common: {
    borderRadius: '10px',
    fontFamily:
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  }
}

// 响应式主题配置对象，供 NConfigProvider 使用
export const themeOverridesRef: Ref<GlobalThemeOverrides> = ref(baseThemeOverrides)

// 设置主题主色，同时保持基础圆角等其他配置
export function setPrimaryColor(color: string): void {
  themeOverridesRef.value = {
    ...themeOverridesRef.value,
    common: {
      ...themeOverridesRef.value.common,
      primaryColor: color,
      primaryColorHover: color,
      primaryColorPressed: color,
      primaryColorSuppl: color
    }
  }
}

// 设置全局字体族，作用于 Naive UI 组件
export function setGlobalFontFamily(fontStack: string): void {
  themeOverridesRef.value = {
    ...themeOverridesRef.value,
    common: {
      ...themeOverridesRef.value.common,
      fontFamily: fontStack
    }
  }
}
