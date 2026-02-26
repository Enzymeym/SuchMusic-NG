<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { usePlayerStore } from '../../stores/playerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import defaultCover from '@renderer/assets/icon.png'
import {
  NIcon,
  NSlider,
  NButton,
  NDrawer,
  NDrawerContent,
  NScrollbar,
  NSpin,
  NEmpty,
  NDropdown,
  useMessage
} from 'naive-ui'
import { webAudioEngine } from '../../audio/audio-engine'
import LyricPlayer from '../common/PlayerLyrics/LyricPlayer.vue'
import BackgroundRender from '../common/AMLL/BackgroundRender.vue'
import { extractImageColors } from '../../utils/imageColors'
import { fetchNewComments, type CommentItem } from '../../apis/netease/comment'

const player = usePlayerStore()
const settingsStore = useSettingsStore()
const playlistStore = usePlaylistStore()
const message = useMessage()

// 向父组件发送事件（用于打开发送播放列表抽屉）
const emit = defineEmits<{
  (e: 'open-playlist'): void
}>()

// 控制条显示状态
const isControlsVisible = ref(true)
let hideControlsTimer: ReturnType<typeof setTimeout> | null = null

// 鼠标指针隐藏状态
const isCursorHidden = ref(false)

// 全屏状态与容器引用
const isFullscreen = ref(false)
const playerPageRef = ref<HTMLElement | null>(null)

// 是否启用“隐藏底栏时自动隐藏鼠标指针”设置
const autoHideCursorEnabled = computed(
  () => settingsStore.playback.autoHideCursorWhenControlsHidden
)

// 根据当前状态应用鼠标指针显示/隐藏
const applyCursorVisibility = () => {
  // 播放页关闭或未启用设置时，确保恢复指针
  if (!player.isPlayerPageShown || !autoHideCursorEnabled.value) {
    if (isCursorHidden.value) {
      document.body.style.cursor = ''
      isCursorHidden.value = false
    }
    return
  }

  if (isControlsVisible.value) {
    if (isCursorHidden.value) {
      document.body.style.cursor = ''
      isCursorHidden.value = false
    }
  } else {
    if (!isCursorHidden.value) {
      document.body.style.cursor = 'none'
      isCursorHidden.value = true
    }
  }
}

// 显示控制条，并重置隐藏计时器
const showControls = () => {
  isControlsVisible.value = true
  if (hideControlsTimer) {
    clearTimeout(hideControlsTimer)
  }
  hideControlsTimer = setTimeout(() => {
    // 仅在未拖动进度条时才隐藏
    if (!isDraggingProgress.value) {
      isControlsVisible.value = false
    }
  }, 3000)
}

const handleActivity = () => {
  // 用户有操作时，显示控制条并恢复鼠标指针
  showControls()
}

// 同步全屏状态（处理 Esc 等外部退出）
const handleFullscreenChange = () => {
  isFullscreen.value = !!document.fullscreenElement
}

// 进入全屏
const enterFullscreen = async (): Promise<void> => {
  const el = playerPageRef.value
  if (!el || !el.requestFullscreen) return
  try {
    await el.requestFullscreen()
  } catch (e) {
    console.error('enter fullscreen failed', e)
  }
}

// 退出全屏
const exitFullscreen = async (): Promise<void> => {
  if (!document.fullscreenElement) {
    isFullscreen.value = false
    return
  }
  try {
    await document.exitFullscreen()
  } catch (e) {
    console.error('exit fullscreen failed', e)
  } finally {
    isFullscreen.value = false
  }
}

// 切换全屏
const toggleFullscreen = (): void => {
  if (isFullscreen.value) {
    void exitFullscreen()
  } else {
    void enterFullscreen()
  }
}

onMounted(() => {
  showControls()
  window.addEventListener('mousemove', handleActivity)
  window.addEventListener('click', handleActivity)
  window.addEventListener('keydown', handleActivity)
  document.addEventListener('fullscreenchange', handleFullscreenChange)
})

onUnmounted(() => {
  if (hideControlsTimer) {
    clearTimeout(hideControlsTimer)
  }
  window.removeEventListener('mousemove', handleActivity)
  window.removeEventListener('click', handleActivity)
  window.removeEventListener('keydown', handleActivity)
  document.removeEventListener('fullscreenchange', handleFullscreenChange)

  // 播放页卸载时恢复鼠标指针与全屏
  if (isCursorHidden.value) {
    document.body.style.cursor = ''
    isCursorHidden.value = false
  }
  if (isFullscreen.value) {
    void exitFullscreen()
  }
})

// 监听控制条显示状态和设置开关，实时更新鼠标指针状态
watch([isControlsVisible, autoHideCursorEnabled], () => {
  applyCursorVisibility()
})

