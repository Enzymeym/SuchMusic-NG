<script setup lang="ts">
import { computed, onMounted, onUnmounted, onActivated, onDeactivated, ref } from 'vue'
import { NScrollbar, NGrid, NGridItem } from 'naive-ui'
import { useRouter } from 'vue-router'
import defaultCover from '@renderer/assets/default-cover.png'
import { usePlayerStore } from '../stores/playerStore'
import { useLocalMusicStore } from '../stores/localMusicStore'
import { usePlaylistTheme } from '../composables/usePlaylistTheme'
import { albumCache } from '../stores/albumCache'
import { throttle } from '../utils/performance'
import { formatTime } from '../utils/format'

const playerStore = usePlayerStore()
const localMusicStore = useLocalMusicStore()
const router = useRouter()

const currentTimeDisplay = ref(0)

let progressTimer: ReturnType<typeof setInterval> | null = null
const startProgressTimer = () => {
  if (progressTimer) return
  progressTimer = setInterval(() => {
    currentTimeDisplay.value = playerStore.positionMs
  }, 250)
}
const stopProgressTimer = () => {
  if (progressTimer) {
    clearInterval(progressTimer)
    progressTimer = null
  }
}

onMounted(() => {
  updateDisplayLimit()
  window.addEventListener('resize', onWindowResize)
  playerStore.loadHistory()
  startProgressTimer()
})

onDeactivated(() => {
  stopProgressTimer()
})

onActivated(() => {
  startProgressTimer()
})

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  stopProgressTimer()
})

const displayLimit = ref(8)

const updateDisplayLimit = () => {
  const width = document.documentElement.clientWidth
  if (width >= 1536) { displayLimit.value = 16 }
  else if (width >= 1280) { displayLimit.value = 12 }
  else if (width >= 1024) { displayLimit.value = 10 }
  else if (width >= 768) { displayLimit.value = 8 }
  else if (width >= 640) { displayLimit.value = 6 }
  else { displayLimit.value = 4 }
}

// 持有 throttle 包装引用，确保 add/removeEventListener 使用同一函数（避免监听器泄漏）
const onWindowResize = throttle(updateDisplayLimit, 200)

const nowPlayingCover = computed(() => playerStore.currentSong?.cover || defaultCover)

const { accentColor: _accentColor, textColor } = usePlaylistTheme(() => nowPlayingCover.value)

const UNKNOWN_ARTIST = '\u672a\u77e5\u6b4c\u624b'

const recommendedSongs = computed(() => {
  const history = playerStore.playHistory
  const localSongs = localMusicStore.songs

  const songs: { id: string | number; title: string; artist: string; cover: string }[] = []
  const seenIds = new Set<string | number>()

  for (const record of history) {
    if (seenIds.has(record.songId)) continue
    seenIds.add(record.songId)
    const localSong = localSongs.find(s => s.id === record.songId)
    songs.push({
      id: record.songId,
      title: record.title,
      artist: record.artist,
      cover: record.cover || localSong?.picUrl || localSong?.al?.picUrl || defaultCover
    })
    if (songs.length >= 12) break
  }

  if (songs.length < 12 && localSongs.length > 0) {
    // 随机不重复抽样：从尚未出现的本地歌曲中随机抽取（部分 Fisher-Yates，只洗前 need 个），
    // 避免 `[...list].sort(() => Math.random() - 0.5)` 的整表复制 + 全量洗牌开销
    const candidates = localSongs.filter(s => !seenIds.has(s.id))
    const need = 12 - songs.length
    const take = Math.min(candidates.length, need)
    for (let i = 0; i < take; i++) {
      const j = i + Math.floor(Math.random() * (candidates.length - i))
      const tmp = candidates[i]
      candidates[i] = candidates[j]
      candidates[j] = tmp
      const song = candidates[i]
      seenIds.add(song.id)
      songs.push({
        id: song.id,
        title: song.name,
        artist: song.ar?.[0]?.name || UNKNOWN_ARTIST,
        cover: song.picUrl || song.al?.picUrl || defaultCover
      })
    }
  }

  return songs.slice(0, displayLimit.value)
})

const recommendedAlbums = computed(() => {
  const albums = localMusicStore.albumList
  if (albums.length === 0) return []

  const shuffled = [...albums].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, displayLimit.value).map(a => ({
    name: a.name,
    artist: a.artist,
    cover: a.cover || defaultCover,
    songCount: a.songs.length
  }))
})

// Label text constants
const L = {
  songRecommend: '\u6b4c\u66f2\u63a8\u8350',
  albumRecommend: '\u4e13\u8f91\u63a8\u8350',
  noSongPlaying: '\u6682\u65e0\u64ad\u653e\u6b4c\u66f2\uff0c\u53bb\u9009\u62e9\u4e00\u9996\u6b4c\u66f2\u5f00\u59cb\u64ad\u653e\u5427',
}
const playSong = (songId: string | number) => {
  const localSong = localMusicStore.songs.find(s => s.id === songId)
  if (localSong) {
    playerStore.setCurrentSong({
      id: localSong.id,
      title: localSong.name,
      artist: localSong.ar?.[0]?.name || UNKNOWN_ARTIST,
      cover: localSong.picUrl || localSong.al?.picUrl || defaultCover,
      durationMs: localSong.dt || 0,
      album: localSong.al?.name,
      filePath: localSong.filePath
    })
  }
}

