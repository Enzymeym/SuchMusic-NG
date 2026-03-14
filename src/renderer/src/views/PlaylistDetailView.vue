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

          <!-- 标签（模拟数据，实际UserPlaylist暂无标签字段） -->
          <div class="tags-row" v-if="layoutStyle === 'classic'">
            <span class="tag">本地歌单</span>
            <span class="tag">自建</span>
          </div>

          <!-- 描述 -->
          <div class="desc-row">
            <div class="desc-text line-clamp-2">
              {{ playlist.description || `这是一个本地创建的歌单，包含了 ${playlist.tracks.length} 首歌曲。` }}
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

    <PlaylistSettingsModal 
      v-model:show="showSettings" 
      :playlist="playlist || null"
      @save="handleSavePlaylist"
      @delete="handleDeletePlaylist"
    />
  </div>

  <div v-else class="not-found">
    <n-empty description="未找到歌单" />
    <n-button style="margin-top: 16px" @click="router.back()">返回</n-button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch, type CSSProperties } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NIcon, NEmpty, useMessage } from 'naive-ui'
import { usePlaylistStore, type UserPlaylist } from '../stores/playlistStore'
import { usePlayerStore } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import SongList from '../components/common/SongList.vue'
import PlaylistSettingsModal from '../components/common/PlaylistSettingsModal.vue'
import defaultCover from '@renderer/assets/icon.png'
import { AudioPlayerManager } from '../utils/audioPlayerManager'
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

const handleSavePlaylist = (updatedPlaylist: UserPlaylist) => {
  playlistStore.updatePlaylist(updatedPlaylist)
  // 如果当前播放列表就是这个歌单，可能需要同步更新 store 中的 playlist 元数据？
  // 不过 playerStore 目前只存 tracks，不存 playlist 元数据，所以可能不需要。
}

const handleDeletePlaylist = (id: string) => {
  playlistStore.removePlaylist(id)
  message.success('歌单已删除')
  router.push('/playlist')
}

// 歌单封面：优先使用自定义封面，其次使用第一首歌的封面，最后使用默认图标
const playlistCover = computed(() => {
  if (!playlist.value) return defaultCover
  if (playlist.value.cover) return playlist.value.cover
  const first = playlist.value.tracks[0]
  return first?.cover || defaultCover
})

// 计算封面样式
const playlistCoverStyle = computed<CSSProperties>(() => {
  if (!playlist.value) return {}
  const style = playlist.value.coverStyle || 'square'
  
  switch (style) {
    case 'full': return { objectFit: 'cover' }
    case 'square': 
    default: return { aspectRatio: '1/1', objectFit: 'cover' }
  }
})

