<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NEmpty, NIcon, NScrollbar, NSelect, NTag, NTooltip } from 'naive-ui'
import defaultCover from '@renderer/assets/default-cover.png'
import { usePlayerStore } from '../stores/playerStore'
import type { PlayerSong } from '../stores/playerStore'

const playerStore = usePlayerStore()

// 初始化加载
onMounted(() => {
  playerStore.loadHistory()
  // 默认选中当前年份下最新有数据的月份，提升首次进入体验
  const latest = latestAvailableMonth(now.getFullYear())
  if (latest !== -1) {
    selectedMonth.value = latest
  }
})

// 月份和年份选择
const now = new Date()
const monthNames = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']
const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]
const allMonths = Array.from({ length: 12 }, (_, i) => i)

const selectedMonth = ref(now.getMonth())
const selectedYear = ref(now.getFullYear())

// 计算某一年有数据的月份
const getAvailableMonths = (year: number) => {
  const months = new Set<number>()
  playerStore.playHistory.forEach((record) => {
    const d = new Date(record.timestamp)
    if (d.getFullYear() === year) {
      months.add(d.getMonth())
    }
  })
  return Array.from(months).sort((a, b) => a - b)
}

const availableMonths = computed(() => getAvailableMonths(selectedYear.value))

const latestAvailableMonth = (year: number) => {
  const months = getAvailableMonths(year)
  return months.length > 0 ? months[months.length - 1] : -1
}

// 切换年份时，若当前月份无数据则自动跳转到最新有数据的月份
watch(selectedYear, (year) => {
  const months = getAvailableMonths(year)
  if (months.length > 0 && !months.includes(selectedMonth.value)) {
    selectedMonth.value = months[months.length - 1]
  }
})

const currentMonth = computed(() => monthNames[selectedMonth.value] + '月')
const currentYear = computed(() => selectedYear.value + '年')

// 共享的按月+年筛选结果，避免多个 computed 重复 filter
const filteredHistory = computed(() => {
  return playerStore.playHistory.filter((record) => {
    const d = new Date(record.timestamp)
    return d.getMonth() === selectedMonth.value && d.getFullYear() === selectedYear.value
  })
})

// 本月播放次数
const totalPlays = computed(() => filteredHistory.value.length)