const navigateToAlbum = (albumName: string) => {
  const album = localMusicStore.albumList.find(a => a.name === albumName)
  if (album) {
    albumCache.set(album.name, album)
  }
  router.push({ name: 'album-detail', params: { name: albumName } })
}

</script>

<template>
  <div style="height: 100%">
    <n-scrollbar style="height: 100%" content-style="padding: 16px 24px 32px;">
      <div class="home-view">
        <div v-if="playerStore.currentSong" class="now-playing-section">
          <div class="np-bg-layer full" :style="{ backgroundImage: `url(${nowPlayingCover})` }"></div>
          <div class="np-bg-reflection full" :style="{ backgroundImage: `url(${nowPlayingCover})` }"></div>
          <div class="np-header-section">
            <div class="np-header-content">
              <div class="np-cover-wrapper full">
                <img :src="nowPlayingCover" class="np-cover-img" :class="{ 'is-playing': playerStore.isPlaying }" />
              </div>
              <div class="np-info-wrapper">
                <div class="np-title" :style="{ color: textColor }">{{ playerStore.currentSong.title }}</div>
                <div class="np-tags-row" :style="{ color: textColor }">
                  <span>{{ playerStore.currentSong.artist || UNKNOWN_ARTIST }}</span>
                </div>
                <div v-if="playerStore.currentSong.album" class="np-desc-row" :style="{ color: textColor }">
                  <span>{{ playerStore.currentSong.album }}</span>
                </div>
                <div class="np-actions-row">
                  <span class="np-time" :style="{ color: textColor }">{{ formatTime(currentTimeDisplay / 1000) }}</span>
                  <span>/</span>
                  <span class="np-time" :style="{ color: textColor }">{{ formatTime((playerStore.currentSong.durationMs
                    || 0) / 1000) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="now-playing-section np-placeholder">
          <div class="np-empty">
            <i class="mgc_music_3_line" style="font-size: 48px; opacity: 0.3"></i>
            <p style="margin-top: 12px; opacity: 0.5; font-size: 15px">{{ L.noSongPlaying }}</p>
          </div>
        </div>

        <div v-if="recommendedSongs.length > 0" class="section-block">
          <div class="section-header">
            <h2 class="section-title">{{ L.songRecommend }}</h2>
          </div>
          <n-grid cols="2 s:3 m:4 l:5 xl:6 2xl:8" responsive="screen" :x-gap="16" :y-gap="16">
            <n-grid-item v-for="song in recommendedSongs" :key="song.id">
              <div class="recommend-card" @click="playSong(song.id)">
                <div class="rc-cover-wrapper">
                  <img :src="song.cover" class="rc-cover" loading="lazy" />
                  <div class="rc-play-overlay"><i class="mgc_play_fill" style="font-size: 28px; color: white"></i></div>
                </div>
                <div class="rc-info">
                  <div class="rc-title">{{ song.title }}</div>
                  <div class="rc-subtitle">{{ song.artist }}</div>
                </div>
              </div>
            </n-grid-item>
          </n-grid>
        </div>

        <div v-if="recommendedAlbums.length > 0" class="section-block">
          <div class="section-header">
            <h2 class="section-title">{{ L.albumRecommend }}</h2>
          </div>
          <n-grid cols="2 s:3 m:4 l:5 xl:6 2xl:8" responsive="screen" :x-gap="16" :y-gap="16">
            <n-grid-item v-for="album in recommendedAlbums" :key="album.name">
              <div class="recommend-card" @click="navigateToAlbum(album.name)">
                <div class="rc-cover-wrapper">
                  <img :src="album.cover" class="rc-cover" loading="lazy" />
                  <div class="rc-play-overlay"><i class="mgc_album_line" style="font-size: 28px; color: white"></i>
                  </div>
                </div>
                <div class="rc-info">
                  <div class="rc-title">{{ album.name }}</div>
                  <div class="rc-subtitle">{{ album.artist }} · {{ album.songCount }} 首</div>
                </div>
              </div>
            </n-grid-item>
          </n-grid>
        </div>

      </div>
    </n-scrollbar>
  </div>
</template>

<style scoped>
.home-view {
  display: flex;
  flex-direction: column;

}

.section-block {
  margin-top: 8px;
}

.section-header {
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  font-size: 20px;
  font-weight: bold;
  margin: 0;
}

.now-playing-section {
  position: relative;
  overflow: hidden;
  width: calc(100% + 48px);
  margin-left: -24px;
  margin-right: -24px;
  height: 330px;
  z-index: 1;
  border-radius: 0;
}

.np-bg-layer.full {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 380px;
  background-size: cover;
  background-position: center;
  transform: scale(1.06);
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 40%, transparent 85%);
  mask-image: linear-gradient(to bottom, black 0%, black 40%, transparent 85%);
  opacity: 1;
}

.np-bg-layer::after {
  content: '';
  position: absolute;
  inset: 0;
  backdrop-filter: blur(100px) brightness(0.9);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, transparent 10%, black 60%);
  mask-image: linear-gradient(to bottom, transparent 0%, transparent 10%, black 60%);
  z-index: 1;
}

