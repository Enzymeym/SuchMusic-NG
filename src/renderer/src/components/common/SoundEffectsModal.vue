<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import {
  NModal,
  NSwitch,
  NTag,
  NSlider,
  NIcon,
  NTooltip,
  NScrollbar,
  NSelect,
  NButton,
  NInput,
  NPopconfirm,
  NCollapse,
  NCollapseItem,
  useThemeVars,
  useMessage
} from 'naive-ui'
import { useAudioEngine } from '../../composables/useAudioEngine'
import { useDynamicEq } from '../../composables/useDynamicEq'
import { useSystemVolume } from '../../composables/useSystemVolume'
import { DYNAMIC_EQ_SHAPE_LABELS, type DynamicEqShape } from '../../audio/dynamic-eq'
import {
  computeVirtualBassDrive,
  getStrengthPreset
} from '../../audio/virtual-bass-presets'
import { isWasapiExclusiveMode } from '../../utils/audioOutputModeManager'
import {
  computeEqLoudnessDb,
  LOUDNESS_COMP_MIN_DB,
  LOUDNESS_COMP_MAX_DB
} from '../../audio/web-audio-dsp'
import { useSettingsStore } from '../../stores/settingsStore'
import { usePlayerStore } from '../../stores/playerStore'

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
const playerStore = usePlayerStore()

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
const selectedPresetId = ref(audioEngine.currentPresetId.value || 'flat')
watch(
  () => audioEngine.currentPresetId.value,
  (val) => {
    selectedPresetId.value = val
    // 切换预设后：以新预设曲线为基准，整体强度回归 100%
    captureBaseEqGains()
    eqStrength.value = 100
  }
)

/**
 * 预设列表（内置 + 自定义），供 EQ 卡片内的标签选择器使用。
 * 选择器已从顶部区域下移到均衡曲线下方：预设本质就是一条 EQ 曲线，
 * 与曲线放在一起才符合「选曲线 → 看形状 → 再微调」的操作顺序。
 */
const presetList = computed<any[]>(() => audioEngine.presets.value || [])

/** 「保存为预设」行内编辑状态 */
const savePresetOpen = ref(false)
const presetNameDraft = ref('')
const presetInputRef = ref<any>(null)

/** 生成一个不重名的默认预设名（自定义 1 / 自定义 2 …） */
const nextCustomPresetName = () => {
  const used = presetList.value.filter((p) => !p.builtin).map((p) => p.name as string)
  let n = used.length + 1
  while (used.includes(`自定义 ${n}`)) n++
  return `自定义 ${n}`
}

function openSavePreset() {
  if (presetsLocked.value) {
    message.warning('动态 EQ 开启时无法保存预设，请先关闭动态 EQ')
    return
  }
  presetNameDraft.value = nextCustomPresetName()
  savePresetOpen.value = true
  nextTick(() => presetInputRef.value?.focus?.())
}

function closeSavePreset() {
  savePresetOpen.value = false
}

/**
 * 预设是否被锁定：动态 EQ 开启时不允许切换/保存预设。
 * 动态 EQ 会在 EQ 增益上叠加实时修正，此时换预设会让曲线被两边同时改写，
 * 用户看到的是「选了预设但曲线不是预设的样子」。
 */
const presetsLocked = computed<boolean>(() => dynamicEqEnabled.value)

/** 把当前手动调节的曲线（含各频段增益之外的音效参数）存为自定义预设 */
async function confirmSavePreset() {
  if (presetsLocked.value) {
    message.warning('动态 EQ 开启时无法保存预设，请先关闭动态 EQ')
    return
  }
  const name = presetNameDraft.value.trim()
  if (!name) {
    message.warning('请先输入预设名称')
    return
  }
  await audioEngine.saveCurrentAsPreset(name)
  savePresetOpen.value = false
  message.success(`已保存为预设「${name}」`)
}

/** 删除自定义预设（内置预设不可删） */
function handleDeletePreset(presetId: string) {
  const target = presetList.value.find((p) => p.id === presetId)
  if (!target || target.builtin) return
  audioEngine.deletePreset(presetId)
  message.success(`已删除预设「${target.name}」`)
}

const isWebAudioOutput = computed(() => settingsStore.playback.audioOutputMode === 'webaudio')

/**
 * 输出设备名。Web Audio 模式下明确显示为系统默认输出，
 * 避免与预设名（如「平坦」）混淆——用户曾误以为默认设备叫「平坦」。
 */
const deviceName = computed(() => {
  if (isWebAudioOutput.value) return '系统默认输出（Web Audio）'
  return settingsStore.playback.audioOutputDeviceName || '默认输出设备'
})

const handlePresetChange = (presetId: string) => {
  savePresetOpen.value = false
  if (presetsLocked.value) {
    message.warning('动态 EQ 开启时无法切换预设，请先关闭动态 EQ')
    return
  }
  // 再次点击当前预设 = 把曲线还原成该预设（丢弃这次的手动调整）
  const same = presetId === audioEngine.currentPresetId.value
  if (same && !presetModified.value) return
  audioEngine.applyPreset(presetId)
  // 以新预设曲线为基准，强度复位
  captureBaseEqGains()
  eqStrength.value = 100
}

/** 重置为默认（平坦）设置 */
const handleReset = () => {
  audioEngine.applyPreset('flat')
  captureBaseEqGains()
  eqStrength.value = 100
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

/** 打开设置页的「播放」分区（输出模式 / 输出设备等） */
const openPlaybackSettings = () => {
  showModal.value = false
  window.dispatchEvent(new CustomEvent('open-settings', { detail: { section: 'playback' } }))
}

const handleGoToSound = () => {
  openPlaybackSettings()
}

// ==================== EQ 曲线图 ====================
// 已统一为参数均衡器（EQ）：不再区分「原EQ（post）/预EQ（pre）」，
// 每个频段只有一个增益（沿用引擎的 preGain 字段），直接在曲线上拖动调节。
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const EQ_MIN_DB = -10
const EQ_MAX_DB = 10
/** 纵向可扩展上限：低音量补偿叠加后曲线可能超过 +10dB */
const EQ_PLOT_MAX_DB = 24
const GRAPH_H = 220
const F_MIN = 20
const F_MAX = 20000

const graphCanvas = ref<HTMLCanvasElement | null>(null)
const graphWrap = ref<HTMLDivElement | null>(null)
const draggingBand = ref(-1)
/** 拖拽期间冻结的纵轴上限，避免拖动时刻度跳变 */
let dragTopDb = EQ_MAX_DB
const activeDrags = new Map<number, number>()

const eqEnabled = computed<boolean>({
  get: () => audioEngine.eqEnabled.value,
  set: (v) => {
    audioEngine.setEqEnabled(v)
  }
})

/** EQ 各频段增益（dB），直接映射引擎频段的 preGain */
const eqGains = computed(() => audioEngine.eqBands.value.map((b: any) => b.preGain ?? 0))

/**
 * 归一化增益数组：默认「平坦」预设的 eqBands 为空，或频段数不足时，
 * 统一按 0dB 兜底，保证曲线绘制、频点命中检测与拖拽始终一致可用
 */
const normalizedGains = () => EQ_FREQS.map((_, i) => eqGains.value[i] ?? 0)

/** 当前预设自身的曲线（用于判断是否被手动改过 / 改过多少） */
const presetOwnGains = computed<number[]>(() => {
  const p = presetList.value.find((x) => x.id === audioEngine.currentPresetId.value)
  if (!p?.eqBands) return EQ_FREQS.map(() => 0)
  return EQ_FREQS.map((_, i) => clamp(p.eqBands[i]?.preGain ?? 0, EQ_MIN_DB, EQ_MAX_DB))
})

/**
 * 曲线是否已偏离当前预设：拖动频点、调整强度都会让实际增益与预设值不一致，
 * 此时标签栏下方提示「可存为新预设」，避免用户以为改动已经写进预设。
 */
const presetModified = computed(() =>
  normalizedGains().some((g, i) => Math.abs(g - (presetOwnGains.value[i] ?? 0)) > 0.05)
)

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
  return { cssW, padL, padR, padT, padB, plotW, plotH }
}

