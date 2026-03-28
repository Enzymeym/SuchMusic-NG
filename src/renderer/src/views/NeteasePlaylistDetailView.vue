<template>
  <div v-if="playlist" class="playlist-detail" :class="[layoutStyle, playlist.coverStyle || 'square']">
    <!-- 背景层（仅现代模式）：统一模糊背景 -->
    <div
      v-if="layoutStyle === 'modern'"
      class="bg-layer"
      :class="playlist.coverStyle || 'square'"
      :style="{ backgroundImage: `url(${playlistCover})` }"
    ></div>

    <!-- 底部倒转模糊层 -->
    <div
      v-if="layoutStyle === 'modern'"
      class="bg-reflection"
      :class="playlist.coverStyle || 'square'"
      :style="{ backgroundImage: `url(${playlistCover})` }"
    ></div>

    <div class="header-section">
      <!-- 现代模式下增加一层容器，方便布局 -->
      <div class="header-content">
        <!-- 封面 -->
        <div class="cover-wrapper" :class="playlist.coverStyle || 'square'">
          <img :src="playlistCover" class="cover-img" :style="playlistCoverStyle" />
        </div>

        <!-- 信息区域 -->
        <div class="info-wrapper">
          <div class="playlist-title" :style="playlistTitleStyle">{{ playlist.name }}</div>

          <div class="creator-info" v-if="playlist.creator">
            <n-avatar round size="small" :src="playlist.creator.avatarUrl" style="margin-right: 8px" />
            <span class="creator-name">{{ playlist.creator.nickname }}</span>
            <span class="create-time">{{ formatDate(playlist.createTime) }} 创建</span>
          </div>

          <div class="tags-row" v-if="layoutStyle === 'classic' && playlist.tags?.length">
            <span class="tag" v-for="tag in playlist.tags" :key="tag">{{ tag }}</span>
          </div>

          <!-- 描述 -->
          <div class="desc-row">
            <div class="desc-text line-clamp-2">
              {{ playlist.description || '暂无简介' }}
            </div>
          </div>

          <!-- 按钮组 -->
          <div class="actions-row" style="justify-content: space-between;">
            <div class="actions-row">
              <n-button type="primary" round size="large" @click="playAll" :loading="loadingTracks && songsForList.length === 0">
                <template #icon>
                  <n-icon><i class="mgc_play_fill"></i></n-icon>
                </template>
                播放全部
              </n-button>

              <n-button secondary round size="large">
                <template #icon>
                  <n-icon><i class="mgc_star_line"></i></n-icon>
                </template>
                {{ formatCount(dynamicData?.bookedCount || playlist.trackCount) }}
              </n-button>

              <n-button secondary round size="large">
                <template #icon>
                  <n-icon><i class="mgc_share_forward_line"></i></n-icon>
                </template>
                {{ formatCount(dynamicData?.shareCount || 0) }}
              </n-button>
            </div>
            
            <div class="action-row" style="display: flex; gap: 12px; align-items: center; opacity: 0.8; font-size: 13px;">
              <span v-if="dynamicData?.playCount">
                <n-icon><i class="mgc_play_line"></i></n-icon> {{ formatCount(dynamicData.playCount) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 歌曲列表 -->
    <div class="list-section">
      <SongList
        :songs="songsForList"
        :loading="loadingTracks && songsForList.length === 0"
        :current-playing-song-id="player.currentSong?.sourceSongId ? String(player.currentSong.sourceSongId) : (player.currentSong?.id ? String(player.currentSong.id) : null)"
        :transparent-header="layoutStyle === 'modern'"
        :item-variant="layoutStyle === 'modern' ? 'plain' : 'card'"
        :draggable="false"
        @song-click="handleSongClick"
      />
      <div ref="loadTrigger" class="load-trigger">
        <n-spin v-if="loadingTracks && songsForList.length > 0" size="small" />
        <span v-else-if="!hasMore" class="no-more">没有更多了</span>
      </div>
    </div>
  </div>

  <div v-else-if="loadingDetail" class="loading-container">
    <n-spin size="large" />
  </div>

  <div v-else class="not-found">
    <n-empty description="未找到歌单或加载失败" />
    <n-button style="margin-top: 16px" @click="router.back()">返回</n-button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, type CSSProperties, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NIcon, NEmpty, NSpin, NAvatar, useMessage } from 'naive-ui'
import { usePlayerStore } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import SongList from '../components/common/SongList.vue'
import defaultCover from '@renderer/assets/icon.png'
import { AudioPlayerManager } from '../utils/audioPlayerManager'
import { runSnowdropGetMusicUrl } from '../apis/snowdrop-transform'
import { fetchNewLyric } from '../apis/netease/lyric'
import {
  fetchPlaylistDetail,
  fetchPlaylistTracks,
  fetchPlaylistDynamic,
  type PlaylistDetail,
  type PlaylistDynamicResponse,
  type PlaylistTrack
} from '../apis/netease/playlist/detail'

const route = useRoute()
const router = useRouter()
const player = usePlayerStore()
const settingsStore = useSettingsStore()
const message = useMessage()

const playlistId = route.params.id as string

const layoutStyle = ref<'classic' | 'modern'>(
  settingsStore.appearance.playlistLayoutStyle || 'classic'
)

const playlist = ref<PlaylistDetail & { coverStyle?: string; titleFontWeight?: string; titleFontFamily?: string } | null>(null)
const dynamicData = ref<PlaylistDynamicResponse | null>(null)
const tracks = ref<PlaylistTrack[]>([])

const loadingDetail = ref(true)
const loadingTracks = ref(false)
const hasMore = ref(true)
const offset = ref(0)
const limit = 50

const loadTrigger = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

// 格式化数字
const formatCount = (count: number): string => {
  if (!Number.isFinite(count)) return '0'
  if (count >= 100000000) return `${(count / 100000000).toFixed(1)}亿`
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return String(count)
}

// 格式化日期
const formatDate = (time: number): string => {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const loadDetail = async () => {
  loadingDetail.value = true
  try {
    const [detailRes, dynamicRes] = await Promise.all([
      fetchPlaylistDetail(playlistId),
      fetchPlaylistDynamic(playlistId)
    ])
    
    if (detailRes && detailRes.playlist) {
      playlist.value = {
        ...detailRes.playlist,
        coverStyle: 'square', // 默认样式
        titleFontWeight: 'bold',
        titleFontFamily: 'default'
      }
    }
    
    if (dynamicRes) {
      dynamicData.value = dynamicRes
    }
  } finally {
    loadingDetail.value = false
  }
}

const loadMoreTracks = async () => {
  if (loadingTracks.value || !hasMore.value) return
  
  loadingTracks.value = true
  try {
    const res = await fetchPlaylistTracks(playlistId, limit, offset.value)
    if (res && res.songs) {
      tracks.value.push(...res.songs)
      offset.value += res.songs.length
      
      // 网易云的 trackCount 可能不准确，或者 songs 数量小于 limit 时说明到底了
      if (res.songs.length < limit || (playlist.value && tracks.value.length >= playlist.value.trackCount)) {
        hasMore.value = false
      }
    } else {
      hasMore.value = false
    }
  } catch (error) {
    console.error('加载歌曲失败:', error)
    hasMore.value = false
  } finally {
    loadingTracks.value = false
  }
}

onMounted(async () => {
  await loadDetail()
  await loadMoreTracks()
  
  observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && hasMore.value && !loadingTracks.value) {
      loadMoreTracks()
    }
  }, { rootMargin: '200px' })
  
  // Need to wait for DOM to update after loadDetail
  nextTick(() => {
    if (loadTrigger.value) {
      observer?.observe(loadTrigger.value)
    }
  })
})

