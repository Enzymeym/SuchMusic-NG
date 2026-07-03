<template>
  <div v-if="playlist" ref="detailRef" class="playlist-detail" :class="[layoutStyle, playlist.coverStyle || 'square', { collapsed: isCollapsed }]" @scroll="handleScroll">
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
          <img :src="playlistCover" class="cover-img" :style="playlistCoverStyle" loading="lazy" decoding="async" />
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
              <n-button :color="accentColor" round size="large" @click="playAll">
                <template #icon>
                  <n-icon><i class="mgc_play_fill"></i></n-icon>
                </template>
                播放
              </n-button>

              <n-button secondary round size="large">
                <template #icon>
                  <n-icon><i class="mgc_folder_download_line"></i></n-icon>
                </template>
                下载全部
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
import { computed, ref, onMounted, onUnmounted, watch, type CSSProperties } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NIcon, NEmpty, useMessage } from 'naive-ui'
import { usePlaylistStore, type UserPlaylist } from '../stores/playlistStore'
import { usePlayerStore } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { usePlaylistTheme } from '../composables/usePlaylistTheme'
import SongList from '../components/common/SongList.vue'
import PlaylistSettingsModal from '../components/common/PlaylistSettingsModal.vue'
import defaultCover from '@renderer/assets/icon.png'
import { AudioPlayerManager } from '../utils/audioPlayerManager'

const route = useRoute()
const router = useRouter()
const playlistStore = usePlaylistStore()
const player = usePlayerStore()
const settingsStore = useSettingsStore()
const message = useMessage()

const playlistId = route.params.id as string
// 从 store 获取用户偏好的布局风格
const storedLayoutStyle = ref<'classic' | 'modern'>(
  settingsStore.appearance.playlistLayoutStyle || 'classic'
)

// 当 coverStyle 为 'full' 时强制使用现代布局，否则使用用户偏好
const layoutStyle = computed<'classic' | 'modern'>(() => {
  if (!playlist.value) return storedLayoutStyle.value
  return playlist.value.coverStyle === 'full' ? 'modern' : storedLayoutStyle.value
})

const showSettings = ref(false)

// 滚动驱动页头收缩
const detailRef = ref<HTMLElement | null>(null)
const scrollY = ref(0)
const HEADER_COLLAPSE_THRESHOLD = 200
const isCollapsed = computed(() => scrollY.value >= HEADER_COLLAPSE_THRESHOLD)

const handleScroll = () => {
  if (!detailRef.value) return
  scrollY.value = detailRef.value.scrollTop
}

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

/**
 * 歌单封面：根据 coverFollowsFirstTrack 决定使用自定义封面还是第一首歌曲封面
 * 优先级：coverFollowsFirstTrack=true → 第一首歌曲封面 → 自定义封面(customCover) → 默认图标
 */
const playlistCover = computed(() => {
  if (!playlist.value) return defaultCover
  if (playlist.value.coverFollowsFirstTrack) {
    const first = playlist.value.tracks[0]
    return first?.cover || playlist.value.cover || defaultCover
  }
  return playlist.value.cover || defaultCover
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

// 根据封面提取主题色
const { accentColor } = usePlaylistTheme(() => playlistCover.value)

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

// 监听用户偏好布局风格变化并保存到 store
watch(storedLayoutStyle, (newStyle) => {
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

  const target = list.find((s) => s.id === song.id)
  if (!target) return

  // 本地文件播放
  if (target.filePath && !target.filePath.startsWith('http')) {
    try {
      const lyrics = target.lyrics || ''

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
      console.error('本地文件播放失败:', e)
      message.error('找不到本地文件')
      return
    }
  }

  // 没有本地文件
  message.error('找不到本地文件')
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

onUnmounted(() => {
  // 清理：无需手动移除，Vue 自动处理
})
</script>

<style scoped>
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

/* Full 模式下的背景层：全尺寸封面大图作为背景，顶部清晰不模糊 */
.modern .bg-layer.full {
  background-size: cover;
  background-position: center;
  /* 顶部保持清晰可见，中下部渐隐过渡给倒影模糊层接管 */
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 40%, transparent 85%);
  mask-image: linear-gradient(to bottom, black 0%, black 40%, transparent 85%);
  opacity: 1;
  height: 380px;
  /* 不设置 filter，避免创建层叠上下文破坏 backdrop-filter */
}

.modern .bg-layer::after {
  content: '';
  position: absolute;
  inset: 0;
  backdrop-filter: blur(100px) brightness(0.9);
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

/* Full 模式下的倒影层：从中间开始向底部渐进增强模糊，实现渐进模糊效果 */
.modern .bg-reflection.full {
  opacity: 0.65;
  filter: blur(40px) brightness(0.75);
  height: 380px;
  /* 从 35% 处开始渐显，覆盖 bg-layer 的渐隐区域 */
  -webkit-mask-image: linear-gradient(to bottom, transparent 35%, black 100%);
  mask-image: linear-gradient(to bottom, transparent 35%, black 100%);
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

/* ================= Collapsed Header（滚动收缩页头模式） ================= */
/* 页头区域过渡动画 */
.modern .header-section {
  transition: min-height 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              padding 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.modern .cover-wrapper {
  transition: width 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              height 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              margin-right 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              border-radius 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.modern .playlist-title {
  transition: font-size 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              margin-bottom 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.modern .desc-row,
.modern .actions-row {
  transition: opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1),
              max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              margin 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.modern .bg-layer,
.modern .bg-reflection {
  transition: opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              mask-image 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              -webkit-mask-image 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              height 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

/* 收缩态：页头缩小为 compact bar */
.playlist-detail.modern.collapsed .header-section {
  min-height: 60px;
  padding: 8px 40px;
  position: sticky;
  top: 0;
  z-index: 10;
  /* 半透明毛玻璃背景，让模糊层透出 */
  background: rgba(0, 0, 0, 0.08);
  backdrop-filter: blur(30px);
  -webkit-backdrop-filter: blur(30px);
}

[data-theme='light'] .playlist-detail.modern.collapsed .header-section {
  background: rgba(255, 255, 255, 0.5);
}

.playlist-detail.modern.collapsed .header-content {
  align-items: center;
}

/* 收缩态：封面缩小（square 模式有封面，full 模式封面已隐藏） */
.playlist-detail.modern.collapsed .cover-wrapper:not(.full) {
  width: 44px;
  height: 44px;
  aspect-ratio: 1/1;
  border-radius: 6px;
  margin-right: 12px;
}

/* 收缩态：标题缩小 */
.playlist-detail.modern.collapsed .playlist-title {
  font-size: 20px;
  margin-bottom: 0;
  text-shadow: none;
}

/* 收缩态：隐藏描述和操作按钮 */
.playlist-detail.modern.collapsed .desc-row,
.playlist-detail.modern.collapsed .actions-row {
  opacity: 0;
  max-height: 0;
  margin: 0;
  overflow: hidden;
  pointer-events: none;
}

/* 收缩态：背景层仅保留底部模糊区域 */
.playlist-detail.modern.collapsed .bg-layer.full {
  /* 顶部完全透明，仅底部保留模糊过渡 */
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, transparent 55%, black 100%);
  mask-image: linear-gradient(to bottom, transparent 0%, transparent 55%, black 100%);
  opacity: 0.5;
  height: 280px;
}

/* 收缩态：倒影层覆盖更广，承接模糊背景 */
.playlist-detail.modern.collapsed .bg-reflection.full {
  opacity: 0.75;
  height: 280px;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 100%);
  mask-image: linear-gradient(to bottom, transparent 0%, black 100%);
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