// 是否为网易云歌曲
const isNeteaseSong = computed(() => player.currentSong?.source === 'netease')

// 当前网易云歌曲的原始 ID（优先使用 sourceSongId）
const neteaseSongId = computed(() => player.currentSong?.sourceSongId ?? player.currentSong?.id)

// 评论抽屉显示状态
const showCommentsDrawer = ref(false)

// 评论数据与状态
const comments = ref<CommentItem[]>([])
const commentsTotal = ref(0)
const commentsHasMore = ref(false)
const commentsLoading = ref(false)
const commentsError = ref<string | null>(null)
const commentsPageNo = ref(1)

const addToPlaylistDropdownOptions = computed(() =>
  playlistStore.playlists.map((pl) => ({
    label: pl.name,
    key: pl.id
  }))
)

const handleAddToPlaylistSelect = (key: string | number) => {
  if (!player.currentSong) return
  const target = playlistStore.playlists.find((p) => p.id === key)
  if (!target) return
  const exists = target.tracks.some((t) => t.id === player.currentSong?.id)
  if (exists) {
    message.info('歌单中已存在该歌曲')
    return
  }
  const track = {
    id: player.currentSong.id,
    title: player.currentSong.title,
    artist: player.currentSong.artist,
    album: player.currentSong.album,
    cover: player.currentSong.cover,
    filePath: player.currentSong.filePath,
    durationMs: player.currentSong.durationMs,
    source: player.currentSong.source,
    sourceSongId: player.currentSong.sourceSongId
  }
  const updated = {
    ...target,
    tracks: [...target.tracks, track]
  }
  playlistStore.updatePlaylist(updated)
  message.success('已添加到歌单')
}
const commentsPageSize = 20
const commentsSortType = ref<1 | 2 | 3>(1)
const commentsCursor = ref<string | null>(null)

// 重置当前评论状态
const resetCommentsState = () => {
  comments.value = []
  commentsTotal.value = 0
  commentsHasMore.value = false
  commentsLoading.value = false
  commentsError.value = null
  commentsPageNo.value = 1
  commentsCursor.value = null
}

