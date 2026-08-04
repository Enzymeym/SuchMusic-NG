<script setup lang="ts">
/**
 * 音频可视化组件
 * 使用 Canvas 2D 渲染实时频谱柱状图
 *
 * 延迟初始化策略：组件挂载后延迟一帧再设置 Canvas 和注册 FFT 回调，
 * 避免与播放页面的初次渲染竞争资源导致前端卡死。
 * 渲染循环按需启动：仅在收到 FFT 数据或播放状态变化时启动/停止。
 * 可见性检测：组件不可见或页面隐藏时自动暂停渲染循环，减少 CPU/GPU 占用。
 */
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { usePlayerStore } from '../../stores/playerStore'
import { onFftData } from '../../audio/audio-engine'

const props = defineProps<{
  size: number
  intensity: number
}>()

const playerStore = usePlayerStore()
const canvasRef = ref<HTMLCanvasElement | null>(null)

let animationId: number | null = null
let ctx: CanvasRenderingContext2D | null = null
let smoothedData = new Float32Array(128)
let rawSpectrum = new Float32Array(128)
let fftCleanup: (() => void) | null = null
let isUnmounted = false
let isVisible = true
let observer: IntersectionObserver | null = null

// 缓存的主题色 RGB
let cachedAccentR = 255
let cachedAccentG = 255
let cachedAccentB = 255
let accentColorFrameCounter = 0

// 预计算柱状图坐标
let barPositions: number[] = []
let barWidth = 0
const BAR_COUNT = 128
let canvasW = 0
let canvasH = 0
let maxBarHeight = 0
let decayLevel = 0

// 渲染是否活跃：仅在有数据需要绘制时运行 loop
let renderActive = false

function updateAccentColor(): void {
  const hex = getComputedStyle(document.documentElement).getPropertyValue('--player-accent-color').trim()
  if (hex.startsWith('#')) {
    cachedAccentR = parseInt(hex.slice(1, 3), 16)
    cachedAccentG = parseInt(hex.slice(3, 5), 16)
    cachedAccentB = parseInt(hex.slice(5, 7), 16)
  }
}

function setupCanvas(canvas: HTMLCanvasElement, size: number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
  const parent = canvas.parentElement
  if (!parent) return

  canvasW = parent.clientWidth * Math.min(size, 1.5)
  canvasH = parent.clientHeight * Math.min(size, 1.5)

  canvas.style.width = `${canvasW}px`
  canvas.style.height = `${canvasH}px`
  canvas.width = canvasW * dpr
  canvas.height = canvasH * dpr

  ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.scale(dpr, dpr)
  }

  maxBarHeight = canvasH * 0.85

  const gap = canvasW / BAR_COUNT
  barWidth = gap * 0.4
  barPositions = new Array(BAR_COUNT)
  for (let i = 0; i < BAR_COUNT; i++) {
    barPositions[i] = i * gap
  }
}

function drawBars(): void {
  if (!ctx) return

  ctx.clearRect(0, 0, canvasW, canvasH)

  // 将所有柱状图合并到单个路径，一次 fill() 完成，减少 GPU 绘制调用
  const midAlpha = 0.44
  ctx.fillStyle = `rgba(${cachedAccentR}, ${cachedAccentG}, ${cachedAccentB}, ${midAlpha})`
  ctx.beginPath()

  for (let i = 0; i < BAR_COUNT; i++) {
    const value = Math.min(displayData[i], 1) * props.intensity
    if (value < 0.01) continue

    const barHeight = Math.max(value * maxBarHeight, 2)

    const x = barPositions[i]
    const y = canvasH - barHeight - (canvasH - maxBarHeight) / 2
    const radius = Math.min(barWidth / 2, 2)

    ctx.moveTo(x + radius, y)
    ctx.lineTo(x + barWidth - radius, y)
    ctx.arcTo(x + barWidth, y, x + barWidth, y + radius, radius)
    ctx.lineTo(x + barWidth, canvasH)
    ctx.lineTo(x, canvasH)
    ctx.lineTo(x, y + radius)
    ctx.arcTo(x, y, x + radius, y, radius)
    ctx.closePath()
  }

  ctx.fill()
}

