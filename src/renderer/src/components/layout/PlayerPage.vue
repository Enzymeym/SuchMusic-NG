<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { usePlayerStore } from '../../stores/playerStore'
import { useSettingsStore } from '../../stores/settingsStore'
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
  NPopover
} from 'naive-ui'
import LyricPlayer from '../common/PlayerLyrics/LyricPlayer.vue'
import BackgroundRender from '../common/AMLL/BackgroundRender.vue'

// 导入拆分后的模块
import { usePlayerControls } from './PlayerPage/usePlayerControls'
import { usePlayerProgress } from './PlayerPage/usePlayerProgress'
import { usePlayerVolume } from './PlayerPage/usePlayerVolume'
import { usePlayerTheme } from './PlayerPage/usePlayerTheme'
import { usePlayerComments } from './PlayerPage/usePlayerComments'
import { usePlayerLyrics } from './PlayerPage/usePlayerLyrics'

// 初始化各模块
const player = usePlayerStore()
const settingsStore = useSettingsStore()

const {
  isControlsVisible,
  isFullscreen,
  playerPageRef,
  showControls,
  handleActivity,
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
  closePage,
  downloadMusic
} = usePlayerControls()

const {
  isDraggingProgress,
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
  toggleMute,
  toggleVolumePopover
} = usePlayerVolume()

const {
  playerThemeColor,
  playerPageStyle
} = usePlayerTheme()

const {
  isNeteaseSong,
  showCommentsDrawer,
  comments,
  commentsTotal,
  commentsHasMore,
  commentsLoading,
  commentsError,
  formatCommentTime,
  handleLoadMoreComments,
  openComments
} = usePlayerComments()

const {
  currentTime,
  lyricsData,
  translatedLyricsData,
  lyricsMode,
  lyricsBaseFontSize,
  lyricsAreaRatio,
  leftPanelFlex,
  rightPanelFlex,
  lyricsMainFontSize,
  lyricsSubFontSize,
  activePageIndex,
  handleMainScroll,
  scrollToPage
} = usePlayerLyrics()

// 向父组件发送事件（用于打开发送播放列表抽屉）
const emit = defineEmits<{
  (e: 'open-playlist'): void
}>()

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
          <Transition name="song-switch" mode="out-in">
            <div
              :key="player.currentSong?.id || 'empty'"
              class="main-area"
              @scroll="handleMainScroll"
            >
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
                    settingsStore.playback.lyricsAutoSize
                      ? 'lyrics-auto-size'
                      : 'lyrics-manual-size'
                  ]"
                >
                  <LyricPlayer
                    :lyrics="lyricsData"
                    :translated-lyrics="translatedLyricsData"
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

          <!-- Mobile Swipe Indicator -->
          <div class="mobile-indicator">
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
              <n-button
                text
                circle
                @click="player.currentSong && downloadMusic(player.currentSong)"
                class="mobile-action-btn"
              >
                <n-icon size="24"><i class="mgc_download_line"></i></n-icon>
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
              <n-button
                text
                circle
                :disabled="!isNeteaseSong"
                @click="openComments"
                class="mobile-action-btn"
              >
                <n-icon size="24"><i class="mgc_comment_line"></i></n-icon>
              </n-button>
            </div>

            <!-- Left Actions (Desktop) -->
            <div class="footer-left desktop-only">
              <n-button v-if="!isFullscreen" quaternary class="action-btn" @click="closePage">
                <n-icon size="24" style="transform: translateX(-5px) translateY(1px)"
                  ><i class="mgc_down_line"></i
                ></n-icon>
              </n-button>
              <n-button
                quaternary
                class="action-btn"
                @click="player.currentSong && downloadMusic(player.currentSong)"
              >
                <n-icon size="24" style="transform: translateX(-5px) translateY(1px)"
                  ><i class="mgc_download_line"></i
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
            <div class="footer-right desktop-only">
              <n-button quaternary class="action-btn">
                <n-icon size="22"><i class="mgc_settings_2_line"></i></n-icon>
              </n-button>
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

  <!-- 网易云评论抽屉 -->
  <n-drawer
    v-model:show="showCommentsDrawer"
    :width="420"
    placement="right"
    :trap-focus="false"
    :block-scroll="false"
    :to="drawerTarget"
    :z-index="10000"
  >
    <n-drawer-content :native-scrollbar="false" body-content-style="padding: 0;">
      <template #header>
        <div class="comments-header">
          <div class="comments-title">评论</div>
          <div class="comments-meta">
            <span v-if="commentsTotal > 0" class="comments-count"> 共 {{ commentsTotal }} 条 </span>
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
              style="margin-top: 40px"
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
@import './PlayerPage/PlayerPage.scss';
</style>


