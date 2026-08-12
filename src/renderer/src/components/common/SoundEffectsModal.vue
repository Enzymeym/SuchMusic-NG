<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import {
  NModal,
  NSwitch,
  NSlider,
  NIcon,
  NTooltip,
  NScrollbar,
  NSelect,
  NButton,
  NRadioGroup,
  NRadioButton,
  NCollapse,
  NCollapseItem,
  useThemeVars,
  useMessage
} from 'naive-ui'
import { useAudioEngine } from '../../composables/useAudioEngine'
import { useSettingsStore } from '../../stores/settingsStore'

const themeVars = useThemeVars()
const message = useMessage()

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
}>()

const audioEngine = useAudioEngine() as any
const settingsStore = useSettingsStore()

const showModal = computed({
  get: () => props.show,
  set: (val) => emit('update:show', val)
})

/** 主题强调色（跟随应用主题主色） */
const ACCENT = computed(() => themeVars.value.primaryColor)
const ACCENT_DARK = computed(() => themeVars.value.primaryColorPressed)

/** 将主题主色转为带透明度的 rgba 字符串（兼容 hex 与 rgb 两种格式） */
const accentRgba = (alpha: number) => {
  const color = themeVars.value.primaryColor.trim()
  let r = 236
  let g = 72
  let b = 153
  // hex: #rrggbb / #rgb
  const hexMatch = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hexMatch) {
    const hex = hexMatch[1]
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
    r = parseInt(full.slice(0, 2), 16)
    g = parseInt(full.slice(2, 4), 16)
    b = parseInt(full.slice(4, 6), 16)
  } else {
    // rgb(r, g, b) / rgba(r, g, b, a)
    const nums = color.match(/[\d.]+/g)
    if (nums && nums.length >= 3) {
      r = Number(nums[0])
      g = Number(nums[1])
      b = Number(nums[2])
    }
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// ==================== 工具函数 ====================
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const fmtDb = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
const fmtDbCompact = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}dB`

// ==================== 顶部导航 & 预设 ====================
const selectedPresetId = ref('flat')
watch(
  () => audioEngine.currentPresetId.value,
  (val) => {
    selectedPresetId.value = val
    // 切换预设后，整体强度回归 100%
    eqStrength.value = 100
    eqStrengthPrev = 100
  }
)

const presetOptions = computed(() =>
  audioEngine.presets.value.map((p: any) => ({ label: p.name, value: p.id }))
)

const deviceName = computed(
  () => settingsStore.playback.audioOutputDeviceName || '默认输出设备'
)

const handlePresetChange = (presetId: string) => {
  audioEngine.applyPreset(presetId)
  eqStrength.value = 100
  eqStrengthPrev = 100
}

/** 重置为默认（平坦）设置 */
const handleReset = () => {
  audioEngine.applyPreset('flat')
  eqStrength.value = 100
  eqStrengthPrev = 100
  message.success('已重置为默认设置')
}

/** 复制文本（带降级方案） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

const handleCopyPreset = async () => {
  const ok = await copyText(JSON.stringify(audioEngine.getCurrentSnapshot(), null, 2))
  ok ? message.success('已复制当前预设数据') : message.error('复制失败')
}

const handleSharePreset = async () => {
  const payload = JSON.stringify({
    app: 'such-music',
    presetId: audioEngine.currentPresetId.value,
    data: audioEngine.getCurrentSnapshot()
  })
  const ok = await copyText(payload)
  ok ? message.success('分享数据已复制到剪贴板') : message.error('复制失败')
}

const handleGoToSound = () => {
  message.info('请在系统「声音」设置中查看更多输出选项')
}

// ==================== EQ 曲线图 ====================
const eqTab = ref<'pre' | 'post'>('pre')
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const EQ_MIN_DB = -10
const EQ_MAX_DB = 10
const GRAPH_H = 220
const F_MIN = 20
const F_MAX = 20000

const graphCanvas = ref<HTMLCanvasElement | null>(null)
const graphWrap = ref<HTMLDivElement | null>(null)
const draggingBand = ref(-1)
const activeDrags = new Map<number, number>()

const eqEnabled = computed<boolean>({
  get: () => audioEngine.eqEnabled.value,
  set: (v) => {
    audioEngine.setEqEnabled(v)
  }
})

const eqGains = computed(() =>
  audioEngine.eqBands.value.map((b: any) =>
    eqTab.value === 'pre' ? (b.preGain ?? 0) : (b.postGain ?? 0)
  )
)

/**
 * 归一化增益数组：默认「平坦」预设的 eqBands 为空，或频段数不足时，
 * 统一按 0dB 兜底，保证曲线绘制、频点命中检测与拖拽始终一致可用
 */
const normalizedGains = () => EQ_FREQS.map((_, i) => eqGains.value[i] ?? 0)

const fmtFreq = (f: number) => audioEngine.getBandLabel(f)

function getPlotMetrics() {
  // 使用布局宽度（clientWidth）而非 getBoundingClientRect：后者会包含模态框
  // 入场 scale 动画的变换值，导致画布被按缩小后的宽度永久写死（每次打开都变小）
  const cssW =
    graphWrap.value?.clientWidth ||
    graphCanvas.value?.clientWidth ||
    300
  const padL = 38
  const padR = 12
  const padT = 14
  const padB = 26
  const plotW = cssW - padL - padR
  const plotH = GRAPH_H - padT - padB
  return { cssW, padL, padR, padT, padB, plotW, plotH, centerY: padT + plotH / 2 }
}

const xFor = (f: number, m: ReturnType<typeof getPlotMetrics>) =>
  m.padL + ((Math.log10(f) - Math.log10(F_MIN)) / (Math.log10(F_MAX) - Math.log10(F_MIN))) * m.plotW

const yFor = (db: number, m: ReturnType<typeof getPlotMetrics>) =>
  m.centerY - (db / EQ_MAX_DB) * (m.plotH / 2)

function drawGraph() {
  const canvas = graphCanvas.value
  if (!canvas || !showModal.value) return
  const m = getPlotMetrics()
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.floor(m.cssW * dpr))
  canvas.height = Math.floor(GRAPH_H * dpr)
  canvas.style.width = `${m.cssW}px`
  canvas.style.height = `${GRAPH_H}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, m.cssW, GRAPH_H)

  const grid = 'rgba(128,128,128,0.22)'
  const gridStrong = 'rgba(128,128,128,0.45)'
  const gridLight = 'rgba(128,128,128,0.10)'
  const textColor = themeVars.value.textColor3

  // 横向网格 + Y 轴刻度
  ctx.font = '10px system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let db = EQ_MIN_DB; db <= EQ_MAX_DB + 0.01; db += 5) {
    const y = yFor(db, m)
    ctx.strokeStyle = db === 0 ? gridStrong : grid
    ctx.beginPath()
    ctx.moveTo(m.padL, y)
    ctx.lineTo(m.cssW - m.padR, y)
    ctx.stroke()
    ctx.fillStyle = textColor
    ctx.fillText((db > 0 ? '+' : '') + db, m.padL - 6, y)
  }

  // 纵向网格 + X 轴频点刻度
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  EQ_FREQS.forEach((f) => {
    const x = xFor(f, m)
    ctx.strokeStyle = gridLight
    ctx.beginPath()
    ctx.moveTo(x, m.padT)
    ctx.lineTo(x, m.padT + m.plotH)
    ctx.stroke()
    ctx.fillStyle = textColor
    ctx.fillText(fmtFreq(f), x, m.padT + m.plotH + 7)
  })

  const gains = normalizedGains()
  const pts = EQ_FREQS.map((f, i) => ({ x: xFor(f, m), y: yFor(clamp(gains[i], EQ_MIN_DB, EQ_MAX_DB), m) }))
  const bottomY = m.padT + m.plotH

  // 曲线填充
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y)
  }
  ctx.strokeStyle = ACCENT.value
  ctx.lineWidth = 2.2
  ctx.stroke()
  ctx.lineTo(pts[pts.length - 1].x, bottomY)
  ctx.lineTo(pts[0].x, bottomY)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, m.padT, 0, bottomY)
  grad.addColorStop(0, accentRgba(0.3))
  grad.addColorStop(1, accentRgba(0.02))
  ctx.fillStyle = grad
  ctx.fill()

  // 频点手柄
  pts.forEach((p, i) => {
    const active = i === draggingBand.value
    ctx.beginPath()
    ctx.arc(p.x, p.y, active ? 8 : 5.5, 0, Math.PI * 2)
    ctx.fillStyle = ACCENT.value
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.stroke()

    if (active) {
      const label = fmtDbCompact(clamp(gains[i], EQ_MIN_DB, EQ_MAX_DB))
      ctx.font = '600 11px system-ui, sans-serif'
      const tw = ctx.measureText(label).width
      const bx = clamp(p.x - tw / 2 - 6, m.padL, m.cssW - m.padR - tw - 12)
      const by = p.y - 30
      ctx.fillStyle = ACCENT_DARK.value
      ctx.strokeStyle = ACCENT_DARK.value
      ctx.beginPath()
      ctx.roundRect(bx, by, tw + 12, 20, 5)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, bx + (tw + 12) / 2, by + 11)
    }
  })
}