onUnmounted(() => {
  if (observer) {
    observer.disconnect()
  }
})

const playlistCover = computed(() => {
  if (!playlist.value) return defaultCover
  return playlist.value.coverImgUrl || defaultCover
})

const playlistCoverStyle = computed<CSSProperties>(() => {
  if (!playlist.value) return {}
  const style = playlist.value.coverStyle || 'square'
  
  switch (style) {
    case 'full': return { objectFit: 'cover' }
    case 'square': 
    default: return { aspectRatio: '1/1', objectFit: 'cover' }
  }
})

const playlistTitleStyle = computed(() => {
  if (!playlist.value) return {}
  const weight = playlist.value.titleFontWeight || 'bold'
  const family = playlist.value.titleFontFamily || 'default'
  
  const weightMap: Record<string, string> = {
    light: '300',
    regular: '400',
    bold: '700',
    heavy: '900'
  }
  
  return {
    fontWeight: weightMap[weight] || 'bold',
    fontFamily: family === 'serif' ? '"SHSC", serif' : 'inherit'
  }
})

// 转换成 SongList 组件需要的格式
const songsForList = computed(() => {
  return tracks.value.map((t) => ({
    id: String(t.id),
    name: t.name,
    al: t.al ? { name: t.al.name } : undefined,
    ar: t.ar && t.ar.length > 0 ? t.ar.map(a => ({ name: a.name })) : [{ name: '未知歌手' }],
    dt: t.dt,
    picUrl: t.al?.picUrl || defaultCover,
    source: 'netease',
    sourceSongId: t.id
  }))
})

