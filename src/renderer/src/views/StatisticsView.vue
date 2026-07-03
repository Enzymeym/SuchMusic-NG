<script setup lang="ts">
import { computed, onMounted, ref, watch, nextTick } from 'vue'
import { NIcon, NScrollbar, NSelect } from 'naive-ui'
import defaultCover from '@renderer/assets/icon.png'
import { usePlayerStore } from '../stores/playerStore'

const playerStore = usePlayerStore()

/**
 * 动画数字：用于概览卡片中的数字滚动效果
 * @param target 目标数值
 * @returns 动画中的当前显示值
 */
const useAnimatedNumber = (initialValue: number = 0) => {
  const displayValue = ref(initialValue)
  let animationFrame: number | null = null
  let startTime: number | null = null
  let startValue = initialValue
  let targetValue = initialValue

  /**
   * 启动数字动画
   * @param to 目标值
   * @param duration 动画持续时间（毫秒）
   */
  const animateTo = (to: number, duration: number = 800) => {
    if (animationFrame) cancelAnimationFrame(animationFrame)
    startValue = displayValue.value
    targetValue = to
    startTime = null

    const step = (timestamp: number) => {
      if (!startTime) startTime = timestamp
      const elapsed = timestamp - startTime
      const progress = Math.min(elapsed / duration, 1)
      // 缓出函数
      const eased = 1 - Math.pow(1 - progress, 3)
      displayValue.value = Math.round(startValue + (targetValue - startValue) * eased)
      if (progress < 1) {
        animationFrame = requestAnimationFrame(step)
      }
    }
    animationFrame = requestAnimationFrame(step)
  }

  return { displayValue, animateTo }
}

const animatedTotalMinutes = useAnimatedNumber(0)
const animatedMonthlyMinutes = useAnimatedNumber(0)
const animatedYearlyMinutes = useAnimatedNumber(0)
const animatedDailyMinutes = useAnimatedNumber(0)

// 初始化加载
onMounted(() => {
  playerStore.loadHistory()
})

// 月份和年份选择
const now = new Date()
const monthNames = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']
const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]

const selectedMonth = ref(now.getMonth())
const selectedYear = ref(now.getFullYear())

// 计算有数据的月份
const availableMonths = computed(() => {
  const months = new Set<number>()
  playerStore.playHistory.forEach((record) => {
    const d = new Date(record.timestamp)
    if (d.getFullYear() === selectedYear.value) {
      months.add(d.getMonth())
    }
  })
  return Array.from(months).sort((a, b) => a - b)
})

const currentMonth = computed(() => monthNames[selectedMonth.value] + '月')
const currentYear = computed(() => selectedYear.value + '年')

// 计算总播放时长（分钟）
const totalMinutes = computed(() => {
  const filteredHistory = playerStore.playHistory.filter((record) => {
    const d = new Date(record.timestamp)
    return d.getMonth() === selectedMonth.value && d.getFullYear() === selectedYear.value
  })
  
  // 假设每首歌平均播放时长为3.5分钟
  const averageSongDuration = 3.5
  return Math.round(filteredHistory.length * averageSongDuration)
})

// 计算月度播放时长
const monthlyMinutes = computed(() => {
  return totalMinutes.value
})

// 计算年度播放时长
const yearlyMinutes = computed(() => {
  const filteredHistory = playerStore.playHistory.filter((record) => {
    const d = new Date(record.timestamp)
    return d.getFullYear() === selectedYear.value
  })
  const averageSongDuration = 3.5
  return Math.round(filteredHistory.length * averageSongDuration)
})

// 计算平均每日播放时长
const averageDailyMinutes = computed(() => {
  const daysInMonth = new Date(selectedYear.value, selectedMonth.value + 1, 0).getDate()
  const currentDay = now.getDate()
  const maxDay = Math.min(currentDay, daysInMonth)
  return Math.round(monthlyMinutes.value / maxDay)
})