.np-bg-layer::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.137), rgba(0, 0, 0, 0) 80%, rgba(0, 0, 0, 0.8) 100%);
  z-index: 2;
}

.np-bg-reflection.full {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 380px;
  background-size: cover;
  background-position: center;
  transform: scaleY(-1) scale(1.06);
  transform-origin: center;
  filter: blur(40px) brightness(0.75);
  -webkit-mask-image: linear-gradient(to bottom, transparent 35%, black 100%);
  mask-image: linear-gradient(to bottom, transparent 35%, black 100%);
  z-index: 3;
  pointer-events: none;
  opacity: 0.65;
}

.np-header-section {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 60px 40px 12px 40px;
  height: 300px;
  min-height: 300px;
  box-sizing: border-box;
  color: white;
}

.np-header-content {
  display: flex;
  align-items: flex-end;
  width: 100%;
}

.np-cover-wrapper {
  width: 200px;
  height: auto;
  aspect-ratio: 1/1;
  flex-shrink: 0;
  border-radius: 8px;
  overflow: hidden;
  margin-right: 24px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}

.np-cover-wrapper.full {
  display: none;
}

.np-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.5s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.np-cover-img.is-playing {
  animation: coverSpin 20s linear infinite;
}

@keyframes coverSpin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

.np-info-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding-bottom: 8px;
}

.np-title {
  font-size: 40px;
  font-weight: 800;
  line-height: 1.1;
  margin-bottom: 8px;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
}

.np-tags-row {
  display: flex;
  gap: 8px;
  font-size: 15px;
  opacity: 0.9;
  margin-bottom: 8px;
  font-weight: 500;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.np-desc-row {
  font-size: 14px;
  opacity: 0.8;
  margin-bottom: 16px;
  max-width: 600px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}

.np-actions-row {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 12px;
  max-width: 400px;
}

.np-time {
  font-size: 12px;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}

.np-slider-wrapper {
  display: none;
}

.np-placeholder {
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.np-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  color: rgba(255, 255, 255, 0.6);
}

.recommend-card {
  cursor: pointer;
  border-radius: 12px;
  transition: transform 0.2s, background-color 0.2s;
}

.recommend-card:hover {
  transform: translateY(-4px);
}

.recommend-card:hover .rc-play-overlay {
  opacity: 1;
}

.recommend-card:hover .rc-cover {
  transform: scale(1.05);
}

.rc-cover-wrapper {
  position: relative;
  width: 100%;
  padding-bottom: 100%;
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 8px;
  background-color: rgba(0, 0, 0, 0.05);
}

.rc-cover {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s;
}

.rc-play-overlay {
  position: absolute;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.3s;
}

.rc-info {
  padding: 0 4px;
}

.rc-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.rc-subtitle {
  font-size: 12px;
  color: var(--n-text-color-3);
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:root[data-theme='light'] .np-bg-layer::before {
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0) 80%, rgba(255, 255, 255, 0.9) 100%);
}

:root[data-theme='light'] .np-bg-reflection {
  filter: blur(40px) brightness(1.1);
  opacity: 0.6;
}

:root[data-theme='light'] .np-header-section {
  color: black;
}

:root[data-theme='light'] .np-title {
  color: rgba(0, 0, 0, 0.74);
  font-family: 'SHSC';
  text-shadow: none;
}

:root[data-theme='light'] .np-tags-row {
  color: rgba(0, 0, 0, 0.8);
  text-shadow: none;
}

:root[data-theme='light'] .np-desc-row {
  color: rgba(0, 0, 0, 0.699);
  text-shadow: none;
  opacity: 0.9;
}

:root[data-theme='light'] .np-placeholder {
  background: linear-gradient(135deg, #e8e8f0 0%, #dce0f0 50%, #cfd8f0 100%);
}

:root[data-theme='light'] .np-empty {
  color: rgba(0, 0, 0, 0.5);
}

html[data-theme='dark'] .np-title {
  font-family: 'SHSC', serif;
  color: white !important;
}

html[data-theme='dark'] .np-tags-row {
  color: white !important;
}

html[data-theme='dark'] .np-desc-row {
  color: white !important;
}

html[data-theme='dark'] .np-time {
  color: white !important;
}

@media (max-width: 768px) {
  .now-playing-section {
    height: 280px;
  }

  .np-bg-layer {
    height: 280px;
  }

  .np-bg-reflection {
    height: 280px;
  }

  .np-header-section {
    padding: 40px 20px 12px 20px;
    height: 250px;
    min-height: 250px;
  }

  .np-cover-wrapper {
    width: 120px;
  }

  .np-title {
    font-size: 24px;
  }

  .np-actions-row {
    max-width: 100%;
  }
}
</style>
