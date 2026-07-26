<template>
  <div
    v-if="playlist"
    class="playlist-detail"
    :class="[layoutStyle, playlist.coverStyle || 'square']"
  >
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
          <img
            :src="playlistCover"
            class="cover-img"
            :style="playlistCoverStyle"
            loading="lazy"
            decoding="async"
          />
        </div>

        <!-- 信息区域 -->
        <div class="info-wrapper">
          <div class="playlist-title" :style="[playlistTitleStyle, headerTextStyle]">
            {{ playlist.name }}
          </div>

          <!-- 标签（模拟数据，实际UserPlaylist暂无标签字段） -->
          <div class="tags-row" v-if="layoutStyle === 'classic'">
            <span class="tag">本地歌单</span>
            <span class="tag">自建</span>
          </div>

          <!-- 描述 -->
          <div class="desc-row" :style="headerTextStyle">
            <div class="desc-text line-clamp-2">
              {{
                playlist.description ||
                `这是一个本地创建的歌单，包含了 ${playlist.tracks.length} 首歌曲。`
              }}
            </div>
          </div>

          <!-- 按钮组 -->
          <div class="actions-row" style="justify-content: space-between">
            <div class="actions-row">
              <n-button :color="accentColor" round size="large" @click="playAll">
                <template #icon>
                  <n-icon><i class="mgc_play_fill"></i></n-icon>
                </template>
                播放
              </n-button>
              <n-button
                size="large"
                secondary
                round
                :type="isBatchMode ? 'primary' : 'default'"
                @click="toggleBatchMode"
              >
                <template #icon>
                  <n-icon
                    ><i :class="isBatchMode ? 'mgc_close_line' : 'mgc_list_check_2_line'"></i
                  ></n-icon>
                </template>
                {{ isBatchMode ? '退出管理' : '批量管理' }}
              </n-button>
            </div>
            <div class="actions-row">
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
        v-model:selected-ids="selectedIds"
        :songs="songsForList"
        :loading="false"
        :current-playing-song-id="player.currentSong?.id ?? null"
        :transparent-header="layoutStyle === 'modern'"
        :item-variant="(layoutStyle === 'modern' || playlist?.coverStyle === 'square') ? 'plain' : 'card'"
        :draggable="!isBatchMode"
        :selectable="isBatchMode"
        @song-click="handleSongClick"
        @reorder="handleReorder"
      />
    </div>

    <!-- 批量操作栏 -->
    <transition name="batch-bar-fade">
      <div v-if="isBatchMode" class="batch-action-bar">
        <div class="batch-action-left">
          <n-checkbox
            :checked="allSelected"
            :indeterminate="someSelected"
            @update:checked="toggleSelectAll"
          >
            全选
          </n-checkbox>
          <span v-if="selectedIds.length > 0" class="batch-selected-count">
            已选 {{ selectedIds.length }} 首
          </span>
        </div>
        <div class="batch-action-right">
          <n-button size="large" @click="exitBatchMode"> 取消 </n-button>
          <n-button
            size="large"
            type="error"
            :disabled="selectedIds.length === 0"
            @click="handleBatchDelete"
          >
            删除选中 ({{ selectedIds.length }})
          </n-button>
        </div>
      </div>
    </transition>

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
import { NButton, NIcon, NEmpty, useMessage, useDialog, NCheckbox } from 'naive-ui'
import { usePlaylistStore, type UserPlaylist } from '../stores/playlistStore'
import { usePlayerStore } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { usePlaylistTheme } from '../composables/usePlaylistTheme'
import SongList from '../components/common/SongList.vue'
import PlaylistSettingsModal from '../components/common/PlaylistSettingsModal.vue'
import defaultCover from '@renderer/assets/default-cover.png'


const route = useRoute()
const router = useRouter()
const playlistStore = usePlaylistStore()
const player = usePlayerStore()
const settingsStore = useSettingsStore()
const message = useMessage()
const dialog = useDialog()

const playlistId = route.params.id as string
const isBatchMode = ref(false)
const selectedIds = ref<Array<string | number>>([])
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
    case 'full':
      return { objectFit: 'cover' }
    case 'square':
    default:
      return { aspectRatio: '1/1', objectFit: 'cover' }
  }
})

// 根据封面提取主题色与自适应文字颜色
const { accentColor, textColor } = usePlaylistTheme(() => playlistCover.value)

// 全尺寸模式下标题/描述等覆盖在封面上的文字颜色
const headerTextStyle = computed<CSSProperties>(() => {
  if (playlist.value?.coverStyle !== 'full') return {}
  return { color: textColor.value }
})

