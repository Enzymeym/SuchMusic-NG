<script setup lang="ts">
import { ref, watch, nextTick, computed, defineAsyncComponent } from 'vue'
import { useRouter } from 'vue-router'
import { usePlayerStore } from '../../stores/playerStore'
import { useLocalMusicStore } from '../../stores/localMusicStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { audioEngine } from '../../audio/audio-engine'
import SoundEffectsModal from '../common/SoundEffectsModal.vue'
import LyricSearchModal from '../common/LyricSearchModal.vue'
import defaultCover from '@renderer/assets/default-cover.png'
import {
  NIcon,
  NSlider,
  NButton,
  NDropdown,
  NPopover
} from 'naive-ui'
import LyricPlayer from '../common/PlayerLyrics/LyricPlayer.vue'
import ShinyText from '../common/ShinyText.vue'
const BackgroundRender = defineAsyncComponent(() => import('../common/AMLL/BackgroundRender.vue'))
import AudioVisualizer from '../common/AudioVisualizer.vue'
import AudioVisualizerControls from '../common/AudioVisualizerControls.vue'

// 导入拆分后的模块
import { usePlayerControls } from './PlayerPage/usePlayerControls'
import { usePlayerProgress } from './PlayerPage/usePlayerProgress'
import { usePlayerVolume } from './PlayerPage/usePlayerVolume'
import { usePlayerTheme } from './PlayerPage/usePlayerTheme'
import { usePlayerLyrics } from './PlayerPage/usePlayerLyrics'

// 初始化各模块
const player = usePlayerStore()
const localMusicStore = useLocalMusicStore()
const settingsStore = useSettingsStore()
const router = useRouter()

const {
  isControlsVisible,
  isFullscreen,
  // @ts-ignore: template ref
  playerPageRef,
  toggleFullscreen,
  togglePlay,
  handlePrev,
  handleNext,
  isFavorite,
  toggleFavorite,
  modeIcon,
  addToPlaylistDropdownOptions,
  handleAddToPlaylistSelect,
  handleTouchStart,
  handleTouchMove,
  handleTouchEnd,
  closePage
} = usePlayerControls()

const {
  progressPercent,
  displayTime,
  formatTime,
  handleProgressUpdate,
  startDrag,
  endDrag
} = usePlayerProgress()

const {
  showVolumePopover,
  volumePercent,
  volumeIcon,
  toggleVolumePopover
} = usePlayerVolume()

const {
  playerThemeColor,
  playerPageStyle
} = usePlayerTheme()

const {
  currentTime,
  lyricsData,
  hasLyrics,
  translatedLyricsData,
  lyricsMode,
  lyricsBaseFontSize,
  leftPanelFlex,
  rightPanelFlex,
  lyricsFontFamily,
  activePageIndex,
  handleMainScroll,
  scrollToPage,
  fetchingLyrics,
  markManualLyricsSelected
} = usePlayerLyrics()

// 向父组件发送事件（用于打开发送播放列表抽屉）
const emit = defineEmits<{
  (e: 'open-playlist'): void
}>()

/**
 * 交叉淡入淡出仅在智能过渡过程中使用，其他切歌场景使用默认缩放淡化
 */
const useCrossfadeTransition = computed(() => player.isTransitioning)

/**
 * 歌词模式状态：隐藏封面，歌曲信息移到歌词顶部居中，歌词居中显示
 */
const isLyricsMode = ref(false)

/**
 * 切换歌词模式
 */
const toggleLyricsMode = () => {
  isLyricsMode.value = !isLyricsMode.value
}

// 更多菜单显示状态（移动端和桌面端独立）
const showMobileMoreMenu = ref(false)
const showDesktopMoreMenu = ref(false)

// 音效调节弹窗
const showSoundEffectsModal = ref(false)

/** 可视化控制弹窗 */
const showVisualizerControls = ref(false)

/** 歌词搜索选择弹窗 */
const showLyricSearchModal = ref(false)

/**
 * 处理用户从搜索结果中选择歌词
 * @param result 歌词结果
 */