// 计算最活跃的时间段
const mostActiveHour = computed(() => {
  const filteredHistory = playerStore.playHistory.filter((record) => {
    const d = new Date(record.timestamp)
    return d.getFullYear() === selectedYear.value && d.getMonth() === selectedMonth.value
  })
  
  if (filteredHistory.length === 0) return '无'
  
  const hourCounts: Record<string, number> = {}
  filteredHistory.forEach((record) => {
    const hour = new Date(record.timestamp).getHours()
    const hourStr = hour.toString().padStart(2, '0') + ':00'
    hourCounts[hourStr] = (hourCounts[hourStr] || 0) + 1
  })
  
  let maxHour = ''
  let maxCount = -1
  
  for (const [hour, count] of Object.entries(hourCounts)) {
    if (count > maxCount) {
      maxCount = count
      maxHour = hour
    }
  }
  
  return maxHour
})

// 获取排名前几的项目
const getTopItems = (key: 'songId' | 'artist' | 'album', limit: number = 3) => {
  const filteredHistory = playerStore.playHistory.filter((record) => {
    const d = new Date(record.timestamp)
    return d.getFullYear() === selectedYear.value && d.getMonth() === selectedMonth.value
  })
  
  if (filteredHistory.length === 0) return []

  const counts: Record<string, number> = {}
  filteredHistory.forEach((record) => {
    const val = key === 'songId' ? String(record.songId) : record[key] || '未知'
    if (!val) return
    counts[val] = (counts[val] || 0) + 1
  })

  // 排序并获取前limit个
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)

  // 转换为完整对象
  return sorted.map(([keyVal, count]) => {
    const record = filteredHistory.find((r) =>
      key === 'songId' ? String(r.songId) == keyVal : (r[key] || '未知') == keyVal
    )
    return {
      ...record,
      count,
      displayTitle: key === 'songId' ? record?.title : keyVal
    }
  })
}

const topSongs = computed(() => getTopItems('songId', 4))
const topArtists = computed(() => getTopItems('artist', 2))
const topAlbums = computed(() => getTopItems('album', 3))

const statsBgImage = computed(() => {
  return `url("${topSongs.value[0]?.cover || defaultCover}")`
})