// 格式化评论时间
const formatCommentTime = (time: number): string => {
  if (!time) return ''
  const d = new Date(time)
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  const hh = `${d.getHours()}`.padStart(2, '0')
  const mm = `${d.getMinutes()}`.padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}`
}

// 从网易云拉取评论列表
const loadComments = async (reset: boolean = false): Promise<void> => {
  if (!isNeteaseSong.value || !neteaseSongId.value) return

  if (reset) {
    commentsPageNo.value = 1
    commentsCursor.value = null
    comments.value = []
  }

  commentsLoading.value = true
  commentsError.value = null

  try {
    const res = await fetchNewComments({
      id: neteaseSongId.value,
      type: 0,
      pageNo: commentsPageNo.value,
      pageSize: commentsPageSize,
      sortType: commentsSortType.value,
      cursor:
        commentsSortType.value === 3 && commentsPageNo.value > 1
          ? commentsCursor.value || undefined
          : undefined
    })

    if (!res || res.code !== 200 || !res.data) {
      commentsError.value = res?.message || '获取评论失败'
      return
    }

    const data = res.data
    const list = Array.isArray(data.comments) ? data.comments : []

    if (reset) {
      comments.value = list
    } else {
      comments.value = [...comments.value, ...list]
    }

    commentsTotal.value = data.totalCount ?? list.length
    commentsHasMore.value = !!data.hasMore
    if (data.cursor !== undefined && data.cursor !== null) {
      commentsCursor.value = String(data.cursor)
    }
  } catch (e: any) {
    console.error('fetch comments failed', e)
    commentsError.value = e?.message || '获取评论失败'
  } finally {
    commentsLoading.value = false
  }
}

// 加载更多评论
const handleLoadMoreComments = async (): Promise<void> => {
  if (!commentsHasMore.value || commentsLoading.value) return
  commentsPageNo.value += 1
  await loadComments(false)
}

// 当当前播放歌曲变化时，自动刷新评论（仅网易云歌曲）
watch(
  () => player.currentSong?.id,
  () => {
    resetCommentsState()
    if (isNeteaseSong.value && neteaseSongId.value) {
      void loadComments(true)
    }
  }
)

// Touch handling for swipe down
const touchStartY = ref(0)
const touchCurrentY = ref(0)
const isDragging = ref(false)

const handleTouchStart = (e: TouchEvent): void => {
  touchStartY.value = e.touches[0].clientY
  isDragging.value = true
}

const handleTouchMove = (e: TouchEvent): void => {
  if (!isDragging.value) return
  touchCurrentY.value = e.touches[0].clientY
}

const handleTouchEnd = (): void => {
  if (!isDragging.value) return
  isDragging.value = false

  const deltaY = touchCurrentY.value - touchStartY.value
  if (deltaY > 60 && !isFullscreen.value) {
    closePage()
  }

  touchStartY.value = 0
  touchCurrentY.value = 0
}

const closePage = (): void => {
  // 关闭播放页前确保退出全屏
  if (isFullscreen.value) {
    void exitFullscreen()
  }
  player.setPlayerPageShown(false)
}

// 打开评论抽屉（非网易云歌曲时不响应）
const openComments = (): void => {
  if (!isNeteaseSong.value) return
  showCommentsDrawer.value = true
  if (!commentsLoading.value && comments.value.length === 0) {
    void loadComments(true)
  }
}

// Format time helper
const formatTime = (seconds: number): string => {
  if (!seconds || isNaN(seconds)) return '00:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

// Progress handling
const isDraggingProgress = ref(false)
const dragValue = ref(0)

const progressPercent = computed(() => {
  if (isDraggingProgress.value) return dragValue.value
  if (!player.currentSong || player.currentSong.durationMs <= 0) return 0
  return (player.positionMs / player.currentSong.durationMs) * 100
})

const displayTime = computed(() => {
  if (isDraggingProgress.value) {
    if (!player.currentSong || player.currentSong.durationMs <= 0) return '00:00'
    const ms = (dragValue.value / 100) * player.currentSong.durationMs
    return formatTime(ms / 1000)
  }
  return formatTime(player.positionMs / 1000)
})

const handleProgressUpdate = (val: number): void => {
  // 始终更新拖拽值，保证 UI 与滑块一致
  dragValue.value = val

  // 非拖拽场景（例如点击或键盘调节），直接跳转进度
  if (!isDraggingProgress.value) {
    if (!player.currentSong || player.currentSong.durationMs <= 0) return
    const ratio = Math.min(Math.max(val, 0), 100) / 100
    const targetMs = player.currentSong.durationMs * ratio
    webAudioEngine.seek(targetMs)
  }

  // Reset hide controls timer on interaction
  showControls()
}

const startDrag = (): void => {
  // Clear hide timer when dragging starts
  if (hideControlsTimer) {
    clearTimeout(hideControlsTimer)
  }
  isControlsVisible.value = true

  // 初始化拖拽起点为当前播放进度，避免进度条跳变
  if (player.currentSong && player.currentSong.durationMs > 0) {
    dragValue.value = (player.positionMs / player.currentSong.durationMs) * 100
  } else {
    dragValue.value = 0
  }

  isDraggingProgress.value = true
  window.addEventListener('mouseup', endDrag)
  window.addEventListener('touchend', endDrag)
}

const endDrag = (): void => {
  if (!isDraggingProgress.value) return

  isDraggingProgress.value = false
  window.removeEventListener('mouseup', endDrag)
  window.removeEventListener('touchend', endDrag)

  // Restart hide timer
  showControls()

  if (!player.currentSong || player.currentSong.durationMs <= 0) return

  // 根据拖拽结果计算目标位置并跳转
  const ratio = Math.min(Math.max(dragValue.value, 0), 100) / 100
  const targetMs = player.currentSong.durationMs * ratio
  webAudioEngine.seek(targetMs)
}

// Play/Pause
const togglePlay = async (): Promise<void> => {
  if (player.isPlaying) {
    await webAudioEngine.pause()
    player.setPlaying(false)
  } else {
    if (player.currentSong) {
      await webAudioEngine.resume()
      player.setPlaying(true)
    }
  }
}

const handlePrev = (): void => player.playPrev()
const handleNext = (): void => player.playNext()

// Mode icon
const modeIcon = computed(() => {
  switch (player.playMode) {
    case 'loop':
      return 'mgc_repeat_one_line'
    case 'shuffle':
      return 'mgc_shuffle_line'
    case 'list':
    default:
      return 'mgc_repeat_line'
  }
})

const currentTime = computed(() => {
  return player.positionMs / 1000
})

const lyricsData = computed(() => {
  return player.currentSong?.lyrics || ''
})

// 歌词显示模式（Apple 风格或简洁列表）
const lyricsMode = computed<'apple' | 'suth'>(() =>
  settingsStore.playback.lyricsAppleStyle ? 'apple' : 'suth'
)

// 歌词基础字号（px）
const lyricsBaseFontSize = computed(() => settingsStore.playback.lyricsFontSize || 28)

// 歌词布局占比（右侧歌词区域百分比）
const lyricsAreaRatio = computed(() => {
  const raw = settingsStore.playback.lyricsAreaRatio ?? 60
  return Math.min(Math.max(raw, 30), 70)
})

// 左右区域 flex 比例
const leftPanelFlex = computed(() => 100 - lyricsAreaRatio.value)
const rightPanelFlex = computed(() => lyricsAreaRatio.value)

// 歌词字号样式字符串
const lyricsMainFontSize = computed(() => `${lyricsBaseFontSize.value}px`)
const lyricsSubFontSize = computed(() => `${Math.round(lyricsBaseFontSize.value * 0.7)}px`)

// 播放页内的主题色（只作用于本页）
const playerThemeColor = ref('#2C8EFD')
const lastCoverForTheme = ref<string | null>(null)

// 解析十六进制颜色
const hexToRgb = (hex: string) => {
  let s = hex.trim()
  if (s.startsWith('#')) s = s.slice(1)
  if (s.length === 3) {
    s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
  }
  if (s.length !== 6) return null
  const r = parseInt(s.slice(0, 2), 16)
  const g = parseInt(s.slice(2, 4), 16)
  const b = parseInt(s.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
  return { r, g, b }
}

// 计算颜色亮度（0-1）
const getBrightness = (hex: string) => {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255
}

const mixWithWhite = (hex: string, weight: number) => {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const w = Math.min(Math.max(weight, 0), 1)
  const r = Math.round(rgb.r * (1 - w) + 255 * w)
  const g = Math.round(rgb.g * (1 - w) + 255 * w)
  const b = Math.round(rgb.b * (1 - w) + 255 * w)
  const toHex = (v: number) => v.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

const normalizeThemeColor = (hex: string) => {
  let color = hex
  let brightness = getBrightness(color)
  const target = 0.7
  if (brightness >= target) return color
  for (let i = 0; i < 3 && brightness < target; i++) {
    const delta = target - brightness
    const weight = Math.min(0.6, Math.max(0.2, delta * 1.2))
    color = mixWithWhite(color, weight)
    brightness = getBrightness(color)
  }
  return color
}

// 转为 rgba 字符串
const hexToRgba = (hex: string, alpha: number) => {
  const rgb = hexToRgb(hex)
  if (!rgb) return `rgba(255, 255, 255, ${alpha})`
  const a = Math.min(Math.max(alpha, 0), 1)
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`
}

