<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  NCard,
  NEmpty,
  NIcon,
  NScrollbar,
  NStatistic,
  NTag,
  NTooltip,
  useThemeVars
} from 'naive-ui'
import defaultCover from '@renderer/assets/default-cover.png'
import { usePlayerStore } from '../stores/playerStore'
import { useLocalMusicStore } from '../stores/localMusicStore'
import type { PlayerSong, PlayRecord } from '../stores/playerStore'
import { hexToRgba } from '../utils/color'

const playerStore = usePlayerStore()
const localMusicStore = useLocalMusicStore()
const themeVars = useThemeVars()

/* ==========================================================================
   常量
   ========================================================================== */
const DAY_MS = 24 * 60 * 60 * 1000
/** 聆听足迹展示的周数（13 周 ≈ 近 90 天） */
const FOOTPRINT_WEEKS = 13
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const HOUR_LABELS = ['00', '06', '12', '18', '24']
const LOSSLESS_EXTS = new Set(['flac', 'ape', 'wav', 'aiff', 'aif', 'wv', 'alac'])
/**
 * 播放时段折线图的坐标系（viewBox 尺寸，随容器等比拉伸）。
 * `top` 同时是峰值点的纵坐标（peakHour 恒为最大值点），必须留出足够高度容纳
 * 悬浮在峰值上方的「最常播放」气泡，否则气泡会顶穿卡片头。按视觉高度
 * `.hour-plot` 158px 反推：气泡 8px 偏移 + 约 37px 高度需要 ~45px 净空，
 * 对应 top ≈ 88。
 */
const HOUR_CHART = { width: 1000, height: 260, top: 88, base: 216 }
/** 音频格式环形图半径 */
const DONUT_RADIUS = 42
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS

/* ==========================================================================
   主题色
   ========================================================================== */
const accentColor = computed(() => themeVars.value.primaryColor || '#2C8EFD')

/** 热力图 5 级色阶：0 级用中性描边色，其余用主色递增透明度 */
const heatColors = computed<string[]>(() => [
  'var(--n-border-color)',
  hexToRgba(accentColor.value, 0.26),
  hexToRgba(accentColor.value, 0.46),
  hexToRgba(accentColor.value, 0.68),
  accentColor.value
])

const metricIconStyle = computed(() => ({ color: hexToRgba(accentColor.value, 0.16) }))
const peakBadgeStyleBase = computed(() => ({
  borderColor: hexToRgba(accentColor.value, 0.45)
}))

/* ==========================================================================
   通用格式化
   ========================================================================== */
