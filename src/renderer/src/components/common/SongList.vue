<template>
  <div class="song-list-container" :class="{ 'transparent-header': transparentHeader }">
    <!-- Header -->
    <div class="song-list-header">
      <div style="display: flex; align-items: center; flex: 1; transform: translateX(-6px)">
        <div style="width: 24px; text-align: center; margin-right: 4px">#</div>

        <span
          style="
            cursor: pointer;
            user-select: none;
            display: flex;
            align-items: center;
            gap: 4px;
            margin-left: 4px;
          "
          @click="showSortMenu"
          :title="currentSortLabel"
        >
          标题
          <n-icon size="14" :depth="3">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 10l5 5 5-5z" />
            </svg>
          </n-icon>
        </span>
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between; width: 50%">
        <span>专辑</span>
        <span v-if="!hideDuration" style="position: relative; left: -43px">时长</span>
      </div>
    </div>

    <!-- Sort Dropdown -->
    <n-dropdown
      :show="showSortDropdown"
      :x="sortDropdownX"
      :y="sortDropdownY"
      :options="sortOptions"
      @select="handleSortSelect"
      @clickoutside="showSortDropdown = false"
      placement="bottom-start"
      style="z-index: 9999"
    />

    <!-- Context Menu（包含“添加到歌单”的子菜单） -->
    <n-dropdown
      :show="showDropdown"
      :x="dropdownX"
      :y="dropdownY"
      :options="dropdownOptions"
      @select="handleContextMenuSelect"
      @clickoutside="showDropdown = false"
      style="z-index: 9999"
    />

    <!-- Loading State -->
    <div v-if="loading && !loadMore" class="skeleton-container">
      <div v-for="i in skeletonCount" :key="i" class="song-item skeleton-item" :class="itemVariantClass">
        <div style="display: flex; align-items: center; gap: 8px; flex: 1">
          <!-- Index -->
          <div class="index-cell">
            <n-skeleton text style="width: 14px" />
          </div>
          <!-- Cover -->
          <n-skeleton style="width: 48px; height: 48px; border-radius: 6px; flex-shrink: 0" />
          <!-- Song Info -->
          <div class="song-info" style="flex: 1">
            <n-skeleton text style="width: 40%; height: 20px; margin-bottom: 4px" />
            <n-skeleton text style="width: 25%; height: 14px" />
          </div>
        </div>

        <!-- Album & Duration -->
        <div class="song-meta">
          <div class="album-info">
            <n-skeleton text style="width: 60%" />
          </div>
          <div v-if="!hideDuration" class="duration-info">
            <n-skeleton text style="width: 36px" />
          </div>
        </div>
      </div>
    </div>

    <!-- Song List -->
    <Transition name="fade">
      <div v-if="!loading || loadMore" class="song-list-scroll-wrapper">
        <n-scrollbar class="song-list-scroll-container" @scroll="(e) => emit('scroll', e)">
          <div v-for="(song, index) in songs" :key="song.id" @contextmenu="(e) => showContextMenu(song, e)">
            <div
              :class="['song-item', itemVariantClass, { active: song.id == currentPlayingSongId }]"
              @click="handleSongClick(song)"
              :draggable="draggableEnabled"
              @dragstart="(e) => handleDragStart(index, e)"
              @dragover="(e) => handleDragOver(index, e)"
              @drop="(e) => handleDrop(index, e)"
            >
              <div style="display: flex; align-items: center; gap: 8px">
                <!-- Index -->
                <div class="index-cell">
                  {{ startIndex + index + 1 }}
                </div>
                <!-- Cover -->
                <img
                  class="song-cover"
                  :src="song.picUrl || song.al?.picUrl || defaultCover"
                  alt=""
                  referrerpolicy="no-referrer"
                />
                <!-- Song Info -->
                <div class="song-info">
                  <div style="display: flex; align-items: center; gap: 10px">
                    <div style="display: flex; flex-direction: column; min-width: 0; flex: 1">
                      <n-ellipsis style="font-weight: bold; font-size: 16.5px; max-width: 200px">
                        {{ processSongTitle(song.name).mainTitle }}
                      </n-ellipsis>
                      <n-ellipsis
                        v-if="processSongTitle(song.name).subTitle"
                        style="font-size: 12.5px; color: #818181; max-width: 200px"
                      >
                        {{ processSongTitle(song.name).subTitle }}
                      </n-ellipsis>
                    </div>

                    <!-- Tags -->
                    <n-tag v-if="song.isOriginal" type="success" size="small" round :bordered="false" style="transform: scale(0.8); margin-right: 2px; flex-shrink: 0;">原唱</n-tag>
                    <n-tag v-if="song.mv" type="warning" size="small" round style="cursor: pointer; transform: scale(0.8); margin-right: 2px; flex-shrink: 0;" :bordered="false"
                      >MV</n-tag
                    >
                  </div>
                  <!-- Artists & Quality Tag -->
                  <div style="display: flex; align-items: center; max-width: 200px; transform: translateX(-4px);">
                    <!-- Source Tag -->
                    <n-tag
                      v-if="song.source"
                      :type="getSourceType(song.source)"
                      size="small"
                      round
                      :bordered="false"
                      style="transform: scale(0.8); margin-right: 2px; flex-shrink: 0;"
                    >
                      {{ getSourceLabel(song.source) }}
                    </n-tag>
                    <n-tag
                      v-if="song.quality"
                      :type="getQualityTag(song.quality).type"
                      size="small"
                      round
                      :bordered="false"
                      style="transform: scale(0.8); margin-right: 2px; flex-shrink: 0;"
                    >
                      {{ getQualityTag(song.quality).label }}
                    </n-tag>
                    <n-ellipsis style="font-size: 14px; color: #818181; flex: 1;">
                      {{ getArtistsFormatted(song) }}
                    </n-ellipsis>
                  </div>
                </div>
              </div>

              <!-- Album & Duration -->
              <div class="song-meta">
                <div class="album-info">
                  <n-ellipsis
                    @click.stop="handleAlbumClick(song)"
                    style="font-size: 14px; color: #818181; cursor: pointer; max-width: 32vh"
                  >
                    {{ getAlbumName(song) }}
                  </n-ellipsis>
                </div>
                <div v-if="!hideDuration" class="duration-info">
                  {{ formatDuration(song.dt) }}
                </div>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div style="padding: 16px 0">
            <n-flex v-if="loadMore && loading" align="center" justify="center" style="gap: 8px">
              <n-spin size="small" style="transform: scale(0.8);"/>
              <n-text>{{ loadingText || '加载中...' }}</n-text>
            </n-flex>

            <n-divider v-else-if="!loading && songs.length > 0">
              <span style="font-size: 14px; color: #818181">没有更多啦 ~</span>
            </n-divider>
          </div>
        </n-scrollbar>
      </div>
    </Transition>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  NDropdown,
  NTag,
  NFlex,
  NSpin,
  NText,
  NEllipsis,
  useThemeVars,
  NSkeleton,
  NDivider,
  NIcon,
  NScrollbar,
  useMessage
} from 'naive-ui'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useSettingsStore } from '../../stores/settingsStore'
import defaultCover from '../../assets/default-cover.png'