// 计算标题样式
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

  // 歌词重试获取函数
  const fetchLyricWithRetry = async (id: string, source: string): Promise<string> => {
    let attempt = 0
    while (true) {
      // 检查当前播放歌曲是否改变，如果改变则停止重试
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
        } else {
          // 动态导入 fetchGMALyric 避免顶部导入
          const { fetchGMALyric } = await import('../apis/gma')
          const lrc = await fetchGMALyric(id, source)
          if (lrc) return lrc
        }
      } catch (e) {
        console.warn(`获取歌词失败，第 ${attempt + 1} 次重试:`, e)
      }
      
      attempt++
      // 指数退避策略，最大延迟 5 秒
      const delay = Math.min(500 + attempt * 500, 5000)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  // 1. 优先尝试使用已有的 filePath
  if (target.filePath && !target.filePath.startsWith('http')) {
    try {
      // 验证文件是否存在
      // const exists = await window.electron.ipcRenderer.invoke('system:fs-exists', target.filePath)
      // if (!exists) throw new Error('Local file not found')

      // 尝试获取歌词（如果本地没存）
      let lyrics = target.lyrics || ''
      if (!lyrics) {
        const neteaseId = target.sourceSongId ?? target.id
        const source = target.source || 'wy'
        lyrics = await fetchLyricWithRetry(String(neteaseId), source)
      }

      await AudioPlayerManager.play({
        filePath: target.filePath,
        volume: player.volume
      })

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
        lyrics: lyrics
      })
      player.setPlaying(true)
      message.success('从本地缓存播放')
      return
    } catch (e) {
      console.error('从本地缓存播放失败，回退到在线获取:', e)
      // 失败时清除 filePath，以便继续走下面的在线逻辑
      target.filePath = undefined
    }
  }

  // 2. 如果没有 filePath 或文件不存在，尝试主动检测缓存
  const neteaseId = target.sourceSongId ?? target.id
  const quality = settingsStore.source.preferredQuality || '128k'
  // 默认尝试使用网易云，或根据设置
  let source =
    settingsStore.source.preferredPlatform === 'all'
      ? 'wy'
      : settingsStore.source.preferredPlatform
  
  // 映射旧设置值
  if (source === 'netease') source = 'wy'
  else if (source === 'qq') source = 'tx'
  else if (source === 'kugou') source = 'kg'
  else if (source === 'kuwo') source = 'kw'
  else if (source === 'migu') source = 'mg'

  // 如果歌曲本身指定了来源，则优先使用（映射旧值）
  if (target.source) {
    switch (target.source) {
      case 'netease': source = 'wy'; break;
      case 'qq': source = 'tx'; break;
      case 'kugou': source = 'kg'; break;
      case 'kuwo': source = 'kw'; break;
      case 'migu': source = 'mg'; break;
      default: source = target.source; break;
    }
  }

  const cacheKey = `${source}:${neteaseId}:${quality}`
  
  if (window.electron && window.electron.ipcRenderer) {
    try {
      const cachePath = await window.electron.ipcRenderer.invoke('online-cache:check', {
         dir: settingsStore.local.cacheDir || null,
         key: cacheKey
      })

      if (cachePath) {
         console.log('[PlaylistDetail] 主动检测到缓存文件存在', cachePath)
         
         // 尝试获取歌词
         let lyrics = target.lyrics || ''
         if (!lyrics) {
           lyrics = await fetchLyricWithRetry(String(neteaseId), source)
         }

         await AudioPlayerManager.play({
           filePath: cachePath,
           volume: player.volume
         })

         player.setCurrentSong({
           id: target.id,
           title: target.title,
           artist: target.artist,
           album: target.album,
           cover: target.cover || '',
           durationMs: target.durationMs || 0,
           filePath: cachePath,
           source: target.source,
           sourceSongId: target.sourceSongId,
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

  player.setCurrentSong(target)

  // 3. 在线获取逻辑
  if (!target.filePath || target.filePath.startsWith('http')) {
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

      // const cacheKey = ... (上面已定义)
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

      // 统一使用 AudioPlayerManager 播放，它会自动处理 cacheFilePath 或 url
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
  color: #666666c4;
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
  transform: scale(1.06); /* 放大一点，避免边缘被裁切 */
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
  /* 拉长渐变：从 20% 处就开始渐变，直到 100% 透明，过渡区域更长 */
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 20%, transparent 100%);
  mask-image: linear-gradient(to bottom, black 0%, black 20%, transparent 100%);
}

/* Square 模式下的背景层，增加渐隐 */
.modern .bg-layer.square {
  /* 更快的渐隐，让背景更淡 */
  -webkit-mask-image: linear-gradient(to bottom, black 0%, transparent 60%);
  mask-image: linear-gradient(to bottom, black 0%, transparent 60%);
  opacity: 0.6; /* 整体透明度降低 */
  filter: blur(20px) brightness(0.8); /* 增加模糊 */
}

.modern .bg-layer::after {
  content: '';
  position: absolute;
  inset: 0;
  backdrop-filter: blur(20px) brightness(0.9);
  /* 调整模糊层的显现速度，让模糊感更早出现，并且渐变更平滑 */
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, transparent 10%, black 60%);
  mask-image: linear-gradient(to bottom, transparent 0%, transparent 10%, black 60%);
  z-index: 1;
}

.modern .bg-layer::before {
  content: '';
  position: absolute;
  inset: 0;
  /* 增强底部遮罩，过渡到深色而不是透明，防止发白 */
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.137), rgba(0, 0, 0, 0) 80%, rgba(0, 0, 0, 0.8) 100%);
  z-index: 2;
}

/* 适配浅色模式：使用 Naive UI 的主题变量或 data-theme 属性 */
[data-theme='light'] .modern .bg-layer::before {
  /* 浅色模式下，底部过渡到白色，而不是黑色 */
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
  transform: scaleY(-1) scale(1.06); /* 倒转 180 度 + 放大 */
  transform-origin: center;
  filter: blur(40px) brightness(0.8);
  /* 只显示底部，且渐进 */
  -webkit-mask-image: linear-gradient(to bottom, transparent 60%, black 100%);
  mask-image: linear-gradient(to bottom, transparent 60%, black 100%);
  z-index: 3; /* 在 bg-layer 的 ::before (z-index:2) 之上，才能看到 */
  pointer-events: none;
  opacity: 0.8;
}

/* 适配浅色模式倒影层 */
[data-theme='light'] .modern .bg-reflection {
  /* 浅色模式下，倒影不需要太暗 */
  filter: blur(40px) brightness(1.1);
  opacity: 0.6;
}

/* Square 模式下的倒影层 */
.modern .bg-reflection.square {
  /* 隐藏倒影，或者让它非常淡，避免干扰 */
  opacity: 0.2;
  filter: blur(60px) brightness(0.6);
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

[data-theme='light'] .modern .header-section {
  color: black;
}

/* 调整布局为：左下角封面+信息 */
.modern .header-content {
  display: flex;
  align-items: flex-end;
  width: 100%;
}

.modern .cover-wrapper {
  /* 现代模式下隐藏小封面，因为背景已经是大封面了，或者按需求隐藏 */
  /* 如果是 full 模式，隐藏封面，使用大背景 */
  /* 如果是 square 模式，显示小封面 */
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
  text-shadow: none; /* 或者使用非常淡的阴影 */
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
  color: white; /* 现代模式下默认白色文字 */
}

[data-theme='light'] .modern .desc-row {
  color: rgba(0, 0, 0, 0.699);
  text-shadow: none; /* 浅色模式下通常不需要强阴影，或者使用浅色阴影 */
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