// 播放页根元素样式（注入局部 CSS 变量）
const playerPageStyle = computed(() => {
  const main = playerThemeColor.value
  return {
    '--player-accent-color': main,
    '--player-accent-soft-bg': hexToRgba(main, 0.18),
    '--player-accent-border': hexToRgba(main, 0.6)
  } as Record<string, string>
})

// 根据封面自动更新播放页主题色
watch(
  () => player.currentSong?.cover,
  async (cover) => {
    if (!cover) return
    if (cover === lastCoverForTheme.value) return
    lastCoverForTheme.value = cover
    try {
      const palette = await extractImageColors(cover)
      const candidates = [palette.main, palette.secondary, palette.third].filter(Boolean)
      if (!candidates.length) return
      let best = candidates[0]
      let bestBrightness = getBrightness(best)
      for (let i = 1; i < candidates.length; i++) {
        const b = getBrightness(candidates[i])
        if (b > bestBrightness) {
          bestBrightness = b
          best = candidates[i]
        }
      }
      playerThemeColor.value = normalizeThemeColor(best)
    } catch (e) {
      console.error('auto theme from cover failed', e)
    }
  }
)
</script>

<template>
  <Transition name="player-slide">
    <div
      v-if="player.isPlayerPageShown"
      class="player-page"
      ref="playerPageRef"
      :style="playerPageStyle"
      @touchstart="handleTouchStart"
      @touchmove="handleTouchMove"
      @touchend="handleTouchEnd"
    >
      <!-- Background Layer：根据设置切换旧背景与 AMLL 动态背景 -->
      <div class="player-bg">
        <template v-if="settingsStore.playback.playerBackgroundStyle === 'amll'">
          <BackgroundRender
            :album="player.currentSong?.cover || defaultCover"
            :playing="player.isPlaying"
            :has-lyric="!!lyricsData"
            :flow-speed="2"
            :render-scale="0.6"
          />
          <div class="bg-mask"></div>
        </template>
        <template v-else>
          <img :src="player.currentSong?.cover || defaultCover" class="bg-image" />
          <div class="bg-mask"></div>
        </template>
      </div>

      <!-- Content Layer -->
      <div class="player-content">
        <!-- Header -->
        <div class="page-header" :class="{ 'hide-controls': !isControlsVisible }">
          <div class="header-left">
            <n-button text class="header-btn">
              <n-icon size="24"><i class="mgc_menu_line"></i></n-icon>
            </n-button>
          </div>
          <div class="header-right">
            <n-button text class="header-btn" @click="toggleFullscreen">
              <n-icon size="24">
                <i :class="isFullscreen ? 'mgc_fullscreen_exit_line' : 'mgc_fullscreen_2_line'"></i>
              </n-icon>
            </n-button>
            <n-button v-if="!isFullscreen" text class="header-btn" @click="closePage">
              <n-icon size="24"><i class="mgc_down_line"></i></n-icon>
            </n-button>
          </div>
        </div>

        <!-- Main Area (Split View) -->
        <Transition name="song-switch" mode="out-in">
          <div :key="player.currentSong?.id || 'empty'" class="main-area">
            <!-- Left Panel: Cover & Info -->
            <div class="left-panel" :style="{ flex: leftPanelFlex }">
              <div class="cover-wrapper">
                <img
                  :src="player.currentSong?.cover || defaultCover"
                  class="main-cover"
                  :class="{ 'is-playing': player.isPlaying }"
                />
              </div>

              <div class="info-wrapper">
                <div class="song-title">{{ player.currentSong?.title || '未选择歌曲' }}</div>
                <div class="tags-row">
                  <span class="tag-badge">Hi-Res</span>
                  <span class="tag-badge">LRC</span>
                </div>
                <div class="artist-row">
                  <n-icon size="16"><i class="mgc_user_3_line"></i></n-icon>
                  <span>{{ player.currentSong?.artist || '未知歌手' }}</span>
                </div>
                <div v-if="player.currentSong?.album" class="album-row">
                  <n-icon size="16"><i class="mgc_album_line"></i></n-icon>
                  <span>{{ player.currentSong?.album }}</span>
                </div>
              </div>
            </div>

            <!-- Right Panel: Lyrics -->
            <div class="right-panel" :style="{ flex: rightPanelFlex }">
              <div
                class="lyrics-placeholder"
                :class="[
                  { 'fullscreen-lyrics': isFullscreen },
                  settingsStore.playback.lyricsAutoSize ? 'lyrics-auto-size' : 'lyrics-manual-size'
                ]"
              >
                <LyricPlayer
                  :lyrics="lyricsData"
                  :current-time="currentTime"
                  :mode="lyricsMode"
                  :font-size="lyricsBaseFontSize"
                  :active-line-color="playerThemeColor" 
                />
              </div>

              <!-- Side Tools (Right Edge) -->
              <div class="side-tools" v-if="false">
                <n-button text class="side-btn">
                  <n-icon size="20"><i class="mgc_copy_line"></i></n-icon>
                </n-button>
                <n-button text class="side-btn">
                  <n-icon size="20"><i class="mgc_text_line"></i></n-icon>
                </n-button>
              </div>
            </div>
          </div>
        </Transition>

        <!-- Footer Control Area -->
        <div class="footer-area" :class="{ 'hide-controls': !isControlsVisible }">
          <!-- Left Actions -->
          <div class="footer-left">
            <n-button v-if="!isFullscreen" quaternary class="action-btn" @click="closePage">
              <n-icon size="24" style="transform: translateX(-5px) translateY(1px)"
                ><i class="mgc_down_line"></i
              ></n-icon>
            </n-button>
            <n-button quaternary class="action-btn">
              <n-icon size="24" style="transform: translateX(-5px) translateY(1px)"
                ><i class="mgc_heart_line"></i
              ></n-icon>
            </n-button>
            <n-dropdown
              trigger="click"
              :options="addToPlaylistDropdownOptions"
              @select="handleAddToPlaylistSelect"
            >
              <n-button quaternary class="action-btn">
                <n-icon size="24" style="transform: translateX(-5px) translateY(0.5px)"
                  ><i class="mgc_add_circle_line"></i
                ></n-icon>
              </n-button>
            </n-dropdown>
            <n-button
              quaternary
              class="action-btn"
              :disabled="!isNeteaseSong"
              @click="openComments"
            >
              <n-icon size="24" style="transform: translateX(-5px) translateY(1px)"
                ><i class="mgc_comment_line"></i
              ></n-icon>
            </n-button>
          </div>

          <!-- Center Controls -->
          <div class="footer-center">
            <div class="control-buttons">
              <n-button text class="control-btn" @click="player.togglePlayMode()">
                <n-icon size="20"><i :class="modeIcon"></i></n-icon>
              </n-button>
              <n-button quaternary circle @click="handlePrev">
                <n-icon size="24"><i class="mgc_skip_previous_fill"></i></n-icon>
              </n-button>
              <div class="play-pause-btn" @click="togglePlay">
                <n-icon size="24">
                  <i :class="player.isPlaying ? 'mgc_pause_line' : 'mgc_play_fill'"></i>
                </n-icon>
              </div>
              <n-button quaternary circle @click="handleNext">
                <n-icon size="24"><i class="mgc_skip_forward_fill"></i></n-icon>
              </n-button>
              <n-button quaternary circle>
                <n-icon size="20"><i class="mgc_repeat_line"></i></n-icon>
              </n-button>
            </div>

            <div class="progress-bar-row">
              <span class="time-text">{{ displayTime }}</span>
              <div class="slider-container" @mousedown="startDrag" @touchstart="startDrag">
                <n-slider
                  :value="progressPercent"
                  :tooltip="false"
                  @update:value="handleProgressUpdate"
                  @update:value-end="endDrag"
                />
              </div>
              <span class="time-text">{{
                formatTime((player.currentSong?.durationMs || 0) / 1000)
              }}</span>
            </div>
          </div>

          <!-- Right Actions -->
          <div class="footer-right">
            <n-button quaternary class="action-btn">
              <n-icon size="22"><i class="mgc_settings_2_line"></i></n-icon>
            </n-button>
            <n-button quaternary class="action-btn">
              <n-icon size="22"><i class="mgc_volume_line"></i></n-icon>
            </n-button>
            <n-button quaternary class="action-btn" @click="emit('open-playlist')">
              <n-icon size="22"><i class="mgc_playlist_line"></i></n-icon>
            </n-button>
          </div>
        </div>
      </div>
    </div>
  </Transition>

  <!-- 网易云评论抽屉 -->
  <n-drawer
    v-model:show="showCommentsDrawer"
    :width="420"
    placement="right"
    :trap-focus="false"
    :block-scroll="false"
  >
    <n-drawer-content :native-scrollbar="false" body-content-style="padding: 0;">
      <template #header>
        <div class="comments-header">
          <div class="comments-title">评论</div>
          <div class="comments-meta">
            <span v-if="commentsTotal > 0" class="comments-count">
              共 {{ commentsTotal }} 条
            </span>
            <span v-if="!isNeteaseSong" class="comments-tip">仅支持网易云歌曲</span>
          </div>
        </div>
      </template>

      <div class="comments-body">
        <n-spin :show="commentsLoading">
          <n-scrollbar style="max-height: 100%">
            <n-empty
              v-if="!commentsLoading && comments.length === 0 && !commentsError"
              description="暂无评论"
              style="margin-top: 40px;"
            />
            <div v-else-if="commentsError" class="comments-error">
              {{ commentsError }}
            </div>
            <div v-else class="comment-list">
              <div v-for="item in comments" :key="item.commentId" class="comment-item">
                <img :src="item.user.avatarUrl" class="comment-avatar" />
                <div class="comment-main">
                  <div class="comment-header">
                    <div class="comment-author">{{ item.user.nickname }}</div>
                    <div class="comment-time">
                      {{ formatCommentTime(item.time) }}
                    </div>
                  </div>
                  <div class="comment-content">
                    {{ item.content }}
                  </div>
                  <div class="comment-footer">
                    <span class="comment-like">
                      <i class="mgc_thumb_up_line"></i>
                      <span class="comment-like-count">{{ item.likedCount }}</span>
                    </span>
                  </div>
                </div>
              </div>

              <div v-if="commentsHasMore" class="comments-load-more">
                <n-button
                  size="small"
                  tertiary
                  :loading="commentsLoading"
                  @click="handleLoadMoreComments"
                >
                  加载更多
                </n-button>
              </div>
            </div>
          </n-scrollbar>
        </n-spin>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped lang="scss">