// Define interfaces
interface Artist {
  id?: number | string
  name: string
}

interface Album {
  id?: number | string
  name: string
  picUrl?: string
}

interface Song {
  id: number | string
  name: string
  al?: Album
  album?: Album | string
  ar?: Artist[]
  artists?: Artist[]
  artist?: string | Artist
  singer?: string
  dt?: number
  mv?: number | string
  isOriginal?: boolean
  quality?: string
  isPreloaded?: boolean
  picUrl?: string
  mp3Url?: string
  [key: string]: any
}

interface Props {
  songs: Song[]
  loading?: boolean
  loadMore?: boolean
  loadingText?: string
  currentPlayingSongId?: string | number | null
  startIndex?: number
  skeletonCount?: number
  themeColor?: string
  itemHeight?: number
  hideDuration?: boolean
  itemVariant?: 'card' | 'plain'
  menuOptions?: any[]
  transparentHeader?: boolean
  draggable?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
  loadMore: false,
  loadingText: '',
  currentPlayingSongId: null,
  startIndex: 0,
  skeletonCount: 10,
  themeColor: '#3d889b',
  itemHeight: 82,
  hideDuration: false,
  menuOptions: undefined,
  transparentHeader: false,
  draggable: false
})

const emit = defineEmits<{
  (e: 'song-click', song: Song): void
  (e: 'album-click', song: Song): void
  (e: 'context-menu-select', key: string, song: Song): void
  (e: 'sort-change', key: string): void
  (e: 'preload', song: Song): void
  (e: 'scroll', event: Event): void
  (e: 'reorder', fromIndex: number, toIndex: number): void
}>()