const handleLyricSelect = async (result: {
  lyrics: string
  translatedLyrics: string
  romanLyrics: string
  wySongId?: string
  coverUrl?: string
  applyCover?: boolean
  applySongInfo?: boolean
  source?: 'netease' | 'qq'
  mid?: string
  name?: string
  artists?: string
  album?: string
}): Promise<void> => {
  markManualLyricsSelected()
  if (result.lyrics) {
    player.setLyrics(result.lyrics)
  }
  if (result.translatedLyrics) {
    player.setTranslatedLyrics(result.translatedLyrics)
  }

  const filePath = player.currentSong?.filePath
  const songId = player.currentSong?.id

  // 更新播放器当前歌曲信息（内存中即时生效）
  if (result.applySongInfo && player.currentSong) {
    if (result.name) player.currentSong.title = result.name
    if (result.artists) player.currentSong.artist = result.artists
    if (result.album) player.currentSong.album = result.album
  }

  if (result.applyCover && result.coverUrl) {
    player.setCover(result.coverUrl)
  }

  // 同步更新本地音乐库中对应歌曲信息
  const localSong = localMusicStore.songs.find((s) => s.id === songId)
  if (localSong) {
    if (result.applySongInfo) {
      if (result.name) localSong.name = result.name
      if (result.artists) localSong.ar = result.artists.split(' / ').map((n) => ({ name: n.trim() }))
      if (result.album) {
        if (!localSong.al) {
          localSong.al = { name: result.album }
        } else {
          localSong.al.name = result.album
        }
      }
    }
    if (result.applyCover && result.coverUrl) {
      localSong.picUrl = result.coverUrl
      if (localSong.al) {
        localSong.al.picUrl = result.coverUrl
      }
    }
  }

  if (filePath) {
    if (result.applySongInfo) {
      try {
        await window.electron.ipcRenderer.invoke('local-music:write-song-info', filePath, {
          title: result.name,
          artist: result.artists,
          album: result.album,
          lyrics: result.lyrics,
          coverUrl: result.applyCover ? result.coverUrl : undefined
        })
      } catch (e) {
        console.warn('[PlayerPage] Failed to write song info to audio file:', e)
      }
    } else if (result.applyCover && result.coverUrl) {
      try {
        await window.electron.ipcRenderer.invoke(
          'local-music:write-cover',
          filePath,
          result.coverUrl
        )
      } catch (e) {
        console.warn('[PlayerPage] Failed to write cover to audio file:', e)
      }
    }
  }

  showLyricSearchModal.value = false
}

/**
 * 歌词偏移预设选项
 */
const lyricsOffsetOptions = computed(() => {
  const offsets = [-2.0, -1.0, -0.5, 0, 0.5, 1.0, 2.0]
  return offsets.map((offset) => ({
    label: offset === 0 ? '0s（默认）' : (offset > 0 ? `+${offset}s` : `${offset}s`),
    key: `lyrics-offset-${offset}`,
    offset
  }))
})

/**
 * 播放速度预设选项
 */
const playbackRateOptions = computed(() => {
  const rates = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
  return rates.map((rate) => ({
    label: rate === 1.0 ? `${rate}x（正常）` : `${rate}x`,
    key: `playback-rate-${rate}`,
    rate
  }))
})

/**
 * 更多菜单选项
 */
const moreMenuOptions = computed(() => [
  {
    label: '歌词偏移',
    key: 'lyrics-offset-header',
    children: lyricsOffsetOptions.value
  },
  {
    label: '播放速度',
    key: 'playback-rate-header',
    children: playbackRateOptions.value
  },
  {
    type: 'divider' as const,
    key: 'divider-1'
  },
  {
    label: '搜索同名歌曲',
    key: 'search-same-name',
    disabled: !player.currentSong?.title
  }
])

/**
 * 处理更多菜单选择
 * @param key 选项键值
 */
