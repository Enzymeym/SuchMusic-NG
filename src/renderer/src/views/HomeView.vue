<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NGrid, NGridItem, NIcon, NScrollbar, NButton } from 'naive-ui'
import { useRouter } from 'vue-router'
import defaultCover from '@renderer/assets/icon.png'
import { usePlayerStore } from '../stores/playerStore'
import { fetchTopPlaylists, type TopPlaylistItem } from '../apis/netease/playlist/top-playlist'
import { fetchToplists, type ToplistItem } from '../apis/netease/playlist/toplist'
import { fetchTopArtists, type TopArtistItem } from '../apis/netease/artist/top-artist'

const playerStore = usePlayerStore()
const router = useRouter()

// 响应式显示数量，确保只显示一行
const displayLimit = ref(8)

const updateDisplayLimit = () => {
  // Use container width or window width to determine columns
  // The layout has a sidebar (200px) + padding (32px), so content area is smaller than window
  const width = document.documentElement.clientWidth
  
  // We need to account for the sidebar (200px) and padding (32px)
  // Effective content width = width - 232
  
  // NGrid breakpoints are based on SCREEN width, not container width by default if responsive="screen"
  // But our grid uses responsive="screen" which matches window width.
  // Let's align exactly with the breakpoints:
  // cols="2 s:3 m:4 l:5 xl:6 2xl:8"
  // s: 640, m: 768, l: 1024, xl: 1280, 2xl: 1536
  
  // Always show 2 rows
  if (width >= 1536) { // 2xl (8 cols)
    displayLimit.value = 16
  } else if (width >= 1280) { // xl (6 cols)
    displayLimit.value = 12
  } else if (width >= 1024) { // l (5 cols)
    displayLimit.value = 10
  } else if (width >= 768) { // m (4 cols)
    displayLimit.value = 8
  } else if (width >= 640) { // s (3 cols)
    displayLimit.value = 6
  } else { // (2 cols)
    displayLimit.value = 4
  }
}

const navigateTo = (name: string) => {
  router.push({ name })
}

// 歌单广场数据
const squarePlaylists = ref<
  Array<{
    id: number
    title: string
    cover: string
    playCount: string
  }>
>([])

// 排行榜数据
const toplists = ref<
  Array<{
    id: number
    name: string
    cover: string
    playCount: string
    updateFrequency: string
  }>
>([])

// 歌手广场数据
const topArtists = ref<
  Array<{
    id: number
    name: string
    cover: string
    alias: string
  }>
>([])

// 初始化加载
onMounted(async () => {
  updateDisplayLimit()
  window.addEventListener('resize', updateDisplayLimit)

  playerStore.loadHistory()

  // 并行加载所有数据
  const [playlistData, toplistData, artistData] = await Promise.all([
    fetchTopPlaylists(),
    fetchToplists(),
    fetchTopArtists()
  ])

  // 处理最热歌单
  squarePlaylists.value = playlistData.slice(0, 24).map((item: TopPlaylistItem) => ({
    id: item.id,
    title: item.name,
    cover: item.coverImgUrl || defaultCover,
    playCount: formatPlayCount(item.playCount)
  }))

  // 处理排行榜数据
  toplists.value = toplistData.slice(0, 24).map((item: ToplistItem) => ({
    id: item.id,
    name: item.name,
    cover: item.coverImgUrl || defaultCover,
    playCount: formatPlayCount(item.playCount),
    updateFrequency: item.updateFrequency ?? ''
  }))

  // 处理歌手数据
  topArtists.value = artistData.slice(0, 24).map((item: TopArtistItem) => ({
    id: item.id,
    name: item.name,
    cover: item.picUrl || defaultCover,
    alias: item.alias && item.alias.length > 0 ? item.alias[0] : ''
  }))
})

onUnmounted(() => {
  window.removeEventListener('resize', updateDisplayLimit)
})

const totalPlays = computed(() => playerStore.playHistory.length)

const now = new Date()
const monthNames = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']
const currentMonth = computed(() => monthNames[now.getMonth()] + '月')
const currentYear = computed(() => now.getFullYear() + '年')