// 播放逻辑与 PlaylistDetailView 类似，但在获取 URL 时统一走在线逻辑
const getPlayableList = () => {
  return tracks.value.map((t) => ({
    id: String(t.id),
    title: t.name,
    artist: t.ar?.map(a => a.name).join('/') || '未知歌手',
    album: t.al?.name || '未知专辑',
    cover: t.al?.picUrl || defaultCover,
    durationMs: t.dt || 0,
    source: 'netease' as const,
    sourceSongId: t.id,
    lyrics: ''
  }))
}

const playAll = () => {
  const list = getPlayableList()
  if (list.length === 0) return
  
  player.setPlaylist(list)
  player.setCurrentSong(list[0])
  player.setPlaying(true)
}

const handleSongClick = async (song: any) => {
  const list = getPlayableList()
  
  // 更新播放列表
  player.setPlaylist(list)
  const target = list.find((s) => s.id === String(song.id))
  if (!target) return

  // 歌词重试获取函数
  const fetchLyricWithRetry = async (id: string, source: string): Promise<string> => {
    let attempt = 0
    while (true) {
      const currentId = player.currentSong?.sourceSongId ?? player.currentSong?.id
      if (String(currentId) !== String(id)) {
        return ''
      }

      try {
        if (source === 'wy' || source === 'netease') {
          const lyricRes = await fetchNewLyric(Number(id))
          if (lyricRes && lyricRes.code === 200) {
            const lrc =
              lyricRes.yrc?.lyric ||
              lyricRes.lrc?.lyric ||
              lyricRes.klyric?.lyric ||
              lyricRes.tlyric?.lyric ||
              lyricRes.romalrc?.lyric ||
              ''
            if (lrc) return lrc
          }
        }
      } catch (e) {
        console.warn(`获取歌词失败，第 ${attempt + 1} 次重试:`, e)
      }
      
      attempt++
      const delay = Math.min(500 + attempt * 500, 5000)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  const neteaseId = target.sourceSongId ?? target.id
  const quality = settingsStore.source.preferredQuality || '128k'
  let source =
    settingsStore.source.preferredPlatform === 'all'
      ? 'wy'
      : settingsStore.source.preferredPlatform
  
  if (source === 'netease') source = 'wy'
  else if (source === 'qq') source = 'tx'
  else if (source === 'kugou') source = 'kg'
  else if (source === 'kuwo') source = 'kw'
  else if (source === 'migu') source = 'mg'

  const cacheKey = `${source}:${neteaseId}:${quality}`
  
  // 先设置当前歌曲，触发 UI 变化
  player.setCurrentSong(target)

  // 1. 主动检测缓存
  if (window.electron && window.electron.ipcRenderer) {
    try {
      const cachePath = await window.electron.ipcRenderer.invoke('online-cache:check', {
         dir: settingsStore.local.cacheDir || null,
         key: cacheKey
      })

      if (cachePath) {
         let lyrics = await fetchLyricWithRetry(String(neteaseId), source)

         await AudioPlayerManager.play({
           filePath: cachePath,
           volume: player.volume
         })

         player.setCurrentSong({
           ...target,
           filePath: cachePath,
           lyrics: lyrics
         })
         player.setPlaying(true)
         message.success('从本地缓存播放')
         return
      }
    } catch (e) {
       console.warn('主动检测缓存失败:', e)
    }
  }

  // 2. 在线获取逻辑
  try {
    message.loading('正在获取播放链接...')

    const musicInfo = {
      id: String(neteaseId),
      name: target.title,
      singer: target.artist || '未知歌手',
      albumName: target.album || '未知专辑',
      pic: target.cover || '',
      songmid: String(neteaseId),
      mediaId: String(neteaseId)
    }

    const lyricPromise = fetchLyricWithRetry(String(neteaseId), source).catch(() => '')

    const { url } = await runSnowdropGetMusicUrl(source, musicInfo, quality)
    if (!url) {
      throw new Error('未获取到播放链接')
    }

    let finalUrl = url
    let cacheFilePath: string | null = null

    if (window.electron && window.electron.ipcRenderer) {
      try {
        const cacheResult = (await window.electron.ipcRenderer.invoke(
          'online-cache:prepare',
          {
            dir: settingsStore.local.cacheDir || null,
            key: cacheKey,
            url
          }
        )) as { usedCache: boolean; filePath: string | null; url: string }

        if (cacheResult.filePath) {
          cacheFilePath = cacheResult.filePath
          finalUrl = cacheResult.url || url
        }
      } catch (e) {
        console.error('准备在线播放缓存失败:', e)
      }
    }

    const lyrics = await lyricPromise

    try {
      await AudioPlayerManager.play({
        filePath: cacheFilePath || undefined,
        url: finalUrl,
        volume: player.volume
      })
    } catch (e) {
      console.error('播放失败，尝试回退纯URL播放:', e)
      await AudioPlayerManager.play({
        url: finalUrl,
        volume: player.volume
      })
    }

    player.setCurrentSong({
      ...target,
      lyrics
    })
    player.setPlaying(true)
    message.success('开始播放')
  } catch (error: any) {
    console.error('播放失败:', error)
    message.error(`播放失败: ${error?.message || '未知错误'}`)
  }
}
</script>

<style scoped>
/* 可以直接复用 PlaylistDetailView.vue 的样式，为了完整性，这里包含样式 */
.playlist-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  /* 因为在 MainLayout 中 immersive-container 已经去除了 padding-top 并设置了 max-width: none */
  /* 所以这里不再需要使用负的 margin，只要占满 100% 即可 */
  width: 100%;
}

.loading-container, .not-found {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.list-section {
  flex: 1;
  overflow-y: hidden;
  /* 列表区域背景色，确保文字清晰 */
  background: transparent;
  display: flex;
  flex-direction: column;
}

.load-trigger {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 16px;
  height: 60px;
  color: #888;
  font-size: 13px;
}

/* ================= Classic Style ================= */
.playlist-detail.classic {
  background-color: transparent;
}

.classic .header-section {
  display: flex;
  padding: 30px 30px 0 30px;
  margin-bottom: 20px;
  position: relative;
}

.classic .cover-wrapper {
  width: 180px;
  height: auto;
  aspect-ratio: 1 / 1;
  flex-shrink: 0;
  border-radius: 8px;
  overflow: hidden;
  margin-right: 20px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.classic .cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.classic .info-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
}

.classic .playlist-title {
  font-size: 24px;
  font-weight: bold;
  margin-bottom: 12px;
  line-height: 1.2;
}

.classic .creator-info {
  display: flex;
  align-items: center;
  font-size: 13px;
  color: #666;
  margin-bottom: 12px;
}

.classic .creator-name {
  color: #0c73c2;
  margin-right: 12px;
}

.classic .create-time {
  color: #999;
}

.classic .tags-row {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.classic .tag {
  font-size: 12px;
  color: #666;
  background: rgba(0, 0, 0, 0.05);
  padding: 2px 8px;
  border-radius: 12px;
}

.classic .desc-row {
  font-size: 13px;
  color: #666666c4;
  line-height: 1.5;
  margin-bottom: auto;
}

.classic .actions-row {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}

/* ================= Modern Style ================= */
.playlist-detail.modern {
  overflow-y: auto;
  position: relative;
}

.modern .bg-layer {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 332px;
  background-size: cover;
  background-position: center;
  transform: scale(1.06);
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 20%, transparent 100%);
  mask-image: linear-gradient(to bottom, black 0%, black 20%, transparent 100%);
}

.modern .bg-layer.square {
  -webkit-mask-image: linear-gradient(to bottom, black 0%, transparent 60%);
  mask-image: linear-gradient(to bottom, black 0%, transparent 60%);
  opacity: 0.6;
  filter: blur(20px) brightness(0.8);
}

.modern .bg-layer::after {
  content: '';
  position: absolute;
  inset: 0;
  backdrop-filter: blur(20px) brightness(0.9);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, transparent 10%, black 60%);
  mask-image: linear-gradient(to bottom, transparent 0%, transparent 10%, black 60%);
  z-index: 1;
}

.modern .bg-layer::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.137), rgba(0, 0, 0, 0) 80%, rgba(0, 0, 0, 0.8) 100%);
  z-index: 2;
}