// 获取排名前几的项目
const getTopItems = (key: 'songId' | 'artist' | 'album', limit: number = 3) => {
  const history = filteredHistory.value
  if (history.length === 0) return []

  const counts: Record<string, number> = {}
  history.forEach((record) => {
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
    const record = history.find((r) =>
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

const monthlyPlays = computed(() => totalPlays.value)

const getTopItem = (key: 'songId' | 'artist' | 'album') => {
  const history = filteredHistory.value
  if (history.length === 0) return null
  const counts: Record<string, number> = {}
  history.forEach((record) => {
    const val = key === 'songId' ? String(record.songId) : record[key] || '未知'
    if (!val) return
    counts[val] = (counts[val] || 0) + 1
  })
  let maxVal: string | null = null
  let maxCount = -1
  for (const [k, v] of Object.entries(counts)) {
    if (v > maxCount) { maxCount = v; maxVal = k }
  }
  if (!maxVal) return null
  const record = history.find((r) =>
    key === 'songId' ? String(r.songId) == maxVal : (r[key] || '未知') == maxVal
  )
  return { ...record, count: maxCount, displayTitle: key === 'songId' ? record?.title : maxVal }
}

const topSong = computed(() => getTopItem('songId'))
const topArtist = computed(() => getTopItem('artist'))
const topAlbum = computed(() => getTopItem('album'))

const statsBgImage = computed(() => `url("${topSong.value?.cover || defaultCover}")`)

// 本周每天的原始播放次数与归一化高度
const weeklyPlayCounts = computed(() => {
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

  return days
})

const weeklyActivity = computed(() => {
  const counts = weeklyPlayCounts.value
  const max = Math.max(...counts, 5) // At least 5 to avoid huge bars for 1 play
  return counts.map((count) => Math.round((count / max) * 100))
})

const weeklyLabels = ['一', '二', '三', '四', '五', '六', '日']

/**
 * 播放选中的 TOP 歌曲
 */
const handlePlaySong = (item: ReturnType<typeof getTopItems>[number]) => {
  if (!item.songId) return
  const song: PlayerSong = {
    id: item.songId,
    title: item.title || '未知歌曲',
    artist: item.artist || '未知艺人',
    album: item.album,
    cover: item.cover || defaultCover,
    durationMs: 0,
    filePath: item.filePath,
    source: item.source
  }
  playerStore.setCurrentSong(song)
}</script>

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
                  v-for="index in allMonths"
                  :key="index"
                  class="month-tab"
                  :class="{
                    active: selectedMonth === index,
                    'has-data': availableMonths.includes(index)
                  }"
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
                :options="years.map((year) => ({ label: year + '年', value: year }))"
                :bordered="false"
                class="year-select"
              />
            </div>
          </div>
        </div>

        <!-- 概览卡片 -->
        <div class="overview-section">
          <div class="stats-card">
            <!-- 左侧：日期 + 本月播放 -->
            <div class="stats-left">
              <div class="date-group">
                <div class="month">{{ currentMonth }}</div>
                <div class="year">{{ currentYear }}</div>
              </div>
              <div class="play-total-group">
                <div class="total-count">{{ monthlyPlays }}</div>
                <div class="total-label">本月播放</div>
              </div>
              <div class="play-btn-circle">
                <n-icon size="24" color="white"><i class="mgc_play_fill"></i></n-icon>
              </div>
            </div>
            <!-- 中间：精彩回顾 -->
            <div class="stats-middle">
              <div class="column-header">精彩回顾</div>
              <div v-if="topSong" class="highlight-item big">
                <img :src="topSong.cover || defaultCover" class="highlight-img" loading="lazy" />
                <div class="highlight-info">
                  <div class="song-name">{{ topSong.displayTitle }}</div>
                  <div class="artist-name">{{ topSong.artist }}</div>
                </div>
                <div class="play-times">{{ topSong.count }}<span class="unit">次</span></div>
              </div>
              <div v-else class="highlight-item big" style="justify-content: center; color: #999">暂无播放记录</div>
              <div class="highlight-row">
                <div v-if="topArtist" class="highlight-item small">
                  <img :src="topArtist.cover || defaultCover" class="highlight-img-small" loading="lazy" />
                  <div class="highlight-info">
                    <div class="tag">最爱艺人</div>
                    <div class="name">{{ topArtist.displayTitle }}</div>
                  </div>
                </div>
                <div v-else class="highlight-item small">
                  <div class="highlight-info">
                    <div class="tag">最爱艺人</div>
                    <div class="name">暂无</div>
                  </div>
                </div>
                <div v-if="topAlbum" class="highlight-item small">
                  <img :src="topAlbum.cover || defaultCover" class="highlight-img-small" loading="lazy" />
                  <div class="highlight-info">
                    <div class="tag">最爱专辑</div>
                    <div class="name">{{ topAlbum.displayTitle }}</div>
                  </div>
                </div>
                <div v-else class="highlight-item small">
                  <div class="highlight-info">
                    <div class="tag">最爱专辑</div>
                    <div class="name">暂无</div>
                  </div>
                </div>
              </div>
            </div>
            <!-- 右侧：周活跃度 -->
            <div class="stats-right">
              <div class="column-header">活跃动态（周）</div>
              <div class="activity-chart">
                <n-tooltip
                  v-for="(value, i) in weeklyActivity"
                  :key="i"
                  trigger="hover"
                  :disabled="weeklyPlayCounts[i] === 0"
                >
                  <template #trigger>
                    <div class="chart-bar-wrapper">
                      <div class="chart-bar" :style="{ height: value + '%' }"></div>
                      <div class="chart-label">{{ weeklyLabels[i] }}</div>
                    </div>
                  </template>
                  周{{ weeklyLabels[i] }}：{{ weeklyPlayCounts[i] }} 次播放
                </n-tooltip>
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
                :style="{ animationDelay: index * 0.1 + 's' }"
              >
                <n-tag
                  :type="index === 0 ? 'warning' : index === 1 ? 'info' : 'default'"
                  :bordered="false"
                  size="small"
                  round
                  class="artist-rank"
                  >{{ index + 1 }}</n-tag
                >
                <div class="artist-img-wrapper">
                  <img
                    :src="artist.cover || defaultCover"
                    class="artist-img"
                    loading="lazy"
                    decoding="async"
                  />
                  <div class="artist-img-ring"></div>
                </div>
                <div class="artist-name" :title="artist.displayTitle">
                  {{ artist.displayTitle }}
                </div>
                <div class="artist-meta">
                  <n-icon size="14"><i class="mgc_time_line"></i></n-icon>
                  <span>{{ Math.round(artist.count * 3.5) }} 分钟</span>
                </div>
              </div>
            </div>
            <n-empty v-else description="暂无播放记录" class="empty-state" />
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
                :style="{ animationDelay: index * 0.08 + 's' }"
                @click="handlePlaySong(song)"
              >
                <div class="song-rank" :class="{ 'rank-highlight': index < 3 }">
                  <template v-if="index < 3">
                    <n-tag
                      :type="index === 0 ? 'warning' : index === 1 ? 'info' : 'error'"
                      :bordered="false"
                      size="tiny"
                      class="rank-medal"
                      >{{ index + 1 }}</n-tag
                    >
                  </template>
                  <template v-else>
                    {{ index + 1 }}
                  </template>
                </div>
                <div class="song-cover-wrapper">
                  <img
                    :src="song.cover || defaultCover"
                    class="song-img"
                    loading="lazy"
                    decoding="async"
                  />
                  <div class="song-play-overlay">
                    <n-icon size="18" color="white"><i class="mgc_play_fill"></i></n-icon>
                  </div>
                </div>
                <div class="song-info">
                  <div class="song-name" :title="song.displayTitle">{{ song.displayTitle }}</div>
                  <div class="song-artist" :title="song.artist">{{ song.artist }}</div>
                </div>
                <div class="song-stats">
                  <span class="song-plays-count">{{ song.count }}</span>
                  <span class="song-plays-label">次播放</span>
                </div>
              </div>
            </div>
            <n-empty v-else description="暂无播放记录" class="empty-state" />
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
                :style="{ animationDelay: index * 0.12 + 's' }"
              >
                <div class="album-img-wrapper">
                  <img
                    :src="album.cover || defaultCover"
                    class="album-img"
                    loading="lazy"
                    decoding="async"
                  />
                  <div class="album-img-overlay">
                    <n-tag :bordered="false" size="tiny" class="album-rank-badge">{{
                      index + 1
                    }}</n-tag>
                  </div>
                </div>
                <div class="album-name" :title="album.displayTitle">{{ album.displayTitle }}</div>
                <div v-if="album.artist" class="album-artist" :title="album.artist">
                  {{ album.artist }}
                </div>
                <div class="album-plays">{{ album.count }} 次</div>
              </div>
            </div>
            <n-empty v-else description="暂无播放记录" class="empty-state" />
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
  0% {
    background-position: -200% center;
  }
  100% {
    background-position: 200% center;
  }
}

@keyframes pulse-ring {
  0% {
    transform: scale(1);
    opacity: 0.6;
  }
  100% {
    transform: scale(1.15);
    opacity: 0;
  }
}

.statistics-view {
  min-height: 100%;
}

/* ============================================
   头部样式
   ============================================ */
.header-section {
  margin: 64px 0 20px 0;
}

.header-content {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
}

.header-left {
  flex: 1;
  min-width: 0;
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
  color: var(--n-text-color-3);
}

.month-tab:hover {
  border-color: var(--n-primary-color);
  color: var(--n-text-color);
  background: var(--n-primary-color-suppl, rgba(var(--n-primary-color-rgb), 0.08));
}

.month-tab.active {
  background: var(--n-primary-color);
  color: #fff;
  font-weight: 600;
  border-color: var(--n-primary-color);
  box-shadow: 0 2px 8px rgba(var(--n-primary-color-rgb, 0, 0, 0), 0.3);
}

.month-tab.has-data:not(.active)::after {
  content: '';
  position: absolute;
  top: 7px;
  right: 7px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--n-primary-color);
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
  flex-shrink: 0;
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
  border-radius: 16px;
  padding: 24px;
  color: white;
  display: grid;
  backdrop-filter: blur(100px);
  grid-template-columns: 1.5fr 2fr 1fr;
  gap: 24px;
  min-height: 200px;
  z-index: 1;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
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
  filter: blur(60px) brightness(0.7);
  z-index: -1;
  transform: scale(1.5);
}
.stats-left {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding-right: 24px;
  border-right: 1px solid rgba(255, 255, 255, 0.1);
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
.total-count {
  font-size: 36px;
  font-weight: bold;
  line-height: 1;
}
.total-label {
  font-size: 12px;
  opacity: 0.8;
  margin-top: 4px;
}
.play-btn-circle {
  position: absolute;
  right: 24px;
  bottom: 6px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background-color: rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 0.2s;
}
.play-btn-circle:hover {
  background-color: rgba(255, 255, 255, 0.2);
}
.stats-middle {
  max-width: 600px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.column-header {
  font-size: 12px;
  opacity: 0.8;
  margin-bottom: 4px;
}
.highlight-item {
  background-color: rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  transition: background-color 0.2s;
}
.highlight-item:hover {
  background-color: rgba(255, 255, 255, 0.2);
}
.highlight-item.big {
  padding: 16px;
}
.highlight-img {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
}
.highlight-img-small {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  object-fit: cover;
}
.highlight-info {
  flex: 1;
  overflow: hidden;
}
.song-name,
.name {
  font-size: 14px;
  font-weight: bold;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.song-name {
  font-size: 16px;
}
.artist-name,
.tag {
  font-size: 12px;
  opacity: 0.8;
}
.play-times {
  text-align: right;
  font-size: 16px;
  font-weight: bold;
}
.play-times .unit {
  font-size: 12px;
  font-weight: normal;
  opacity: 0.8;
}
.highlight-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.stats-right {
  padding-left: 24px;
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  flex-direction: column;
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
}
.chart-bar {
  width: 6px;
  background-color: rgba(255, 255, 255, 0.3);
  border-radius: 3px;
  transition: height 0.3s, background-color 0.3s;
}
.chart-bar-wrapper:hover .chart-bar {
  background-color: white;
}
.chart-label {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.6);
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
  grid-template-columns: repeat(auto-fit, minmax(170px, 220px));
  gap: 20px;
  justify-content: start;
}

.artist-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-width: 220px;
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
  background: var(--n-primary-color-suppl, rgba(0, 0, 0, 0.03));
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

/* 排名徽章（NTag） */
.artist-rank {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 2;
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
  cursor: pointer;
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
  grid-template-columns: repeat(auto-fit, minmax(150px, 180px));
  gap: 20px;
  justify-content: start;
}

.album-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-width: 180px;
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
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  padding: 8px;
}

.album-rank-badge {
  backdrop-filter: blur(4px);
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
  margin-bottom: 2px;
}

.album-artist {
  font-size: 11px;
  color: var(--n-text-color-2);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
  margin-bottom: 2px;
}

.album-plays {
  font-size: 11px;
  color: var(--n-text-color-3);
}

/* ============================================
   空状态
   ============================================ */
.empty-state {
  background: var(--n-color-card);
  border-radius: 14px;
  border: 1px dashed var(--n-border-color);
  padding: 16px;
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

  .month-selector {
    width: 100%;
  }

  .month-tab {
    padding: 6px 14px;
    font-size: 13px;
  }

  .artists-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .albums-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
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
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .month {
    font-size: 28px;
  }
}
</style>
