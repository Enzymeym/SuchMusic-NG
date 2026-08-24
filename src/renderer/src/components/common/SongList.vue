<template>
  <div
    class="song-list-container"
    :class="{ 'transparent-header': transparentHeader }"
    :style="{
      '--song-list-bg': listBackgroundColor,
      '--song-active-border': activeBorderColor
    }"
  >
    <!-- Header -->
    <div class="song-list-header">
      <div style="display: flex; align-items: center; flex: 1; transform: translateX(-6px)">
        <div v-if="selectable" style="width: 32px; text-align: center; margin-right: 4px">
          <n-checkbox
            :checked="allSelected"
            :indeterminate="someSelected"
            @update:checked="toggleSelectAll"
            @click.stop
          />
        </div>
        <div v-else style="width: 24px; text-align: center; margin-right: 4px">#</div>

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
      <div
        v-for="i in skeletonCount"
        :key="i"
        class="song-item skeleton-item"
        :class="itemVariantClass"
      >
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
          <transition-group
            name="song-fade"
            tag="div"
            :class="{ 'song-list-rows--large': isLargeList }"
          >
            <div
              v-for="(song, index) in songs"
              :key="song.id || `s-${index}`"
              @contextmenu="(e) => showContextMenu(song, e)"
              class="song-item-wrapper"
            >
              <div
                :class="[
                  'song-item',
                  itemVariantClass,
                  {
                    active: song.id == currentPlayingSongId,
                    selected: selectable && selectedSet.has(String(song.id))
                  }
                ]"
                @click="handleSongClick(song)"
                :draggable="draggableEnabled"
                @dragstart="(e) => handleDragStart(index, e)"
                @dragover="(e) => handleDragOver(index, e)"
                @drop="(e) => handleDrop(index, e)"
              >
                <div style="display: flex; align-items: center; gap: 8px">
                  <div v-if="selectable" class="index-cell" style="width: 32px" @click.stop>
                    <n-checkbox
                      :checked="selectedSet.has(String(song.id))"
                      @update:checked="() => toggleRowSelection(song)"
                      @click.stop="handleCheckboxClick"
                    />
                  </div>
                  <div v-else class="index-cell">
                    {{ getDisplayIndex(index) }}
                  </div>
                  <img
                    class="song-cover"
                    :src="song.thumbUrl || song.picUrl || song.al?.picUrl || defaultCover"
                    alt=""
                    referrerpolicy="no-referrer"
                    loading="lazy"
                    decoding="async"
                  />
                  <div class="song-info">
                    <div style="display: flex; align-items: center; gap: 10px">
                      <div style="display: flex; flex-direction: column; min-width: 0; flex: 1">
                        <div
                          class="song-title-ellipsis"
                          :title="getSongTitle(song).mainTitle"
                        >
                          {{ getSongTitle(song).mainTitle }}
                        </div>
                        <div
                          v-if="getSongTitle(song).subTitle"
                          class="song-subtitle-ellipsis"
                          :title="getSongTitle(song).subTitle"
                        >
                          {{ getSongTitle(song).subTitle }}
                        </div>
                      </div>
                      <n-tag
                        v-if="song.isOriginal"
                        type="success"
                        size="small"
                        round
                        :bordered="false"
                        style="transform: scale(0.8); margin-right: 2px; flex-shrink: 0"
                        >原唱</n-tag
                      >
                      <n-tag
                        v-if="song.mv"
                        type="warning"
                        size="small"
                        round
                        style="
                          cursor: pointer;
                          transform: scale(0.8);
                          margin-right: 2px;
                          flex-shrink: 0;
                        "
                        :bordered="false"
                        >MV</n-tag
                      >
                    </div>
                    <div style="display: flex; align-items: center; max-width: 200px">
                      <template v-if="filterPlatformsCached(song.platforms).length > 0">
                        <n-tag
                          v-for="p in filterPlatformsCached(song.platforms)"
                          :key="p.source"
                          :type="getSourceType(p.source)"
                          size="small"
                          round
                          :bordered="false"
                          style="transform: scale(0.8); margin-right: 2px; flex-shrink: 0"
                        >
                          {{ getSourceLabel(p.source) }}
                        </n-tag>
                      </template>
                      <n-tag
                        v-else-if="song.source && !blockedPlatforms.includes(song.source)"
                        :type="getSourceType(song.source)"
                        size="small"
                        round
                        :bordered="false"
                        style="transform: scale(0.8); margin-right: 2px; flex-shrink: 0"
                      >
                        {{ getSourceLabel(song.source) }}
                      </n-tag>
                      <n-tag
                        v-if="song.quality"
                        :type="getQualityTagCached(song.quality).type"
                        size="small"
                        round
                        :bordered="false"
                        style="transform: scale(0.8); margin-right: 2px; flex-shrink: 0"
                      >
                        {{ getQualityTagCached(song.quality).label }}
                      </n-tag>
                      <div
                        class="song-artist-ellipsis"
                        :title="getArtistsFormatted(song)"
                      >
                        {{ getArtistsFormatted(song) }}
                      </div>
                    </div>
                  </div>
                </div>
                <div class="song-meta">
                  <div class="album-info">
                    <div
                      class="song-album-ellipsis"
                      :title="getAlbumName(song)"
                      @click.stop="handleAlbumClick(song)"
                    >
                      {{ getAlbumName(song) }}
                    </div>
                  </div>
                  <div v-if="!hideDuration" class="duration-info">
                    {{ formatDuration(song.dt) }}
                  </div>
                </div>
              </div>
            </div>
          </transition-group>

          <!-- Footer -->
          <div style="padding: 16px 0">
            <n-flex v-if="loadMore && loading" align="center" justify="center" style="gap: 8px">
              <n-spin size="small" style="transform: scale(0.8)" />
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
import { ref, computed, onMounted, onBeforeUnmount, h } from 'vue'
import {
  NDropdown,
  NTag,
  NFlex,
  NSpin,
  NText,
  useThemeVars,
  NSkeleton,
  NDivider,
  NIcon,
  NScrollbar,
  NCheckbox,
  useMessage,
  type DropdownOption
} from 'naive-ui'
import { useRouter } from 'vue-router'
import { usePlaylistStore } from '../../stores/playlistStore'
import { usePlayerStore, type PlayerSong } from '../../stores/playerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useDownloadMusic } from '../../composables/useDownloadMusic'
import defaultCover from '../../assets/default-cover.png'
import { formatDuration } from '../../utils/format'