const redraw = () => {
  if (showModal.value) drawGraph()
}

// 频段增益变化 / Tab 切换 / 拖拽状态变化时重绘
watch(
  () => audioEngine.eqBands.value.map((b: any) => `${b.preGain},${b.postGain}`).join('|'),
  redraw,
  { flush: 'post' }
)
watch([eqTab, draggingBand], redraw, { flush: 'post' })
watch(
  () => props.show,
  (v) => {
    if (v) nextTick(() => requestAnimationFrame(drawGraph))
  }
)

// ==================== EQ 曲线图交互 ====================
function getPos(e: PointerEvent) {
  const rect = graphCanvas.value!.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function handleGraphDown(e: PointerEvent) {
  if (!eqEnabled.value || !graphCanvas.value) return
  const pos = getPos(e)
  const m = getPlotMetrics()
  const gains = normalizedGains()
  let best = -1
  let bestD = 32
  EQ_FREQS.forEach((f, i) => {
    const px = xFor(f, m)
    const py = yFor(clamp(gains[i], EQ_MIN_DB, EQ_MAX_DB), m)
    const d = Math.hypot(px - pos.x, py - pos.y)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  if (best === -1) return
  graphCanvas.value.setPointerCapture(e.pointerId)
  activeDrags.set(e.pointerId, best)
  draggingBand.value = best
  applyDrag(best, pos.y)
}

function handleGraphMove(e: PointerEvent) {
  const band = activeDrags.get(e.pointerId)
  if (band === undefined) return
  applyDrag(band, getPos(e).y)
}

function handleGraphUp(e: PointerEvent) {
  activeDrags.delete(e.pointerId)
  if (activeDrags.size === 0) draggingBand.value = -1
}

function applyDrag(band: number, offsetY: number) {
  const canvas = graphCanvas.value
  if (!canvas) return
  const m = getPlotMetrics()
  const db = clamp(
    Math.round(((m.centerY - offsetY) / (m.plotH / 2)) * EQ_MAX_DB * 2) / 2,
    EQ_MIN_DB,
    EQ_MAX_DB
  )
  // 确保目标频段存在，否则 setEqBand 会因 eqBands 为空/不足而静默失败
  ensureEqBands(band)
  if (eqTab.value === 'pre') audioEngine.setEqBand(band, { preGain: db })
  else audioEngine.setEqBand(band, { postGain: db })
}

/** 补齐缺失的默认 EQ 频段（默认「平坦」预设的频段列表为空） */
function ensureEqBands(band: number) {
  const bands: any[] = audioEngine.eqBands.value
  if (bands[band]) return
  const defaults = EQ_FREQS.map((f, i) => ({
    frequency: f,
    preGain: 0,
    postGain: 0,
    preQ: 1,
    postQ: 1,
    bandType: i === 0 ? 'lowShelf' : i === EQ_FREQS.length - 1 ? 'highShelf' : 'peaking'
  }))
  audioEngine.eqBands.value = EQ_FREQS.map((_, i) => bands[i] ?? defaults[i])
}

// ==================== EQ 强度 ====================
const eqStrengthMode = ref<'overall' | 'segmented'>('overall')
const eqStrength = ref(100)
let eqStrengthPrev = 100

function handleEqStrengthChange(v: number) {
  const ratio = eqStrengthPrev === 0 ? v / 100 : v / eqStrengthPrev
  eqStrengthPrev = v
  eqStrength.value = v
  const gains = audioEngine.eqBands.value.map((b: any) =>
    clamp(Math.round((b.preGain ?? 0) * ratio * 2) / 2, EQ_MIN_DB, EQ_MAX_DB)
  )
  audioEngine.setEqGains(gains)
}

// ==================== 等响度 ====================
const loudnessEnabled = computed<boolean>({
  get: () => audioEngine.loudness.value.enabled,
  set: (v) => {
    audioEngine.setLoudnessEnabled(v)
  }
})
const loudnessGain = ref(0)
const loudnessStatus = computed(
  () => `等响度${loudnessEnabled.value ? '开' : '关'}: ${fmtDbCompact(loudnessGain.value)}`
)

function handleLoudnessGain(v: number) {
  const wasEnabled = audioEngine.loudness.value.enabled
  loudnessGain.value = v
  if (v !== 0 && wasEnabled) {
    audioEngine.setLoudnessEnabled(false)
    message.info('调节增益后等响度已自动关闭')
  }
}

// ==================== 等响补偿（因逻辑冲突默认禁用） ====================
const loudnessCompEnabled = ref(false)
const loudnessCompDiff = computed(() =>
  Math.max(0, Math.round((1 - (audioEngine.state.volume ?? 1)) * 100))
)
const loudnessCompStrength = computed(() =>
  Math.round(audioEngine.loudness.value.compensation * 300) / 100
)
const loudnessCompThreshold = computed(() =>
  clamp(audioEngine.loudness.value.referenceLoudness, -30, -1)
)
const loudnessCompStatus = computed(
  () => `补偿中: +${loudnessCompDiff.value}% x ${loudnessCompStrength.value.toFixed(2)}`
)
const loudnessCompHint = computed(
  () => `当前系统音量比基准低 ${loudnessCompDiff.value}%，正在增强高低频`
)

/** 设定基准：将当前系统音量换算为参考响度并写入补偿阈值 */
const handleSetLoudnessBaseline = () => {
  const vol = clamp(audioEngine.state.volume ?? 1, 0.01, 1)
  // 音量 → dB 换算（20 * log10(vol)），并钳制到阈值范围 [-30, -1]
  const refDb = Math.round(20 * Math.log10(vol))
  const ref = clamp(refDb, -30, -1)
  audioEngine.setLoudnessParams({ referenceLoudness: ref })
  message.success(`已设定基准：补偿阈值为 ${Math.abs(ref)} dB`)
}

// ==================== 多频段压缩 MBC ====================
const mbcEnabled = computed<boolean>({
  get: () => audioEngine.compressorEnabled.value,
  set: (v) => {
    audioEngine.setCompressorEnabled(v)
  }
})
const mbcBands = ref(2)
const mbcExpanded = ref(false)
const mbcStatus = computed(() => `${mbcBands.value}段: ${audioEngine.compressor.value.ratio.toFixed(1)}:1`)

const mbcParams = computed(() => [
  {
    key: 'attack',
    label: '启动时间',
    min: 1,
    max: 100,
    step: 1,
    value: audioEngine.compressor.value.attack,
    fmt: (v: number) => `${v} ms`,
    set: (v: number) => audioEngine.setCompressorParams({ attack: v })
  },
  {
    key: 'release',
    label: '释放时间',
    min: 10,
    max: 1000,
    step: 1,
    value: audioEngine.compressor.value.release,
    fmt: (v: number) => `${v} ms`,
    set: (v: number) => audioEngine.setCompressorParams({ release: v })
  },
  {
    key: 'ratio',
    label: '压缩比',
    min: 1,
    max: 20,
    step: 0.5,
    value: audioEngine.compressor.value.ratio,
    fmt: (v: number) => `${v.toFixed(1)}:1`,
    set: (v: number) => audioEngine.setCompressorParams({ ratio: v })
  },
  {
    key: 'threshold',
    label: '阈值',
    min: -60,
    max: 0,
    step: 1,
    value: audioEngine.compressor.value.threshold,
    fmt: (v: number) => `${v} dB`,
    set: (v: number) => audioEngine.setCompressorParams({ threshold: v })
  }
])

// ==================== 限幅器 ====================
const limiterEnabled = computed<boolean>({
  get: () => audioEngine.limiterEnabled.value,
  set: (v) => {
    audioEngine.setLimiterEnabled(v)
  }
})
const limiterExpanded = ref(false)
// 引擎暂未提供的参数，作为界面参数保存
const limiterAttack = ref(5)
const limiterRatio = ref(10)
const limiterThreshold = ref(-6)
const limiterPostGain = ref(0)
const limiterStatus = computed(() => `${limiterThreshold.value} dB : ${limiterRatio.value}:1`)

const limiterParams = computed(() => [
  {
    key: 'attack',
    label: '启动时间',
    min: 1,
    max: 100,
    step: 1,
    value: limiterAttack.value,
    fmt: (v: number) => `${v} ms`,
    set: (v: number) => (limiterAttack.value = v)
  },
  {
    key: 'release',
    label: '释放时间',
    min: 10,
    max: 500,
    step: 1,
    value: audioEngine.limiter.value.release,
    fmt: (v: number) => `${v} ms`,
    set: (v: number) => audioEngine.setLimiterParams({ release: v })
  },
  {
    key: 'ratio',
    label: '限幅比',
    min: 1,
    max: 20,
    step: 1,
    value: limiterRatio.value,
    fmt: (v: number) => `${v}:1`,
    set: (v: number) => (limiterRatio.value = v)
  },
  {
    key: 'threshold',
    label: '阈值',
    min: -12,
    max: 0,
    step: 1,
    value: limiterThreshold.value,
    fmt: (v: number) => `${v} dB`,
    set: (v: number) => (limiterThreshold.value = v)
  },
  {
    key: 'postGain',
    label: '后增益',
    min: -6,
    max: 6,
    step: 0.5,
    value: limiterPostGain.value,
    fmt: (v: number) => fmtDb(v),
    set: (v: number) => (limiterPostGain.value = v)
  }
])

// ==================== 声道平衡 ====================
const balanceEnabled = ref(false)
const balanceExpanded = ref(false)
const balanceL = ref(-0.1)
const balanceR = ref(-0.1)
const balanceStatus = computed(() => (balanceEnabled.value ? '已开启' : '已关闭'))

// ==================== 音量记忆 ====================
const volumeMemoryEnabled = ref(false)

// ==================== 界面状态持久化 ====================
const UI_STORAGE_KEY = 'sound-effects-ui'
function loadUiState() {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY)
    if (!raw) return
    const d = JSON.parse(raw)
    if (typeof d.balanceEnabled === 'boolean') balanceEnabled.value = d.balanceEnabled
    if (typeof d.balanceL === 'number') balanceL.value = d.balanceL
    if (typeof d.balanceR === 'number') balanceR.value = d.balanceR
    if (typeof d.volumeMemory === 'boolean') volumeMemoryEnabled.value = d.volumeMemory
    if (typeof d.loudnessComp === 'boolean') loudnessCompEnabled.value = d.loudnessComp
  } catch {
    /* ignore */
  }
}
let uiSaveTimer: ReturnType<typeof setTimeout> | null = null
function saveUiState() {
  if (uiSaveTimer) clearTimeout(uiSaveTimer)
  uiSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        UI_STORAGE_KEY,
        JSON.stringify({
          balanceEnabled: balanceEnabled.value,
          balanceL: balanceL.value,
          balanceR: balanceR.value,
          volumeMemory: volumeMemoryEnabled.value,
          loudnessComp: loudnessCompEnabled.value
        })
      )
    } catch {
      /* ignore */
    }
  }, 300)
}
watch(
  [balanceEnabled, balanceL, balanceR, volumeMemoryEnabled, loudnessCompEnabled],
  saveUiState
)

