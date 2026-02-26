<template>
  <div v-if="playlist" class="playlist-detail" :class="layoutStyle">
    <!-- 背景层（仅现代模式）：统一模糊背景 -->
    <div
      v-if="layoutStyle === 'modern'"
      class="bg-layer"
      :style="{ backgroundImage: `url(${playlistCover})` }"
    ></div>

    <div class="header-section">
      <!-- 现代模式下增加一层容器，方便布局 -->
      <div class="header-content">
        <!-- 封面 -->
        <div class="cover-wrapper">
          <img :src="playlistCover" class="cover-img" />
        </div>

        <!-- 信息区域 -->
        <div class="info-wrapper">
          <div class="playlist-title">{{ playlist.name }}</div>

          <!-- 标签（模拟数据，实际UserPlaylist暂无标签字段） -->
          <div class="tags-row" v-if="layoutStyle === 'classic'">
            <span class="tag">本地歌单</span>
            <span class="tag">自建</span>
          </div>

          <!-- 描述（模拟数据） -->
          <div class="desc-row" v-if="layoutStyle === 'classic'">
            <div class="desc-text line-clamp-2">
              这是一个本地创建的歌单，包含了 {{ playlist.tracks.length }} 首歌曲。
            </div>
          </div>

          <!-- 按钮组 -->
          <div class="actions-row" style="justify-content: space-between;">
            <div class="actions-row">
              <n-button type="primary" round size="large" @click="playAll">
                <template #icon>
                  <n-icon><i class="mgc_play_fill"></i></n-icon>
                </template>
                播放全部
              </n-button>

              <n-button secondary circle size="large">
                <template #icon>
                  <n-icon><i class="mgc_folder_download_line"></i></n-icon>
                </template>
              </n-button>

              <n-button secondary circle size="large">
                <template #icon>
                  <n-icon><i class="mgc_more_2_line"></i></n-icon>
                </template>
              </n-button>
            </div>
            <div class="action-row">
              <n-button size="large" secondary circle @click="showSettings = true">
                <template #icon>
                  <n-icon><i class="mgc_settings_3_line"></i></n-icon>
                </template>
              </n-button>
            </div>
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
        :transparent-header="layoutStyle === 'modern'"
        :item-variant="layoutStyle === 'modern' ? 'plain' : 'card'"
        :draggable="true"
        @song-click="handleSongClick"
        @reorder="handleReorder"
      />
    </div>

    <PlaylistSettingsModal v-model:show="showSettings" v-model:layoutStyle="layoutStyle" />
  </div>

  <div v-else class="not-found">
    <n-empty description="未找到歌单" />
    <n-button style="margin-top: 16px" @click="router.back()">返回</n-button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NIcon, NEmpty, useMessage } from 'naive-ui'
import { usePlaylistStore } from '../stores/playlistStore'
import { usePlayerStore } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import SongList from '../components/common/SongList.vue'
import PlaylistSettingsModal from '../components/common/PlaylistSettingsModal.vue'
import defaultCover from '@renderer/assets/icon.png'
import { webAudioEngine } from '../audio/audio-engine'
import { runSnowdropGetMusicUrl } from '../apis/snowdrop-transform'
import { fetchNewLyric } from '../apis/netease/lyric'

const route = useRoute()
const router = useRouter()
const playlistStore = usePlaylistStore()
const player = usePlayerStore()
const settingsStore = useSettingsStore()
const message = useMessage()

const playlistId = route.params.id as string
// 初始化时从 store 获取布局风格
const layoutStyle = ref<'classic' | 'modern'>(
  settingsStore.appearance.playlistLayoutStyle || 'classic'
)
const showSettings = ref(false)

const playlist = computed(() => {
  return playlistStore.playlists.find((p) => p.id === playlistId)
})

// 歌单封面：优先使用自定义封面，其次使用第一首歌的封面，最后使用默认图标
const playlistCover = computed(() => {
  if (!playlist.value) return defaultCover
  if (playlist.value.cover) return playlist.value.cover
  const first = playlist.value.tracks[0]
  return first?.cover || defaultCover
})

// 监听布局风格变化并保存到 store
watch(layoutStyle, (newStyle) => {
  // 直接写入 store 的 appearance，利用 Pinia 的深度 watch 持久化到 localStorage
  settingsStore.appearance.playlistLayoutStyle = newStyle
})