// 预分配 displayData 避免每帧创建
const displayData = new Float32Array(BAR_COUNT)

function renderFrame(): void {
  if (isUnmounted || !ctx) {
    renderActive = false
    animationId = null
    return
  }

  // 组件不可见或页面隐藏时暂停渲染
  if (!isVisible || document.hidden) {
    animationId = requestAnimationFrame(renderFrame)
    return
  }

  accentColorFrameCounter++
  if (accentColorFrameCounter >= 60) {
    accentColorFrameCounter = 0
    updateAccentColor()
  }

  const isPlaying = playerStore.isPlaying

  if (!isPlaying) {
    decayLevel = Math.max(0, decayLevel - 0.02)
  } else {
    decayLevel = Math.min(1, decayLevel + 0.05)
  }

  // 检查是否有需要渲染的内容
  if (isPlaying || decayLevel > 0.01) {
    // 平滑 + 衰减
    for (let i = 0; i < BAR_COUNT; i++) {
      const val = rawSpectrum[i] * 255
      smoothedData[i] = smoothedData[i] * 0.7 + val * 0.3
    }

    for (let i = 0; i < BAR_COUNT; i++) {
      displayData[i] = smoothedData[i] * decayLevel
    }

    drawBars()
  }

  // 若已无渲染内容且不在播放，停止 loop
  if (!isPlaying && decayLevel <= 0.01) {
    renderActive = false
    animationId = null
    return
  }

  animationId = requestAnimationFrame(renderFrame)
}

/** 按需启动渲染循环（幂等） */
function ensureRenderLoop(): void {
  if (renderActive || isUnmounted || !ctx) return
  renderActive = true
  animationId = requestAnimationFrame(renderFrame)
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null

function debouncedHandleResize(): void {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (canvasRef.value) {
      setupCanvas(canvasRef.value, props.size)
    }
  }, 150)
}

onMounted(() => {
  // 延迟一帧初始化：让 PlayerPage 先完成首帧渲染，再设置可视化
  requestAnimationFrame(() => {
    if (isUnmounted) return

    updateAccentColor()

    // 注册 FFT 数据回调，首次收到数据时启动渲染循环
    fftCleanup = onFftData((spectrum) => {
      let hasData = false
      for (let i = 0; i < Math.min(spectrum.length, BAR_COUNT); i++) {
        rawSpectrum[i] = spectrum[i]
        if (spectrum[i] > 0) hasData = true
      }
      if (hasData) ensureRenderLoop()
    })

    if (canvasRef.value) {
      setupCanvas(canvasRef.value, props.size)
      // 仅当正在播放时启动渲染循环
      if (playerStore.isPlaying) {
        ensureRenderLoop()
      }
    }

    // 可见性检测：离开视口时暂停渲染
    observer = new IntersectionObserver(
      (entries) => {
        isVisible = entries[0]?.isIntersecting ?? true
      },
      { threshold: 0 }
    )
    if (canvasRef.value) {
      observer.observe(canvasRef.value)
    }

    window.addEventListener('resize', debouncedHandleResize)
  })
})

onUnmounted(() => {
  isUnmounted = true
  renderActive = false
  window.removeEventListener('resize', debouncedHandleResize)
  if (resizeTimer) {
    clearTimeout(resizeTimer)
    resizeTimer = null
  }
  if (observer) {
    observer.disconnect()
    observer = null
  }
  if (fftCleanup) {
    fftCleanup()
    fftCleanup = null
  }
  if (animationId !== null) {
    cancelAnimationFrame(animationId)
    animationId = null
  }
  ctx = null
})

watch(() => props.size, () => {
  debouncedHandleResize()
})
</script>

<template>
  <div class="audio-visualizer-container">
    <canvas ref="canvasRef" class="visualizer-canvas"></canvas>
  </div>
</template>

<style lang="scss" scoped>
.audio-visualizer-container {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.visualizer-canvas {
  display: block;
  border-radius: 16px 16px 0 0;
}
</style>
