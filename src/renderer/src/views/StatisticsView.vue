<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NPageHeader, NGrid, NGridItem, NIcon, NButton, NScrollbar, NSelect } from 'naive-ui'
import { useRouter } from 'vue-router'
import defaultCover from '@renderer/assets/icon.png'
import { usePlayerStore } from '../stores/playerStore'

const playerStore = usePlayerStore()
const router = useRouter()

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

// Helper to find top item
const getTopItem = (key: 'songId' | 'artist' | 'album') => {
  const filteredHistory = playerStore.playHistory.filter((record) => {
    const d = new Date(record.timestamp)
    return d.getFullYear() === selectedYear.value && d.getMonth() === selectedMonth.value
  })
  
  if (filteredHistory.length === 0) return null

  const counts: Record<string, number> = {}
  filteredHistory.forEach((record) => {
    const val = key === 'songId' ? String(record.songId) : record[key] || '未知'
    if (!val) return
    counts[val] = (counts[val] || 0) + 1
  })

  let maxVal: string | null = null
  let maxCount = -1

  for (const [k, v] of Object.entries(counts)) {
    if (v > maxCount) {
      maxCount = v
      maxVal = k
    }
  }

  if (!maxVal) return null

  // Find the record for details
  const record = filteredHistory.find((r) =>
    key === 'songId' ? String(r.songId) == maxVal : (r[key] || '未知') == maxVal
  )

  return {
    ...record,
    count: maxCount,
    displayTitle: key === 'songId' ? record?.title : maxVal
  }
}

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

// 导航回主页
const goBack = () => {
  router.push({ name: 'home' })
}
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
                  {{ monthNames[index] }}
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
            <!-- 左侧：日期和总播放时长 -->
            <div class="stats-left">
              <div class="date-group">
                <div class="month">{{ currentMonth }}</div>
                <div class="year">{{ currentYear }}</div>
              </div>

              <div class="play-total-group">
                <div class="total-count">{{ totalMinutes }}</div>
                <div class="total-label">分钟</div>
              </div>
              <div class="total-desc">你聆听了</div>
            </div>

            <!-- 中间：关键指标 -->
            <div class="stats-middle">
              <div class="metrics-grid">
                <div class="metric-item">
                  <div class="metric-value">{{ monthlyMinutes }}</div>
                  <div class="metric-label">本月时长</div>
                </div>
                <div class="metric-item">
                  <div class="metric-value">{{ yearlyMinutes }}</div>
                  <div class="metric-label">本年时长</div>
                </div>
                <div class="metric-item">
                  <div class="metric-value">{{ averageDailyMinutes }}</div>
                  <div class="metric-label">日均时长</div>
                </div>
                <div class="metric-item">
                  <div class="metric-value">{{ mostActiveHour }}</div>
                  <div class="metric-label">最活跃时段</div>
                </div>
              </div>
            </div>

            <!-- 右侧：周活跃度 -->
            <div class="stats-right">
              <div class="column-header">活跃动态（周）</div>
              <div class="activity-chart">
                <div class="chart-bar-wrapper" v-for="i in 7" :key="i">
                  <div class="chart-bar" :style="{ height: weeklyActivity[i - 1] + '%' }"></div>
                  <div class="chart-label">
                    {{ ['一', '二', '三', '四', '五', '六', '日'][i - 1] }}
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
            <h2 class="section-title">你的最爱艺人</h2>
            <div class="artists-grid" v-if="topArtists.length > 0">
              <div 
                v-for="(artist, index) in topArtists" 
                :key="index"
                class="artist-card"
              >
                <div class="artist-rank">{{ index + 1 }}</div>
                <img :src="artist.cover || defaultCover" class="artist-img" />
                <div class="artist-name">{{ artist.displayTitle }}</div>
                <div class="artist-minutes">{{ Math.round(artist.count * 3.5) }} 分钟</div>
              </div>
            </div>
            <div class="empty-state" v-else>
              暂无播放记录
            </div>
          </div>

          <!-- 最爱歌曲 -->
          <div class="favorite-section">
            <h2 class="section-title">你的最爱歌曲</h2>
            <div class="songs-list" v-if="topSongs.length > 0">
              <div 
                v-for="(song, index) in topSongs" 
                :key="index"
                class="song-item"
              >
                <div class="song-rank">{{ index + 1 }}</div>
                <img :src="song.cover || defaultCover" class="song-img" />
                <div class="song-info">
                  <div class="song-name">{{ song.displayTitle }}</div>
                  <div class="song-artist">{{ song.artist }}</div>
                </div>
                <div class="song-plays">{{ song.count }} 次</div>
                <div class="song-more">
                  <n-button secondary circle size="small">
                    <n-icon><i class="mgc_more_2_line"></i></n-icon>
                  </n-button>
                </div>
              </div>
            </div>
            <div class="empty-state" v-else>
              暂无播放记录
            </div>
          </div>

          <!-- 最爱专辑 -->
          <div class="favorite-section">
            <h2 class="section-title">你的最爱专辑</h2>
            <div class="albums-grid" v-if="topAlbums.length > 0">
              <div 
                v-for="(album, index) in topAlbums" 
                :key="index"
                class="album-card"
              >
                <div class="album-rank">{{ index + 1 }}</div>
                <img :src="album.cover || defaultCover" class="album-img" />
                <div class="album-name">{{ album.displayTitle }}</div>
              </div>
            </div>
            <div class="empty-state" v-else>
              暂无播放记录
            </div>
          </div>
        </div>
      </div>
    </n-scrollbar>
  </div>