/** 本地日期 -> YYYY-MM-DD（用于按天聚合，字符串可直接比较大小） */
function dateKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${m}-${d}`
}

function formatDayLabel(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/** 毫秒时长 -> 「3时24 分」的数值与单位两段式，便于分开排版 */
function formatDuration(ms: number): { value: string; unit?: string } {
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes <= 0) return { value: '0', unit: '分' }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return { value: `${hours}时${minutes}`, unit: '分' }
  return { value: String(minutes), unit: '分' }
}

/** 字节 -> 人类可读的数值与单位两段式 */
function formatBytes(bytes: number): { value: string; unit: string } {
  if (!bytes || bytes <= 0) return { value: '0', unit: 'B' }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const value = i === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1)
  return { value, unit: units[i] }
}

/** 取文件扩展名（不含点，小写），失败返回 null */
function extOf(filePath?: string): string | null {
  if (!filePath) return null
  const clean = filePath.split(/[?#]/)[0]
  const idx = clean.lastIndexOf('.')
  if (idx < 0 || idx === clean.length - 1) return null
  const ext = clean.slice(idx + 1).toLowerCase()
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : null
}

/* ==========================================================================
   本地曲库指标（歌曲 / 专辑 / 歌手 / 总时长 / 总大小）
   ========================================================================== */
const librarySongs = computed(() => localMusicStore.songs)
const libraryLoading = computed(() => localMusicStore.loading)

/** 文件大小缓存：key 为文件路径，value 为字节数 */
const fileSizes = ref<Record<string, number>>({})

/** 批量向主进程查询本地音频文件大小（扫描阶段不做 stat，此处按需拉取） */
async function loadFileSizes(): Promise<void> {
  const paths = Array.from(
    new Set(
      librarySongs.value
        .map((song) => song.filePath)
        .filter(
          (p): p is string => typeof p === 'string' && !!p && !/^https?:\/\//i.test(p)
        )
    )
  )
  if (paths.length === 0) {
    fileSizes.value = {}
    return
  }
  try {
    // @ts-ignore - window.electron 由 preload 注入，无类型声明
    const sizes = (await window.electron.ipcRenderer.invoke(
      'local-music:sizes',
      paths
    )) as Record<string, number>
    if (sizes && typeof sizes === 'object') fileSizes.value = sizes
  } catch (error) {
    console.error('读取本地音频文件大小失败', error)
  }
}

onMounted(() => {
  playerStore.loadHistory()
  void loadFileSizes()
})

// 本地曲库为异步扫描，长度变化（首次加载完成 / 重新扫描）时刷新文件大小
watch(
  () => librarySongs.value.length,
  () => {
    void loadFileSizes()
  }
)

const uniqueAlbumCount = computed(() => {
  const set = new Set<string>()
  librarySongs.value.forEach((song) => {
    const name = song.al?.name?.trim()
    if (name) set.add(name)
  })
  return set.size
})

const uniqueArtistCount = computed(() => {
  const set = new Set<string>()
  librarySongs.value.forEach((song) => {
    const names = song.ar?.length ? song.ar : []
    names.forEach((ar) => {
      const name = ar?.name?.trim()
      if (name) set.add(name)
    })
  })
  return set.size
})

const libraryDurationMs = computed(() =>
  librarySongs.value.reduce((sum, song) => sum + (song.dt || 0), 0)
)
const librarySizeBytes = computed(() =>
  Object.values(fileSizes.value).reduce((sum, size) => sum + size, 0)
)

interface MetricItem {
  key: string
  label: string
  value: string
  unit?: string
  icon: string
}

const metrics = computed<MetricItem[]>(() => {
  const duration = formatDuration(libraryDurationMs.value)
  const size = formatBytes(librarySizeBytes.value)
  return [
    { key: 'songs', label: '歌曲', value: String(librarySongs.value.length), icon: 'mgc_music_3_line' },
    { key: 'albums', label: '专辑', value: String(uniqueAlbumCount.value), icon: 'mgc_album_2_line' },
    { key: 'artists', label: '歌手', value: String(uniqueArtistCount.value), icon: 'mgc_user_3_line' },
    { key: 'duration', label: '总时长', value: duration.value, unit: duration.unit, icon: 'mgc_time_line' },
    { key: 'size', label: '总大小', value: size.value, unit: size.unit, icon: 'mgc_drive_line' }
  ]
})

/* ==========================================================================
   音频格式分布（环形图）
   ========================================================================== */
interface FormatStat {
  name: string
  count: number
  percent: number
  lossless: boolean
}

interface DonutSegment extends FormatStat {
  color: string
  dasharray: string
  dashoffset: number
}

const formatStats = computed<FormatStat[]>(() => {
  const counts = new Map<string, { count: number; lossless: boolean }>()
  let total = 0

  librarySongs.value.forEach((song) => {
    const ext = extOf(song.filePath)
    const name = ext ? ext.toUpperCase() : '未知'
    const lossless = ext ? LOSSLESS_EXTS.has(ext) : false
    const current = counts.get(name) || { count: 0, lossless }
    current.count++
    counts.set(name, current)
    total++
  })

  if (total === 0) return []
  return Array.from(counts.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, info]) => ({
      name,
      count: info.count,
      percent: (info.count / total) * 100,
      lossless: info.lossless
    }))
})

const losslessPercent = computed(() => {
  const stats = formatStats.value
  const total = stats.reduce((sum, s) => sum + s.count, 0)
  if (total === 0) return 0
  const lossless = stats.filter((s) => s.lossless).reduce((sum, s) => sum + s.count, 0)
  return (lossless / total) * 100
})

const donutSegments = computed<DonutSegment[]>(() => {
  const stats = formatStats.value
  const total = stats.reduce((sum, s) => sum + s.count, 0)
  if (total === 0) return []

  // 同色系由深到浅递减，视觉上仍与主题主色统一
  const palette = [
    accentColor.value,
    hexToRgba(accentColor.value, 0.55),
    hexToRgba(accentColor.value, 0.35),
    hexToRgba(accentColor.value, 0.2)
  ]

  let offset = 0
  return stats.map((stat, index) => {
    const length = (stat.count / total) * DONUT_CIRCUMFERENCE
    const segment: DonutSegment = {
      ...stat,
      color: palette[Math.min(index, palette.length - 1)],
      dasharray: `${length} ${DONUT_CIRCUMFERENCE - length}`,
      dashoffset: -offset
    }
    offset += length
    return segment
  })
})

/* ==========================================================================
   聆听足迹（近 90 天热力图）
   ========================================================================== */
interface FootprintDay {
  key: string
  date: Date
  count: number
  level: number
  future: boolean
}

interface FootprintWeek {
  key: string
  monthLabel: string
  days: FootprintDay[]
}

/** 依据当日播放次数占最大值的比例划分 1-4 级 */
function heatLevel(count: number, max: number): number {
  if (count <= 0) return 0
  if (max <= 1) return 4
  const ratio = count / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

const footprintWeeks = computed<FootprintWeek[]>(() => {
  const counts = new Map<string, number>()
  let maxCount = 0

  playerStore.playHistory.forEach((record) => {
    const date = new Date(record.timestamp)
    if (Number.isNaN(date.getTime())) return
    const key = dateKey(date)
    const next = (counts.get(key) || 0) + 1
    counts.set(key, next)
    if (next > maxCount) maxCount = next
  })

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayKey = dateKey(today)
  const daysFromMonday = (today.getDay() + 6) % 7
  const thisMonday = new Date(today.getTime() - daysFromMonday * DAY_MS)
  const firstMonday = new Date(thisMonday.getTime() - (FOOTPRINT_WEEKS - 1) * 7 * DAY_MS)

  const weeks: FootprintWeek[] = []
  let previousMonth = -1

  for (let w = 0; w < FOOTPRINT_WEEKS; w++) {
    const days: FootprintDay[] = []
    for (let d = 0; d < 7; d++) {
      const date = new Date(firstMonday.getTime() + (w * 7 + d) * DAY_MS)
      const key = dateKey(date)
      const count = counts.get(key) || 0
      days.push({
        key,
        date,
        count,
        level: heatLevel(count, maxCount),
        future: key > todayKey
      })
    }
    const month = days[0].date.getMonth()
    weeks.push({
      key: `week-${w}`,
      monthLabel: month !== previousMonth ? `${month + 1}月` : '',
      days
    })
    previousMonth = month
  }

  return weeks
})

/* ==========================================================================
   播放时段（24 小时折线）
   ========================================================================== */
const hourlyCounts = computed<number[]>(() => {
  const hours = new Array(24).fill(0) as number[]
  playerStore.playHistory.forEach((record) => {
    const date = new Date(record.timestamp)
    if (!Number.isNaN(date.getTime())) hours[date.getHours()]++
  })
  return hours
})

const hasHourlyData = computed(() => hourlyCounts.value.some((count) => count > 0))

const peakHour = computed(() => {
  const hours = hourlyCounts.value
  let index = 0
  for (let i = 1; i < hours.length; i++) {
    if (hours[i] > hours[index]) index = i
  }
  return index
})

const peakHourCount = computed(() => hourlyCounts.value[peakHour.value])

const hourChartMax = computed(() => Math.max(1, ...hourlyCounts.value))

function hourPointX(index: number): number {
  return (index / 23) * HOUR_CHART.width
}

function hourPointY(value: number): number {
  const plotHeight = HOUR_CHART.base - HOUR_CHART.top
  return HOUR_CHART.base - (value / hourChartMax.value) * plotHeight
}

const hourLinePath = computed(() =>
  hourlyCounts.value
    .map((value, index) => {
      const command = index === 0 ? 'M' : 'L'
      return `${command}${hourPointX(index).toFixed(2)},${hourPointY(value).toFixed(2)}`
    })
    .join(' ')
)

const hourAreaPath = computed(() => {
  const points = hourlyCounts.value
    .map((value, index) => `${hourPointX(index).toFixed(2)},${hourPointY(value).toFixed(2)}`)
    .join(' L')
  return `M${hourPointX(0).toFixed(2)},${HOUR_CHART.base} L${points} L${hourPointX(23).toFixed(
    2
  )},${HOUR_CHART.base} Z`
})

/** 峰值竖条：底部对齐，高度到峰值点 */
const peakBandStyle = computed(() => ({
  left: `${(hourPointX(peakHour.value) / HOUR_CHART.width) * 100}%`,
  height: `${(1 - hourPointY(peakHourCount.value) / HOUR_CHART.height) * 100}%`,
  background: `linear-gradient(to top, ${hexToRgba(accentColor.value, 0.3)}, ${hexToRgba(
    accentColor.value,
    0.02
  )})`
}))

/** 峰值气泡：贴住峰值点上方，左右做 6%~94% 夹紧避免溢出卡片 */
const peakBadgeStyle = computed(() => ({
  left: `${Math.min(94, Math.max(6, (hourPointX(peakHour.value) / HOUR_CHART.width) * 100))}%`,
  bottom: `${(1 - hourPointY(peakHourCount.value) / HOUR_CHART.height) * 100}%`
}))

/* ==========================================================================
   最常听（TOP 1）
   ========================================================================== */
interface TopItem {
  songId: string | number
  title?: string
  artist?: string
  album?: string
  cover?: string
  filePath?: string
  source?: string
  durationMs?: number
  displayTitle?: string
  count: number
}

type TopKey = 'songId' | 'artist' | 'album'

/** 播放记录中某维度缺失时的兜底名称 */
function fallbackName(key: Exclude<TopKey, 'songId'>): string {
  return key === 'album' ? '未知专辑' : '未知'
}

function getTopItem(key: TopKey): TopItem | null {
  const history = playerStore.playHistory
  if (history.length === 0) return null

  const counts: Record<string, number> = {}
  history.forEach((record) => {
    const value =
      key === 'songId' ? String(record.songId) : record[key] || fallbackName(key)
    if (!value) return
    counts[value] = (counts[value] || 0) + 1
  })

  let target: string | null = null
  let maxCount = -1
  for (const [name, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count
      target = name
    }
  }
  if (target === null) return null

  const expected = target
  const record = history.find((r) =>
    key === 'songId'
      ? String(r.songId) === expected
      : (r[key] || fallbackName(key)) === expected
  )
  if (!record) return null

  return {
    songId: record.songId,
    title: record.title,
    artist: record.artist,
    album: record.album,
    cover: resolveLiveCover(key, record),
    filePath: record.filePath,
    source: record.source,
    durationMs: record.durationMs,
    displayTitle: key === 'songId' ? record.title : expected,
    count: maxCount
  }
}

/**
 * 取封面：播放记录里的封面**不可靠**，必须优先用本地曲库的实时封面。
 *
 * 原因：`playerStore.recordPlay` 会把 blob: 与大体积 data:image 封面写成空串
 * （避免几 MB 的 base64 撑爆 localStorage），上一会话遗留的 blob: 也已失效。
 * 而本地曲库每次启动都重新扫描并生成 blob 缩略图，本次会话内一定有效。
 */
function resolveLiveCover(key: TopKey, record: PlayRecord): string {
  if (key === 'songId') {
    // 优先按 filePath 匹配（id 在跨音源时可能重复），再退回 id
    const song =
      (record.filePath && localMusicStore.songs.find((s) => s.filePath === record.filePath)) ||
      localMusicStore.songs.find((s) => String(s.id) === String(record.songId))
    const live = song?.thumbUrl || song?.picUrl || song?.al?.picUrl
    if (live) return live
  } else {
    // 本组件对歌手的兜底名是「未知」，曲库分组用的是「未知歌手」，两个都试
    const names = (key === 'album' ? [record.album, '未知专辑'] : [record.artist, '未知歌手']).filter(
      (name): name is string => typeof name === 'string' && name.length > 0
    )
    if (key === 'album') {
      for (const name of names) {
        const group = localMusicStore.albumList.find((g) => g.name === name)
        if (group?.cover) return group.cover
      }
    } else {
      for (const name of names) {
        const group = localMusicStore.artistList.find((g) => g.name === name)
        if (group?.cover) return group.cover
      }
    }
  }
  // 记录里的封面只在非 blob:（http/data/file，跨会话仍有效）时才敢用
  if (record.cover && !record.cover.startsWith('blob:')) return record.cover
  return ''
}

const topSong = computed(() => getTopItem('songId'))
const topAlbum = computed(() => getTopItem('album'))
const topArtist = computed(() => getTopItem('artist'))

/** 封面加载失败（历史遗留的 blob:、远端 404）时回落到默认封面，避免出现碎图 */
function onCoverError(event: Event): void {
  const img = event.target as HTMLImageElement | null
  if (!img || img.dataset.coverFallback === '1') return
  img.dataset.coverFallback = '1'
  img.src = defaultCover
}

/** 从 TOP 卡片回到播放：切到该曲目 */
function playTop(item: TopItem | null): void {
  if (!item || item.songId == null) return
  const song: PlayerSong = {
    id: item.songId,
    title: item.title || '未知歌曲',
    artist: item.artist || '未知艺人',
    album: item.album,
    cover: item.cover || defaultCover,
    durationMs: item.durationMs || 0,
    filePath: item.filePath,
    source: item.source
  }
  playerStore.setCurrentSong(song)
}
</script>

<template>
  <div class="statistics-view">
    <n-scrollbar
      style="height: 100%"
      content-style="padding: 80px clamp(16px, 2vw, 24px) 32px; margin-top: 80px;"
    >
      <!-- 自适应容器：所有卡片断点都以「本组件实际可用宽度」为准（见 <style> 里的 @container） -->
      <div class="stats-container">
        <!-- ===================== 概览指标 ===================== -->
        <div class="metrics-row">
          <n-card
            v-for="item in metrics"
            :key="item.key"
            class="metric-card"
            size="small"
            :bordered="true"
          >
            <n-statistic>
              <template #default>
                <span class="metric-value">{{ item.value }}</span>
                <span v-if="item.unit" class="metric-unit">{{ item.unit }}</span>
              </template>
              <template #label>
                <span class="metric-label">{{ item.label }}</span>
              </template>
            </n-statistic>
            <n-icon class="metric-icon" :style="metricIconStyle">
              <i :class="item.icon"></i>
            </n-icon>
          </n-card>
        </div>

        <!-- ===================== 聆听足迹 / 播放时段 / 音频格式 ===================== -->
        <div class="panels-row">
          <!-- 聆听足迹 -->
          <n-card class="panel-card" size="small" :bordered="true">
            <template #header>
              <div class="card-header">
                <n-icon :size="16"><i class="mgc_dot_grid_line"></i></n-icon>
                <span>聆听足迹</span>
              </div>
            </template>
            <template #header-extra>
              <span class="card-hint">近 90 天</span>
            </template>

            <div class="footprint">
              <div class="fp-months">
                <span v-for="week in footprintWeeks" :key="week.key" class="fp-month">
                  {{ week.monthLabel }}
                </span>
              </div>
              <div class="fp-body">
                <div class="fp-weekdays">
                  <span v-for="(label, index) in WEEKDAY_LABELS" :key="index">
                    {{ index % 2 === 0 ? '周' + label : '' }}
                  </span>
                </div>
                <div class="fp-grid">
                  <div v-for="week in footprintWeeks" :key="week.key" class="fp-week">
                    <template v-for="day in week.days" :key="day.key">
                      <n-tooltip v-if="day.count > 0" trigger="hover" :delay="100">
                        <template #trigger>
                          <div
                            class="fp-cell"
                            :style="{ background: heatColors[day.level] }"
                          ></div>
                        </template>
                        {{ formatDayLabel(day.date) }} · {{ day.count }} 次播放
                      </n-tooltip>
                      <div
                        v-else
                        class="fp-cell"
                        :class="{ 'is-future': day.future }"
                        :style="{ background: heatColors[0] }"
                      ></div>
                    </template>
                  </div>
                </div>
              </div>
              <div class="fp-legend">
                <span class="fp-legend-text">少</span>
                <span
                  v-for="level in [0, 1, 2, 3, 4]"
                  :key="level"
                  class="fp-cell fp-legend-cell"
                  :style="{ background: heatColors[level] }"
                ></span>
                <span class="fp-legend-text">多</span>
              </div>
            </div>
          </n-card>

          <!-- 播放时段 -->
          <n-card class="panel-card" size="small" :bordered="true">
            <template #header>
              <div class="card-header">
                <n-icon :size="16"><i class="mgc_chart_line_line"></i></n-icon>
                <span>播放时段</span>
              </div>
            </template>
            <template #header-extra>
              <span class="card-hint">24 小时</span>
            </template>

            <n-empty v-if="!hasHourlyData" size="small" description="暂无播放记录" />
            <div v-else class="hour-chart">
              <div class="hour-plot">
                <div class="hour-band" :style="peakBandStyle"></div>
                <svg class="hour-svg" viewBox="0 0 1000 260" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="hourAreaGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" :stop-color="accentColor" stop-opacity="0.32" />
                      <stop offset="100%" :stop-color="accentColor" stop-opacity="0.02" />
                    </linearGradient>
                  </defs>
                  <path class="hour-area" :d="hourAreaPath" />
                  <path
                    class="hour-line"
                    :d="hourLinePath"
                    :stroke="accentColor"
                    vector-effect="non-scaling-stroke"
                  />
                </svg>
                <div class="hour-peak" :style="[peakBadgeStyle, peakBadgeStyleBase]">
                  <span class="hour-peak-label">最常播放</span>
                  <span class="hour-peak-time">{{ formatHour(peakHour) }}</span>
                </div>
              </div>
              <div class="hour-axis">
                <span v-for="label in HOUR_LABELS" :key="label">{{ label }}</span>
              </div>
              <div class="hour-caption">
                你最喜欢在 <strong>{{ formatHour(peakHour) }}</strong> 听歌，共计
                {{ peakHourCount }} 次播放
              </div>
            </div>
          </n-card>

          <!-- 音频格式 -->
          <n-card class="panel-card panel-card--format" size="small" :bordered="true">
            <template #header>
              <div class="card-header">
                <n-icon :size="16"><i class="mgc_chart_pie_line"></i></n-icon>
                <span>音频格式</span>
              </div>
            </template>
            <template #header-extra>
              <span class="card-hint">{{ formatStats.length }} 种格式</span>
            </template>

            <n-empty
              v-if="formatStats.length === 0"
              size="small"
              :description="libraryLoading ? '正在扫描本地音乐…' : '暂无本地音乐'"
            />
            <div v-else class="format-body">
              <div class="donut">
                <svg class="donut-svg" viewBox="0 0 120 120">
                  <circle class="donut-track" cx="60" cy="60" :r="DONUT_RADIUS" />
                  <g transform="rotate(-90 60 60)">
                    <circle
                      v-for="(segment, index) in donutSegments"
                      :key="index"
                      class="donut-segment"
                      cx="60"
                      cy="60"
                      :r="DONUT_RADIUS"
                      :stroke="segment.color"
                      :stroke-dasharray="segment.dasharray"
                      :stroke-dashoffset="segment.dashoffset"
                    />
                  </g>
                </svg>
                <div class="donut-center">
                  <span class="donut-center-label">无损占比</span>
                  <span class="donut-center-value">{{ losslessPercent.toFixed(1) }}%</span>
                </div>
              </div>
              <ul class="format-legend">
                <li v-for="segment in donutSegments" :key="segment.name">
                  <span class="legend-dot" :style="{ background: segment.color }"></span>
                  <span class="legend-name">{{ segment.name }}</span>
                  <span class="legend-meta">
                    {{ segment.count }} 首 · {{ segment.percent.toFixed(1) }}%
                  </span>
                </li>
              </ul>
            </div>
          </n-card>
        </div>

        <!-- ===================== 最常听 TOP 1 ===================== -->
        <div class="tops-row">
          <n-card class="top-card" size="small" :bordered="true">
            <template #header>
              <div class="card-header">
                <n-icon :size="16"><i class="mgc_music_3_line"></i></n-icon>
                <span>最常听的歌曲</span>
              </div>
            </template>
            <template #header-extra>
              <n-tag size="small" :bordered="false" class="rank-tag">TOP 1</n-tag>
            </template>

            <div v-if="topSong" class="top-item" @click="playTop(topSong)">
              <img
                class="top-cover"
                :src="topSong.cover || defaultCover"
                loading="lazy"
                decoding="async"
                @error="onCoverError"
              />
              <div class="top-meta">
                <div class="top-name" :title="topSong.displayTitle">{{ topSong.displayTitle }}</div>
                <div class="top-sub" :title="topSong.artist">{{ topSong.artist }}</div>
              </div>
              <div class="top-count">
                <span class="top-count-num">{{ topSong.count }}</span>
                <span class="top-count-unit">次播放</span>
              </div>
            </div>
            <n-empty v-else size="small" description="暂无播放记录" />
          </n-card>

          <n-card class="top-card" size="small" :bordered="true">
            <template #header>
              <div class="card-header">
                <n-icon :size="16"><i class="mgc_album_2_line"></i></n-icon>
                <span>最常听的专辑</span>
              </div>
            </template>
            <template #header-extra>
              <n-tag size="small" :bordered="false" class="rank-tag">TOP 1</n-tag>
            </template>

            <div v-if="topAlbum" class="top-item" @click="playTop(topAlbum)">
              <img
                class="top-cover"
                :src="topAlbum.cover || defaultCover"
                loading="lazy"
                decoding="async"
                @error="onCoverError"
              />
              <div class="top-meta">
                <div class="top-name" :title="topAlbum.displayTitle">
                  {{ topAlbum.displayTitle }}
                </div>
                <div class="top-sub" :title="topAlbum.artist">{{ topAlbum.artist }}</div>
              </div>
              <div class="top-count">
                <span class="top-count-num">{{ topAlbum.count }}</span>
                <span class="top-count-unit">次播放</span>
              </div>
            </div>
            <n-empty v-else size="small" description="暂无播放记录" />
          </n-card>

          <n-card class="top-card" size="small" :bordered="true">
            <template #header>
              <div class="card-header">
                <n-icon :size="16"><i class="mgc_user_3_line"></i></n-icon>
                <span>最常听的歌手</span>
              </div>
            </template>
            <template #header-extra>
              <n-tag size="small" :bordered="false" class="rank-tag">TOP 1</n-tag>
            </template>

            <div v-if="topArtist" class="top-item" @click="playTop(topArtist)">
              <img
                class="top-cover"
                :src="topArtist.cover || defaultCover"
                loading="lazy"
                decoding="async"
                @error="onCoverError"
              />
              <div class="top-meta is-centered">
                <div class="top-name" :title="topArtist.displayTitle">
                  {{ topArtist.displayTitle }}
                </div>
              </div>
              <div class="top-count">
                <span class="top-count-num">{{ topArtist.count }}</span>
                <span class="top-count-unit">次播放</span>
              </div>
            </div>
            <n-empty v-else size="small" description="暂无播放记录" />
          </n-card>
        </div>
      </div>
    </n-scrollbar>
  </div>
</template>

<style scoped>
/* ============================================
   基础布局
   ============================================ */
.statistics-view {
  height: 100%;
  --accent: v-bind(accentColor);

  /* 自适应尺寸令牌：宽窗口用基准值，窄窗口由下方 @container 整体下调。
     行元素继承这些变量，卡片内部（.metric-value / .top-cover 等）统一取用。 */
  --stats-gap: 14px;
  --stats-pad: 16px;
  --stats-radius: 14px;
  --metric-value-size: 30px;
  --metric-icon-size: 46px;
  --top-cover-size: 58px;
  --donut-size: 124px;
  --hour-plot-h: 158px;
}

/**
 * 自适应容器：卡片布局的断点必须看「本组件实际可用宽度」，而不是视口宽度。
 *
 * 原因：MainLayout 的侧边栏宽 240px，在窗口 <850px 时折叠为 0。于是
 * 窗口 861px（侧边栏展开）时可用宽度只有 621px，而窗口 849px（侧边栏收起）
 * 时反而有 849px —— 视口宽度的变化与可用宽度**方向相反**，媒体查询无法表达，
 * 只能靠容器查询。
 */
.stats-container {
  container-type: inline-size;
  container-name: stats;
}

.metrics-row {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--stats-gap);
}

.panels-row {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1.25fr) minmax(0, 1fr);
  gap: var(--stats-gap);
  margin-top: var(--stats-gap);
}

.tops-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--stats-gap);
  margin-top: var(--stats-gap);
}

/* ============================================
   概览指标卡
   ============================================ */
.metric-card {
  position: relative;
  overflow: hidden;
  border-radius: var(--stats-radius);
  transition: border-color 0.25s, box-shadow 0.25s, transform 0.25s;
}

.metric-card:hover {
  border-color: var(--accent);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.06);
  transform: translateY(-2px);
}

.metric-card :deep(.n-card__content) {
  padding: calc(var(--stats-pad) - 2px) var(--stats-pad) calc(var(--stats-pad) - 4px);
}

.metric-card :deep(.n-statistic) {
  position: relative;
  z-index: 1;
}

.metric-card :deep(.n-statistic-value) {
  margin-bottom: 2px;
}

.metric-card :deep(.n-statistic-value__content) {
  line-height: 1.1;
}

.metric-value {
  /* 卡片变窄时数字同步收小，避免「3时24分」这类长值把卡片撑破 */
  font-size: var(--metric-value-size);
  font-weight: 700;
  color: var(--n-text-color);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
  white-space: nowrap;
}

.metric-unit {
  margin-left: 3px;
  font-size: calc(var(--metric-value-size) * 0.467);
  font-weight: 600;
  color: var(--n-text-color-3);
}

.metric-label {
  font-size: 12px;
  letter-spacing: 0.5px;
}

.metric-icon {
  position: absolute;
  right: 12px;
  bottom: 8px;
  font-size: var(--metric-icon-size);
  pointer-events: none;
}

/* ============================================
   通用卡片头
   ============================================ */
.panel-card,
.top-card {
  border-radius: var(--stats-radius);
  transition: border-color 0.25s, box-shadow 0.25s;
}

.panel-card:hover,
.top-card:hover {
  border-color: var(--accent);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.05);
}

.panel-card :deep(.n-card-header),
.top-card :deep(.n-card-header) {
  padding: calc(var(--stats-pad) - 2px) var(--stats-pad) 0;
}

.panel-card :deep(.n-card__content),
.top-card :deep(.n-card__content) {
  padding: calc(var(--stats-pad) - 4px) var(--stats-pad) var(--stats-pad);
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--n-text-color);
  min-width: 0;
}

.card-header > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-hint {
  font-size: 12px;
  color: var(--n-text-color-3);
}

.rank-tag {
  font-weight: 700;
  letter-spacing: 0.6px;
}

/* ============================================
   聆听足迹
   ============================================ */
.footprint {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fp-months {
  display: flex;
  gap: 3px;
  margin-left: 34px;
  height: 14px;
}

.fp-month {
  flex: 1 1 0;
  min-width: 0;
  font-size: 11px;
  color: var(--n-text-color-3);
  white-space: nowrap;
  overflow: visible;
}

.fp-body {
  display: flex;
  gap: 8px;
}

.fp-weekdays {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 26px;
  flex-shrink: 0;
  padding-top: 0;
}

.fp-weekdays span {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  font-size: 10px;
  line-height: 1;
  color: var(--n-text-color-3);
}

.fp-grid {
  display: flex;
  gap: 3px;
  flex: 1;
  min-width: 0;
}

.fp-week {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 0;
  min-width: 0;
}

.fp-cell {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 3px;
  transition: transform 0.15s, box-shadow 0.15s;
}

.fp-cell.is-future {
  opacity: 0.35;
}

.fp-cell:hover {
  transform: scale(1.18);
  box-shadow: 0 0 0 1px var(--n-border-color);
}

.fp-legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.fp-legend-cell {
  width: 11px;
  height: 11px;
  aspect-ratio: auto;
  flex-shrink: 0;
}

.fp-legend-cell:hover {
  transform: none;
  box-shadow: none;
}

.fp-legend-text {
  font-size: 11px;
  color: var(--n-text-color-3);
}

/* ============================================
   播放时段
   ============================================ */
.hour-chart {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hour-plot {
  position: relative;
  /* 顶部必须预留「最常播放」气泡的净空：峰值点（viewBox y=88/260）落在
     66.15% 高度处，气泡 8px 偏移 + 约 37px 高度共需约 45px。
     约束式：0.3385 × 本高度 ≥ 8 + 气泡高 → 本高度 ≥ 约 132px。
     故自适应下调时下限取 148px，仍留 5px 余量。（想缩小它请先复核这条不等式） */
  height: var(--hour-plot-h);
}

.hour-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.hour-area {
  fill: url(#hourAreaGradient);
}

.hour-line {
  fill: none;
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.hour-band {
  position: absolute;
  bottom: 0;
  width: 2px;
  transform: translateX(-50%);
  border-radius: 2px;
  pointer-events: none;
}

.hour-peak {
  position: absolute;
  transform: translate(-50%, -8px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 3px 9px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: var(--n-color-card);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  pointer-events: none;
  white-space: nowrap;
}

.hour-peak-label {
  font-size: 10px;
  line-height: 1.2;
  color: var(--n-text-color-3);
}

.hour-peak-time {
  font-size: 13px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--n-text-color);
  font-variant-numeric: tabular-nums;
}

.hour-axis {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--n-text-color-3);
}

.hour-caption {
  font-size: 12px;
  color: var(--n-text-color-3);
}

.hour-caption strong {
  color: var(--n-text-color);
  font-variant-numeric: tabular-nums;
}

/* ============================================
   音频格式
   ============================================ */
.format-body {
  display: flex;
  align-items: center;
  gap: var(--stats-gap);
  min-height: var(--donut-size);
}

.donut {
  position: relative;
  width: var(--donut-size);
  height: var(--donut-size);
  flex-shrink: 0;
}

.donut-svg {
  width: 100%;
  height: 100%;
  display: block;
}

.donut-track {
  fill: none;
  stroke: var(--n-border-color);
  stroke-width: 10;
}

.donut-segment {
  fill: none;
  stroke-width: 10;
}

.donut-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
}

.donut-center-label {
  font-size: 11px;
  color: var(--n-text-color-3);
}

.donut-center-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--n-text-color);
  font-variant-numeric: tabular-nums;
}

.format-legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.format-legend li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.legend-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--n-text-color);
}

.legend-meta {
  margin-left: auto;
  font-size: 11px;
  color: var(--n-text-color-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ============================================
   最常听 TOP 1
   ============================================ */
.top-item {
  display: flex;
  align-items: center;
  gap: calc(var(--stats-gap) - 2px);
  padding: 4px 0;
  border-radius: 10px;
  cursor: pointer;
  min-width: 0;
  transition: background-color 0.2s;
}

.top-item:hover {
  background: var(--n-action-color);
}

.top-cover {
  width: var(--top-cover-size);
  height: var(--top-cover-size);
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
  /* 深色背景兜底：封面未加载完 / 透明 PNG 时也不会露出刺眼的白色方块 */
  background: var(--n-action-color);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.top-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.top-meta.is-centered {
  justify-content: center;
}

.top-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--n-text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.top-sub {
  font-size: 12px;
  color: var(--n-text-color-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.top-count {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  flex-shrink: 0;
}

.top-count-num {
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
  color: var(--n-text-color);
  font-variant-numeric: tabular-nums;
}

.top-count-unit {
  font-size: 11px;
  color: var(--n-text-color-3);
}

/* ============================================
   响应式
   —— 全部用容器查询（断点看「本组件可用宽度」而非视口宽度，见 .stats-container 注释）。
      阈值按各类卡片的最小可用宽度反推：
        指标卡 1 张 ≥ 133px → 5 列需 ≥ 720px，3 列需 ≥ 430px
        面板 1 块 ≥ 265px（环形图 + 图例并排的硬下限）→ 3 列需 ≥ 1000px
        TOP 卡 1 张 ≥ 255px → 3 列需 ≥ 800px
   ============================================ */

/* 紧凑档：可用宽度 ≤ 900px，整体收一档间距与尺寸 */
@container stats (max-width: 900px) {
  .metrics-row,
  .panels-row,
  .tops-row {
    --stats-gap: 12px;
    --stats-pad: 14px;
    --stats-radius: 12px;
    --metric-value-size: 26px;
    --metric-icon-size: 40px;
    --top-cover-size: 52px;
    --donut-size: 108px;
    --hour-plot-h: 152px;
  }
}

/* 窄档：可用宽度 ≤ 700px，再收一档 */
@container stats (max-width: 700px) {
  .metrics-row,
  .panels-row,
  .tops-row {
    --stats-gap: 10px;
    --stats-pad: 12px;
    --metric-value-size: 24px;
    --metric-icon-size: 34px;
    --top-cover-size: 46px;
    --donut-size: 96px;
    /* 下限 148px：再小会让「最常播放」气泡顶穿卡片，见 .hour-plot 注释 */
    --hour-plot-h: 148px;
  }
}

/* 指标行：5 列 → 3 列 → 2 列 */
@container stats (max-width: 720px) {
  .metrics-row {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@container stats (max-width: 430px) {
  .metrics-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* 三列面板的中等宽度区间（1001–1180px）：环形图收一档。
   实测最窄的格式卡在这个区间内，「格式名 + 计数」需 117px 而只剩 107px，会挤溢出 */
@container stats (min-width: 1001px) and (max-width: 1180px) {
  .panel-card--format {
    --donut-size: 104px;
  }
}

/* 面板行：3 列 → 2 列（音频格式卡占满整行）→ 1 列 */
@container stats (max-width: 1000px) {
  .panels-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .panel-card--format {
    grid-column: 1 / -1;
  }

  /* 格式卡变成整行后，把「环形图 + 图例」这组内容居中并限宽，
     否则图例会被拉成一条、计数被推到卡片最右边 */
  .format-body {
    max-width: 460px;
    margin: 0 auto;
  }
}

@container stats (max-width: 520px) {
  .panels-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .panel-card--format {
    grid-column: auto;
  }
}

/* TOP 行：3 列 → 2 列（歌手卡占满整行）→ 1 列 */
@container stats (max-width: 800px) {
  .tops-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .top-card:last-child {
    grid-column: 1 / -1;
  }
}

@container stats (max-width: 520px) {
  .tops-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .top-card:last-child {
    grid-column: auto;
  }
}
</style>