.player-page {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
  backdrop-filter: blur(18px); // 整体背景模糊
  background: rgba(0, 0, 0, 0.45); // 整体背景压暗
}

.player-bg {
  position: absolute;
  inset: 0;
  z-index: 10;
  overflow: hidden;

  .bg-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(100px) brightness(0.6);
    transform: scale(1.2);
    transition: opacity 0.4s ease;
  }

  .bg-mask {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.2);
    backdrop-filter: blur(20px);
  }
}

.player-content {
  position: relative;
  z-index: 11;
  flex: 1;
  display: flex;
  flex-direction: column;
  color: #fff;
  padding: 20px 24px 0px;
  padding-top: max(16px, env(safe-area-inset-top));
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 48px;
  margin-bottom: 16px;
  transition:
    opacity 0.5s ease,
    transform 0.5s ease;

  &.hide-controls {
    opacity: 0;
    transform: translateY(-20px);
    pointer-events: none;
  }

  .header-btn {
    color: var(--player-accent-color, rgba(255, 255, 255, 0.8)); // 页头按钮使用封面主色
    &:hover {
      color: var(--player-accent-color, #fff);
    }
  }
}

.main-area {
  flex: 1;
  display: flex;
  gap: 8%;
  height: 100%; /* Use absolute height */
  min-height: 0;
  overflow: hidden; /* Prevent scrolling */

  &::-webkit-scrollbar {
    display: none;
  }

  .left-panel {
    flex: 0.5;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding-left: 64px;
    margin-top: auto;
    margin-bottom: auto;

    @media (min-width: 1280px) {
      padding-left: 80px;
      flex: 0 0 35%;
    }

    @media (min-width: 1600px) {
      padding-left: 10vw;
      flex: 0 0 35%;
    }

    .cover-wrapper {
      height: 45vh;
      width: auto;
      max-width: 100%;
      aspect-ratio: 1 / 1;
      margin-bottom: 36px;
      flex-shrink: 0;
      .main-cover {
        width: 100%;
        height: 100%;
        border-radius: 24px;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
        object-fit: cover;
        transform: scale(0.95);
        transition:
          transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1),
          box-shadow 0.6s ease;

        &.is-playing {
          transform: scale(1.025);
          box-shadow: 0 30px 60px rgba(0, 0, 0, 0.315);
        }
      }
    }

    .info-wrapper {
      width: 100%;
      max-width: 400px;
      flex-shrink: 0;

      .song-title {
        font-size: 24px;
        font-weight: 800;
        margin-bottom: 12px;
        line-height: 1.2;
        color: var(--player-accent-color, #fff); // 歌曲标题使用封面主色
      }

      .tags-row {
        display: none;
        gap: 8px;
        margin-bottom: 16px;

        .tag-badge {
          font-size: 10px;
          padding: 2px 6px;
          border: 1px solid rgba(255, 255, 255, 0.4);
          border-radius: 4px;
          color: rgba(255, 255, 255, 0.8);
        }
      }

      .artist-row,
      .album-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 16px;
        color: var(--player-accent-color, rgba(255, 255, 255, 0.7)); // 歌曲信息文字使用封面主色
        margin-bottom: 2px;
      }
    }
  }

  .right-panel {
    flex: 1;
    display: flex;
    position: relative;
    min-height: 0; /* Ensure flex item can shrink */

    .lyrics-placeholder {
      flex: 1;
      width: 100%;
      height: 77vh;
      min-height: 0; /* Ensure flex item can shrink */
      overflow: hidden;

      &.fullscreen-lyrics.lyrics-auto-size {
        /* 全屏时自适应模式下限制歌词字号过大 */
        :deep(.am-lyric div[class*='lyricMainLine'] span) {
          font-size: clamp(22px, 2.6vh, 32px);
          line-height: 1.25;
        }

        :deep(.am-lyric div[class*='lyricSubLine'] span) {
          font-size: clamp(16px, 2vh, 22px);
        }
      }

      &.lyrics-manual-size {
        /* 手动控制歌词字号时使用设置中的大小 */
        :deep(.am-lyric div[class*='lyricMainLine'] span) {
          font-size: v-bind('lyricsMainFontSize');
          line-height: 1.25;
        }

        :deep(.am-lyric div[class*='lyricSubLine'] span) {
          font-size: v-bind('lyricsSubFontSize');
        }
      }
    }

    .side-tools {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      gap: 16px;

      .side-btn {
        color: rgba(255, 255, 255, 0.5);
        &:hover {
          color: #fff;
        }
      }
    }
  }
}