</template>

<style scoped>
.statistics-view {
  min-height: 100%;
}

/* 头部样式 */
.header-section {
  margin: 16px 0 24px 0;
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
    font-weight: bold;
    margin-bottom: 16px;
    color: var(--n-text-color);
  }

.month-selector {
  display: flex;
  gap: 16px;
  overflow-x: auto;
  padding-bottom: 8px;
}

.month-selector::-webkit-scrollbar {
  height: 4px;
}

.month-selector::-webkit-scrollbar-track {
  background: rgba(0, 0, 0, 0.05);
  border-radius: 2px;
}

.month-selector::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 2px;
}

.month-tab {
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.3s;
  white-space: nowrap;
}

.month-tab:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

.month-tab.active {
  background-color: var(--n-primary-color);
  color: white;
  font-weight: 600;
}

.header-right {
  display: flex;
  align-items: center;
}

.year-select {
  min-width: 100px;
}

/* 概览卡片 */
.overview-section {
  margin: 24px 0;
}

.stats-card {
    position: relative;
    overflow: hidden;
    border-radius: 16px;
    padding: 24px;
    color: white;
    display: grid;
    backdrop-filter: blur(100px);
    grid-template-columns: 1.5fr 2fr 1fr;
    gap: 24px;
    min-height: 200px;
    z-index: 1;
    background-color: var(--n-primary-color);
  }

@media (max-width: 950px) {
  .stats-card {
    grid-template-columns: 1fr 1.5fr;
  }
  .stats-right {
    display: none !important;
  }
}

@media (max-width: 768px) {
  .stats-card {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .stats-left {
    border-right: none !important;
    padding-right: 0 !important;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    padding-bottom: 16px;
  }
}

.stats-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: v-bind(statsBgImage);
  background-size: cover;
  background-position: center;
  filter: blur(60px) brightness(0.5);
  z-index: -1;
  transform: scale(1.5);
}

/* 左侧样式 */
.stats-left {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding-right: 24px;
  border-right: 1px solid rgba(255, 255, 255, 0.1);
}

.date-group {
  margin-bottom: 16px;
}

.month {
  font-size: 36px;
  font-weight: bold;
  line-height: 1;
}

.year {
  font-size: 16px;
  opacity: 0.8;
  margin-top: 4px;
}

.total-desc {
  font-size: 16px;
  margin-bottom: 8px;
  opacity: 0.9;
}

.play-total-group {
  margin-top: 8px;
}

.total-count {
  font-size: 48px;
  font-weight: bold;
  line-height: 1;
  margin-bottom: 4px;
}

.total-label {
  font-size: 14px;
  opacity: 0.8;
}