[data-theme='light'] .modern .bg-layer::before {
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0) 80%, rgba(255, 255, 255, 0.9) 100%);
}

.modern .bg-reflection {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 332px;
  background-size: cover;
  background-position: center;
  transform: scaleY(-1) scale(1.06);
  transform-origin: center;
  filter: blur(40px) brightness(0.8);
  -webkit-mask-image: linear-gradient(to bottom, transparent 60%, black 100%);
  mask-image: linear-gradient(to bottom, transparent 60%, black 100%);
  z-index: 3;
  pointer-events: none;
  opacity: 0.8;
}

[data-theme='light'] .modern .bg-reflection {
  filter: blur(40px) brightness(1.1);
  opacity: 0.6;
}

.modern .bg-reflection.square {
  opacity: 0.2;
  filter: blur(60px) brightness(0.6);
}

.modern .header-section {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 60px 40px 12px 40px;
  min-height: 300px;
  box-sizing: border-box;
  color: white;
}

[data-theme='light'] .modern .header-section {
  color: black;
}

.modern .header-content {
  display: flex;
  align-items: flex-end;
  width: 100%;
}

.modern .cover-wrapper {
  display: block;
  width: 200px;
  height: auto;
  aspect-ratio: 1/1;
  border-radius: 8px;
  overflow: hidden;
  margin-right: 24px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.3);
}

