<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { NEmpty, NIcon, NScrollbar, NTag, NTooltip } from 'naive-ui'
import defaultCover from '@renderer/assets/default-cover.png'
import { usePlayerStore } from '../stores/playerStore'
import type { PlayerSong } from '../stores/playerStore'

const playerStore = usePlayerStore()

// 初始化加载
onMounted(() => {
  playerStore.loadHistory()
})

// 全部播放历史（不再按月筛选）
const allHistory = computed(() => playerStore.playHistory)

// 总播放次数
const totalPlays = computed(() => allHistory.value.length)

// 获取排名前几的项目
const getTopItems = (key: 'songId' | 'artist' | 'album', limit: number = 3) => {
  const history = allHistory.value
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

const totalPlaysCount = computed(() => totalPlays.value)

const getTopItem = (key: 'songId' | 'artist' | 'album') => {
  const history = allHistory.value
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
        <!-- 概览卡片 -->
        <div class="overview-section">
          <div class="stats-card">
            <!-- 左侧：总播放 -->
            <div class="stats-left">
              <div class="date-group">
                <div class="month">音乐回忆</div>
                <div class="year">全部时间</div>
              </div>
              <div class="play-total-group">
                <div class="total-count">{{ totalPlaysCount }}</div>
                <div class="total-label">总播放</div>
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

        <!-- 听歌排行 -->
        <div class="favorites-section">
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

.statistics-view {
  min-height: 100%;
}

/* ============================================
   概览卡片
   ============================================ */
.overview-section {
  margin: 64px 0 20px 0;
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
  flex-shrink: 0;
}
.highlight-img-small {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
}
.highlight-info {
  flex: 1;
  overflow: hidden;
  min-width: 0;
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
  flex-shrink: 0;
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
  .month {
    font-size: 28px;
  }
}
</style>