const xFor = (f: number, m: ReturnType<typeof getPlotMetrics>) =>
  m.padL + ((Math.log10(f) - Math.log10(F_MIN)) / (Math.log10(F_MAX) - Math.log10(F_MIN))) * m.plotW

/**
 * 曲线纵向上限（dB）：补偿后的曲线可能超过 +10dB，此时自动抬升上限，
 * 保证叠加曲线完整可见（参考线仍以 0dB 为基准，逐 5dB 重算刻度）。
 * 拖拽期间冻结当前上限，避免拖动过程中刻度反复跳变。
 */
const liveTopDb = computed(() => {
  if (!showCompCurve.value) return EQ_MAX_DB
  const gains = normalizedGains()
  let peak = EQ_MAX_DB
  EQ_FREQS.forEach((f, i) => {
    peak = Math.max(peak, clamp(gains[i] ?? 0, EQ_MIN_DB, EQ_MAX_DB) + followCompDbAt(f))
  })
  return Math.min(EQ_PLOT_MAX_DB, Math.ceil((peak + 0.6) / 5) * 5)
})

const graphTopDb = computed(() => (draggingBand.value >= 0 ? dragTopDb : liveTopDb.value))

const yFor = (db: number, m: ReturnType<typeof getPlotMetrics>) =>
  m.padT + ((graphTopDb.value - db) / (graphTopDb.value - EQ_MIN_DB)) * m.plotH

