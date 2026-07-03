<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { NButton, NIcon, NCard, NTag, NText, NSpace } from 'naive-ui'
import { useOnboardingStore } from '../../stores/onboardingStore'

/**
 * 引导覆盖层组件（Naive UI 版本）
 * 提供聚光灯高亮效果和步骤提示框，引导新用户了解应用功能。
 *
 * 核心功能：
 * - SVG 遮罩实现聚光灯效果，高亮目标 UI 元素
 * - 提示框智能定位，避免溢出视口
 * - 步骤导航（上一步/下一步/跳过）
 * - 响应式布局，窗口大小变化时自动更新
 * - 支持键盘导航（← → 箭头键，Esc 退出）
 */

const store = useOnboardingStore()

// ===== 目标元素位置信息 =====
interface SpotlightRect {
  x: number
  y: number
  width: number
  height: number
}

const targetRect = ref<SpotlightRect>({ x: 0, y: 0, width: 0, height: 0 })
const targetNotFound = ref(false)
const tooltipStyle = ref<Record<string, string>>({})
const svgWidth = ref(window.innerWidth)
const svgHeight = ref(window.innerHeight)
const transitioning = ref(false)

// ===== 计算目标元素位置 =====

/**
 * 获取目标元素在视口中的位置和尺寸
 * 如果找不到目标元素，设置 targetNotFound 标记
 */
const updateTargetRect = (): void => {
  const step = store.currentStep
  if (!step) {
    targetNotFound.value = true
    return
  }
  const el = document.querySelector(step.targetSelector) as HTMLElement | null
  if (!el) {
    targetNotFound.value = true
    return
  }
  targetNotFound.value = false
  const rect = el.getBoundingClientRect()
  const padding = step.spotlightPadding ?? 8
  targetRect.value = {
    x: rect.left - padding,
    y: rect.top - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2
  }
}

// ===== 计算提示框位置 =====

/**
 * 根据目标元素位置和指定方向，计算提示框的 CSS 定位样式
 * @param rect 高亮区域的位置信息
 * @returns CSS 样式对象
 */
const calcTooltipPosition = (rect: SpotlightRect): Record<string, string> => {
  const step = store.currentStep
  if (!step) return {}
  const viewW = window.innerWidth
  const viewH = window.innerHeight
  const gap = 16
  const tooltipW = 340
  const tooltipH = 220

  let placement = step.placement
  if (placement === 'auto') {
    const spaceBottom = viewH - rect.y - rect.height
    const spaceRight = viewW - rect.x - rect.width
    const spaceLeft = rect.x
    if (spaceRight > tooltipW + gap) placement = 'right'
    else if (spaceLeft > tooltipW + gap) placement = 'left'
    else if (spaceBottom > tooltipH + gap) placement = 'bottom'
    else placement = 'top'
  }

  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2

  switch (placement) {
    case 'right':
      return {
        left: `${Math.min(rect.x + rect.width + gap, viewW - tooltipW - 16)}px`,
        top: `${Math.max(16, Math.min(centerY - tooltipH / 2, viewH - tooltipH - 16))}px`
      }
    case 'left':
      return {
        left: `${Math.max(16, rect.x - tooltipW - gap)}px`,
        top: `${Math.max(16, Math.min(centerY - tooltipH / 2, viewH - tooltipH - 16))}px`
      }
    case 'bottom':
      return {
        left: `${Math.max(16, Math.min(centerX - tooltipW / 2, viewW - tooltipW - 16))}px`,
        top: `${Math.min(rect.y + rect.height + gap, viewH - tooltipH - 16)}px`
      }
    case 'top':
    default:
      return {
        left: `${Math.max(16, Math.min(centerX - tooltipW / 2, viewW - tooltipW - 16))}px`,
        top: `${Math.max(16, rect.y - tooltipH - gap)}px`
      }
  }
}

// ===== 更新所有定位信息 =====

/**
 * 刷新聚光灯位置和提示框位置
 * 在步骤切换、窗口大小变化、滚动时调用
 */
