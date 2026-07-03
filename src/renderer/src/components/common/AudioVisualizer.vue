<script setup lang="ts">
/**
 * 音频可视化组件
 * 使用 Canvas 2D 渲染实时频谱柱状图
 */
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { usePlayerStore } from '../../stores/playerStore'
import { audioVisualizer } from '../../audio/audio-visualizer'

const props = defineProps<{
  size: number
  intensity: number
}>()

const playerStore = usePlayerStore()
const canvasRef = ref<HTMLCanvasElement | null>(null)
let animationId: number | null = null
let ctx: CanvasRenderingContext2D | null = null
let smoothedData: Float32Array = new Float32Array(128)

// 缓存的播放页主题色 RGB
let cachedAccentR = 255
let cachedAccentG = 255
let cachedAccentB = 255
let accentColorFrameCounter = 0

// 预计算的柱状图 x 坐标
let barPositions: number[] = []
let barWidth = 0
const BAR_COUNT = 128

/** 读取并缓存播放页主题色 */
function updateAccentColor(): void {
  const hex = getComputedStyle(document.documentElement).getPropertyValue('--player-accent-color').trim()
  if (hex.startsWith('#')) {
    cachedAccentR = parseInt(hex.slice(1, 3), 16)
    cachedAccentG = parseInt(hex.slice(3, 5), 16)
    cachedAccentB = parseInt(hex.slice(5, 7), 16)
  }
}

function shouldRender(isPlaying: boolean, decayLevel: number): boolean {
  return isPlaying || decayLevel > 0.01
}

function setupCanvas(canvas: HTMLCanvasElement, size: number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
  const parent = canvas.parentElement
  if (!parent) return

  const displayWidth = parent.clientWidth * Math.min(size, 1.5)
  const displayHeight = parent.clientHeight * Math.min(size, 1.5)

  canvas.style.width = `${displayWidth}px`
  canvas.style.height = `${displayHeight}px`
  canvas.width = displayWidth * dpr
  canvas.height = displayHeight * dpr

  ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.scale(dpr, dpr)
  }

  // 预计算柱状图 x 坐标（尺寸变化时重新计算）
  const gap = displayWidth / BAR_COUNT
  barWidth = gap * 0.4
  barPositions = new Array(BAR_COUNT)
  for (let i = 0; i < BAR_COUNT; i++) {
    barPositions[i] = i * gap
  }
}

function drawBars(
  data: Float32Array,
  w: number,
  h: number,
  intensity: number
): void {
  if (!ctx) return
  const maxHeight = h * 0.85
  const gap = w / BAR_COUNT

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = `rgba(${cachedAccentR}, ${cachedAccentG}, ${cachedAccentB}, 0)`
  ctx.beginPath()

  for (let i = 0; i < BAR_COUNT; i++) {
    const value = Math.min(data[i] / 255, 1) * intensity
    const barHeight = Math.max(value * maxHeight, 2)
    const alpha = 0.4 + value * 0.08

    const x = barPositions[i]
    const y = h - barHeight - (h - maxHeight) / 2
    const radius = Math.min(barWidth / 2, 2)

    ctx.fillStyle = `rgba(${cachedAccentR}, ${cachedAccentG}, ${cachedAccentB}, ${alpha})`
    ctx.beginPath()
    ctx.moveTo(x + radius, y)
    ctx.lineTo(x + barWidth - radius, y)
    ctx.arcTo(x + barWidth, y, x + barWidth, y + radius, radius)
    ctx.lineTo(x + barWidth, h)
    ctx.lineTo(x, h)
    ctx.lineTo(x, y + radius)
    ctx.arcTo(x, y, x + radius, y, radius)
    ctx.closePath()
    ctx.fill()
  }
}

let decayLevel = 0

function renderLoop(): void {
  if (!canvasRef.value || !ctx) {
    animationId = requestAnimationFrame(renderLoop)
    return
  }

  // 每 60 帧刷新一次主题色（约 1 秒）
  accentColorFrameCounter++
  if (accentColorFrameCounter >= 60) {
    accentColorFrameCounter = 0
    updateAccentColor()
  }

  const canvas = canvasRef.value
  const isPlaying = playerStore.isPlaying
  const w = canvas.clientWidth
  const h = canvas.clientHeight

  if (!isPlaying) {
    decayLevel = Math.max(0, decayLevel - 0.02)
  } else {
    decayLevel = Math.min(1, decayLevel + 0.05)
  }

  if (shouldRender(isPlaying, decayLevel)) {
    const rawData = audioVisualizer.getFrequencyData()
    for (let i = 0; i < rawData.length; i++) {
      smoothedData[i] = smoothedData[i] * 0.7 + rawData[i] * 0.3
    }

    const displayData = new Float32Array(smoothedData.length)
    for (let i = 0; i < smoothedData.length; i++) {
      displayData[i] = smoothedData[i] * decayLevel
    }

    drawBars(displayData, w, h, props.intensity)
  }

  animationId = requestAnimationFrame(renderLoop)
}

function handleResize(): void {
  if (canvasRef.value) {
    setupCanvas(canvasRef.value, props.size)
  }
}

onMounted(() => {
  updateAccentColor()
  if (canvasRef.value) {
    setupCanvas(canvasRef.value, props.size)
    animationId = requestAnimationFrame(renderLoop)
  }
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  if (animationId !== null) {
    cancelAnimationFrame(animationId)
    animationId = null
  }
})

watch(() => props.size, () => {
  handleResize()
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
