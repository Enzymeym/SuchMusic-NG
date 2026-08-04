<template>
  <div v-if="album && album.songs.length > 0" ref="detailRef" class="album-detail modern full" :class="{ collapsed: isCollapsed }" @scroll="handleScroll">
    <div class="header-section">
      <div class="header-content">
        <!-- 封面 -->
        <div class="cover-wrapper">
          <img :src="albumCover" class="cover-img" loading="lazy" decoding="async" />
        </div>

        <!-- 信息区域 -->
        <div class="info-wrapper">
          <div class="album-title">{{ album.name }}</div>

          <div class="artist-row" v-if="album.artist">
            <span class="artist-name">{{ album.artist }}</span>
            <span class="album-year" v-if="albumYear">{{ albumYear }}</span>
          </div>

          <!-- 按钮组 -->
          <div class="actions-row">
            <n-button :color="accentColor" round size="large" @click="playAll">
              <template #icon>
                <n-icon><i class="mgc_play_fill"></i></n-icon>
              </template>
              播放
            </n-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 歌曲列表 -->
    <div class="list-section">
      <SongList
        :songs="songsForList"
        :loading="false"
        :current-playing-song-id="player.currentSong?.id ?? null"
        :transparent-header="true"
        item-variant="plain"
        @song-click="handleSongClick"
      />
    </div>
  </div>

  <div v-else class="not-found">
    <n-empty description="未找到专辑" />
    <n-button style="margin-top: 16px" @click="router.push('/album')">返回</n-button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NIcon, NEmpty, useMessage } from 'naive-ui'
import { usePlayerStore } from '../stores/playerStore'
import { usePlaylistTheme } from '../composables/usePlaylistTheme'
import SongList from '../components/common/SongList.vue'
import defaultCover from '@renderer/assets/default-cover.png'
import { albumCache, type AlbumInfo } from '../stores/albumCache'

const route = useRoute()
const router = useRouter()
const player = usePlayerStore()
const message = useMessage()

const albumName = computed(() => route.params.name as string)

const album = ref<AlbumInfo | null>(null)

// 滚动驱动页头收缩
const detailRef = ref<HTMLElement | null>(null)
const scrollY = ref(0)
const HEADER_COLLAPSE_THRESHOLD = 200
const isCollapsed = computed(() => scrollY.value >= HEADER_COLLAPSE_THRESHOLD)

const handleScroll = () => {
  if (!detailRef.value) return
  scrollY.value = detailRef.value.scrollTop
}

// 专辑封面：查找第一首有封面的歌曲
const albumCover = computed(() => {
  if (!album.value) return defaultCover
  const firstWithCover = album.value.songs.find(s => s.cover)
  return firstWithCover?.cover || album.value.cover || defaultCover
})

// 专辑年份：从歌曲中提取
const albumYear = computed(() => {
  if (!album.value) return undefined
  for (const s of album.value.songs) {
    if (s.year) return s.year
  }
  return undefined
})

// 根据封面提取主题色
const { accentColor } = usePlaylistTheme(() => albumCover.value)

// 转换成 SongList 需要的格式
const songsForList = computed(() => {
  if (!album.value) return []
  return album.value.songs.map((s) => ({
    id: s.id ?? '',
    name: s.title,
    al: s.album ? { name: s.album } : undefined,
    ar: [{ name: s.artist || '未知歌手' }],
    dt: s.durationMs,
    picUrl: s.cover || defaultCover,
    filePath: s.filePath
  }))
})

const playAll = () => {
  if (!album.value || !album.value.songs.length) return
  const list = album.value.songs.map((s) => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album,
    cover: s.cover || '',
    filePath: s.filePath,
    durationMs: s.durationMs || 0,
    lyrics: ''
  }))
  player.setPlaylist(list)
  if (list.length > 0) {
    player.setCurrentSong(list[0])
  }
}