const monthlyPlays = computed(() => {
  const currentMonthIdx = now.getMonth()
  const currentYearVal = now.getFullYear()
  return playerStore.playHistory.filter((record) => {
    const d = new Date(record.timestamp)
    return d.getMonth() === currentMonthIdx && d.getFullYear() === currentYearVal
  }).length
})

// Helper to find top item
const getTopItem = (key: 'songId' | 'artist' | 'album') => {
  if (playerStore.playHistory.length === 0) return null

  const counts: Record<string, number> = {}
  playerStore.playHistory.forEach((record) => {
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
  const record = playerStore.playHistory.find((r) =>
    key === 'songId' ? String(r.songId) == maxVal : (r[key] || '未知') == maxVal
  )

  return {
    ...record,
    count: maxCount,
    displayTitle: key === 'songId' ? record?.title : maxVal
  }
}

const topSong = computed(() => getTopItem('songId'))
const topArtist = computed(() => getTopItem('artist'))
const topAlbum = computed(() => getTopItem('album'))

const statsBgImage = computed(() => {
  return `url("${topSong.value?.cover || defaultCover}")`
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

// 播放次数格式化
const formatPlayCount = (count: number): string => {
  if (!Number.isFinite(count)) return '0'
  if (count >= 100000000) {
    return `${(count / 100000000).toFixed(1)}亿`
  }
  if (count >= 10000) {
    return `${(count / 10000).toFixed(1)}万`
  }
  return String(count)
}
</script>

<template>
  <div style="height: 100%">
    <n-scrollbar style="height: 100%" content-style="padding: 16px 24px;">
      <div class="home-view">
        <div class="home-container">
          <!-- Greeting Section -->
          <div class="greeting-section">
            <h1 class="greeting-title">
              统计
              <n-button secondary circle style="margin-top: 2px">
                <n-icon size="24"><i class="mgc_right_line"></i></n-icon
              ></n-button>
            </h1>
            <p class="greeting-sub">总共播放了 {{ totalPlays }} 次</p>
          </div>
        </div>

        <div class="stats-section">
          <div class="stats-card">
            <!-- Left Column: Date & Total -->
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

            <!-- Middle Column: Highlights -->
            <div class="stats-middle">
              <div class="column-header">精彩回顾</div>

              <!-- Top Song -->
              <div class="highlight-item big" v-if="topSong">
                <img :src="topSong.cover || defaultCover" class="highlight-img" />
                <div class="highlight-info">
                  <div class="song-name">{{ topSong.displayTitle }}</div>
                  <div class="artist-name">{{ topSong.artist }}</div>
                </div>
                <div class="play-times">{{ topSong.count }} <span class="unit">次</span></div>
              </div>
              <div class="highlight-item big" v-else style="justify-content: center; color: #999">
                暂无播放记录
              </div>

              <!-- Bottom Row -->
              <div class="highlight-row">
                <div class="highlight-item small" v-if="topArtist">
                  <img :src="topArtist.cover || defaultCover" class="highlight-img-small" />
                  <div class="highlight-info">
                    <div class="tag">最爱艺人</div>
                    <div class="name">{{ topArtist.displayTitle }}</div>
                  </div>
                </div>
                <div class="highlight-item small" v-else>
                  <div class="highlight-info">
                    <div class="tag">最爱艺人</div>
                    <div class="name">暂无</div>
                  </div>
                </div>

                <div class="highlight-item small" v-if="topAlbum">
                  <img :src="topAlbum.cover || defaultCover" class="highlight-img-small" />
                  <div class="highlight-info">
                    <div class="tag">最爱专辑</div>
                    <div class="name">{{ topAlbum.displayTitle }}</div>
                  </div>
                </div>
                <div class="highlight-item small" v-else>
                  <div class="highlight-info">
                    <div class="tag">最爱专辑</div>
                    <div class="name">暂无</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Right Column: Activity -->
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
        <!-- Banners Section -->
        <div class="banners-section">
          <div class="section-header-row">
            <div class="banner-title">歌单广场</div>
            <n-button
              secondary
              circle
              style="margin-top: 2px"
              @click="navigateTo('playlist-square')"
            >
              <n-icon size="20"><i class="mgc_right_line"></i></n-icon>
            </n-button>
          </div>
          <span
            style="font-size: 14px; color: #666; margin-bottom: 8px; transform: translateY(-2px)"
            >Netease Music 精选推荐</span
          >
          <div class="playlists-section">
            <n-grid x-gap="16" y-gap="24" cols="2 s:3 m:4 l:5 xl:6 2xl:8" responsive="screen">
              <n-grid-item v-for="item in squarePlaylists.slice(0, displayLimit)" :key="item.id">
                <div class="playlist-card">
                  <div class="cover-wrapper">
                    <img :src="item.cover" class="playlist-cover" />
                    <div class="play-count">
                      <n-icon><i class="mgc_play_line"></i></n-icon> {{ item.playCount }}
                    </div>
                    <div class="play-overlay">
                      <n-icon size="40" color="white"><i class="mgc_play_circle_line"></i></n-icon>
                    </div>
                  </div>
                  <div class="playlist-title">{{ item.title }}</div>
                </div>
              </n-grid-item>
            </n-grid>
          </div>

          <div class="section-header-row" style="margin-top: 24px">
            <div class="banner-title">歌手广场</div>
            <n-button secondary circle style="margin-top: 2px" @click="navigateTo('playlist-square')">
              <n-icon size="20"><i class="mgc_right_line"></i></n-icon>
            </n-button>
          </div>
          <span
            style="font-size: 14px; color: #666; margin-bottom: 8px; transform: translateY(-2px)"
            >热门歌手推荐</span
          >
          <div class="playlists-section">
            <n-grid x-gap="24" y-gap="24" cols="2 s:3 m:4 l:5 xl:6 2xl:8" responsive="screen">
              <n-grid-item v-for="item in topArtists.slice(0, displayLimit)" :key="item.id">
                <div class="artist-card">
                  <div class="artist-cover-wrapper">
                    <img :src="item.cover" class="artist-cover" />
                  </div>
                  <div class="artist-name">{{ item.name }}</div>
                  <div class="artist-alias" v-if="item.alias">{{ item.alias }}</div>
                </div>
              </n-grid-item>
            </n-grid>
          </div>

          <div class="section-header-row" style="margin-top: 24px">
            <div class="banner-title">排行榜</div>
            <n-button secondary circle style="margin-top: 2px" @click="navigateTo('toplist')">
              <n-icon size="20"><i class="mgc_right_line"></i></n-icon>
            </n-button>
          </div>
          <span
            style="font-size: 14px; color: #666; margin-bottom: 8px; transform: translateY(-2px)"
            >探索最新内容</span
          >
          <div class="toplist-section">
            <n-grid x-gap="16" y-gap="24" cols="2 s:3 m:4 l:5 xl:6 2xl:8" responsive="screen">
              <n-grid-item v-for="item in toplists.slice(0, displayLimit)" :key="item.id">
                <div class="playlist-card">
                  <div class="cover-wrapper">
                    <img :src="item.cover" class="playlist-cover" />
                    <div class="play-count">
                      <n-icon><i class="mgc_play_line"></i></n-icon> {{ item.playCount }}
                    </div>
                    <div class="play-overlay">
                      <n-icon size="40" color="white"><i class="mgc_play_circle_line"></i></n-icon>
                    </div>
                  </div>
                  <div class="playlist-title">{{ item.name }}</div>
                  <div v-if="item.updateFrequency" class="toplist-sub">
                    {{ item.updateFrequency }}
                  </div>
                </div>
              </n-grid-item>
            </n-grid>
          </div>
        </div>
        <!-- Exclusive Playlists Section -->
      </div>
    </n-scrollbar>
  </div>
</template>

<style scoped>
.home-view {
  /* overflow-y: auto; handled by NScrollbar */
}

.home-container {
}

.greeting-section {
}

.greeting-title {
  font-size: 32px;
  font-weight: bold;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.greeting-sub {
  font-size: 14px;
  color: #666;
  margin: -6px 0 0 0;
}

.banners-section {
  display: flex;
  flex-direction: column;
  margin-bottom: 32px;
  margin-top: 8px;
}

.left-banners {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.banner-title {
  font-size: 24px;
  font-weight: bold;
}

.section-header-row {
  display: flex;
  justify-content: start;
  gap: 12px;
  align-items: center;
}

.banner-card {
  height: 100px;
  /* Approximate height */
  background-color: #f9f9f9;
  border-radius: 12px;
  cursor: pointer;
  transition: transform 0.2s;
}

.banner-card:hover {
  transform: translateY(-2px);
  background-color: #f0f0f0;
}

.card-content {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 100%;
}

.card-icon {
  width: 60px;
  height: 60px;
  border-radius: 8px;
}

.card-title {
  font-size: 18px;
  font-weight: bold;
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-desc {
  font-size: 12px;
  color: #666;
  margin-top: 4px;
}

.toplist-section {
  margin-top: 8px;
}

.toplist-sub {
  font-size: 12px;
  color: #888;
  margin-top: 4px;
}

.right-banner {
  flex: 1.5;
}

.fm-card {
  height: 100%;
  background-color: #333;
  /* Dark background like image */
  color: white;
  border-radius: 12px;
}

.fm-content {
  display: flex;
  gap: 24px;
  align-items: center;
  height: 100%;
}

.fm-cover {
  width: 140px;
  height: 140px;
  border-radius: 8px;
}

.fm-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  position: relative;
}

.fm-title {
  font-size: 24px;
  font-weight: bold;
  margin-bottom: 8px;
}

.fm-artist,
.fm-album {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}

.fm-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 16px;
}

.fm-tag {
  position: absolute;
  bottom: 0;
  right: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  display: flex;
  align-items: center;
  gap: 4px;
}

.section-header {
  margin-bottom: 16px;
  padding-left: 8px;
}

.section-title {
  font-size: 18px;
  font-weight: bold;
  line-height: 1;
}

.playlist-card {
  cursor: pointer;
}

.artist-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
  padding: 12px;
  border-radius: 12px;
  transition: background-color 0.2s;
  will-change: transform; /* Hint to browser */
}

.artist-card:hover {
  background-color: var(--n-color-modal);
}

.artist-cover-wrapper {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  overflow: hidden;
  margin-bottom: 12px;
  /* Removed heavy shadow */
  /* box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); */
  background-color: rgba(0, 0, 0, 0.05); /* Placeholder bg */
}

.artist-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* Removed scale transition on image to improve performance */
  /* transition: transform 0.3s; */
}

/* 
.artist-card:hover .artist-cover {
  transform: scale(1.1);
} 
*/

.artist-name {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
}

.artist-alias {
  font-size: 12px;
  color: var(--n-text-color-3);
  text-align: center;
}

.cover-wrapper {
  position: relative;
  width: 100%;
  padding-bottom: 100%;
  /* Square aspect ratio */
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 8px;
}

.playlist-cover {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s;
}

.playlist-card:hover .playlist-cover {
  transform: scale(1.05);
}

.play-count {
  position: absolute;
  top: 8px;
  right: 8px;
  background-color: rgba(0, 0, 0, 0.5);
  color: white;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 2px;
}

.play-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.3s;
}

.playlist-card:hover .play-overlay {
  opacity: 1;
}

.playlist-title {
  font-size: 14px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.stats-section {
  margin-bottom: 32px;
  margin-top: 8px;
}

.stats-header {
  margin-bottom: 12px;
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.stats-title {
  font-size: 20px;
  font-weight: bold;
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.stats-subtitle {
  font-size: 12px;
  color: #666;
}

/* Left Column */
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

/* Middle Column */
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

/* Right Column */
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
  transition:
    height 0.3s,
    background-color 0.3s;
}

.chart-bar-wrapper:hover .chart-bar {
  background-color: white;
}

.chart-label {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.6);
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
}

.stats-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  /* Use a nice placeholder image */
  background-image: v-bind(statsBgImage);
  background-size: cover;
  background-position: center;
  /* Blur and darken */
  filter: blur(60px) brightness(0.7);
  z-index: -1;
  transform: scale(1.5);
  /* Prevent white edges from blur */
}
</style>