// 计算标题样式
const playlistTitleStyle = computed<CSSProperties>(() => {
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

const allSelected = computed(() => {
  if (!playlist.value || playlist.value.tracks.length === 0) return false
  const set = new Set(selectedIds.value.map(String))
  return playlist.value.tracks.every((t) => t.id && set.has(String(t.id)))
})

const someSelected = computed(() => {
  if (!playlist.value || playlist.value.tracks.length === 0) return false
  const set = new Set(selectedIds.value.map(String))
  const hasSelected = playlist.value.tracks.some((t) => t.id && set.has(String(t.id)))
  return hasSelected && !allSelected.value
})

const isPlayerPlayingThisPlaylist = computed(() => {
  if (!playlist.value || player.playlist.length === 0) return false
  if (player.playlist.length !== playlist.value.tracks.length) return false
  const ids = new Set(playlist.value.tracks.map((t) => t.id))
  return player.playlist.every((s) => ids.has(s.id))
})

function toggleBatchMode(): void {
  if (isBatchMode.value) {
    exitBatchMode()
  } else {
    enterBatchMode()
  }
}

function enterBatchMode(): void {
  selectedIds.value = []
  isBatchMode.value = true
}

function exitBatchMode(): void {
  isBatchMode.value = false
  selectedIds.value = []
}

function toggleSelectAll(): void {
  if (!playlist.value) return
  selectedIds.value = allSelected.value
    ? []
    : playlist.value.tracks.map((t) => t.id).filter((id): id is string | number => id !== null)
}

function handleBatchDelete(): void {
  if (!playlist.value || selectedIds.value.length === 0) return

  const shouldSyncPlayer = isPlayerPlayingThisPlaylist.value

  dialog.warning({
    title: '确认删除',
    content: `确定从歌单中移除 ${selectedIds.value.length} 首歌曲吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      const removed = playlistStore.removeTracksFromPlaylist(playlistId, selectedIds.value)
      if (removed > 0) {
        if (shouldSyncPlayer && playlist.value) {
          player.setPlaylist(
            playlist.value.tracks.map((t) => ({
              id: t.id,
              title: t.title,
              artist: t.artist,
              album: t.album,
              cover: t.cover || '',
              durationMs: t.durationMs || 0,
              filePath: t.filePath,
              source: t.source,
              sourceSongId: t.sourceSongId,
              lyrics: ''
            }))
          )
        }
        message.success(`已移除 ${removed} 首歌曲`)
      }
      exitBatchMode()
    }
  })
}

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
    cover: t.cover || '',
    filePath: t.filePath,
    durationMs: t.durationMs || 0,
    source: t.source,
    sourceSongId: t.sourceSongId,
    lyrics: ''
  }))
  player.setPlaylist(list)
  if (list.length > 0) {
    player.setCurrentSong(list[0])
  }
}

const handleSongClick = (song: any) => {
  if (!playlist.value) return

  const list = playlist.value.tracks.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    cover: t.cover || '',
    filePath: t.filePath,
    durationMs: t.durationMs || 0,
    source: t.source,
    sourceSongId: t.sourceSongId,
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
  // 歌单数据已在 App.vue 初始化时加载，无需重复调用
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
  padding: 44px 30px 0 30px;
  margin-bottom: 20px;
}

/* 经典模式下去除 header-content 的包装层，让封面和信息区域直接成为 flex 子项 */
.classic .header-content {
  display: flex;
  margin-top: 32px;
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
  justify-content: center;
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
}

.classic .actions-row {
  margin-top: 16px;
  display: flex;
  gap: 8px;
  align-items: center;
}

.classic .list-section {
  padding: 0 30px;
}

/* ================= Modern Style (Apple-like) ================= */
.playlist-detail.modern {
  /* 现代模式下外层不滚动，仅歌曲列表内部滚动，避免 header 高度变化与滚动容器相互影响导致抽搐 */
  overflow: hidden;
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
  height: 350px; /* 略微增高以覆盖相对定位的 header 区域 */
}

/* Square 模式下禁用 ::after 的 backdrop-filter，避免与父级 filter 冲突造成双重重叠模糊 */
.modern .bg-layer.square::after {
  display: none;
}

/* ================= Modern + Square 布局覆写 ================= */
/* Square 模式下 header 使用正常流 flex 布局，而非 absolute 定位 */
.modern.square .header-section {
  position: relative;
  top: auto;
  left: auto;
  right: auto;
  height: auto;
  min-height: auto;
  padding: 60px 40px 24px 40px;
  justify-content: flex-start;
}

/* Square 模式下列表区域去除为 absolute header 预留的顶部 padding */
.modern.square .list-section {
  padding: 16px 40px 0 40px;
  flex: 1;
  height: auto;
}

/* Square 模式下封面与信息顶部对齐 */
.modern.square .header-content {
  align-items: flex-start;
}

/* Square 模式下倒影层同步增高 */
.modern .bg-reflection.square {
  height: 350px;
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
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.137),
    rgba(0, 0, 0, 0) 80%,
    rgba(0, 0, 0, 0.8) 100%
  );
  z-index: 2;
}

/* 适配浅色模式：使用 Naive UI 的主题变量或 data-theme 属性 */
[data-theme='light'] .modern .bg-layer::before {
  /* 浅色模式下，底部过渡到白色，而不是黑色 */
  background: linear-gradient(
    to bottom,
    rgba(255, 255, 255, 0.1),
    rgba(255, 255, 255, 0) 80%,
    rgba(255, 255, 255, 0.9) 100%
  );
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
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  flex-direction: column; /* 改为垂直布局，模拟大封面在顶部的效果，或者保持水平 */
  align-items: flex-start;
  justify-content: flex-end;
  padding: 60px 40px 12px 40px; /* 增加顶部 padding 避开标题栏 */
  height: 300px;
  min-height: 300px;
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
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
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
  padding: 300px 40px 0 40px; /* 为 absolute 定位的 header 留出 300px 空间 */
  box-sizing: border-box;
  height: 100%;
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

.batch-action-bar {
  position: sticky;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 12px 20px;
  border-radius: 12px;
  background: var(--n-card-color, rgba(255, 255, 255, 0.95));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  backdrop-filter: blur(12px);
  min-width: 420px;
  max-width: 90vw;
  align-self: flex-start;
}

:root[data-theme='dark'] .batch-action-bar {
  background: rgba(40, 40, 40, 0.95);
}

.batch-action-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.batch-selected-count {
  font-size: 14px;
  color: #666;
}

:root[data-theme='dark'] .batch-selected-count {
  color: #aaa;
}

.batch-action-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.batch-bar-fade-enter-active,
.batch-bar-fade-leave-active {
  transition:
    opacity 0.25s ease,
    transform 0.25s ease;
}

.batch-bar-fade-enter-from,
.batch-bar-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(12px);
}
</style>