// ==================== 底部控制栏 ====================
const handleFooterSettings = () => {
  message.info('更多输出设置请在系统「声音」中调整')
}

// ==================== 生命周期 ====================
let resizeObserver: ResizeObserver | null = null
const handleResize = () => {
  if (showModal.value) drawGraph()
}

onMounted(() => {
  loadUiState()
  audioEngine.initialize()
  if (graphWrap.value) {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(graphWrap.value)
  }
  window.addEventListener('resize', handleResize)
  nextTick(() => requestAnimationFrame(drawGraph))
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', handleResize)
  audioEngine.destroy()
})
</script>

<script lang="ts">
export default {
  name: 'SoundEffectsModal'
}
</script>

<template>
  <n-modal
    v-model:show="showModal"
    :mask-closable="true"
    :close-on-esc="true"
    display-directive="show"
  >
    <div class="se-modal" :style="{ '--se-modal-bg': themeVars.modalColor }">
      <!-- 顶部导航 -->
      <header class="se-header">
        <n-button quaternary circle title="返回" @click="showModal = false">
          <template #icon>
            <n-icon size="20"><i class="mgc_arrow_left_line"></i></n-icon>
          </template>
        </n-button>
        <h1 class="se-title">Stack Sound</h1>
        <n-button quaternary circle title="刷新/重置" @click="handleReset">
          <template #icon>
            <n-icon size="19"><i class="mgc_refresh_2_line"></i></n-icon>
          </template>
        </n-button>
      </header>

      <!-- 当前预设区 -->
      <div class="se-preset">
        <div class="se-preset-info">
          <div class="se-preset-line">
            <i class="mgc_speaker_line se-preset-speaker"></i>
            <span class="se-preset-device">{{ deviceName }}</span>
          </div>
          <n-select
            v-model:value="selectedPresetId"
            :options="presetOptions"
            size="small"
            class="se-preset-select"
            @update:value="handlePresetChange"
          />
        </div>

        <div class="se-preset-actions">
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button quaternary circle @click="handleCopyPreset">
                <template #icon>
                  <n-icon size="18"><i class="mgc_copy_2_line"></i></n-icon>
                </template>
              </n-button>
            </template>
            复制当前预设
          </n-tooltip>

          <n-button type="primary" secondary @click="handleGoToSound">去 Sound 里寻觅</n-button>

          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button quaternary circle @click="handleSharePreset">
                <template #icon>
                  <n-icon size="18"><i class="mgc_share_2_line"></i></n-icon>
                </template>
              </n-button>
            </template>
            分享预设数据
          </n-tooltip>
        </div>
      </div>

      <!-- 内容区 -->
      <n-scrollbar class="se-scroll">
        <div class="se-body">
          <!-- EQ 均衡器曲线图 -->
          <section class="se-section">
            <div class="se-eq-tabs">
              <n-radio-group v-model:value="eqTab" size="small">
                <n-radio-button value="post">原EQ</n-radio-button>
                <n-radio-button value="pre">预EQ</n-radio-button>
              </n-radio-group>
            </div>
            <div ref="graphWrap" class="se-graph-wrap">
              <canvas
                ref="graphCanvas"
                class="se-graph"
                :class="{ dimmed: !eqEnabled }"
                @pointerdown="handleGraphDown"
                @pointermove="handleGraphMove"
                @pointerup="handleGraphUp"
                @pointercancel="handleGraphUp"
              ></canvas>
              <div v-if="!eqEnabled" class="se-graph-mask">均衡器已关闭</div>
            </div>
          </section>

          <!-- EQ 强度 -->
          <section class="se-section" :class="{ disabled: !eqEnabled }">
            <header class="se-sec-head">
              <span class="se-sec-title">EQ 强度</span>
              <span class="se-sec-status">{{ eqEnabled ? '已开启' : '已关闭' }}</span>
              <n-switch v-model:value="eqEnabled" size="small" />
            </header>

            <div class="se-mode-toggle">
              <n-radio-group v-model:value="eqStrengthMode" size="small">
                <n-radio-button value="overall">整体控制</n-radio-button>
                <n-radio-button value="segmented">分段控制</n-radio-button>
              </n-radio-group>
            </div>

            <div v-if="eqStrengthMode === 'overall'" class="se-slider-row">
              <span class="se-slider-label">整体强度</span>
              <n-slider
                :value="eqStrength"
                :min="0"
                :max="100"
                :step="1"
                :tooltip="false"
                :disabled="!eqEnabled"
                @update:value="handleEqStrengthChange"
              />
              <span class="se-slider-val">{{ eqStrength }}%</span>
            </div>
            <p v-else class="se-hint">在曲线上直接拖动频点，可单独调节每个频段。</p>
          </section>

          <!-- 等响度 -->
          <section class="se-section">
            <header class="se-sec-head">
              <span class="se-sec-title">等响度</span>
              <span class="se-sec-status">{{ loudnessStatus }}</span>
              <n-switch v-model:value="loudnessEnabled" size="small" />
            </header>
            <div class="se-slider-row">
              <span class="se-slider-label">整体增益</span>
              <n-slider
                :value="loudnessGain"
                :min="-12"
                :max="12"
                :step="0.5"
                :tooltip="false"
                @update:value="handleLoudnessGain"
              />
              <span class="se-slider-val">{{ fmtDb(loudnessGain) }}</span>
            </div>
            <p class="se-note">调节此滑条会自动关闭等响度。</p>
          </section>

          <!-- 等响补偿 -->
          <section class="se-section">
            <header class="se-sec-head">
              <span class="se-sec-title">等响补偿</span>
              <span class="se-sec-status">{{ loudnessCompStatus }}</span>
              <n-switch v-model:value="loudnessCompEnabled" size="small" />
            </header>

            <div class="se-comp-body" :class="{ 'is-disabled': loudnessCompEnabled }">
              <div class="se-slider-row">
                <span class="se-slider-label">补偿强度</span>
                <n-slider
                  :value="loudnessCompStrength"
                  :min="0"
                  :max="3"
                  :step="0.05"
                  :tooltip="false"
                  @update:value="
                    (v: any) => audioEngine.setLoudnessParams({ compensation: Math.round(v / 3 * 100) / 100 })
                  "
                />
                <span class="se-slider-val">{{ loudnessCompStrength.toFixed(2) }}</span>
              </div>

              <div class="se-slider-row">
                <span class="se-slider-label">补偿阈值</span>
                <n-slider
                  :value="loudnessCompThreshold"
                  :min="-30"
                  :max="-1"
                  :step="1"
                  :tooltip="false"
                  @update:value="
                    (v: any) => audioEngine.setLoudnessParams({ referenceLoudness: v })
                  "
                />
                <span class="se-slider-val">{{ Math.abs(loudnessCompThreshold).toFixed(1) }} dB</span>
              </div>
              <div class="se-comp-actions">
                <n-button
                  size="small"
                  secondary
                  @click="handleSetLoudnessBaseline"
                >
                  <template #icon>
                    <n-icon size="16"><i class="mgc_target_line"></i></n-icon>
                  </template>
                  设定基准（按当前音量）
                </n-button>
              </div>
              <p class="se-note">音量低于该阈值时才开始增强高低频，数值越大（越接近 -1 dB）越早介入。</p>

              <div v-if="loudnessCompEnabled" class="se-comp-mask">
                <span>关闭等响补偿后才能设定基准</span>
              </div>
            </div>

            <p v-if="loudnessCompEnabled" class="se-hint">{{ loudnessCompHint }}</p>
          </section>

          <!-- 多频段压缩 MBC -->
          <section class="se-section">
            <header class="se-sec-head">
              <span class="se-sec-title">多频段压缩 <em>(MBC)</em></span>
              <span class="se-sec-status">{{ mbcStatus }}</span>
              <n-switch v-model:value="mbcEnabled" size="small" />
            </header>
            <p class="se-desc">对不同频段应用独立的动态压缩。</p>

            <n-collapse
              v-if="mbcEnabled"
              class="se-collapse"
              :expanded-names="mbcExpanded ? ['mbc'] : []"
              @update:expanded-names="(names: any) => (mbcExpanded = (names || []).includes('mbc'))"
            >
              <n-collapse-item title="折叠选项" name="mbc">
                <div class="se-params">
                  <div class="se-param">
                    <div class="se-param-head">
                      <span class="se-slider-label">频段数量</span>
                      <n-select
                        :value="mbcBands"
                        :options="[
                          { label: '2 段', value: 2 },
                          { label: '3 段', value: 3 },
                          { label: '4 段', value: 4 }
                        ]"
                        size="small"
                        style="width: 110px"
                        @update:value="(v: any) => (mbcBands = v)"
                      />
                    </div>
                  </div>
                  <div v-for="p in mbcParams" :key="p.key" class="se-param">
                    <div class="se-param-head">
                      <span class="se-slider-label">{{ p.label }}</span>
                      <span class="se-param-value">{{ p.fmt(p.value) }}</span>
                    </div>
                    <n-slider
                      :value="p.value"
                      :min="p.min"
                      :max="p.max"
                      :step="p.step"
                      :tooltip="false"
                      @update:value="p.set"
                    />
                  </div>
                </div>
              </n-collapse-item>
            </n-collapse>

            <p class="se-note se-note-warn">注意: 调整此项需要完全重载音效，会产生噪音。</p>
          </section>

          <!-- 限幅器 -->
          <section class="se-section">
            <header class="se-sec-head">
              <span class="se-sec-title">限幅器 <em>(Limiter)</em></span>
              <span class="se-sec-status">{{ limiterStatus }}</span>
              <n-switch v-model:value="limiterEnabled" size="small" />
            </header>

            <n-collapse
              v-if="limiterEnabled"
              class="se-collapse"
              :expanded-names="limiterExpanded ? ['limiter'] : []"
              @update:expanded-names="(names: any) => (limiterExpanded = (names || []).includes('limiter'))"
            >
              <n-collapse-item title="折叠选项" name="limiter">
                <div class="se-params">
                  <div v-for="p in limiterParams" :key="p.key" class="se-param">
                    <div class="se-param-head">
                      <span class="se-slider-label">{{ p.label }}</span>
                      <span class="se-param-value">{{ p.fmt(p.value) }}</span>
                    </div>
                    <n-slider
                      :value="p.value"
                      :min="p.min"
                      :max="p.max"
                      :step="p.step"
                      :tooltip="false"
                      @update:value="p.set"
                    />
                  </div>
                </div>
              </n-collapse-item>
            </n-collapse>
          </section>

          <!-- 声道平衡 -->
          <section class="se-section">
            <header class="se-sec-head">
              <span class="se-sec-title">声道平衡</span>
              <span class="se-sec-status">{{ balanceStatus }}</span>
              <n-switch v-model:value="balanceEnabled" size="small" />
            </header>

            <n-collapse
              class="se-collapse"
              :class="{ 'is-disabled': !balanceEnabled }"
              :expanded-names="balanceExpanded ? ['balance'] : []"
              @update:expanded-names="(names: any) => (balanceExpanded = (names || []).includes('balance'))"
            >
              <n-collapse-item title="折叠选项" name="balance">
                <div class="se-params">
                  <div class="se-param">
                    <div class="se-param-head">
                      <span class="se-slider-label">左声道 (L)</span>
                      <span class="se-param-value">{{ fmtDb(balanceL) }}</span>
                    </div>
                    <n-slider
                      :value="balanceL"
                      :min="-6"
                      :max="6"
                      :step="0.1"
                      :tooltip="false"
                      @update:value="(v: any) => (balanceL = v)"
                    />
                  </div>
                  <div class="se-param">
                    <div class="se-param-head">
                      <span class="se-slider-label">右声道 (R)</span>
                      <span class="se-param-value">{{ fmtDb(balanceR) }}</span>
                    </div>
                    <n-slider
                      :value="balanceR"
                      :min="-6"
                      :max="6"
                      :step="0.1"
                      :tooltip="false"
                      @update:value="(v: any) => (balanceR = v)"
                    />
                  </div>
                </div>
              </n-collapse-item>
            </n-collapse>
          </section>

          <!-- 音量记忆 -->
          <section class="se-section">
            <header class="se-sec-head">
              <span class="se-sec-title">音量记忆</span>
              <span class="se-sec-status">{{ volumeMemoryEnabled ? '已启用' : '已禁用' }}</span>
              <n-switch v-model:value="volumeMemoryEnabled" size="small" />
            </header>
            <p class="se-desc">自动记忆/关闭 Such Music 时的系统音量。</p>
          </section>
        </div>
      </n-scrollbar>

      <!-- 底部操作栏 -->
      <footer class="se-footer">
        <div class="se-footer-group">
          <n-button quaternary circle title="设置" @click="handleFooterSettings">
            <template #icon>
              <n-icon size="20"><i class="mgc_settings_3_line"></i></n-icon>
            </template>
          </n-button>
          <n-button quaternary circle title="刷新/重置" @click="handleReset">
            <template #icon>
              <n-icon size="20"><i class="mgc_refresh_2_line"></i></n-icon>
            </template>
          </n-button>
        </div>
      </footer>
    </div>
  </n-modal>