const refreshPositions = (): void => {
  updateTargetRect()
  if (!targetNotFound.value) {
    tooltipStyle.value = calcTooltipPosition(targetRect.value)
  }
  svgWidth.value = window.innerWidth
  svgHeight.value = window.innerHeight
}

// ===== SVG 遮罩相关 =====

const maskId = 'onboarding-spotlight-mask'

/**
 * 计算圆角矩形的 SVG path
 * @param x 左上角 x 坐标
 * @param y 左上角 y 坐标
 * @param w 宽度
 * @param h 高度
 * @param r 圆角半径
 * @returns SVG path 字符串
 */
const roundedRectPath = (x: number, y: number, w: number, h: number, r: number): string => {
  const rr = Math.min(r, w / 2, h / 2)
  return `M${x + rr},${y} h${w - rr * 2} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - rr * 2} a${rr},${rr} 0 0 1 -${rr},${rr} h-${w - rr * 2} a${rr},${rr} 0 0 1 -${rr},-${rr} v-${h - rr * 2} a${rr},${rr} 0 0 1 ${rr},-${rr} z`
}

// 步骤切换时更新位置
watch(
  () => store.currentStepIndex,
  () => {
    transitioning.value = true
    refreshPositions()
    setTimeout(() => { transitioning.value = false }, 350)
  }
)

// 窗口大小变化
let resizeTimer: ReturnType<typeof setTimeout> | null = null
const handleResize = (): void => {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(refreshPositions, 100)
}

// 滚动
const handleScroll = (): void => { refreshPositions() }

// 键盘导航
const handleKeydown = (e: KeyboardEvent): void => {
  if (!store.isActive) return
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      e.preventDefault(); store.next(); break
    case 'ArrowLeft':
    case 'ArrowUp':
      e.preventDefault(); store.prev(); break
    case 'Escape':
      e.preventDefault(); store.skip(); break
  }
}