const weeklyActivity = computed(() => {
  const days = Array(7).fill(0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Find most recent Monday
  const dayOfWeek = today.getDay() // 0(Sun) - 6(Sat)
  const distToMon = (dayOfWeek + 6) % 7 // Mon is 0 distance, Sun is 6
  const monday = new Date(today.getTime() - distToMon * 24 * 60 * 60 * 1000)

  playerStore.playHistory.forEach((record) => {
    const d = new Date(record.timestamp)
    if (d >= monday) {
      const dayIndex = (d.getDay() + 6) % 7 // Mon=0, Sun=6
      days[dayIndex]++
    }
  })

  const max = Math.max(...days, 5) // At least 5 to avoid huge bars for 1 play
  return days.map((count) => Math.round((count / max) * 100))
})

/**
 * 监听计算值变化，触发数字动画
 */
watch(totalMinutes, (val) => {
  nextTick(() => animatedTotalMinutes.animateTo(val))
}, { immediate: true })

watch(monthlyMinutes, (val) => {
  nextTick(() => animatedMonthlyMinutes.animateTo(val))
}, { immediate: true })

watch(yearlyMinutes, (val) => {
  nextTick(() => animatedYearlyMinutes.animateTo(val))
}, { immediate: true })

watch(averageDailyMinutes, (val) => {
  nextTick(() => animatedDailyMinutes.animateTo(val))
}, { immediate: true })

/**
 * 指标卡片配置：图标与颜色映射
 */
interface MetricConfig {
  icon: string
  color: string
}
const metricConfigs: Record<string, MetricConfig> = {
  'monthly': { icon: 'mgc_time_line', color: '#ff9a9e' },
  'yearly': { icon: 'mgc_calendar_2_line', color: '#a18cd1' },
  'daily': { icon: 'mgc_chart_bar_line', color: '#fbc2eb' },
  'active': { icon: 'mgc_flash_line', color: '#fda085' }
}

const metrics = computed(() => [
  { key: 'monthly', value: animatedMonthlyMinutes.displayValue, label: '本月时长', unit: '分钟' },
  { key: 'yearly', value: animatedYearlyMinutes.displayValue, label: '本年时长', unit: '分钟' },
  { key: 'daily', value: animatedDailyMinutes.displayValue, label: '日均时长', unit: '分钟' },
  { key: 'active', value: mostActiveHour.value, label: '最活跃时段', unit: '' }
])
</script>

<template>
  <div style="height: 100%">
    <n-scrollbar style="height: 100%" content-style="padding: 16px 24px;">
      <div class="statistics-view">
        <!-- Page Header -->
        <div class="header-section">
          <div class="header-content">
            <div class="header-left">
              <h1 class="page-title">音乐回忆</h1>
              <div class="month-selector">
                <div
                  v-for="index in availableMonths"
                  :key="index"
                  class="month-tab"
                  :class="{ active: selectedMonth === index }"
                  @click="selectedMonth = index"
                >
                  <span class="month-tab-text">{{ monthNames[index] }}月</span>
                  <span v-if="selectedMonth === index" class="month-tab-dot"></span>
                </div>
              </div>
            </div>
            <div class="header-right">
              <n-select
                v-model:value="selectedYear"
                :options="years.map(year => ({ label: year + '年', value: year }))"
                :bordered="false"
                class="year-select"
              />
            </div>
          </div>
        </div>

        <!-- 概览卡片 -->
        <div class="overview-section">
          <div class="stats-card">
            <!-- 卡片背景遮罩 -->
            <div class="card-bg-overlay"></div>
            <div class="card-bg-gradient"></div>

            <!-- 左侧：日期和总播放时长 -->
            <div class="stats-left">
              <div class="date-group">
                <div class="month">{{ currentMonth }}</div>
                <div class="year">{{ currentYear }}</div>
              </div>
              <div class="play-total-group">
                <div class="total-desc">总聆听时长</div>
                <div class="total-count">
                  <span class="total-number">{{ animatedTotalMinutes.displayValue }}</span>
                  <span class="total-unit">分钟</span>
                </div>
              </div>
            </div>

            <!-- 中间：关键指标带图标 -->
            <div class="stats-middle">
              <div class="metrics-grid">
                <div
                  v-for="metric in metrics"
                  :key="metric.key"
                  class="metric-item"
                  :style="{ '--metric-color': metricConfigs[metric.key]?.color || '#fff' }"
                >
                  <div class="metric-icon">
                    <n-icon size="18">
                      <i :class="metricConfigs[metric.key]?.icon || 'mgc_chart_line'"></i>
                    </n-icon>
                  </div>
                  <div class="metric-content">
                    <div class="metric-value">
                      {{ metric.value }}<span v-if="metric.unit" class="metric-unit">{{ metric.unit }}</span>
                    </div>
                    <div class="metric-label">{{ metric.label }}</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 右侧：周活跃度 -->
            <div class="stats-right">
              <div class="column-header">活跃动态（周）</div>
              <div class="activity-chart">
                <div class="chart-bar-wrapper" v-for="(value, i) in weeklyActivity" :key="i">
                  <div
                    class="chart-bar"
                    :style="{
                      height: value + '%',
                      '--bar-height': value + '%'
                    }"
                  ></div>
                  <div class="chart-label">
                    {{ ['一', '二', '三', '四', '五', '六', '日'][i] }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 最爱内容 -->
        <div class="favorites-section">
          <!-- 最爱艺人 -->
          <div class="favorite-section">
            <div class="section-header-row">
              <h2 class="section-title">你的最爱艺人</h2>
              <span class="section-count">TOP {{ topArtists.length }}</span>
            </div>
            <div class="artists-grid" v-if="topArtists.length > 0">
              <div
                v-for="(artist, index) in topArtists"
                :key="index"
                class="artist-card"
                :style="{ animationDelay: (index * 0.1) + 's' }"
              >
                <div class="artist-rank" :class="'rank-' + (index + 1)">{{ index + 1 }}</div>
                <div class="artist-img-wrapper">
                  <img :src="artist.cover || defaultCover" class="artist-img" />
                  <div class="artist-img-ring"></div>
                </div>
                <div class="artist-name">{{ artist.displayTitle }}</div>
                <div class="artist-meta">
                  <n-icon size="14"><i class="mgc_time_line"></i></n-icon>
                  <span>{{ Math.round(artist.count * 3.5) }} 分钟</span>
                </div>
              </div>
            </div>
            <div class="empty-state" v-else>
              <n-icon size="48" color="var(--n-text-color-3)"><i class="mgc_user_3_line"></i></n-icon>
              <span>暂无播放记录</span>
            </div>
          </div>

          <!-- 最爱歌曲 -->
          <div class="favorite-section">
            <div class="section-header-row">
              <h2 class="section-title">你的最爱歌曲</h2>
              <span class="section-count">TOP {{ topSongs.length }}</span>
            </div>
            <div class="songs-list" v-if="topSongs.length > 0">
              <div
                v-for="(song, index) in topSongs"
                :key="index"
                class="song-item"
                :style="{ animationDelay: (index * 0.08) + 's' }"
              >
                <div class="song-rank" :class="{ 'rank-highlight': index < 3 }">
                  <template v-if="index === 0">
                    <span class="rank-medal rank-gold">1</span>
                  </template>
                  <template v-else-if="index === 1">
                    <span class="rank-medal rank-silver">2</span>
                  </template>
                  <template v-else-if="index === 2">
                    <span class="rank-medal rank-bronze">3</span>
                  </template>
                  <template v-else>
                    {{ index + 1 }}
                  </template>
                </div>
                <div class="song-cover-wrapper">
                  <img :src="song.cover || defaultCover" class="song-img" />
                  <div class="song-play-overlay">
                    <n-icon size="18" color="white"><i class="mgc_play_fill"></i></n-icon>
                  </div>
                </div>
                <div class="song-info">
                  <div class="song-name">{{ song.displayTitle }}</div>
                  <div class="song-artist">{{ song.artist }}</div>
                </div>
                <div class="song-stats">
                  <span class="song-plays-count">{{ song.count }}</span>
                  <span class="song-plays-label">次播放</span>
                </div>
              </div>
            </div>
            <div class="empty-state" v-else>
              <n-icon size="48" color="var(--n-text-color-3)"><i class="mgc_music_2_line"></i></n-icon>
              <span>暂无播放记录</span>
            </div>
          </div>

          <!-- 最爱专辑 -->
          <div class="favorite-section">
            <div class="section-header-row">
              <h2 class="section-title">你的最爱专辑</h2>
              <span class="section-count">TOP {{ topAlbums.length }}</span>
            </div>
            <div class="albums-grid" v-if="topAlbums.length > 0">
              <div
                v-for="(album, index) in topAlbums"
                :key="index"
                class="album-card"
                :style="{ animationDelay: (index * 0.12) + 's' }"
              >
                <div class="album-img-wrapper">
                  <img :src="album.cover || defaultCover" class="album-img" />
                  <div class="album-img-overlay">
                    <span class="album-rank-badge">{{ index + 1 }}</span>
                  </div>
                </div>
                <div class="album-name">{{ album.displayTitle }}</div>
                <div class="album-plays">{{ album.count }} 次</div>
              </div>
            </div>
            <div class="empty-state" v-else>
              <n-icon size="48" color="var(--n-text-color-3)"><i class="mgc_album_line"></i></n-icon>
              <span>暂无播放记录</span>
            </div>
          </div>
        </div>
      </div>
    </n-scrollbar>
  </div>
</template>

<style scoped>
/* ============================================
   全局动画定义
   ============================================ */
@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes fadeInRight {
  from {
    opacity: 0;
    transform: translateX(-12px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes shimmer {
  0% { background-position: -200% center; }
  100% { background-position: 200% center; }
}

@keyframes pulse-ring {
  0% { transform: scale(1); opacity: 0.6; }
  100% { transform: scale(1.15); opacity: 0; }
}

@keyframes gradientShift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

.statistics-view {
  min-height: 100%;
}

/* ============================================
   头部样式
   ============================================ */
.header-section {
  margin: 8px 0 20px 0;
}

.header-content {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
}

.header-left {
  flex: 1;
}

.page-title {
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 16px 0;
  color: var(--n-text-color);
  letter-spacing: 0.5px;
}

.month-selector {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 6px;
  scroll-behavior: smooth;
}

.month-selector::-webkit-scrollbar {
  height: 3px;
}

.month-selector::-webkit-scrollbar-track {
  background: transparent;
}

.month-selector::-webkit-scrollbar-thumb {
  background: var(--n-border-color);
  border-radius: 3px;
}

.month-tab {
  position: relative;
  padding: 8px 18px;
  border-radius: 24px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  white-space: nowrap;
  background: var(--n-color-card);
  border: 1px solid var(--n-border-color);
  user-select: none;
}

.month-tab:hover {
  border-color: var(--n-primary-color);
  background: var(--n-primary-color-suppl, rgba(var(--n-primary-color-rgb), 0.08));
}

.month-tab.active {
  background: var(--n-primary-color);
  color: #fff;
  font-weight: 600;
  border-color: var(--n-primary-color);
  box-shadow: 0 2px 8px rgba(var(--n-primary-color-rgb, 0, 0, 0), 0.3);
}

.month-tab-dot {
  display: none;
}

.month-tab-text {
  position: relative;
  z-index: 1;
}

.header-right {
  display: flex;
  align-items: center;
  padding-top: 2px;
}

.year-select {
  min-width: 100px;
}

/* ============================================
   概览卡片
   ============================================ */
.overview-section {
  margin: 20px 0;
}

.stats-card {
  position: relative;
  overflow: hidden;
  border-radius: 20px;
  padding: 28px;
  color: white;
  display: grid;
  grid-template-columns: 1.2fr 2.2fr 1fr;
  gap: 28px;
  min-height: 210px;
  z-index: 1;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  box-shadow:
    0 8px 32px rgba(102, 126, 234, 0.25),
    0 2px 8px rgba(0, 0, 0, 0.1);
}

/* 背景图层 */
.card-bg-overlay {
  position: absolute;
  inset: 0;
  z-index: 0;
  background-image: v-bind(statsBgImage);
  background-size: cover;
  background-position: center;
  filter: blur(50px) brightness(0.35);
  transform: scale(1.3);
}

.card-bg-gradient {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: linear-gradient(
    135deg,
    rgba(102, 126, 234, 0.5) 0%,
    rgba(118, 75, 162, 0.3) 50%,
    rgba(102, 126, 234, 0.5) 100%
  );
  background-size: 200% 200%;
  animation: gradientShift 8s ease infinite;
}

/* 保证内容在背景上方 */
.stats-left,
.stats-middle,
.stats-right {
  position: relative;
  z-index: 1;
}

/* 左侧 */
.stats-left {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding-right: 28px;
  border-right: 1px solid rgba(255, 255, 255, 0.15);
}

.date-group {
  margin-bottom: 8px;
}

.month {
  font-size: 38px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: 1px;
}

.year {
  font-size: 16px;
  opacity: 0.75;
  margin-top: 6px;
  font-weight: 500;
}

.play-total-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.total-desc {
  font-size: 13px;
  opacity: 0.7;
  text-transform: uppercase;
  letter-spacing: 1px;
  font-weight: 500;
}

.total-count {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.total-number {
  font-size: 52px;
  font-weight: 800;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  background: linear-gradient(to right, #fff, rgba(255, 255, 255, 0.85));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.total-unit {
  font-size: 14px;
  opacity: 0.6;
  font-weight: 500;
}

/* 中间指标卡片 */
.stats-middle {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
}

.metric-item {
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 14px 16px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: default;
}

.metric-item:hover {
  background: rgba(255, 255, 255, 0.15);
  transform: translateY(-3px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  border-color: rgba(255, 255, 255, 0.15);
}

.metric-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--metric-color, rgba(255, 255, 255, 0.15));
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: transform 0.3s;
}

.metric-item:hover .metric-icon {
  transform: scale(1.1);
}

.metric-content {
  min-width: 0;
}

.metric-value {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.metric-unit {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.65;
  margin-left: 2px;
}

.metric-label {
  font-size: 11px;
  opacity: 0.6;
  margin-top: 2px;
  font-weight: 500;
}

/* 右侧活跃度 */
.stats-right {
  padding-left: 28px;
  border-left: 1px solid rgba(255, 255, 255, 0.15);
  display: flex;
  flex-direction: column;
}

.column-header {
  font-size: 12px;
  opacity: 0.65;
  margin-bottom: 16px;
  font-weight: 500;
  letter-spacing: 0.5px;
}

.activity-chart {
  flex: 1;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 4px;
}

.chart-bar-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  height: 100%;
  justify-content: flex-end;
  cursor: pointer;
  transition: transform 0.2s;
}

.chart-bar-wrapper:hover {
  transform: translateY(-4px);
}

.chart-bar {
  width: 10px;
  min-height: 4px;
  border-radius: 5px;
  transition:
    height 0.6s cubic-bezier(0.34, 1.56, 0.64, 1),
    background 0.3s;
  background: linear-gradient(
    to top,
    rgba(255, 255, 255, 0.9),
    rgba(255, 255, 255, 0.35)
  );
}

.chart-bar-wrapper:hover .chart-bar {
  background: linear-gradient(
    to top,
    #fff,
    rgba(255, 255, 255, 0.5)
  );
  box-shadow: 0 0 12px rgba(255, 255, 255, 0.3);
}

.chart-label {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.55);
  font-weight: 500;
  transition: color 0.2s;
}

.chart-bar-wrapper:hover .chart-label {
  color: rgba(255, 255, 255, 0.9);
}

/* ============================================
   最爱内容部分
   ============================================ */
.favorites-section {
  margin: 36px 0;
  display: flex;
  flex-direction: column;
  gap: 40px;
}

.favorite-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-header-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.section-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--n-text-color);
  margin: 0;
  letter-spacing: 0.3px;
}

.section-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--n-text-color-3);
  background: var(--n-color-card);
  padding: 3px 10px;
  border-radius: 12px;
  letter-spacing: 0.5px;
}