.modern .cover-wrapper.full {
  display: none;
}

.modern .cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.modern .info-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding-bottom: 8px;
}

.modern .playlist-title {
  font-size: 40px;
  font-weight: 800;
  margin-bottom: 8px;
  line-height: 1.1;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
}

[data-theme='light'] .modern .playlist-title {
  color: rgba(0, 0, 0, 0.74);
  font-family: 'SHSC';
  text-shadow: none;
}

.modern .creator-info {
  display: flex;
  align-items: center;
  font-size: 15px;
  color: rgba(255, 255, 255, 0.9);
  margin-bottom: 24px;
  font-weight: 500;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

[data-theme='light'] .modern .creator-info {
  color: rgba(0, 0, 0, 0.8);
  text-shadow: none;
}

.modern .creator-name {
  color: white;
  font-weight: 700;
  margin-right: 12px;
}

[data-theme='light'] .modern .creator-name {
  color: black;
}

.modern .desc-row {
  margin-bottom: 16px;
  font-size: 14px;
  opacity: 0.8;
  max-width: 600px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  color: white;
}

[data-theme='light'] .modern .desc-row {
  color: rgba(0, 0, 0, 0.699);
  text-shadow: none;
  opacity: 0.9;
}

.modern .actions-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.modern .list-section {
  position: relative;
  z-index: 1;
  background: transparent;
  padding: 0 40px;
}

@media (prefers-color-scheme: dark) {
  .classic .creator-name {
    color: #4da1ff;
  }
  .classic .creator-info,
  .classic .desc-row {
    color: #aaa;
  }
  .classic .tag {
    background: rgba(255, 255, 255, 0.1);
    color: #ccc;
  }
}

.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