/** 大列表阈值：超过该数量启用视口外渲染跳过与动画禁用，避免整库全量渲染/动画开销 */
const LARGE_LIST_THRESHOLD = 120

/** 不支持的平台列表 */
const blockedPlatforms = ['soda', '5sing', 'bilibili', 'mg', 'migu']

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

// 歌曲标题解析结果缓存（WeakMap，随歌曲对象生命周期自动回收；name 变化时自动失效）
const songTitleResultCache = new WeakMap<
  object,
  { rawName: string; value: { mainTitle: string; subTitle: string } }
>()
function getSongTitle(song: Song): { mainTitle: string; subTitle: string } {
  const entry = songTitleResultCache.get(song)
  if (entry && entry.rawName === song.name) return entry.value
  const value = processSongTitle(song.name)
  songTitleResultCache.set(song, { rawName: song.name, value })
  return value
}

// 平台过滤结果缓存（按 platforms 数组引用复用，避免每行每次渲染重复 filter）
const platformsResultCache = new WeakMap<object, any[]>()
function filterPlatformsCached(platforms?: any[]): any[] {
  if (!platforms || platforms.length === 0) return []
  const cached = platformsResultCache.get(platforms)
  if (cached) return cached
  const result = platforms.filter((p) => !blockedPlatforms.includes(p.source))
  platformsResultCache.set(platforms, result)
  return result
}

// 音质标签纯函数结果缓存（质量字符串重复出现频率高）
const qualityTagCache = new Map<string, { label: string; type: TagType }>()
function getQualityTagCached(quality: string): { label: string; type: TagType } {
  let cached = qualityTagCache.get(quality)
  if (!cached) {
    cached = getQualityTag(quality)
    qualityTagCache.set(quality, cached)
  }
  return cached
}

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
  thumbUrl?: string
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
  extraMenuOptions?: any[]
  getPlayableSong?: (song: Song) => Promise<PlayerSong | null>
  transparentHeader?: boolean
  draggable?: boolean
  selectable?: boolean
  selectedIds?: Array<string | number>
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
  extraMenuOptions: undefined,
  getPlayableSong: undefined,
  transparentHeader: false,
  draggable: false,
  selectable: false,
  selectedIds: () => []
})