/* ============================================
   艺人卡片（玻璃态）
   ============================================ */
.artists-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 20px;
}

.artist-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 18px 20px;
  background: var(--n-color-card);
  border-radius: 16px;
  border: 1px solid var(--n-border-color);
  transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
  animation: fadeInUp 0.5s ease forwards;
  opacity: 0;
  cursor: default;
}

.artist-card::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 16px;
  background: radial-gradient(
    circle at 50% 0%,
    var(--n-primary-color-suppl, rgba(0, 0, 0, 0.03)) 0%,
    transparent 70%
  );
  opacity: 0;
  transition: opacity 0.35s;
}

.artist-card:hover {
  transform: translateY(-6px);
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.08),
    0 4px 12px rgba(0, 0, 0, 0.04);
  border-color: var(--n-primary-color);
}

.artist-card:hover::after {
  opacity: 1;
}

/* 排名徽章 */
.artist-rank {
  position: absolute;
  top: 12px;
  left: 12px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  z-index: 2;
  color: white;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
}

.rank-1 {
  background: linear-gradient(135deg, #f6d365, #fda085);
}

.rank-2 {
  background: linear-gradient(135deg, #a1c4fd, #c2e9fb);
  color: #555;
}

/* 艺人头像容器 */
.artist-img-wrapper {
  position: relative;
  width: 100px;
  height: 100px;
  margin: 20px 0 14px;
}

.artist-img {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  object-fit: cover;
  position: relative;
  z-index: 1;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.artist-card:hover .artist-img {
  transform: scale(1.06);
}

.artist-img-ring {
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 2px solid transparent;
  border-top-color: var(--n-primary-color);
  opacity: 0;
  transition: opacity 0.3s;
  z-index: 0;
}

.artist-card:hover .artist-img-ring {
  opacity: 0.5;
  animation: pulse-ring 1.2s ease-out infinite;
}

.artist-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--n-text-color);
  margin-bottom: 6px;
  text-align: center;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artist-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--n-text-color-2);
}