</template>

<style lang="scss" scoped>
.se-modal {
  display: flex;
  flex-direction: column;
  width: 880px;
  max-width: calc(100vw - 96px);
  height: 80vh;
  border-radius: 12px;
  overflow: hidden;
  --se-modal-bg: #1e1e24;
  background: var(--se-modal-bg);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.15));
  color: var(--n-text-color);

  // ===== 顶部导航 =====
  .se-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    padding: 14px 18px 10px;

    .se-title {
      margin: 0;
      font-size: 19px;
      font-weight: 700;
      letter-spacing: 0.4px;
      background: linear-gradient(135deg, v-bind('themeVars.primaryColor'), v-bind('themeVars.primaryColorPressed'));
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
    }
  }

  // ===== 预设区 =====
  .se-preset {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-shrink: 0;
    padding: 6px 18px 14px;
    border-bottom: 1px solid var(--n-divider-color, rgba(128, 128, 128, 0.12));

    .se-preset-info {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
      min-width: 240px;
      max-width: 320px;

      .se-preset-line {
        display: flex;
        align-items: center;
        gap: 6px;

        .se-preset-speaker {
          font-size: 15px;
          color: v-bind('themeVars.primaryColor');
        }

        .se-preset-device {
          font-size: 13px;
          font-weight: 600;
          color: var(--n-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      }

      .se-preset-select {
        width: 100%;
      }
    }

    .se-preset-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
  }

  // ===== 内容区 =====
  .se-scroll {
    flex: 1;
    min-height: 0;
  }

  .se-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px 18px 20px;
  }

  .se-section {
    padding: 14px 16px;
    border-radius: 14px;
    background: var(--n-card-color, rgba(128, 128, 128, 0.05));
    border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.12));
    transition: opacity 0.2s;

    &.disabled {
      opacity: 0.6;
    }

    .se-sec-head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;

      .se-sec-title {
        font-size: 15px;
        font-weight: 600;
        color: var(--n-text-color);

        em {
          font-style: normal;
          font-size: 12px;
          color: var(--n-text-color-3);
          font-weight: 400;
        }
      }

      .se-sec-status {
        margin-left: auto;
        font-size: 12px;
        color: var(--n-text-color-3);
      }
    }

    .se-desc {
      margin: 0 0 6px;
      font-size: 13px;
      color: var(--n-text-color-2);
    }

    .se-hint {
      margin: 8px 0 0;
      font-size: 12px;
      color: var(--n-text-color-3);
    }

    .se-note {
      margin: 8px 0 0;
      font-size: 12px;
      color: var(--n-text-color-3);

      &.se-note-warn {
        color: #f59e0b;
      }
    }
  }

  // EQ Tab + 曲线图
  .se-eq-tabs {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
  }

  .se-graph-wrap {
    position: relative;
    border-radius: 10px;
    overflow: hidden;

    .se-graph {
      display: block;
      width: 100%;
      height: 220px;
      cursor: grab;
      touch-action: none;

      &.dimmed {
        opacity: 0.4;
        pointer-events: none;
      }
    }

    .se-graph-mask {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      color: var(--n-text-color-3);
      background: color-mix(in srgb, var(--se-modal-bg) 76%, transparent);
    }
  }

  // 模式切换
  .se-mode-toggle {
    display: flex;
    gap: 6px;
    margin-bottom: 12px;
  }

  // 滑块行
  .se-slider-row {
    display: grid;
    grid-template-columns: 76px 1fr 92px;
    align-items: center;
    gap: 12px;

    .se-slider-label {
      font-size: 13px;
      color: var(--n-text-color-2);
    }

    .se-slider-val {
      font-size: 13px;
      font-weight: 600;
      color: var(--n-text-color);
      text-align: right;
    }

    & + .se-slider-row {
      margin-top: 14px;
    }
  }

  // 等响补偿
  .se-comp-body {
    position: relative;

    &.is-disabled {
      .se-slider-row {
        opacity: 0.4;
      }
    }

    .se-comp-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 12px;
    }

    .se-comp-mask {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      font-size: 13px;
      color: var(--n-text-color-3);
      background: var(--n-fill-color, rgba(128, 128, 128, 0.28));
      z-index: 2;
    }
  }

  // 折叠区
  .se-collapse {
    &.is-disabled {
      opacity: 0.4;
      pointer-events: none;
    }

    .se-params {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 2px 4px 6px;
    }
  }

  .se-param {
    .se-param-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;

      .se-slider-label {
        font-size: 13px;
        color: var(--n-text-color-2);
      }

      .se-param-value {
        font-size: 13px;
        font-weight: 600;
        color: var(--n-text-color);
      }
    }
  }

  // ===== 底部控制栏 =====
  .se-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-shrink: 0;
    padding: 10px 18px;
    border-top: 1px solid var(--n-divider-color, rgba(128, 128, 128, 0.12));

    .se-footer-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }
  }
}

// 滚动条美化
.se-scroll {
  :deep(.n-scrollbar-rail) {
    right: 2px;
    width: 4px;
  }

  :deep(.n-scrollbar-rail__scrollbar) {
    width: 4px;
    border-radius: 2px;
    background-color: rgba(128, 128, 128, 0.25);
  }
}
</style>