// 转换成 SongList 组件需要的格式
const songsForList = computed(() => {
  if (!playlist.value) return []
  return playlist.value.tracks.map((t) => ({
    id: t.id ?? '',
    name: t.title,
    al: t.album ? { name: t.album } : undefined,
    ar: t.artist ? [{ name: t.artist }] : [{ name: '未知歌手' }],
    dt: t.durationMs,
    picUrl: t.cover || defaultCover,
    filePath: t.filePath,
    source: t.source,
    sourceSongId: t.sourceSongId
  }))
})

const playAll = () => {
  if (!playlist.value || !playlist.value.tracks.length) return
  // 复用之前的播放逻辑
  const list = playlist.value.tracks.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    cover: t.cover || defaultCover,
    filePath: t.filePath,
    durationMs: t.durationMs || 0,
    source: t.source,
    sourceSongId: t.sourceSongId,
    lyrics: ''
  }))
  player.setPlaylist(list)
  if (list.length > 0) {
    player.setCurrentSong(list[0])
    player.setPlaying(true)
  }
}

const handleSongClick = async (song: any) => {
  if (!playlist.value) return

  const list = playlist.value.tracks.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    cover: t.cover || defaultCover,
    filePath: t.filePath,
    durationMs: t.durationMs || 0,
    source: t.source,
    sourceSongId: t.sourceSongId,
    lyrics: ''
  }))

  player.setPlaylist(list)
  const target = list.find((s) => s.id === song.id)
  if (!target) return

  // 如果已有本地缓存文件，直接走本地文件播放链路，避免再次在线获取
  if (target.filePath && window.electron && window.electron.ipcRenderer) {
    try {
      console.log('[PlaylistDetail] 尝试从本地缓存播放网易云歌曲', {
        id: target.id,
        title: target.title,
        filePath: target.filePath
      })
      const data = (await window.electron.ipcRenderer.invoke(
        'audio:load-file',
        target.filePath
      )) as ArrayBuffer
      webAudioEngine.setVolume(player.volume)
      await webAudioEngine.playFromFileData(data)

      player.setCurrentSong({
        id: target.id,
        title: target.title,
        artist: target.artist,
        album: target.album,
        cover: target.cover || '',
        durationMs: target.durationMs || 0,
        filePath: target.filePath,
        source: target.source,
        sourceSongId: target.sourceSongId,
        lyrics: target.lyrics || ''
      })
      player.setPlaying(true)
      message.success('从本地缓存播放')
      return
    } catch (e) {
      console.error('从本地缓存播放失败，回退到在线获取:', e)
      // 失败时继续走下面的在线逻辑
    }
  }

  player.setCurrentSong(target)

  if (target.source === 'netease') {
    try {
      message.loading('正在获取播放链接...')

      const neteaseId = target.sourceSongId ?? target.id
      const musicInfo = {
        id: String(neteaseId),
        name: target.title,
        singer: target.artist || '未知歌手',
        albumName: target.album || '未知专辑',
        pic: target.cover || '',
        songmid: String(neteaseId),
        mediaId: String(neteaseId)
      }

      const source =
        settingsStore.source.preferredPlatform === 'all'
          ? 'wy'
          : settingsStore.source.preferredPlatform
      const quality = settingsStore.source.preferredQuality || '128k'

      const lyricPromise = fetchNewLyric(neteaseId as number).catch(() => null)

      const { url } = await runSnowdropGetMusicUrl(source, musicInfo, quality)
      if (!url) {
        throw new Error('未获取到播放链接')
      }

      const cacheKey = `netease:${neteaseId}:${quality}`
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

      const lyricRes = await lyricPromise
      let lyrics = ''
      if (lyricRes && lyricRes.code === 200) {
        lyrics =
          lyricRes.yrc?.lyric ||
          lyricRes.lrc?.lyric ||
          lyricRes.klyric?.lyric ||
          lyricRes.tlyric?.lyric ||
          lyricRes.romalrc?.lyric ||
          ''
      }

      if (cacheFilePath && window.electron && window.electron.ipcRenderer) {
        try {
          const data = (await window.electron.ipcRenderer.invoke(
            'audio:load-file',
            cacheFilePath
          )) as ArrayBuffer
          webAudioEngine.setVolume(player.volume)
          await webAudioEngine.playFromFileData(data)
        } catch (e) {
          console.error('从缓存文件播放失败，回退到在线播放:', e)
          await webAudioEngine.playFromUrl(finalUrl)
        }
      } else {
        await webAudioEngine.playFromUrl(finalUrl)
      }

      player.setCurrentSong({
        id: target.id,
        title: target.title,
        artist: target.artist,
        album: target.album,
        cover: target.cover || '',
        durationMs: target.durationMs || 0,
        source: 'netease',
        sourceSongId: neteaseId ?? undefined,
        lyrics
      })
      player.setPlaying(true)
      message.success('开始播放')
    } catch (error: any) {
      console.error('播放失败:', error)
      message.error(`播放失败: ${error?.message || '未知错误'}`)
    }
  } else {
    player.setPlaying(true)
  }
}