/* ============================================
   歌曲列表
   ============================================ */
.songs-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.song-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  background: var(--n-color-card);
  border-radius: 12px;
  border: 1px solid var(--n-border-color);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  animation: fadeInRight 0.4s ease forwards;
  opacity: 0;
  cursor: default;
}

.song-item:nth-child(odd) {
  background: var(--n-color-card);
}

.song-item:nth-child(even) {
  background: var(--n-color-modal);
}

.song-item:hover {
  transform: translateX(6px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
  border-color: var(--n-primary-color);
}

/* 排名样式 */
.song-rank {
  width: 32px;
  flex-shrink: 0;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  color: var(--n-text-color-3);
  font-variant-numeric: tabular-nums;
}

.rank-medal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
}

.rank-gold {
  background: linear-gradient(135deg, #f6d365, #fda085);
  box-shadow: 0 2px 6px rgba(246, 211, 101, 0.3);
}

.rank-silver {
  background: linear-gradient(135deg, #a8c0ff, #c2e9fb);
  box-shadow: 0 2px 6px rgba(168, 192, 255, 0.3);
}

.rank-bronze {
  background: linear-gradient(135deg, #f5af19, #f12711);
  box-shadow: 0 2px 6px rgba(245, 175, 25, 0.3);
}

/* 歌曲封面容器 */
.song-cover-wrapper {
  position: relative;
  width: 52px;
  height: 52px;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
}

.song-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s;
}

.song-item:hover .song-img {
  transform: scale(1.08);
}

.song-play-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.25s;
}

.song-item:hover .song-play-overlay {
  opacity: 1;
}

.song-info {
  flex: 1;
  min-width: 0;
}

.song-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--n-text-color);
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-artist {
  font-size: 12px;
  color: var(--n-text-color-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-stats {
  display: flex;
  align-items: baseline;
  gap: 4px;
  flex-shrink: 0;
}

.song-plays-count {
  font-size: 18px;
  font-weight: 700;
  color: var(--n-text-color);
  font-variant-numeric: tabular-nums;
}

.song-plays-label {
  font-size: 11px;
  color: var(--n-text-color-3);
}

/* ============================================
   专辑网格
   ============================================ */
.albums-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 20px;
}

.album-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 12px 14px;
  background: var(--n-color-card);
  border-radius: 14px;
  border: 1px solid var(--n-border-color);
  transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  animation: fadeInUp 0.5s ease forwards;
  opacity: 0;
  cursor: default;
}