onMounted(() => {
  refreshPositions()
  window.addEventListener('resize', handleResize)
  window.addEventListener('scroll', handleScroll, true)
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('scroll', handleScroll, true)
  window.removeEventListener('keydown', handleKeydown)
  if (resizeTimer) clearTimeout(resizeTimer)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="onboarding-fade">
      <div v-if="store.isActive && store.currentStep" class="onboarding-overlay">
        <!-- SVG 聚光灯遮罩层 -->
        <svg
          class="spotlight-svg"
          :width="svgWidth"
          :height="svgHeight"
          :viewBox="`0 0 ${svgWidth} ${svgHeight}`"
        >
          <defs>
            <mask :id="maskId">
              <rect x="0" y="0" :width="svgWidth" :height="svgHeight" fill="white" />
              <path
                v-if="!targetNotFound"
                :d="roundedRectPath(targetRect.x, targetRect.y, targetRect.width, targetRect.height, 12)"
                fill="black"
                :class="{ 'spotlight-hole-transition': transitioning }"
              />
            </mask>
          </defs>
          <rect
            x="0" y="0"
            :width="svgWidth" :height="svgHeight"
            fill="rgba(0, 0, 0, 0.55)"
            :mask="`url(#${maskId})`"
          />
          <rect
            v-if="!targetNotFound"
            :x="targetRect.x" :y="targetRect.y"
            :width="targetRect.width" :height="targetRect.height"
            rx="12" ry="12"
            fill="none"
            stroke="rgba(255, 255, 255, 0.5)"
            stroke-width="2"
            :class="{ 'spotlight-hole-transition': transitioning }"
          />
        </svg>

        <!-- 提示框卡片 -->
        <n-card
          v-if="!targetNotFound"
          class="onboarding-tooltip"
          :class="{ 'tooltip-transition': transitioning }"
          :style="tooltipStyle"
          :bordered="true"
          size="medium"
          content-style="padding: 20px;"
        >
          <!-- 图标和步骤标签 -->
          <n-space align="center" :size="8" style="margin-bottom: 10px;">
            <div class="tooltip-icon-box" v-if="store.currentStep.icon">
              <n-icon size="20" color="#fff"><i :class="store.currentStep.icon"></i></n-icon>
            </div>
            <n-tag :bordered="false" size="small" round>
              {{ store.currentStepIndex + 1 }} / {{ store.totalSteps }}
            </n-tag>
          </n-space>

          <!-- 标题 -->
          <n-text tag="h3" class="tooltip-title">{{ store.currentStep.title }}</n-text>

          <!-- 描述 -->
          <n-text depth="2" class="tooltip-desc">{{ store.currentStep.description }}</n-text>

          <!-- 操作栏 -->
          <n-space justify="space-between" align="center" style="margin-top: 16px;">
            <n-button text size="small" @click="store.skip()">跳过引导</n-button>
            <n-space :size="8">
              <n-button v-if="!store.isFirstStep" size="small" @click="store.prev()">上一步</n-button>
              <n-button v-if="!store.isLastStep" type="primary" size="small" @click="store.next()">下一步</n-button>
              <n-button v-else type="primary" size="small" @click="store.complete()">完成</n-button>
            </n-space>
          </n-space>

          <!-- 进度指示点 -->
          <div class="tooltip-progress-dots">
            <span
              v-for="(_, idx) in store.steps"
              :key="idx"
              class="progress-dot"
              :class="{ active: idx === store.currentStepIndex, completed: idx < store.currentStepIndex }"
              @click="store.goTo(idx)"
            ></span>
          </div>
        </n-card>

        <!-- 目标未找到 -->
        <n-card
          v-else
          class="onboarding-tooltip not-found-card"
          :bordered="true"
          size="medium"
        >
          <n-text tag="h3" class="tooltip-title">无法定位目标元素</n-text>
          <n-text depth="2" class="tooltip-desc">请尝试导航到正确的页面，或跳过引导继续使用应用。</n-text>
          <n-space justify="space-between" style="margin-top: 16px;">
            <n-button text size="small" @click="store.skip()">跳过引导</n-button>
            <n-button type="primary" size="small" @click="store.next()">下一步</n-button>
          </n-space>
        </n-card>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ===== 覆盖层 ===== */
.onboarding-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  pointer-events: auto;
}

.onboarding-fade-enter-active,
.onboarding-fade-leave-active {
  transition: opacity 0.4s ease;
}
.onboarding-fade-enter-from,
.onboarding-fade-leave-to {
  opacity: 0;
}

/* ===== SVG 聚光灯 ===== */
.spotlight-svg {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.spotlight-hole-transition {
  transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

/* ===== 提示框卡片 ===== */
.onboarding-tooltip {
  position: fixed;
  z-index: 10000;
  width: 340px;
  max-width: calc(100vw - 32px);
  pointer-events: auto;
  user-select: none;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08);
}

.tooltip-transition {
  transition: left 0.35s cubic-bezier(0.4, 0, 0.2, 1), top 0.35s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.35s ease;
}

.not-found-card {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

/* ===== 图标 ===== */
.tooltip-icon-box {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--n-primary-color);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ===== 标题 ===== */
.tooltip-title {
  font-size: 18px;
  font-weight: 700;
  margin: 0 0 6px;
  display: block;
}

/* ===== 描述 ===== */
.tooltip-desc {
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
  display: block;
}

/* ===== 进度指示点 ===== */
.tooltip-progress-dots {
  display: flex;
  justify-content: center;
  gap: 6px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--n-border-color);
}

.progress-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--n-border-color);
  cursor: pointer;
  transition: all 0.3s ease;
}

.progress-dot:hover {
  background: var(--n-primary-color);
  opacity: 0.6;
  transform: scale(1.2);
}

.progress-dot.active {
  background: var(--n-primary-color);
  width: 24px;
  border-radius: 4px;
  cursor: default;
}

.progress-dot.completed {
  background: var(--n-primary-color);
  opacity: 0.5;
}

/* ===== 响应式 ===== */
@media (max-width: 400px) {
  .onboarding-tooltip {
    width: calc(100vw - 32px);
  }
  .tooltip-title {
    font-size: 16px;
  }
  .tooltip-desc {
    font-size: 13px;
  }
}
</style>