const handleMoreMenuSelect = (key: string) => {
  showMobileMoreMenu.value = false
  showDesktopMoreMenu.value = false

  if (key.startsWith('lyrics-offset-')) {
    const offset = parseFloat(key.replace('lyrics-offset-', ''))
    settingsStore.playback.lyricsOffset = offset
    return
  }

  if (key.startsWith('playback-rate-')) {
    const rate = parseFloat(key.replace('playback-rate-', ''))
    settingsStore.playback.playbackRate = rate
    audioEngine.setPlaybackRate(rate)
    return
  }

  if (key === 'search-same-name') {
    const title = player.currentSong?.title
    if (title) {
      router.push({ path: '/search', query: { q: title } })
    }
    return
  }
}

// 抽屉目标元素
const drawerTarget = ref('body')
watch(
  () => player.isPlayerPageShown,
  async (val) => {
    if (val) {
      await nextTick()
      setTimeout(() => {
        drawerTarget.value = '#player-page-container'
      }, 50)
    } else {
      drawerTarget.value = 'body'
    }
  },
  { immediate: true }
)
</script>

<template>
  <Teleport to="body">
    <Transition name="player-slide">
      <div
        v-if="player.isPlayerPageShown"
        id="player-page-container"
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

        <!-- 音频可视化层 -->
        <div
          v-if="settingsStore.playback.visualizerEnabled"
          class="visualizer-layer"
          :class="{ 'fade-out': isControlsVisible }"
        >
          <AudioVisualizer
            :size="settingsStore.playback.visualizerSize"
            :intensity="settingsStore.playback.visualizerIntensity"
          />
        </div>

        <!-- Content Layer -->
        <div class="player-content">
          <!-- Header -->
          <div class="page-header" :class="{ 'hide-controls': !isControlsVisible }">
            <div class="header-left">
              <n-button text class="header-btn" @click="toggleLyricsMode">
                <n-icon size="24">
                  <i :class="isLyricsMode ? 'mgc_text_line' : 'mgc_menu_line'"></i>
                </n-icon>
              </n-button>
            </div>
            <div class="header-right">
              <n-button text class="header-btn" @click="toggleFullscreen">
                <n-icon size="24">
                  <i
                    :class="isFullscreen ? 'mgc_fullscreen_exit_line' : 'mgc_fullscreen_2_line'"
                  ></i>
                </n-icon>
              </n-button>
              <n-button v-if="!isFullscreen" text class="header-btn" @click="closePage">
                <n-icon size="24"><i class="mgc_down_line"></i></n-icon>
              </n-button>
            </div>
          </div>

          <!-- Main Area (Split View) -->
          <div class="main-area-wrapper">
            <Transition
              :name="useCrossfadeTransition ? 'song-crossfade' : 'song-switch'"
              :mode="useCrossfadeTransition ? undefined : 'out-in'"
            >
              <div
                :key="player.currentSong?.id || 'empty'"
                class="main-area"
                :class="{ 'lyrics-mode': isLyricsMode, 'no-lyrics': !hasLyrics }"
                @scroll="handleMainScroll"
              >
              <!-- Left Panel: Cover & Info (隐藏于歌词模式下) -->
              <div v-if="!isLyricsMode" class="left-panel" :style="{ flex: leftPanelFlex }">
                <div class="cover-wrapper">
                  <img
                    :src="player.currentSong?.cover || defaultCover"
                    class="main-cover"
                    :class="{ 'is-playing': player.isPlaying }"
                  />
                  <!-- 智能过渡提示：嵌在封面左下角，带渐变黑色遮罩 -->
                  <Transition name="cover-overlay">
                    <div v-if="player.isTransitioning" class="cover-transition-overlay">
                      <ShinyText
                        text="正在智能过渡"
                        :speed="2.5"
                        color="rgba(255, 255, 255, 0.6)"
                        shine-color="#ffffff"
                      >
                        <template #prefix>
                          <i class="mgc_ease_in_out_control_point_line"></i>
                        </template>
                      </ShinyText>
                    </div>
                  </Transition>
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
              <div
                v-if="hasLyrics || isLyricsMode"
                class="right-panel"
                :class="{ 'lyrics-mode': isLyricsMode }"
                :style="{ flex: rightPanelFlex }"
              >
                <!-- 歌词模式下的歌曲信息（顶部居中） -->
                <div v-if="isLyricsMode" class="lyrics-mode-info">
                  <div class="song-title">{{ player.currentSong?.title || '未选择歌曲' }}</div>
                  <div class="artist-row">
                    <span>{{ player.currentSong?.artist || '未知歌手' }}</span>
                  </div>
                  <div v-if="player.currentSong?.album" class="album-row">
                    <span>{{ player.currentSong?.album }}</span>
                  </div>
                </div>

                <div
                  v-if="hasLyrics"
                  class="lyrics-placeholder"
                  :class="[
                    { 'fullscreen-lyrics': isFullscreen },
                    settingsStore.playback.lyricsAutoSize
                      ? 'lyrics-auto-size'
                      : 'lyrics-manual-size'
                  ]"
                  :style="{ fontFamily: lyricsFontFamily }"
                >
                  <LyricPlayer
                    :lyrics="lyricsData"
                    :translated-lyrics="translatedLyricsData"
                    :current-time="currentTime"
                    :mode="lyricsMode"
                    :font-size="lyricsBaseFontSize"
                    :active-line-color="playerThemeColor"
                    :loading="fetchingLyrics"
                  />
                </div>

                <!-- Side Tools (Right Edge) -->
                <div v-if="hasLyrics && player.currentSong?.id" class="side-tools">
                  <n-button
                    text
                    class="side-btn"
                    :focusable="false"
                    @click="showLyricSearchModal = true"
                  >
                    <n-icon size="22"><i class="mgc_search_2_line"></i></n-icon>
                  </n-button>
                </div>
              </div>
            </div>
          </Transition>
          </div>

          <!-- Mobile Swipe Indicator（歌词模式或无歌词时隐藏） -->
          <div v-if="!isLyricsMode && hasLyrics" class="mobile-indicator">
            <div
              class="dot"
              :class="{ active: activePageIndex === 0 }"
              @click="scrollToPage(0)"
            ></div>
            <div
              class="dot"
              :class="{ active: activePageIndex === 1 }"
              @click="scrollToPage(1)"
            ></div>
          </div>

          <!-- Footer Control Area -->
          <div class="footer-area" :class="{ 'hide-controls': !isControlsVisible }">
            <!-- Top Actions (Mobile Only) -->
            <div class="mobile-top-actions">
              <n-button text circle @click="toggleFavorite" class="mobile-action-btn">
                <n-icon size="24" :color="isFavorite ? '#ef5350' : undefined">
                  <i :class="isFavorite ? 'mgc_heart_fill' : 'mgc_heart_line'"></i>
                </n-icon>
              </n-button>
              <n-dropdown
                trigger="click"
                :options="addToPlaylistDropdownOptions"
                @select="handleAddToPlaylistSelect"
                :to="drawerTarget"
              >
                <n-button text circle class="mobile-action-btn">
                  <n-icon size="24"><i class="mgc_add_circle_line"></i></n-icon>
                </n-button>
              </n-dropdown>
              <n-dropdown
                trigger="click"
                :options="moreMenuOptions"
                :show="showMobileMoreMenu"
                :to="drawerTarget"
                @select="handleMoreMenuSelect"
                @update:show="(val: boolean) => showMobileMoreMenu = val"
              >
                <n-button text circle class="mobile-action-btn">
                  <n-icon size="24"><i class="mgc_more_2_line"></i></n-icon>
                </n-button>
              </n-dropdown>
            </div>

            <!-- Left Actions (Desktop) -->
            <div class="footer-left desktop-only">
              <n-button v-if="!isFullscreen" quaternary class="action-btn" @click="closePage">
                <n-icon size="24" style="transform: translateX(-5px) translateY(1px)"
                  ><i class="mgc_down_line"></i
                ></n-icon>
              </n-button>
              <n-dropdown
                trigger="click"
                :options="addToPlaylistDropdownOptions"
                @select="handleAddToPlaylistSelect"
                :to="drawerTarget"
              >
                <n-button quaternary class="action-btn">
                  <n-icon size="24" style="transform: translateX(-5px) translateY(0.5px)"
                    ><i class="mgc_add_circle_line"></i
                  ></n-icon>
                </n-button>
              </n-dropdown>
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
                <n-button text circle @click="toggleFavorite" class="desktop-favorite-btn">
                  <n-icon size="20" :color="isFavorite ? '#ef5350' : undefined">
                    <i :class="isFavorite ? 'mgc_heart_fill' : 'mgc_heart_line'"></i>
                  </n-icon>
                </n-button>
                <n-button
                  text
                  circle
                  @click="emit('open-playlist')"
                  class="mobile-playlist-btn"
                  style="display: none"
                >
                  <n-icon size="20"><i class="mgc_playlist_line"></i></n-icon>
                </n-button>
              </div>

              <div class="progress-bar-row">
                <span class="time-text">{{ displayTime }}</span>
                <div class="slider-container">
                  <n-slider
                    :value="progressPercent"
                    :tooltip="false"
                    @update:value="handleProgressUpdate"
                    @dragstart="startDrag"
                    @dragend="endDrag"
                  />
                </div>
                <span class="time-text">{{
                  formatTime((player.currentSong?.durationMs || 0) / 1000)
                }}</span>
              </div>
            </div>

            <!-- Right Actions -->
            <div class="footer-right desktop-only">
              <!-- 音频可视化控制入口 -->
              <n-popover
                v-model:show="showVisualizerControls"
                trigger="click"
                :show-arrow="false"
                placement="top"
                :to="drawerTarget"
              >
                <template #trigger>
                  <n-button quaternary class="action-btn" @click="showVisualizerControls = !showVisualizerControls">
                    <n-icon size="22"><i class="mgc_equalizer_line"></i></n-icon>
                  </n-button>
                </template>
                <AudioVisualizerControls />
              </n-popover>
              <n-button quaternary class="action-btn" @click="showSoundEffectsModal = true">
                <n-icon size="22"><i class="mgc_settings_2_line"></i></n-icon>
              </n-button>
              <n-dropdown
                trigger="click"
                :options="moreMenuOptions"
                :show="showDesktopMoreMenu"
                :to="drawerTarget"
                @select="handleMoreMenuSelect"
                @update:show="(val: boolean) => showDesktopMoreMenu = val"
              >
                <n-button quaternary class="action-btn">
                  <n-icon size="22"><i class="mgc_more_2_line"></i></n-icon>
                </n-button>
              </n-dropdown>
              <div class="volume-control">
                <n-popover v-model:show="showVolumePopover" trigger="manual" :show-arrow="false" overlay-class="player-page-volume-popover" :placement="'top'" :to="drawerTarget">
                  <template #trigger>
                    <n-button style="width: 40px; height: 40px" quaternary class="action-btn" @click="toggleVolumePopover">
                      <n-icon size="22"><i :class="volumeIcon"></i></n-icon
                    ></n-button>
                  </template>
                  <div class="volume-slider-container">
                    <div class="volume-value">{{ volumePercent }}%</div>
                    <n-slider
                      v-model:value="volumePercent"
                      :vertical="true"
                      :min="0"
                      :max="100"
                      :tooltip="false"
                      class="volume-slider"
                      style="width: 4px; height: 100px; min-height: 100px; flex-shrink: 0;"
                    />
                  </div>
                </n-popover>
              </div>
              <n-button quaternary class="action-btn" @click="emit('open-playlist')">
                <n-icon size="22"><i class="mgc_playlist_line"></i></n-icon>
              </n-button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 音效调节弹窗 -->
  <SoundEffectsModal v-model:show="showSoundEffectsModal" />

  <!-- 歌词搜索选择弹窗 -->
  <LyricSearchModal
    v-model:show="showLyricSearchModal"
    :title="player.currentSong?.title || ''"
    :artist="player.currentSong?.artist || ''"
    :current-cover="player.currentSong?.cover"
    @select="handleLyricSelect"
  />
</template>

<style scoped lang="scss">
@use './PlayerPage/PlayerPage.scss';
</style>