const emit = defineEmits<{
  (e: 'song-click', song: Song): void
  (e: 'album-click', song: Song): void
  (e: 'context-menu-select', key: string, song: Song): void
  (e: 'sort-change', key: string): void
  (e: 'scroll', event: Event): void
  (e: 'reorder', fromIndex: number, toIndex: number): void
  (e: 'update:selected-ids', ids: Array<string | number>): void
}>()

const themeVars = useThemeVars()
const router = useRouter()
const playlistStore = usePlaylistStore()
const playerStore = usePlayerStore()
const settingsStore = useSettingsStore()
const message = useMessage()
const { downloadMusic } = useDownloadMusic()
const isDarkMode = ref(document.documentElement.getAttribute('data-theme') === 'dark')
const itemVariantClass = computed(() => {
  const variant = props.itemVariant ?? settingsStore.appearance.songListStyle ?? 'card'
  return variant === 'plain' ? 'song-item--plain' : 'song-item--card'
})
const draggableEnabled = computed(() => props.draggable && !props.selectable)

const localSelected = computed<Array<string | number>>({
  get: () => props.selectedIds || [],
  set: (val) => emit('update:selected-ids', val)
})
const selectedSet = computed(() => new Set(localSelected.value.map(String)))
const allSelected = computed(
  () => props.songs.length > 0 && props.songs.every((s) => selectedSet.value.has(String(s.id)))
)
const someSelected = computed(
  () => props.songs.some((s) => selectedSet.value.has(String(s.id))) && !allSelected.value
)

function toggleSelectAll(): void {
  localSelected.value = allSelected.value ? [] : props.songs.map((s) => s.id)
}

function toggleRowSelection(song: Song): void {
  const id = String(song.id)
  const set = new Set(localSelected.value.map(String))
  set.has(id) ? set.delete(id) : set.add(id)
  localSelected.value = props.songs.filter((s) => set.has(String(s.id))).map((s) => s.id)
}

function handleCheckboxClick(e: MouseEvent): void {
  e.stopPropagation()
}

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

// 菜单项图标（mgc 图标字体）
const renderIcon = (iconClass: string) => {
  return () => h(NIcon, null, { default: () => h('i', { class: iconClass }) })
}

/** 判断歌曲是否为本地文件（有本地路径且非 http 在线地址） */
function isLocalSong(song: Song): boolean {
  const filePath = song.filePath || song.mp3Url
  return !!filePath && !/^https?:\/\//.test(filePath)
}

// 默认菜单项（带“添加到歌单”子菜单），基础操作由组件内部统一处理
const defaultDropdownOptions = computed(() => {
  const song = contextMenuSong.value
  // 本地歌曲无需下载，隐藏“下载歌曲”
  const showDownload = !song || !isLocalSong(song)
  const options: DropdownOption[] = [
    { label: '播放', key: 'play', icon: renderIcon('mgc_play_circle_line') },
    { label: '下一首播放', key: 'playNext', icon: renderIcon('mgc_playlist_add_line') },
    { type: 'divider', key: 'd1' },
    {
      label: '添加到歌单',
      key: 'addToPlaylist',
      icon: renderIcon('mgc_playlist_2_line'),
      children: playlistStore.playlists.map((pl) => ({
        label: pl.name,
        key: `addToPlaylist:${pl.id}`
      }))
    },
    { type: 'divider', key: 'd2' },
    { label: '复制歌曲ID', key: 'copyId', icon: renderIcon('mgc_copy_2_line') },
    { label: '查看专辑', key: 'viewAlbum', icon: renderIcon('mgc_album_2_line') }
  ]
  if (showDownload) {
    options.push(
      { type: 'divider', key: 'd3' },
      {
        label: '下载歌曲',
        key: 'downloadMenu',
        icon: renderIcon('mgc_download_3_line'),
        children: [
          { label: '标准音质 (128kbps)', key: 'download:128k' },
          { label: '较高音质 (192kbps)', key: 'download:192k' },
          { label: '高品音质 (320kbps)', key: 'download:320k' },
          { label: '无损音质 (FLAC)', key: 'download:flac' },
          { type: 'divider', key: 'd-dl-divider' },
          {
            label: '音质受平台版权与会员限制，实际以平台返回为准',
            key: 'download-disclaimer',
            disabled: true
          }
        ]
      }
    )
  }
  return options
})