const handleReorder = (fromIndex: number, toIndex: number) => {
  if (!playlist.value) return
  const tracks = [...playlist.value.tracks]
  const moved = tracks.splice(fromIndex, 1)[0]
  tracks.splice(toIndex, 0, moved)
  const updated = {
    ...playlist.value,
    tracks
  }
  playlistStore.updatePlaylist(updated)
}

onMounted(() => {
  // 确保数据已加载
  if (playlistStore.playlists.length === 0) {
    playlistStore.loadFromStorage()
  }
})
</script>

<style scoped>
.playlist-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
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
  /* 列表区域背景色，确保文字清晰 */
  background: transparent;
}

.style-switcher {
  position: absolute;
  top: 20px;
  right: 20px;
  z-index: 100;
}

/* ================= Classic Style (Netease-like) ================= */
.playlist-detail.classic {
  background-color: transparent;
}

.classic .header-section {
  display: flex;
  padding: 30px 30px 0 30px;
  margin-bottom: 20px;
}

.classic .cover-wrapper {
  width: 180px;
  height: 180px;
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
  transform: translate(0, -50%);
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
  color: #0c73c2; /* 仿网易云蓝 */
  margin-right: 12px;
  cursor: pointer;
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
  color: #666;
  line-height: 1.5;
  margin-bottom: auto; /* Push buttons to bottom if needed, or just let them flow */
}

.classic .actions-row {
  margin-top: 16px;
  display: flex;
  align-items: center;
}

/* ================= Modern Style (Apple-like) ================= */
.playlist-detail.modern {
  /* 现代模式下整体可滚动 */
  overflow-y: auto;
  position: relative;
}

.modern .bg-layer {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 332px; /* 背景高度缩短，避免占据过多内容区域 */
  background-size: cover;
  background-position: center;
  /* 普通统一模糊效果 */
  filter: blur(40px) brightness(0.7);
  transform: scale(1.06); /* 放大一点，避免边缘被裁切 */
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}

.modern .header-section {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column; /* 改为垂直布局，模拟大封面在顶部的效果，或者保持水平 */
  align-items: flex-start;
  justify-content: flex-end;
  padding: 60px 40px 12px 40px; /* 增加顶部 padding 避开标题栏 */
  min-height: 300px; /* 增加头部高度 */
  box-sizing: border-box;
  color: white;
}

/* 调整布局为：左下角封面+信息 */
.modern .header-content {
  display: flex;
  align-items: flex-end;
  width: 100%;
}

.modern .cover-wrapper {
  /* 现代模式下隐藏小封面，因为背景已经是大封面了，或者按需求隐藏 */
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
  font-size: 36px; /* 更大的标题 */
  font-weight: 800;
  margin-bottom: 16px;
  line-height: 1.1;
  text-shadow: 0 4px 12px rgba(0, 0, 0, 0.11);
  letter-spacing: -1px;
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

.modern .creator-name {
  color: white;
  font-weight: 700;
  margin-right: 12px;
}

.modern .actions-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.modern .list-section {
  position: relative;
  z-index: 1;
  /* 列表区域背景色 */
  background: transparent;
  padding: 0 40px;
}

/* 现代模式下的列表样式微调 */
.modern :deep(.song-list-container) {
  /* 可以增加一些半透明背景让文字更清晰，或者直接依靠底色 */
}

/* 适配深色模式 */
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