/* Song Switch Animation */
.song-switch-enter-active,
.song-switch-leave-active {
  transition: all 0.4s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.song-switch-enter-from,
.song-switch-leave-to {
  opacity: 0;
  transform: scale(0.9);
  filter: blur(20px);
}

@media (max-width: 1000px) {
  .main-area {
    flex-direction: column;
    align-items: center;
    gap: 24px;

    .left-panel {
      flex: 0 0 auto;
      align-items: center;
      padding-left: 0;
      text-align: center;

      .cover-wrapper {
        width: 240px;
        height: 240px;
        margin-bottom: 32px;
      }

      .info-wrapper {
        align-items: center;
        .tags-row,
        .artist-row,
        .album-row {
          justify-content: center;
        }
      }
    }

    .right-panel {
      display: none; /* Hide lyrics on small screens for now or make it swipeable */
    }
  }
}

.footer-area {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  transition:
    opacity 0.5s ease,
    transform 0.5s ease;

  &.hide-controls {
    opacity: 0;
    transform: translateY(20px);
    pointer-events: none;
  }

  .footer-left,
  .footer-right {
    flex: 0 0 200px;
    display: flex;
    gap: 6px;
    position: relative;
    top: -8px;
    align-items: center;

    .action-btn {
      color: var(--player-accent-color, rgba(255, 255, 255, 0.342)); // 页脚按钮使用封面主色
      &:hover {
        color: var(--player-accent-color, #fff);
        background: var(--player-accent-soft-bg, rgba(255, 255, 255, 0.1));
      }
      height: 40px;
      width: 40px;

      .n-icon {
        transform: translate(-5px, 0.5px);
      }
    }
  }

  .footer-right {
    justify-content: flex-end;

    .quality-tag {
      font-size: 10px;
      font-weight: bold;
      background: var(--player-accent-soft-bg, rgba(255, 255, 255, 0.2));
      padding: 2px 6px;
      border-radius: 4px;
      margin-right: 8px;
    }
  }

  .footer-center {
    flex: 1;
    max-width: 600px;
    display: flex;
    flex-direction: column;
    gap: 8px;

    .control-buttons {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 24px;
      position: relative;
      top: -6px;

      .control-btn {
        color: rgba(255, 255, 255, 0.8);
        &:hover {
          color: var(--player-accent-color, #fff);
        }
      }

      .n-button {
        color: var(--player-accent-color, #fff);
      }

      .play-pause-btn {
        cursor: pointer;
        transition: all 0.1s;
        &:active {
          transform: scale(0.95);
        }
        display: flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: var(--player-accent-soft-bg, rgba(255, 255, 255, 0.1));
        .n-icon {
          color: var(--player-accent-color, #fff);
        }
        &:hover {
          transform: scale(1.05);
          background: var(--player-accent-soft-bg, rgba(255, 255, 255, 0.1));
        }
      }
    }

    .progress-bar-row {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 65%;
      position: relative;
      left: 17%;
      top: -11px;

      .time-text {
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: rgba(255, 255, 255, 0.6);
        width: 36px;
        text-align: center;
      }

      .slider-container {
        flex: 1;

        :deep(.n-slider .n-slider-rail__fill) {
          height: 4px;
          background: var(--player-accent-color, #fff);
        }

        :deep(.n-slider .n-slider-rail) {
          height: 4px;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 2px;
        }
      }
    }
  }
}

/* Transition Animations */
.player-slide-enter-active,
.player-slide-leave-active {
  // 使用类似缓入缓出的曲线，起止更柔和
  transition: all 0.5s cubic-bezier(0.25, 0.1, 0.25, 1);

  .player-bg {
    transition: opacity 0.5s cubic-bezier(0.25, 0.1, 0.25, 1);
  }

  .player-content {
    transition:
      transform 0.5s cubic-bezier(0.25, 0.1, 0.25, 1),
      opacity 0.5s cubic-bezier(0.25, 0.1, 0.25, 1);
  }
}

.player-slide-enter-from,
.player-slide-leave-to {
  // 初始/结束时取消整体压暗与模糊，配合过渡实现平滑出现/消失
  background: rgba(0, 0, 0, 0);
  backdrop-filter: blur(0px);

  .player-bg {
    opacity: 0;
  }

  .player-content {
    transform: translateY(100%);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .player-slide-enter-active,
  .player-slide-leave-active {
    transition: none !important;
  }
}

@media (max-height: 800px) {
  .main-area {
    .left-panel {
      .cover-wrapper {
        margin-bottom: 32px;
      }
    }
  }
}

@media (max-height: 600px) {
  .main-area {
    .left-panel {
      .cover-wrapper {
        margin-bottom: 16px;
      }
      .info-wrapper {
        .song-title {
          font-size: 24px;
          margin-bottom: 8px;
        }
      }
    }
  }
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.comments-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.comments-title {
  font-size: 16px;
  font-weight: 600;
  margin-left: -6px;
}

.comments-meta {
  font-size: 12px;
  color: #999;
  display: flex;
  align-items: center;
  gap: 8px;
}

.comments-body {
  padding: 8px 0 12px;
}

.comment-list {
  padding: 8px 16px 16px;
}

.comment-item {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

.comment-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}

.comment-main {
  flex: 1;
}

.comment-header {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
}

.comment-author {
  font-weight: 500;
}

.comment-time {
  opacity: 0.8;
}

.comment-content {
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.9);
}

.comment-footer {
  margin-top: 4px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
}

.comment-like {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.comment-like-count {
  min-width: 16px;
}

.comments-load-more {
  display: flex;
  justify-content: center;
  padding: 8px 0 0;
}

.comments-error {
  padding: 16px;
  font-size: 13px;
  color: #f56c6c;
}
</style>