.album-card:hover {
  transform: translateY(-6px);
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.08),
    0 4px 12px rgba(0, 0, 0, 0.04);
  border-color: var(--n-primary-color);
}

/* 专辑封面容器 */
.album-img-wrapper {
  position: relative;
  width: 100px;
  height: 100px;
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.album-card:hover .album-img-wrapper {
  transform: scale(1.04);
}

.album-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.album-img-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.5) 0%,
    transparent 40%
  );
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  padding: 8px;
}

.album-rank-badge {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(4px);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
}

.album-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--n-text-color);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
  margin-bottom: 4px;
}

.album-plays {
  font-size: 11px;
  color: var(--n-text-color-3);
}

/* ============================================
   空状态
   ============================================ */
.empty-state {
  padding: 56px 24px;
  background: var(--n-color-card);
  border-radius: 14px;
  border: 1px dashed var(--n-border-color);
  text-align: center;
  color: var(--n-text-color-3);
  font-size: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  animation: fadeInUp 0.4s ease forwards;
}

/* ============================================
   响应式设计
   ============================================ */
@media (max-width: 950px) {
  .stats-card {
    grid-template-columns: 1fr 1.5fr;
    padding: 24px;
  }
  .stats-right {
    display: none !important;
  }
}

@media (max-width: 768px) {
  .header-content {
    flex-direction: column;
    align-items: flex-start;
  }

  .stats-card {
    grid-template-columns: 1fr;
    gap: 18px;
    padding: 20px;
  }

  .stats-left {
    border-right: none !important;
    padding-right: 0 !important;
    border-bottom: 1px solid rgba(255, 255, 255, 0.15);
    padding-bottom: 18px;
  }

  .metrics-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }

  .total-number {
    font-size: 40px;
  }

  .month-selector {
    width: 100%;
  }

  .month-tab {
    padding: 6px 14px;
    font-size: 13px;
  }

  .artists-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .albums-grid {
    grid-template-columns: repeat(3, 1fr);
  }

  .song-item {
    gap: 10px;
    padding: 12px;
  }

  .song-cover-wrapper {
    width: 44px;
    height: 44px;
  }

  .song-plays-count {
    font-size: 16px;
  }
}

@media (max-width: 480px) {
  .artists-grid {
    grid-template-columns: 1fr;
  }

  .albums-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .total-number {
    font-size: 34px;
  }

  .month {
    font-size: 28px;
  }

  .metrics-grid {
    grid-template-columns: 1fr;
  }

  .metric-item {
    padding: 12px;
  }
}
</style>