const handleSongClick = (song: any) => {
  if (!album.value) return

  const list = album.value.songs.map((s) => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album,
    cover: s.cover || '',
    filePath: s.filePath,
    durationMs: s.durationMs || 0,
    lyrics: ''
  }))

  const target = list.find((s) => s.id === song.id)
  if (!target) return

  if (!target.filePath) {
    message.error('找不到本地文件')
    return
  }

  // 统一交由 PlayerBar 的 watch 监听 currentSong 变化来处理实际播放
  player.setPlaylist(list)
  player.setCurrentSong(target)

  if (/^https?:\/\//.test(target.filePath)) {
    message.success('正在播放在线音频')
  } else {
    message.success('从本地缓存播放')
  }
}

onMounted(() => {
  // 优先从 AlbumView 的缓存中获取专辑数据
  const cached = albumCache.get(albumName.value)
  if (cached) {
    album.value = cached
  }
})
</script>

<style scoped>
.album-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  width: 100%;
  padding-top: 64px;
}

.not-found {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.list-section {
  flex: 1;
  overflow: hidden;
  background: transparent;
  position: relative;
  z-index: 1;
  padding: 0 40px;
}

/* ================= Modern Full Style ================= */

.header-section {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 24px 40px 12px 40px;
  min-height: 240px;
  box-sizing: border-box;
  color: white;
}

[data-theme='light'] .header-section {
  color: black;
}

.header-content {
  display: flex;
  align-items: flex-end;
  width: 100%;
}

.cover-wrapper {
  display: block;
  width: 200px;
  height: auto;
  aspect-ratio: 1/1;
  border-radius: 14px;
  overflow: hidden;
  margin-right: 24px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  flex-shrink: 0;
}

.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.info-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding-bottom: 8px;
}

.album-title {
  font-size: 40px;
  font-weight: 800;
  margin-bottom: 4px;
  line-height: 1.1;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
}

[data-theme='light'] .album-title {
  color: rgba(0, 0, 0, 0.74);
  font-family: 'SHSC';
  text-shadow: none;
}

.artist-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  color: rgba(255, 255, 255, 0.9);
  margin-bottom: 24px;
  font-weight: 500;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

[data-theme='light'] .artist-row {
  color: rgba(0, 0, 0, 0.8);
  text-shadow: none;
}

.artist-name {
  font-weight: 700;
}

.album-year {
  color: rgba(255, 255, 255, 0.5);
  font-weight: 400;
  font-size: 13px;
}

[data-theme='light'] .album-year {
  color: rgba(0, 0, 0, 0.45);
}

.actions-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* ================= Collapsed Header ================= */
.header-section {
  transition: min-height 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              padding 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.cover-wrapper {
  transition: width 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              height 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              margin-right 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              border-radius 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.album-title {
  transition: font-size 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              margin-bottom 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.actions-row,
.artist-row {
  transition: opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1),
              max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              margin 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.album-detail.collapsed .header-section {
  min-height: 60px;
  padding: 8px 40px;
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgba(0, 0, 0, 0.08);
  backdrop-filter: blur(30px);
  -webkit-backdrop-filter: blur(30px);
}

[data-theme='light'] .album-detail.collapsed .header-section {
  background: rgba(255, 255, 255, 0.5);
}

.album-detail.collapsed .header-content {
  align-items: center;
}

.album-detail.collapsed .album-title {
  font-size: 20px;
  margin-bottom: 0;
  text-shadow: none;
}

.album-detail.collapsed .actions-row,
.album-detail.collapsed .artist-row {
  opacity: 0;
  max-height: 0;
  margin: 0;
  overflow: hidden;
  pointer-events: none;
}

/* 收缩态：封面缩小 */
.album-detail.collapsed .cover-wrapper {
  width: 44px;
  height: 44px;
  aspect-ratio: 1/1;
  border-radius: 8px;
  margin-right: 12px;
}
</style>