/* 中间样式 */
.stats-middle {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.metric-item {
  background-color: rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 16px;
  text-align: center;
  transition: all 0.3s;
  backdrop-filter: blur(10px);
}

.metric-item:hover {
  background-color: rgba(255, 255, 255, 0.2);
  transform: translateY(-2px);
}

.metric-value {
  font-size: 24px;
  font-weight: bold;
  margin-bottom: 4px;
}

.metric-label {
  font-size: 12px;
  opacity: 0.8;
}

/* 右侧样式 */
.stats-right {
  padding-left: 24px;
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  flex-direction: column;
}

.column-header {
  font-size: 12px;
  opacity: 0.8;
  margin-bottom: 12px;
}

.activity-chart {
  flex: 1;
  display: flex;
  padding-top: 4px;
  align-items: flex-end;
  justify-content: space-between;
}

.chart-bar-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  height: 100%;
  justify-content: flex-end;
  transition: all 0.3s;
}

.chart-bar-wrapper:hover {
  transform: translateY(-2px);
}

.chart-bar {
  width: 8px;
  background-color: rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  transition:
    height 0.5s ease-out,
    background-color 0.3s;
}

.chart-bar-wrapper:hover .chart-bar {
  background-color: white;
}

.chart-label {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.8);
}

/* 最爱内容部分 */
.favorites-section {
  margin: 32px 0;
  display: flex;
  flex-direction: column;
  gap: 32px;
}

.favorite-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-title {
  font-size: 20px;
  font-weight: bold;
  color: var(--n-text-color);
  margin-bottom: 8px;
}

/* 艺人网格 */
.artists-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 20px;
}

.artist-card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 16px;
    background-color: var(--n-color-card);
    border-radius: 12px;
    border: 1px solid var(--n-border-color);
    transition: all 0.3s;
    overflow: hidden;
  }

  .artist-card:hover {
    transform: translateY(-4px);
  }

.artist-rank {
    position: absolute;
    top: 8px;
    left: 8px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background-color: var(--n-primary-color);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: bold;
    z-index: 1;
  }

.artist-img {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  object-fit: cover;
  margin: 16px 0;
  border: 2px solid rgba(0, 0, 0, 0.1);
}

.artist-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--n-text-color);
  margin-bottom: 4px;
  text-align: center;
}

.artist-minutes {
  font-size: 12px;
  color: var(--n-text-color-2);
}

/* 歌曲列表 */
.songs-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.song-item {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px;
    background-color: var(--n-color-card);
    border-radius: 8px;
    border: 1px solid var(--n-border-color);
    transition: all 0.3s;
  }

  .song-item:hover {
    transform: translateX(4px);
  }

.song-rank {
  width: 24px;
  font-size: 16px;
  font-weight: bold;
  color: var(--n-text-color-2);
  text-align: center;
}

.song-img {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
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

.song-plays {
  font-size: 12px;
  color: var(--n-text-color-2);
  min-width: 50px;
  text-align: right;
}

.song-more {
  opacity: 0;
  transition: opacity 0.3s;
}

.song-item:hover .song-more {
  opacity: 1;
}

/* 专辑网格 */
.albums-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 16px;
}

.album-card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 12px;
    background-color: var(--n-color-card);
    border-radius: 8px;
    border: 1px solid var(--n-border-color);
    transition: all 0.3s;
    overflow: hidden;
  }

  .album-card:hover {
    transform: translateY(-4px);
  }

.album-rank {
    position: absolute;
    top: 4px;
    left: 4px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background-color: var(--n-primary-color);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: bold;
    z-index: 1;
  }

.album-img {
  width: 80px;
  height: 80px;
  border-radius: 8px;
  object-fit: cover;
  margin: 12px 0;
}

.album-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--n-text-color);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100px;
}

/* 空状态 */
.empty-state {
    padding: 48px 24px;
    background-color: var(--n-color-card);
    border-radius: 12px;
    border: 1px solid var(--n-border-color);
    text-align: center;
    color: var(--n-text-color-3);
    font-size: 14px;
  }

/* 响应式设计 */
@media (max-width: 768px) {
  .header-content {
    flex-direction: column;
    align-items: flex-start;
  }
  
  .month-selector {
    width: 100%;
  }
  
  .artists-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .albums-grid {
    grid-template-columns: repeat(3, 1fr);
  }
  
  .song-item {
    gap: 12px;
  }
  
  .song-img {
    width: 40px;
    height: 40px;
  }
}

@media (max-width: 480px) {
  .artists-grid {
    grid-template-columns: 1fr;
  }
  
  .albums-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .total-count {
    font-size: 36px;
  }
  
  .month {
    font-size: 28px;
  }
}
</style>