const dbForY = (y: number, m: ReturnType<typeof getPlotMetrics>) =>
  graphTopDb.value - ((y - m.padT) / m.plotH) * (graphTopDb.value - EQ_MIN_DB)

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

  // 横向网格 + Y 轴刻度（上限随低音量补偿动态抬升）
  const topDb = graphTopDb.value
  ctx.font = '10px system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let db = EQ_MIN_DB; db <= topDb + 0.01; db += 5) {
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
  // 基准频点（用户拖动调节的就是这些点）
  const eqPts = EQ_FREQS.map((f, i) => ({
    x: xFor(f, m),
    y: yFor(clamp(gains[i], EQ_MIN_DB, EQ_MAX_DB), m)
  }))
  // 叠加低音量补偿后的频响：低频（200Hz 低架）/ 高频（8kHz 高架）按当前音量缺口抬升
  const compActive = showCompCurve.value
  const pts = compActive
    ? EQ_FREQS.map((f, i) => ({
        x: xFor(f, m),
        y: yFor(clamp(gains[i] + followCompDbAt(f), EQ_MIN_DB, topDb), m)
      }))
    : eqPts
  const bottomY = m.padT + m.plotH

  /** 用 Catmull-Rom 转三次贝塞尔描出一条平滑曲线路径（不描边/填充） */
  const traceCurve = (list: { x: number; y: number }[]) => {
    ctx.beginPath()
    ctx.moveTo(list[0].x, list[0].y)
    for (let i = 0; i < list.length - 1; i++) {
      const p0 = list[Math.max(0, i - 1)]
      const p1 = list[i]
      const p2 = list[i + 1]
      const p3 = list[Math.min(list.length - 1, i + 2)]
      const c1x = p1.x + (p2.x - p0.x) / 6
      const c1y = p1.y + (p2.y - p0.y) / 6
      const c2x = p2.x - (p3.x - p1.x) / 6
      const c2y = p2.y - (p3.y - p1.y) / 6
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y)
    }
  }

  // 1) 补偿开启时，原 EQ 曲线只淡化颜色（实线），作为基准参考
  if (compActive) {
    traceCurve(eqPts)
    ctx.strokeStyle = accentRgba(0.32)
    ctx.lineWidth = 1.6
    ctx.stroke()
  }

  // 2) 主曲线：当前实际生效的频响（未开补偿时即原曲线）
  traceCurve(pts)
  ctx.strokeStyle = ACCENT.value
  ctx.lineWidth = 2.2
  ctx.stroke()
  ctx.lineTo(pts[pts.length - 1].x, bottomY)
  ctx.lineTo(pts[0].x, bottomY)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, m.padT, 0, bottomY)
  grad.addColorStop(0, accentRgba(compActive ? 0.22 : 0.3))
  grad.addColorStop(1, accentRgba(0.02))
  ctx.fillStyle = grad
  ctx.fill()

  // 频点手柄（始终落在 EQ 基准曲线上，拖动改变的是 EQ 增益）
  eqPts.forEach((p, i) => {
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
watch(draggingBand, redraw, { flush: 'post' })
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
  dragTopDb = graphTopDb.value
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
  const db = clamp(Math.round(dbForY(offsetY, m) * 2) / 2, EQ_MIN_DB, EQ_MAX_DB)
  // 确保目标频段存在，否则 setEqBand 会因 eqBands 为空/不足而静默失败
  ensureEqBands(band)
  audioEngine.setEqBand(band, { preGain: db })
  // 同步基准曲线：曲线显示的是当前实际增益，故基准 = 实际增益 / 强度倍率，
  // 这样之后再调强度时，该频段才能按正确比例缩放
  if (baseEqGains.value.length !== EQ_FREQS.length) captureBaseEqGains()
  const k = eqStrength.value / 100 || 1
  baseEqGains.value[band] = clamp(db / k, EQ_MIN_DB, EQ_MAX_DB)
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
// 强度是「相对基准曲线」的缩放倍率：每次调节都从基准曲线重新换算，
// 而不是在当前增益上累乘。旧实现用 ratio 累乘 + 0.5dB 取整，多次调节后
// 曲线会因取整误差与 ±10dB 钳制而漂移、塌陷 —— 这就是「多次调节后曲线异常」的根因。
const eqStrength = ref(100)
/** 100% 强度下的各频段基准增益（dB） */
const baseEqGains = ref<number[]>([])

/** 采集当前频段增益作为基准曲线（预设切换 / 首次打开时调用） */
function captureBaseEqGains() {
  baseEqGains.value = EQ_FREQS.map((_, i) =>
    clamp(audioEngine.eqBands.value[i]?.preGain ?? 0, EQ_MIN_DB, EQ_MAX_DB)
  )
}

/** 依据基准曲线与强度值计算并下发实际增益 */
function applyEqStrength(v: number) {
  const strength = clamp(Math.round(v), 0, 200)
  eqStrength.value = strength
  if (baseEqGains.value.length !== EQ_FREQS.length) captureBaseEqGains()
  const k = strength / 100
  const gains = EQ_FREQS.map((_, i) =>
    clamp(Math.round((baseEqGains.value[i] ?? 0) * k * 2) / 2, EQ_MIN_DB, EQ_MAX_DB)
  )
  // 确保频段存在，否则 setEqGains 会因 eqBands 为空而静默失败
  ensureEqBands(EQ_FREQS.length - 1)
  audioEngine.setEqGains(gains)
}

function handleEqStrengthChange(v: number) {
  applyEqStrength(v)
}

// ==================== 动态 EQ ====================
// 实时根据音频频谱（FFT 分析推理）动态修正各频段增益，使声音贴合选定走势。
// 状态与持久化在 useAudioEngine.dynamicEq，分析循环在 useDynamicEq runner。
const dynamicEqRunner = useDynamicEq()

const dynamicEqParams = computed(() => audioEngine.dynamicEq.value)

const dynamicEqEnabled = computed<boolean>({
  get: () => dynamicEqParams.value.enabled,
  set: (v) => {
    // 开启动态 EQ 时若均衡器关闭则自动开启（修正量叠加在 EQ 增益上，EQ 旁通则无效）
    if (v && !eqEnabled.value) {
      audioEngine.setEqEnabled(true)
      message.info('已联动开启均衡器（动态 EQ 依赖均衡器生效）')
    }
    audioEngine.setDynamicEqParams({ enabled: v })
    // 显式启停 runner（不依赖 watch 触发，避免 HMR / 时序导致循环没跑起来）
    if (v) {
      dynamicEqRunner.start()
    } else {
      dynamicEqRunner.stop()
    }
  }
})

/** 四种走势（互斥单选） */
const dynamicEqShapeOptions: Array<{ value: DynamicEqShape; label: string }> = (
  ['bassBoost', 'trebleBoost', 'vShape', 'invertedV'] as DynamicEqShape[]
).map((value) => ({ value, label: DYNAMIC_EQ_SHAPE_LABELS[value] }))

function handleDynamicEqShape(shape: DynamicEqShape) {
  audioEngine.setDynamicEqParams({ shape })
}

function handleDynamicEqStrength(v: number) {
  audioEngine.setDynamicEqParams({ strength: clamp(Math.round(v), 1, 5) })
}

function handleDynamicEqEfficiency(v: number) {
  audioEngine.setDynamicEqParams({ efficiency: clamp(Math.round(v), 1, 5) })
}

/** 实时修正读数（低频 / 高频段均值，dB） */
const dynamicEqReadout = computed(() => dynamicEqRunner.deltaSummary.value)
const dynamicEqStatus = computed(() => {
  if (!dynamicEqEnabled.value) return '已关闭'
  const label = `${DYNAMIC_EQ_SHAPE_LABELS[dynamicEqParams.value.shape]} · ${dynamicEqParams.value.strength}档`
  return dynamicEqRunner.running.value ? `${label} · 分析中` : label
})

// ==================== 等响度（EQ 响度补偿） ====================
// 语义：调整 EQ 后保持整体响度与调整前一致。
// DSP 按各频段在整体响度中的权重，算出当前 EQ 曲线带来的响度变化，
// 再对输出施加等量反向增益（见 web-audio-dsp.ts 的 syncLoudness）。
// 本组件只负责开关、强度，并展示算出来的补偿量。
const loudnessEnabled = computed<boolean>({
  get: () => audioEngine.loudness.value.enabled,
  set: (v) => {
    audioEngine.setLoudnessEnabled(v)
  }
})

/** 补偿强度（0~200%），映射到 DSP 的 compensation 倍率（1 = 完全补偿） */
const loudnessAmount = computed(() =>
  Math.round((audioEngine.loudness.value.compensation ?? 1) * 100)
)

function handleLoudnessAmount(v: number) {
  audioEngine.setLoudnessParams({ compensation: clamp(Math.round(v), 0, 200) / 100 })
}

/** 当前 EQ 曲线带来的响度净变化（dB），与 DSP 使用同一套权重换算 */
const eqLoudnessDelta = computed(() => computeEqLoudnessDb(normalizedGains()))

/** 实际下发的补偿增益（dB，已计入强度与上下限） */
const loudnessCompDb = computed(() => {
  if (!loudnessEnabled.value || !eqEnabled.value) return 0
  return clamp(
    -eqLoudnessDelta.value * (audioEngine.loudness.value.compensation ?? 1),
    LOUDNESS_COMP_MIN_DB,
    LOUDNESS_COMP_MAX_DB
  )
})

const loudnessStatus = computed(() =>
  loudnessEnabled.value ? `补偿 ${fmtDbCompact(loudnessCompDb.value)}` : '已关闭'
)

const loudnessCompHint = computed(() => {
  if (!eqEnabled.value) return 'EQ 已关闭（旁通），不产生响度变化，无需补偿。'
  const delta = eqLoudnessDelta.value
  if (Math.abs(delta) < 0.1) return '当前 EQ 曲线几乎不改变整体响度，无需补偿。'
  return `当前 EQ 曲线使整体${delta > 0 ? '变响' : '变轻'} ${Math.abs(delta).toFixed(1)} dB，已自动补偿 ${fmtDbCompact(loudnessCompDb.value)}。`
})

// ==================== 低音量高低频补偿（Fletcher-Munson 近似） ====================
// 音量越低，人耳对高低频越不敏感，因此按「音量缺口」自动提升两端。
// 换算与 web-audio-dsp.ts 的 syncLoudness 第 2 段完全一致。
const FOLLOW_LOW_MAX_DB = 15
const FOLLOW_HIGH_MAX_DB = 12
const FOLLOW_FULL_DEFICIT_DB = 30

const followVolumeEnabled = computed<boolean>({
  get: () => audioEngine.loudness.value.followVolume === true,
  set: (v) => audioEngine.setLoudnessParams({ followVolume: v })
})

/** 补偿强度（0~200%），映射到 DSP 的 followStrength 倍率 */
const followStrength = computed(() =>
  Math.round((audioEngine.loudness.value.followStrength ?? 1) * 100)
)

function handleFollowStrength(v: number) {
  audioEngine.setLoudnessParams({ followStrength: clamp(Math.round(v), 0, 200) / 100 })
}

/** 补偿基准音量（dB，0 = 满音量）：低于该值才开始提升 */
const followReferenceDb = computed(() =>
  clamp(Math.round(audioEngine.loudness.value.referenceLoudness ?? 0), -30, 0)
)

/** 系统主音量（低频增压联动 / 低音量补偿共用） */
const { available: sysVolAvailable, systemVolume } = useSystemVolume()

/**
 * 当前实际听到的有效响度 = 软件音量 × 系统音量。
 * 系统音量作用于扬声器实际输出，只看软件音量会低估「低频听不见」的程度；
 * WASAPI 独占模式绕过系统混音器，系统音量对输出无效，此时只按软件音量。
 */
const effectiveVolume = computed(() => {
  const software = clamp(playerStore.volume ?? 1, 0, 1)
  if (sysVolAvailable.value === false || isWasapiExclusiveMode()) return software
  return clamp(software * systemVolume.value, 0, 1)
})

/** 有效响度换算出的 dB（满音量 = 0dB） */
const currentVolumeDb = computed(() =>
  20 * Math.log10(clamp(effectiveVolume.value || 0.0001, 0.0001, 1))
)

/** 系统音量口径说明（用于文案，避免用户误以为只看软件音量） */
const sysVolNote = computed(() => {
  if (sysVolAvailable.value === false) return '系统音量不可读，按软件音量计算'
  if (isWasapiExclusiveMode()) return '独占模式下系统音量不生效，按软件音量计算'
  return `含系统音量 ${Math.round(systemVolume.value * 100)}%`
})

/** 音量缺口（dB）：比基准低多少，高于基准则为 0 */
const followDeficit = computed(() =>
  Math.max(0, Math.min(FOLLOW_FULL_DEFICIT_DB, followReferenceDb.value - currentVolumeDb.value))
)

/** 实际下发的高低频提升量（与 DSP 同一套换算） */
const followBoost = computed(() => {
  const ratio = (followDeficit.value / FOLLOW_FULL_DEFICIT_DB) * (followStrength.value / 100)
  return {
    low: Math.min(ratio * FOLLOW_LOW_MAX_DB, 18),
    high: Math.min(ratio * FOLLOW_HIGH_MAX_DB, 15)
  }
})

/**
 * 补偿曲线的频响换算：与 DSP 完全一致 —— 200Hz lowshelf + 8kHz highshelf，
 * shelf 斜率固定 S=1（Web Audio 的 lowshelf/highshelf 不使用 Q）。
 */
const FOLLOW_LOW_SHELF_HZ = 200
const FOLLOW_HIGH_SHELF_HZ = 8000
const RESPONSE_SAMPLE_RATE = 48000

/** 单个 RBJ shelf 滤波器在频率 f 处的增益（dB） */
function shelfResponseDb(f: number, type: 'low' | 'high', f0: number, gainDb: number): number {
  if (!gainDb) return 0
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * Math.min(f0, RESPONSE_SAMPLE_RATE / 2 - 1)) / RESPONSE_SAMPLE_RATE
  const cosw = Math.cos(w0)
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2
  const sa = 2 * Math.sqrt(A) * alpha
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
  if (type === 'low') {
    b0 = A * (A + 1 - (A - 1) * cosw + sa)
    b1 = 2 * A * (A - 1 - (A + 1) * cosw)
    b2 = A * (A + 1 - (A - 1) * cosw - sa)
    a0 = A + 1 + (A - 1) * cosw + sa
    a1 = -2 * (A - 1 + (A + 1) * cosw)
    a2 = A + 1 + (A - 1) * cosw - sa
  } else {
    b0 = A * (A + 1 + (A - 1) * cosw + sa)
    b1 = -2 * A * (A - 1 + (A + 1) * cosw)
    b2 = A * (A + 1 + (A - 1) * cosw - sa)
    a0 = A + 1 - (A - 1) * cosw + sa
    a1 = 2 * (A - 1 - (A + 1) * cosw)
    a2 = A + 1 - (A - 1) * cosw - sa
  }
  const w = (2 * Math.PI * Math.min(f, RESPONSE_SAMPLE_RATE / 2 - 1)) / RESPONSE_SAMPLE_RATE
  // z^-1 / z^-2 的实部与虚部
  const z1r = Math.cos(w)
  const z1i = -Math.sin(w)
  const z2r = Math.cos(2 * w)
  const z2i = -Math.sin(2 * w)
  const numRe = b0 + b1 * z1r + b2 * z2r
  const numIm = b1 * z1i + b2 * z2i
  const denRe = a0 + a1 * z1r + a2 * z2r
  const denIm = a1 * z1i + a2 * z2i
  const numMag = Math.hypot(numRe, numIm)
  const denMag = Math.hypot(denRe, denIm)
  if (!numMag || !denMag) return 0
  return 20 * Math.log10(numMag / denMag)
}

/** 低音量补偿在频率 f 处叠加的总增益（dB） */
const followCompDbAt = (f: number) =>
  shelfResponseDb(f, 'low', FOLLOW_LOW_SHELF_HZ, followBoost.value.low) +
  shelfResponseDb(f, 'high', FOLLOW_HIGH_SHELF_HZ, followBoost.value.high)

/** 曲线上是否叠加补偿曲线：关闭补偿 / EQ 旁通 / 提升量为 0 时都不单独显示 */
const showCompCurve = computed(
  () =>
    followVolumeEnabled.value &&
    eqEnabled.value &&
    (followBoost.value.low > 0.05 || followBoost.value.high > 0.05)
)

const followStatus = computed(() =>
  followVolumeEnabled.value
    ? `低频 +${followBoost.value.low.toFixed(1)} / 高频 +${followBoost.value.high.toFixed(1)} dB`
    : '已关闭'
)

// 补偿开关 / 提升量 / EQ 旁通变化时重绘：补偿曲线随之出现或消失
watch(
  () =>
    `${eqEnabled.value}|${showCompCurve.value}|${followBoost.value.low.toFixed(2)}|${followBoost.value.high.toFixed(2)}`,
  redraw,
  { flush: 'post' }
)

const followHint = computed(() => {
  if (!followVolumeEnabled.value) return '关闭后不做低音量补偿，音量较小时高低频听感会变弱。'
  if (followDeficit.value < 0.5) {
    return `当前有效响度 ${fmtDbCompact(currentVolumeDb.value)}（${sysVolNote.value}）不低于补偿基准，暂不提升高低频。`
  }
  return `当前有效响度 ${fmtDbCompact(currentVolumeDb.value)}（${sysVolNote.value}），比基准低 ${followDeficit.value.toFixed(1)} dB，已提升低频 +${followBoost.value.low.toFixed(1)} dB / 高频 +${followBoost.value.high.toFixed(1)} dB。`
})

/** 设定基准：把当前有效响度（含系统音量）写入补偿阈值 */
const handleSetFollowBaseline = () => {
  const ref = clamp(Math.round(currentVolumeDb.value), -30, 0)
  audioEngine.setLoudnessParams({ referenceLoudness: ref })
  message.success(`已按当前有效响度（${sysVolNote.value}）设定补偿基准：${ref} dB`)
}

// ==================== 低频增压（小体积扬声器） ====================
// 缺失基频谐波合成：小扬声器发不出的低频用其高次谐波「骗」出力量感。
// 5 档强度 + 系统音量联动（音量越低力度越强），状态与持久化在
// useAudioEngine.virtualBass，档位表与联动曲线在 virtual-bass-presets.ts。
// 系统音量（systemVolume / sysVolAvailable）复用上方低音量补偿的轮询结果。

const virtualBassParams = computed(() => audioEngine.virtualBass.value)

const virtualBassEnabled = computed<boolean>({
  get: () => virtualBassParams.value.enabled,
  set: (v) => {
    audioEngine.setVirtualBassParams({ enabled: v })
  }
})

function handleVirtualBassStrength(v: number) {
  audioEngine.setVirtualBassParams({ strength: clamp(Math.round(v), 1, 5) })
}

function handleVirtualBassFollow(v: boolean) {
  audioEngine.setVirtualBassParams({ followSystemVolume: v })
}

const virtualBassStatus = computed(() => {
  if (!virtualBassEnabled.value) return '已关闭'
  const label = getStrengthPreset(virtualBassParams.value.strength).label
  const follow =
    virtualBassParams.value.followSystemVolume && sysVolAvailable.value !== false
      ? ' · 音量联动'
      : ''
  return `${virtualBassParams.value.strength}档 ${label}${follow}`
})

/** 当前实际下发的湿路增益（含音量联动换算），供 UI 读数 */
const virtualBassWet = computed(() =>
  computeVirtualBassDrive(
    virtualBassParams.value.strength,
    virtualBassParams.value.followSystemVolume ? systemVolume.value : 1,
    true
  ).wet
)

const virtualBassHint = computed(() => {
  if (!virtualBassEnabled.value) return '对耳机 / 大音箱意义不大，外放小扬声器收益最明显。'
  if (!virtualBassParams.value.followSystemVolume) return '已固定为当前档位，不随系统音量变化。'
  if (sysVolAvailable.value === false) {
    return '系统音量不可读（非 Windows 或无默认设备），按固定档位工作。'
  }
  return `系统音量 ${Math.round(systemVolume.value * 100)}%：音量越低增压越强（等响补偿），满音量回落基准档。`
})

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
const limiterStatus = computed(
  () => `${audioEngine.limiter.value.ceiling} dB : ${audioEngine.limiter.value.ratio ?? 20}:1`
)

// 全部参数直接写入 DSP 链（仅 Web Audio 模式生效），不再是只改本地 ref 的假接线
const limiterParams = computed(() => [
  {
    key: 'attack',
    label: '启动时间',
    min: 1,
    max: 100,
    step: 1,
    value: audioEngine.limiter.value.attack ?? 5,
    fmt: (v: number) => `${v} ms`,
    set: (v: number) => audioEngine.setLimiterParams({ attack: v })
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
    value: audioEngine.limiter.value.ratio ?? 20,
    fmt: (v: number) => `${v}:1`,
    set: (v: number) => audioEngine.setLimiterParams({ ratio: v })
  },
  {
    key: 'threshold',
    label: '阈值',
    min: -12,
    max: 0,
    step: 1,
    value: audioEngine.limiter.value.ceiling,
    fmt: (v: number) => `${v} dB`,
    set: (v: number) => audioEngine.setLimiterParams({ ceiling: v })
  },
  {
    key: 'postGain',
    label: '后增益',
    min: -6,
    max: 6,
    step: 0.5,
    value: audioEngine.limiter.value.postGain ?? 0,
    fmt: (v: number) => fmtDb(v),
    set: (v: number) => audioEngine.setLimiterParams({ postGain: v })
  }
])

// ==================== 声道平衡 ====================
const balanceEnabled = ref(false)
/** 平衡值：-100 全左 / 0 居中 / +100 全右（单一滑块） */
const balance = ref(0)
const balanceStatus = computed(() => {
  if (!balanceEnabled.value) return '已关闭'
  if (Math.abs(balance.value) < 1) return '居中'
  return balance.value < 0
    ? `偏左 ${Math.abs(Math.round(balance.value))}%`
    : `偏右 ${Math.round(balance.value)}%`
})

/**
 * 平衡值 → 左右增益（dB）。
 * 采用线性幅度衰减（与系统音量平衡一致）：向一侧偏移只衰减另一侧，
 * 居中时两侧均为 0dB（不改变原音量），到端点时该侧接近静音（-60dB）。
 */
function balanceToGains(v: number): { left: number; right: number } {
  const p = clamp(v, -100, 100) / 100
  const leftAmp = Math.max(0.001, 1 - Math.max(0, p))
  const rightAmp = Math.max(0.001, 1 + Math.min(0, p))
  return { left: 20 * Math.log10(leftAmp), right: 20 * Math.log10(rightAmp) }
}

/** 将声道平衡设置下发到 DSP（仅 Web Audio 生效） */
function applyBalance() {
  const { left, right } = balanceToGains(balance.value)
  const active = balanceEnabled.value && Math.abs(balance.value) >= 1
  audioEngine.setChannelBalance(active, left, right)
}
watch([balanceEnabled, balance], applyBalance)

// ==================== 界面状态持久化 ====================
const UI_STORAGE_KEY = 'sound-effects-ui'
/** loadUiState 读出的基准曲线，供 onMounted 决定是否重新采集 */
let restoredBaseEqGains: number[] | null = null
function loadUiState() {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY)
    if (!raw) return
    const d = JSON.parse(raw)
    if (typeof d.balanceEnabled === 'boolean') balanceEnabled.value = d.balanceEnabled
    if (typeof d.balance === 'number') {
      balance.value = clamp(d.balance, -100, 100)
    } else if (typeof d.balanceL === 'number' || typeof d.balanceR === 'number') {
      // 兼容旧版本保存的左右声道独立增益（-6~6 dB）→ 折算为单一平衡值
      const l = typeof d.balanceL === 'number' ? d.balanceL : 0
      const r = typeof d.balanceR === 'number' ? d.balanceR : 0
      balance.value = clamp(((r - l) / 12) * 100, -100, 100)
    }
    if (typeof d.volumeMemory === 'boolean') {
      // 音量记忆功能已移除：顺手清掉旧版本留下的记忆音量值
      localStorage.removeItem('volume-memory')
    }
    // EQ 强度与它对应的基准曲线必须成对恢复：
    // 实际增益已经（按强度缩放后）写进 engine 状态，这里只还原「显示用的倍率 + 基准」，
    // 不能再用基准重算一遍，否则重启后曲线会被二次缩放。
    if (Array.isArray(d.baseEqGains) && d.baseEqGains.length === EQ_FREQS.length) {
      restoredBaseEqGains = d.baseEqGains.map((v: unknown) =>
        typeof v === 'number' && Number.isFinite(v) ? clamp(v, EQ_MIN_DB, EQ_MAX_DB) : 0
      )
    }
    if (restoredBaseEqGains && typeof d.eqStrength === 'number') {
      // 强度必须和基准成对生效：只有基准恢复成功时还原倍率，否则 displayed 强度与实际增益不符
      eqStrength.value = clamp(Math.round(d.eqStrength), 0, 200)
    }
    if (typeof d.mbcBands === 'number') {
      mbcBands.value = clamp(Math.round(d.mbcBands), 2, 4)
    }
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
          balance: balance.value,
          eqStrength: eqStrength.value,
          baseEqGains: baseEqGains.value,
          mbcBands: mbcBands.value
        })
      )
    } catch {
      /* ignore */
    }
  }, 300)
}
watch([balanceEnabled, balance, eqStrength, baseEqGains, mbcBands], saveUiState, {
  deep: true
})