// 统一默认菜单 + 页面追加的专属菜单项
const dropdownOptions = computed(() => {
  const base = [...defaultDropdownOptions.value]
  if (props.extraMenuOptions && props.extraMenuOptions.length > 0) {
    base.push({ type: 'divider', key: 'extra-divider' })
    base.push(...props.extraMenuOptions)
  }
  return base
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

async function handleContextMenuSelect(key: string | number): Promise<void> {
  if (!contextMenuSong.value) return
  const keyStr = String(key)
  const song = contextMenuSong.value

  if (keyStr === 'play') {
    // 与单击歌曲行行为完全一致，交由页面统一处理播放
    emit('song-click', song)
  } else if (keyStr === 'playNext') {
    await handlePlayNext(song)
  } else if (keyStr.startsWith('addToPlaylist:')) {
    const playlistId = keyStr.slice('addToPlaylist:'.length)
    if (!playlistId) {
      showDropdown.value = false
      return
    }
    addSongToPlaylistById(playlistId)
  } else if (keyStr === 'copyId') {
    await handleCopyId(song)
  } else if (keyStr === 'viewAlbum') {
    handleViewAlbum(song)
  } else if (keyStr.startsWith('download:')) {
    // 下载歌曲：从菜单 key 中解析音质标识
    const quality = keyStr.slice('download:'.length)
    await handleDownload(song, quality)
  } else {
    // 页面专属菜单项
    emit('context-menu-select', keyStr, song)
  }
  showDropdown.value = false
}

/** 将组件内歌曲结构转换为播放器歌曲结构 */
function toPlayerSong(song: Song): PlayerSong {
  return {
    id: song.id ?? song.sourceSongId ?? null,
    title: song.name,
    artist: getArtistsFormatted(song),
    album: getAlbumName(song),
    cover: song.picUrl || song.al?.picUrl || '',
    durationMs: song.dt || 0,
    filePath: song.filePath || song.mp3Url,
    source: song.source,
    sourceSongId: song.sourceSongId ?? song.id
  }
}

/** 解析无 filePath 的在线歌曲为可播放对象（由页面提供解析器） */
async function resolvePlayable(song: Song): Promise<PlayerSong | null> {
  if (!props.getPlayableSong) return null
  try {
    const resolved = await props.getPlayableSong(song)
    if (resolved) return resolved
  } catch (e) {
    console.error('[SongList] 解析歌曲播放地址失败:', e)
  }
  return null
}

/** 下一首播放：仅插入到当前歌曲之后，不打断当前播放；无当前播放时立即播放 */
async function handlePlayNext(song: Song): Promise<void> {
  let target = toPlayerSong(song)
  if (!target.filePath) {
    const resolved = await resolvePlayable(song)
    if (!resolved) {
      message.warning('该歌曲暂无播放地址，无法加入下一首播放')
      return
    }
    target = resolved
  }

  if (playerStore.currentIndex >= 0 && playerStore.playlist.length > 0) {
    playerStore.insertNextToPlaylist(target)
    message.success('已加入下一首播放')
  } else {
    const list = props.songs.map((s) =>
      String(s.id) === String(song.id) ? target : toPlayerSong(s)
    )
    playerStore.setPlaylist(list)
    const idx = list.findIndex(
      (s) => s.id != null && target.id != null && String(s.id) === String(target.id)
    )
    playerStore.playSongAtIndex(idx >= 0 ? idx : 0)
  }
}

/** 复制歌曲 ID 到剪贴板 */
async function handleCopyId(song: Song): Promise<void> {
  const id = song.sourceSongId ?? song.id
  if (id == null) {
    message.warning('该歌曲没有可复制的 ID')
    return
  }
  try {
    await navigator.clipboard.writeText(String(id))
    message.success('歌曲ID已复制')
  } catch (e) {
    console.error('[SongList] 复制歌曲ID失败:', e)
    message.error('复制失败')
  }
}

/** 查看专辑：跳转到专辑详情页 */
function handleViewAlbum(song: Song): void {
  const name = getAlbumName(song)
  if (!name || name === '未知专辑') {
    message.warning('未找到专辑信息')
    return
  }
  router.push('/album/' + encodeURIComponent(name))
}

/** 下载歌曲：本地文件无需下载，在线歌曲走统一下载流程（quality 可选音质标识） */
async function handleDownload(song: Song, quality?: string): Promise<void> {
  if (isLocalSong(song)) {
    message.info('本地歌曲无需下载')
    return
  }
  await downloadMusic(toPlayerSong(song), quality)
}

function addSongToPlaylistById(playlistId: string) {
  if (!contextMenuSong.value) {
    message.warning('未选中歌曲')
    return
  }
  const target = playlistStore.playlists.find((p) => p.id === playlistId)
  if (!target) {
    message.error('歌单不存在，请刷新页面后重试')
    return
  }
  const song = contextMenuSong.value
  const track = toPlayerSong(song)
  const exists = target.tracks.some((t) => t.id === track.id)
  if (exists) {
    message.info('歌单中已存在该歌曲')
    return
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
    case 'netease':
    case 'wy':
      return 'error'
    case 'qq':
    case 'tx':
      return 'success'
    case 'kugou':
    case 'kg':
      return 'info'
    case 'kuwo':
    case 'kw':
      return 'warning'
    default:
      return 'default'
  }
}

/* 辅助函数：根据 source 返回对应的显示文本 */
function getSourceLabel(source?: string) {
  if (!source) return '未知'
  switch (source) {
    case 'netease':
    case 'wy':
      return '网易'
    case 'qq':
    case 'tx':
      return 'QQ'
    case 'kugou':
    case 'kg':
      return '酷狗'
    case 'kuwo':
    case 'kw':
      return '酷我'
    case 'migu':
    case 'mg':
      return '咪咕'
    case 'local':
      return '本地'
    default:
      return source
  }
}

function getDisplayIndex(idx: number): number {
  return Number(props.startIndex ?? 0) + Number(idx) + 1
}

/** 是否为大列表：启用视口外渲染跳过与动画禁用 */
const isLargeList = computed(() => props.songs.length > LARGE_LIST_THRESHOLD)
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
  will-change: transform;
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
  transition:
    background-color 0.2s ease,
    border-color 0.2s ease;
  border: 1px solid transparent;
  cursor: pointer;
  contain: layout style;
}

.song-item--card {
  background-color: var(--song-list-bg);
}

.song-item--card:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

.song-item--card.active {
  border-color: var(--song-active-border);
}

.song-item--card.selected {
  background-color: rgba(61, 136, 155, 0.12);
}

.song-item--card.selected:hover {
  background-color: rgba(61, 136, 155, 0.18);
}

.song-item--plain.selected {
  background-color: rgba(61, 136, 155, 0.12);
}

.song-item--plain.selected:hover {
  background-color: rgba(61, 136, 155, 0.18);
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

/* 歌曲淡入动画效果 */
.song-item-wrapper {
  transition: all 0.3s ease;
  contain: layout style;
}

/* 轻量 CSS 省略（替代每行 4 个 n-ellipsis，消除每行 4 个 ResizeObserver 实例） */
.song-title-ellipsis,
.song-subtitle-ellipsis,
.song-artist-ellipsis,
.song-album-ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-title-ellipsis {
  font-weight: bold;
  font-size: 16.5px;
  max-width: 200px;
}

.song-subtitle-ellipsis {
  font-size: 12.5px;
  color: #818181;
  max-width: 200px;
}

.song-artist-ellipsis {
  font-size: 14px;
  color: #818181;
  flex: 1;
  min-width: 0;
}

.song-album-ellipsis {
  font-size: 14px;
  color: #818181;
  cursor: pointer;
  max-width: 32vh;
}

/* 大列表：跳过视口外行的渲染/绘制，并禁用昂贵的 blur/位移动画 */
.song-list-rows--large .song-item-wrapper {
  content-visibility: auto;
  contain-intrinsic-size: auto 80px;
}

.song-list-rows--large .song-fade-enter-active,
.song-list-rows--large .song-fade-leave-active,
.song-list-rows--large .song-fade-move {
  transition: none !important;
}

.song-list-rows--large .song-fade-enter-from,
.song-list-rows--large .song-fade-leave-to {
  opacity: 1;
  filter: none;
  transform: none;
}

.song-fade-enter-active,
.song-fade-leave-active {
  transition: all 0.5s ease;
}

.song-fade-enter-from {
  opacity: 0;
  filter: blur(10px);
  transform: translateY(10px);
}

.song-fade-leave-to {
  opacity: 0;
  filter: blur(10px);
  transform: translateY(-10px);
}

.song-fade-move {
  transition: transform 0.5s ease;
}
</style>