const themeVars = useThemeVars()
const playlistStore = usePlaylistStore()
const settingsStore = useSettingsStore()
const message = useMessage()
const isDarkMode = ref(document.documentElement.getAttribute('data-theme') === 'dark')
const itemVariantClass = computed(() => {
  const variant = props.itemVariant ?? settingsStore.appearance.songListStyle ?? 'card'
  return variant === 'plain' ? 'song-item--plain' : 'song-item--card'
})
const draggableEnabled = computed(() => props.draggable)

const handleThemeChange = () => {
  isDarkMode.value = document.documentElement.getAttribute('data-theme') === 'dark'
}

onMounted(() => {
  window.addEventListener('theme-change', handleThemeChange as EventListener)
  if (!playlistStore.playlists.length) {
    playlistStore.loadFromStorage()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('theme-change', handleThemeChange as EventListener)
})

const activeBorderColor = computed(() => themeVars.value.primaryColorHover)
const listBackgroundColor = computed(() => themeVars.value.cardColor)

// Sorting
const showSortDropdown = ref(false)
const sortDropdownX = ref(0)
const sortDropdownY = ref(0)
const currentSort = ref('default')

const sortOptions = [
  { label: '默认排序', key: 'default' },
  { label: '按名称 A-Z', key: 'name-asc' },
  { label: '按名称 Z-A', key: 'name-desc' },
  { label: '按时长升序', key: 'duration-asc' },
  { label: '按时长降序', key: 'duration-desc' }
]

const currentSortLabel = computed(() => {
  const option = sortOptions.find((opt) => opt.key === currentSort.value)
  return option ? option.label : '默认排序'
})

function showSortMenu(e: MouseEvent) {
  e.stopPropagation()
  sortDropdownX.value = e.clientX
  sortDropdownY.value = e.clientY
  showSortDropdown.value = true
}

function handleSortSelect(key: string) {
  currentSort.value = key
  emit('sort-change', key)
  showSortDropdown.value = false
}

// Context Menu
const showDropdown = ref(false)
const dropdownX = ref(0)
const dropdownY = ref(0)
const contextMenuSong = ref<Song | null>(null)
const draggingIndex = ref<number | null>(null)

// 默认菜单项（带“添加到歌单”子菜单）
const defaultDropdownOptions = computed(() => [
  { label: '播放', key: 'play' },
  { label: '下一首播放', key: 'playNext' },
  { type: 'divider', key: 'd1' },
  {
    label: '添加到歌单',
    key: 'addToPlaylist',
    children: playlistStore.playlists.map((pl) => ({
      label: pl.name,
      key: `addToPlaylist:${pl.id}`
    }))
  },
  { type: 'divider', key: 'd2' },
  { label: '预加载到缓存', key: 'preload' },
  { type: 'divider', key: 'd3' },
  { label: '复制歌曲ID', key: 'copyId' },
  { label: '查看专辑', key: 'viewAlbum' },
  { type: 'divider', key: 'd4' },
  { label: '下载歌曲', key: 'download' }
])

// 使用 props 传入的菜单项，如果没有则使用默认菜单项
const dropdownOptions = computed(() => {
  return props.menuOptions || defaultDropdownOptions.value
})

function showContextMenu(song: Song, e: MouseEvent) {
  e.preventDefault()
  contextMenuSong.value = song
  const clientX = e.clientX
  const clientY = e.clientY
  const isNearRightEdge = window.innerWidth - clientX < 200
  dropdownX.value = isNearRightEdge ? clientX - 200 : clientX
  dropdownY.value = clientY
  showDropdown.value = true
}

function handleDragStart(index: number, _e: DragEvent) {
  if (!props.draggable) return
  draggingIndex.value = index
}

function handleDragOver(_index: number, e: DragEvent) {
  if (!props.draggable) return
  e.preventDefault()
}

function handleDrop(index: number, e: DragEvent) {
  if (!props.draggable) return
  e.preventDefault()
  if (draggingIndex.value === null || draggingIndex.value === index) {
    draggingIndex.value = null
    return
  }
  emit('reorder', draggingIndex.value, index)
  draggingIndex.value = null
}

function handleContextMenuSelect(key: string | number) {
  if (!contextMenuSong.value) return
  const keyStr = String(key)

  if (keyStr === 'preload') {
    emit('preload', contextMenuSong.value)
  } else if (keyStr.startsWith('addToPlaylist:')) {
    const playlistId = keyStr.slice('addToPlaylist:'.length)
    if (!playlistId) {
      showDropdown.value = false
      return
    }
    addSongToPlaylistById(playlistId)
  } else {
    emit('context-menu-select', keyStr, contextMenuSong.value)
  }
  showDropdown.value = false
}

function addSongToPlaylistById(playlistId: string) {
  if (!contextMenuSong.value) return
  const target = playlistStore.playlists.find((p) => p.id === playlistId)
  if (!target) {
    return
  }
  const exists = target.tracks.some((t) => t.id === contextMenuSong.value?.id)
  if (exists) {
    message.info('歌单中已存在该歌曲')
    return
  }
  const song = contextMenuSong.value
  const track = {
    id: song.id,
    title: song.name,
    artist: getArtistsFormatted(song),
    album: getAlbumName(song),
    cover: song.picUrl || song.al?.picUrl || defaultCover,
    filePath: (song as any).filePath || song.mp3Url,
    durationMs: song.dt,
    source: (song as any).source,
    sourceSongId: (song as any).sourceSongId
  }
  const updated = {
    ...target,
    tracks: [...target.tracks, track]
  }
  playlistStore.updatePlaylist(updated)
  message.success('已添加到歌单')
}

// Event Handlers
function handleSongClick(song: Song) {
  emit('song-click', song)
}

function handleAlbumClick(song: Song) {
  emit('album-click', song)
}

// Formatters
function getArtistsFormatted(song: Song) {
  if (song.ar && Array.isArray(song.ar)) {
    return song.ar.map((artist) => artist.name).join(' / ')
  }
  if (song.artists && Array.isArray(song.artists)) {
    return song.artists.map((artist) => artist.name).join(' / ')
  }
  if (song.artist) {
    return typeof song.artist === 'string' ? song.artist : song.artist.name || ''
  }
  if (song.singer) {
    return song.singer
  }
  return '未知歌手'
}

function getAlbumName(song: Song) {
  if (song.al && song.al.name) {
    return song.al.name
  }
  if (song.album) {
    return typeof song.album === 'string' ? song.album : song.album.name || '未知专辑'
  }
  return '未知专辑'
}

type TagType = 'default' | 'primary' | 'info' | 'success' | 'warning' | 'error'

function getQualityTag(quality: string): { label: string; type: TagType } {
  switch (quality) {
    case 'Standard':
    case '标准音质':
    case 'LQ':
      // 低码率统一显示为 LQ
      return { label: 'LQ', type: 'default' }
    case 'HQ':
    case 'HQ高音质':
      // 高码率显示为 HQ
      return { label: 'HQ', type: 'info' }
    case 'SQ':
    case 'SQ无损音质':
      // 无损音质显示为 SQ
      return { label: 'SQ', type: 'success' }
    case 'Hi-Res':
    case '臻品母带':
      // 高解析音质显示为 Hi-Res
      return { label: 'Hi-Res', type: 'warning' }
    default:
      return { label: quality, type: 'default' }
  }
}

/* 辅助函数：根据 source 返回对应的标签类型 */
function getSourceType(source?: string) {
  if (!source) return 'default'
  switch (source) {
    case 'netease': return 'error'
    case 'qq': return 'success'
    case 'kugou': return 'info'
    case 'kuwo': return 'warning'
    case 'bilibili': return 'primary'
    default: return 'default'
  }
}

/* 辅助函数：根据 source 返回对应的显示文本 */
function getSourceLabel(source?: string) {
  if (!source) return '未知'
  switch (source) {
    case 'netease': return '网易'
    case 'qq': return 'QQ'
    case 'kugou': return '酷狗'
    case 'kuwo': return '酷我'
    case 'bilibili': return 'B站'
    case 'migu': return '咪咕'
    case 'local': return '本地'
    default: return source
  }
}

function formatDuration(dt?: number): string {
  if (!dt) return '--:--'
  const totalSeconds = Math.floor(dt / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

function processSongTitle(title: string): { mainTitle: string; subTitle: string } {
  if (!title) return { mainTitle: '未知歌曲', subTitle: '' }

  const bracketRegex = /[（(].*?[)）]/g
  const brackets = title.match(bracketRegex)

  if (brackets && brackets.length > 0) {
    const mainTitle = title.replace(bracketRegex, '').trim()
    const subTitle = brackets.join(' ')
    return { mainTitle, subTitle }
  }
  return { mainTitle: title, subTitle: '' }
}
</script>

<style scoped>
.song-list-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.song-list-scroll-wrapper {
  flex: 1;
  width: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.song-list-scroll-container {
  flex: 1;
  width: 100%;
}

.song-list-header {
  display: flex;
  position: sticky;
  top: 0;
  z-index: 10;
  background-color: #f6f6f6;
  align-items: center;
  justify-content: space-between;
  padding: 8px 22px;
  color: #898385;
  font-size: 13px;
  font-weight: 500;
}

.song-item {
  margin: 0 2px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  transition: all 0.2s ease;
  border: 1px solid transparent;
  cursor: pointer;
}

.song-item--card {
  background-color: v-bind('listBackgroundColor');
}

.song-item--card:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

.song-item--card.active {
  border-color: v-bind('activeBorderColor');
}

.song-item--plain {
  background-color: transparent;
  border-color: transparent;
}

.song-item--plain .duration-info {
  left: -26px;
}

.index-cell {
  width: 24px;
  text-align: center;
  font-size: 14px;
  color: #888;
  margin-right: 2px;
}

.song-cover {
  width: 48px;
  height: 48px;
  border-radius: 6px;
  object-fit: cover;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.song-info {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  margin-left: 8px;
  gap: 4px;
}

.song-meta {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 50%;
}

.album-info {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.duration-info {
  font-size: 14px;
  color: #818181;
  min-width: 50px;
  text-align: left;
  position: relative;
  left: -26px;
}

.skeleton-container {
  padding: 12px;
  display: flex;
  flex-direction: column;
}

.skeleton-item {
  cursor: default !important;
  pointer-events: none;
}

/* Dark mode overrides */
  :root[data-theme='dark'] .song-list-header {
    color: #b6b0b2;
    background-color: transparent;
  }
  
  /* 强制透明背景，用于现代模式等场景 */
  .transparent-header .song-list-header {
    background-color: transparent !important;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1); /* 可选：增加一条淡淡的分隔线 */
    color: rgba(0, 0, 0, 0.8); /* 调整文字颜色以适应深色背景 */
  }

:root[data-theme='dark'] .song-item {
  color: #fff;
}

:root[data-theme='dark'] .song-item--card {
  border-color: rgba(255, 255, 255, 0.103);
}
</style>