// ==================== 底部控制栏 ====================
const handleFooterSettings = () => {
  openPlaybackSettings()
}

// ==================== 功能卡片 Tab ====================
// 曲线区（均衡器卡片）与 声道平衡 保持常驻，其余功能卡片改为 Tab 切换。
// 卡片本身的样式不动，只是同一时刻只显示一个 section。
const EFFECT_TABS = [
  { key: 'eqStrength', label: 'EQ 强度' },
  { key: 'dynamicEq', label: '动态 EQ' },
  { key: 'loudness', label: '等响度' },
  { key: 'lowVolume', label: '低音量补偿' },
  { key: 'virtualBass', label: '低频增压' },
  { key: 'mbc', label: '多频段压缩' },
  { key: 'limiter', label: '限幅器' }
] as const

type EffectTabKey = (typeof EFFECT_TABS)[number]['key']

/** 当前功能 Tab。默认停在第一个（EQ 强度） */
const activeEffectTab = ref<EffectTabKey>('eqStrength')

// ==================== 生命周期 ====================
let resizeObserver: ResizeObserver | null = null
const handleResize = () => {
  if (showModal.value) drawGraph()
}

onMounted(async () => {
  // 先恢复引擎状态，再套用界面侧持久化设置，保证「随音量补偿 / 声道平衡」等不被打架
  await audioEngine.initialize()
  loadUiState()
  // 应用持久化的声道平衡（此前只是本地状态，从未生效）
  applyBalance()
  // 以当前曲线为 EQ 强度基准：只有没存过基准时才重新采集，
  // 否则会把「已按强度缩放过的实际增益」当成基准，再乘一次强度就二次缩放
  if (restoredBaseEqGains) {
    baseEqGains.value = restoredBaseEqGains
  } else {
    captureBaseEqGains()
  }
  if (graphWrap.value) {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(graphWrap.value)
  }
  window.addEventListener('resize', handleResize)
  nextTick(() => requestAnimationFrame(drawGraph))
  // 持久化状态里动态 EQ 是开启的：显式拉起分析循环（不依赖 watch 首次触发）
  if (dynamicEqParams.value.enabled) dynamicEqRunner.start()
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', handleResize)
  // 不要在这里销毁音频引擎：引擎是全局共享的播放后端，音效面板只是它的一个视图。
  // 之前关闭/重建面板会 destroy 引擎，导致后续播放报「音频引擎未初始化」并中断当前播放。
  // 引擎由主进程在应用退出时统一回收（audioEngineService.emergencyStopAll）。
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
        <n-button quaternary circle title="重置为默认音效" @click="handleReset">
          <template #icon>
            <n-icon size="19"><i class="mgc_refresh_2_line"></i></n-icon>
          </template>
        </n-button>
      </header>

      <!-- 当前输出设备（预设选择已下移到 EQ 卡片） -->
      <div class="se-preset">
        <div class="se-preset-info">
          <div class="se-preset-line">
            <i class="mgc_speaker_line se-preset-speaker"></i>
            <span class="se-preset-label">输出设备</span>
          </div>
          <span class="se-preset-device">{{ deviceName }}</span>
        </div>

        <div class="se-preset-actions" style="display: none;">
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

          <n-button type="primary" secondary @click="handleGoToSound">输出设置</n-button>

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
          <!-- EQ 参数均衡器曲线图（已合并原「原EQ / 预EQ」为单一参数均衡器） -->
          <section class="se-section">
            <header class="se-sec-head">
              <span class="se-sec-title">均衡器</span>
              <span class="se-sec-status">在曲线上拖动频点调节</span>
            </header>
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
            <div v-if="showCompCurve" class="se-graph-legend">
              <span class="se-legend-item">
                <i class="se-legend-line base"></i>
                原曲线
              </span>
              <span class="se-legend-item">
                <i class="se-legend-line comp"></i>
                补偿后
              </span>
            </div>

            <!-- 预设标签选择器：内置预设 + 自定义预设（动态 EQ 开启时整块锁定） -->
            <div class="se-preset-picker" :class="{ locked: presetsLocked }">
              <div class="se-preset-chips">
                <div v-for="p in presetList" :key="p.id" class="se-pet-wrap">
                  <button
                    type="button"
                    class="se-pet-chip"
                    :class="{ active: p.id === selectedPresetId, custom: !p.builtin }"
                    :disabled="presetsLocked"
                    :title="
                      presetsLocked
                        ? '动态 EQ 开启时不可切换预设'
                        : p.builtin
                          ? p.name
                          : `自定义预设：${p.name}`
                    "
                    @click="handlePresetChange(p.id)"
                  >
                    {{ p.name }}
                  </button>
                  <n-popconfirm
                    v-if="!p.builtin"
                    :show-icon="false"
                    positive-text="删除"
                    negative-text="取消"
                    @positive-click="handleDeletePreset(p.id)"
                  >
                    <template #trigger>
                      <button
                        type="button"
                        class="se-pet-del"
                        :disabled="presetsLocked"
                        title="删除该预设"
                      >
                        <i class="mgc_close_line"></i>
                      </button>
                    </template>
                    删除预设「{{ p.name }}」？
                  </n-popconfirm>
                </div>

                <button
                  type="button"
                  class="se-pet-chip se-pet-add"
                  :class="{ active: savePresetOpen }"
                  :disabled="presetsLocked"
                  :title="presetsLocked ? '动态 EQ 开启时不可保存预设' : '把当前设置存为预设'"
                  @click="savePresetOpen ? closeSavePreset() : openSavePreset()"
                >
                  <i :class="savePresetOpen ? 'mgc_close_line' : 'mgc_add_line'"></i>
                  <span>{{ savePresetOpen ? '取消' : '存为预设' }}</span>
                </button>
              </div>

              <div v-if="savePresetOpen && !presetsLocked" class="se-preset-save">
                <n-input
                  ref="presetInputRef"
                  v-model:value="presetNameDraft"
                  size="small"
                  placeholder="预设名称，如「夜间低音」"
                  :maxlength="20"
                  @keyup.enter="confirmSavePreset"
                />
                <n-button size="small" type="primary" secondary @click="confirmSavePreset">
                  保存
                </n-button>
              </div>
              <p v-if="presetsLocked" class="se-hint se-preset-hint">
                动态 EQ 开启中，预设已锁定；关闭动态 EQ 后可切换或保存预设。
              </p>
              <p v-else-if="presetModified" class="se-hint se-preset-hint">
                当前曲线已手动调整，尚未保存到预设。
              </p>
            </div>
          </section>

          <!-- 功能卡片 Tab 切换（曲线区 / 声道平衡 常驻，不参与切换） -->
          <div class="se-effect-tabs" role="tablist">
            <button
              v-for="tab in EFFECT_TABS"
              :key="tab.key"
              type="button"
              role="tab"
              class="se-effect-tab"
              :class="{ active: activeEffectTab === tab.key }"
              :aria-selected="activeEffectTab === tab.key"
              @click="activeEffectTab = tab.key"
            >
              <span>{{ tab.label }}</span>
            </button>
          </div>

          <div class="se-effect-panels">
          <!-- EQ 强度 -->
          <section v-show="activeEffectTab === 'eqStrength'" class="se-section" :class="{ disabled: !eqEnabled }">
            <header class="se-sec-head">
              <span class="se-sec-title">EQ 强度</span>
              <span class="se-sec-status">{{ eqEnabled ? '已开启' : '已关闭' }}</span>
              <n-switch v-model:value="eqEnabled" size="small" />
            </header>

            <div class="se-slider-row">
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
          </section>

          <!-- 动态 EQ -->
          <section v-show="activeEffectTab === 'dynamicEq'" class="se-section">
            <header class="se-sec-head">
              <span class="se-sec-title">动态 EQ</span>
              <span class="se-sec-status">{{ dynamicEqStatus }}</span>
              <n-switch v-model:value="dynamicEqEnabled" size="small" />
            </header>
            <p class="se-desc">
              开启后实时分析歌曲内容微调 EQ；使声音无时无刻保持最佳
            </p>

            <div class="se-dynamic-shapes">
              <button
                v-for="opt in dynamicEqShapeOptions"
                :key="opt.value"
                type="button"
                class="se-shape-btn"
                :class="{ active: dynamicEqParams.shape === opt.value }"
                :disabled="!dynamicEqEnabled"
                @click="handleDynamicEqShape(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>

            <div class="se-slider-row">
              <span class="se-slider-label">增强力度</span>
              <n-slider
                :value="dynamicEqParams.strength"
                :min="1"
                :max="5"
                :step="1"
                :tooltip="false"
                :disabled="!dynamicEqEnabled"
                :marks="{ 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' }"
                @update:value="handleDynamicEqStrength"
              />
              <span class="se-slider-val">{{ dynamicEqParams.strength }} 档</span>
            </div>

            <div class="se-slider-row">
              <span class="se-slider-label">算法效率</span>
              <n-tooltip trigger="hover" placement="top">
                <template #trigger>
                  <n-slider
                    :value="dynamicEqParams.efficiency"
                    :min="1"
                    :max="5"
                    :step="1"
                    :tooltip="false"
                    :disabled="!dynamicEqEnabled"
                    :marks="{ 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' }"
                    @update:value="handleDynamicEqEfficiency"
                  />
                </template>
                越高分析越频繁、响应越灵敏，CPU 占用略高
              </n-tooltip>
              <span class="se-slider-val">{{ dynamicEqParams.efficiency }} 档</span>
            </div>

            <div v-if="dynamicEqEnabled" class="se-loudness-readout">
              <n-tag round :bordered="false" size="small" type="info">
                当前修正：低频 {{ fmtDbCompact(dynamicEqReadout.low) }} / 高频 {{ fmtDbCompact(dynamicEqReadout.high) }}
              </n-tag>
            </div>
          </section>

          <!-- 等响度（EQ 响度补偿） -->
          <section v-show="activeEffectTab === 'loudness'" class="se-section">
            <header class="se-sec-head">
              <span class="se-sec-title">等响度</span>
              <span class="se-sec-status">{{ loudnessStatus }}</span>
              <n-switch v-model:value="loudnessEnabled" size="small" />
            </header>
            <p class="se-desc">
              调整 EQ 后自动补偿整体增益，使响度与调整前保持一致。
            </p>

            <div class="se-slider-row">
              <span class="se-slider-label">补偿强度</span>
              <n-slider
                :value="loudnessAmount"
                :min="0"
                :max="200"
                :step="5"
                :tooltip="false"
                :disabled="!loudnessEnabled"
                @update:value="handleLoudnessAmount"
              />
              <span class="se-slider-val">{{ loudnessAmount }}%</span>
            </div>

            <div v-if="loudnessEnabled" class="se-loudness-readout">
              <n-tag round :bordered="false" size="small" type="info">
                <template #icon>
                  <n-icon size="14"><i class="mgc_volume_line"></i></n-icon>
                </template>
                实际补偿 {{ fmtDb(loudnessCompDb) }}
              </n-tag>
            </div>

            <p v-if="loudnessEnabled" class="se-hint">{{ loudnessCompHint }}</p>
          </section>

          <!-- 低音量高低频补偿（Fletcher-Munson 近似） -->
          <section v-show="activeEffectTab === 'lowVolume'" class="se-section">
            <header class="se-sec-head">
              <span class="se-sec-title">低音量补偿</span>
              <span class="se-sec-status">{{ followStatus }}</span>
              <n-switch v-model:value="followVolumeEnabled" size="small" />
            </header>
            <p class="se-desc">
              按实际响度缺口自动提升两端，小音量下听感更饱满。
            </p>

            <div class="se-slider-row">
              <span class="se-slider-label">补偿强度</span>
              <n-slider
                :value="followStrength"
                :min="0"
                :max="200"
                :step="5"
                :tooltip="false"
                :disabled="!followVolumeEnabled"
                @update:value="handleFollowStrength"
              />
              <span class="se-slider-val">{{ followStrength }}%</span>
            </div>

            <div class="se-slider-row">
              <span class="se-slider-label">补偿基准</span>
              <n-slider
                :value="followReferenceDb"
                :min="-30"
                :max="0"
                :step="1"
                :tooltip="false"
                :disabled="!followVolumeEnabled"
                @update:value="(v: any) => audioEngine.setLoudnessParams({ referenceLoudness: v })"
              />
              <span class="se-slider-val">{{ followReferenceDb }} dB</span>
            </div>

            <div class="se-loudness-readout">
              <n-button size="small" secondary :disabled="!followVolumeEnabled" @click="handleSetFollowBaseline">
                <template #icon>
                  <n-icon size="16"><i class="mgc_target_line"></i></n-icon>
                </template>
                按当前响度设基准
              </n-button>
              <n-tag v-if="followVolumeEnabled" :bordered="false" size="small" type="info">
                <template #icon>
                  <n-icon size="14"><i class="mgc_volume_line"></i></n-icon>
                </template>
                有效响度 {{ fmtDbCompact(currentVolumeDb) }} · {{ sysVolNote }}
              </n-tag>
            </div>

            <p v-if="followVolumeEnabled" class="se-hint">{{ followHint }}</p>
          </section>

          <!-- 低频增压（小体积扬声器缺失基频谐波合成） -->
          <section v-show="activeEffectTab === 'virtualBass'" class="se-section">
            <header class="se-sec-head">
              <span class="se-sec-title">低频增压 <em>(Virtual Bass)</em></span>
              <span class="se-sec-status">{{ virtualBassStatus }}</span>
              <n-switch v-model:value="virtualBassEnabled" size="small" />
            </header>
            <p class="se-desc">
              为笔记本 / 手机外放等小体积扬声器合成缺失的低频基频谐波，让低音更有力量感
            </p>

            <div class="se-slider-row">
              <span class="se-slider-label">增压强度</span>
              <n-slider
                :value="virtualBassParams.strength"
                :min="1"
                :max="5"
                :step="1"
                :tooltip="false"
                :disabled="!virtualBassEnabled"
                :marks="{ 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' }"
                @update:value="handleVirtualBassStrength"
              />
              <span class="se-slider-val">{{ virtualBassParams.strength }} 档</span>
            </div>

            <div class="se-slider-row">
              <span class="se-slider-label">跟随系统音量</span>
              <n-switch
                :value="virtualBassParams.followSystemVolume"
                size="small"
                :disabled="!virtualBassEnabled"
                @update:value="handleVirtualBassFollow"
              />
              <span class="se-slider-val">
                {{ virtualBassParams.followSystemVolume ? '智能' : '固定' }}
              </span>
            </div>

            <div v-if="virtualBassEnabled" class="se-loudness-readout">
              <n-tag :bordered="false" size="small" type="info">
                <template #icon>
                  <n-icon size="14"><i class="mgc_wave_puls_line"></i></n-icon>
                </template>
                <template v-if="virtualBassParams.followSystemVolume && sysVolAvailable !== false">
                  系统音量 {{ Math.round(systemVolume * 100) }}% · 增压 ×{{
                    (virtualBassWet / getStrengthPreset(virtualBassParams.strength).wetMax).toFixed(2)
                  }}
                </template>
                <template v-else>当前增压 {{ Math.round(virtualBassWet * 100) }}%</template>
              </n-tag>
            </div>

            <p v-if="virtualBassEnabled" class="se-hint">{{ virtualBassHint }}</p>
          </section>

          <!-- 多频段压缩 MBC -->
          <section v-show="activeEffectTab === 'mbc'" class="se-section">
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
          <section v-show="activeEffectTab === 'limiter'" class="se-section">
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

          </div>

          <!-- 声道平衡：常驻、内容始终展开（不再折叠） -->
          <section class="se-section">
            <header class="se-sec-head">
              <span class="se-sec-title">声道平衡</span>
              <span class="se-sec-status">{{ balanceStatus }}</span>
              <n-switch v-model:value="balanceEnabled" size="small" />
            </header>

            <div class="se-params" :class="{ 'is-disabled': !balanceEnabled }">
              <div class="se-param">
                <div class="se-param-head">
                  <span class="se-slider-label">左</span>
                  <span class="se-param-value">{{ balanceStatus }}</span>
                  <span class="se-slider-label">右</span>
                </div>
                <n-slider
                  :value="balance"
                  :min="-100"
                  :max="100"
                  :step="1"
                  :tooltip="false"
                  @update:value="(v: any) => (balance = v)"
                />
              </div>
            </div>
          </section>
        </div>
      </n-scrollbar>

      <!-- 底部操作栏（重置按钮统一放在顶部标题栏，此处不再重复） -->
      <footer class="se-footer">
        <div class="se-footer-group">
          <n-button quaternary circle title="打开输出设置" @click="handleFooterSettings">
            <template #icon>
              <n-icon size="20"><i class="mgc_settings_3_line"></i></n-icon>
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
      margin: 6px;
      font-size: 19px;
      align-self: left;
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

        .se-preset-label {
          font-size: 12px;
          color: var(--n-text-color-3);
        }

        .se-preset-device {
          font-size: 13px;
          font-weight: 600;
          color: var(--n-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-bottom: 4px;
        }
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

  // ===== 卡片 =====
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

  // 功能卡片 Tab 切换（卡片样式本身不动，只是同一时刻只显示一个）
  .se-effect-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border-radius: 12px;
    background: var(--n-card-color, rgba(128, 128, 128, 0.05));
    border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.12));
    overflow-x: auto;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  .se-effect-tab {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 11px;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: var(--n-text-color-2);
    font-size: 12.5px;
    white-space: nowrap;
    cursor: pointer;
    transition: all 0.15s ease;

    &:hover {
      color: var(--n-text-color);
      background: rgba(128, 128, 128, 0.08);
    }

    &.active {
      border-color: v-bind('accentRgba(0.34)');
      background: v-bind('accentRgba(0.14)');
      color: v-bind('ACCENT');
      font-weight: 600;
    }
  }

  // 「已开启」小圆点：卡片被收起后仍能看出哪些效果是开着的
  .se-effect-tab-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: v-bind('ACCENT');
    opacity: 0.8;
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

  // 曲线图例（仅在叠加低音量补偿时出现）
  .se-graph-legend {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 6px;
    padding-left: 4px;
    font-size: 11px;
    color: var(--n-text-color-3);

    .se-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .se-legend-line {
      display: inline-block;
      width: 16px;
      height: 0;
      border-top-width: 2px;
      border-top-style: solid;

      &.base {
        opacity: 0.45;
        border-top-color: var(--n-primary-color);
      }

      &.comp {
        border-top-color: var(--n-primary-color);
      }
    }
  }

  // 预设标签选择器（EQ 卡片内，曲线下方）
  .se-preset-picker {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px dashed var(--n-divider-color, rgba(128, 128, 128, 0.16));

    .se-preset-chips {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }

    .se-pet-wrap {
      position: relative;
      display: inline-flex;
    }

    .se-pet-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 26px;
      padding: 0 12px;
      border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.22));
      border-radius: 999px;
      background: transparent;
      color: var(--n-text-color-2);
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        border-color: v-bind('ACCENT');
        color: var(--n-text-color);
      }

      &.active {
        border-color: v-bind('ACCENT');
        background: v-bind('accentRgba(0.14)');
        color: v-bind('ACCENT');
        font-weight: 600;
      }

      // 自定义预设：右侧给删除按钮留出位置
      &.custom {
        padding-right: 24px;
      }

      // 动态 EQ 开启时整块锁定
      &:disabled {
        opacity: 0.45;
        cursor: not-allowed;

        &:hover {
          border-color: var(--n-border-color, rgba(128, 128, 128, 0.22));
          color: var(--n-text-color-2);
        }

        &.active {
          border-color: v-bind('ACCENT');
          color: v-bind('ACCENT');
        }
      }
    }

    .se-pet-del {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: var(--n-text-color-3);
      font-size: 12px;
      cursor: pointer;
      opacity: 0.6;
      transition: all 0.15s ease;

      &:hover {
        opacity: 1;
        color: #f56c6c;
        background: rgba(245, 108, 108, 0.12);
      }

      &:disabled {
        cursor: not-allowed;

        &:hover {
          opacity: 0.6;
          color: var(--n-text-color-3);
          background: transparent;
        }
      }
    }

    .se-pet-add {
      border-style: dashed;
      color: var(--n-text-color-3);

      i {
        font-size: 13px;
      }
    }

    .se-preset-save {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      max-width: 360px;
    }

    .se-preset-hint {
      margin-top: 8px;
    }
  }

  // 模式切换
  .se-mode-toggle {
    display: flex;
    gap: 6px;
    margin-bottom: 12px;
  }

  // 动态 EQ 走势按钮组（互斥单选）
  .se-dynamic-shapes {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    margin: 10px 0 12px;

    .se-shape-btn {
      padding: 6px 4px;
      border: 1px solid var(--n-border-color);
      border-radius: 8px;
      background: transparent;
      color: var(--n-text-color-2);
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover:not(:disabled) {
        border-color: v-bind('ACCENT');
        color: var(--n-text-color);
      }

      &.active {
        border-color: v-bind('ACCENT');
        background: v-bind('accentRgba(0.12)');
        color: v-bind('ACCENT');
        font-weight: 600;
      }

      &:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
    }
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

  // 等响度：实际补偿量读数
  .se-loudness-readout {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }

  // 折叠区
  .se-collapse {
    &.is-disabled {
      opacity: 0.4;
      pointer-events: none;
    }
  }

  // 参数区（折叠区内与声道平衡常驻区共用）
  .se-params {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 2px 4px 6px;

    &.is-disabled {
      opacity: 0.4;
      pointer-events: none;
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
