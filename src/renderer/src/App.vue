<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, computed, watch, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import {
  NConfigProvider,
  NGlobalStyle,
  NNotificationProvider,
  NMessageProvider,
  NDialogProvider
} from 'naive-ui'
import 'mingcute_icon/font/Mingcute.css'
import { themeOverridesRef, setPrimaryColor } from './themes'
import { useSettingsStore } from './stores/settingsStore'
import { usePlayerStore } from './stores/playerStore'
import { usePlaylistStore } from './stores/playlistStore'
import { useLocalMusicStore } from './stores/localMusicStore'
import { useAutoNaiveTheme } from './themes/autoNaiveTheme'
import PluginUpdateNotifier from './components/common/PluginUpdateNotifier.vue'
import SetupWizard from './components/common/SetupWizard.vue'
import SplashScreen from './components/common/SplashScreen.vue'
import { useSetupWizardStore } from './stores/setupWizardStore'
import { audioEngine } from './audio/audio-engine'
import { getTransitionController } from './audio/transition-controller'
import { debounce } from './utils/performance'

const UpdateNotification = defineAsyncComponent(
  () => import('./components/common/UpdateNotification.vue')
)

// 初始化主题主色为默认值，后续由设置中的主题色控制
setPrimaryColor('#2C8EFD')

// 从设置中读取用户配置的主题色并应用
const settingsStore = useSettingsStore()
const setupWizardStore = useSetupWizardStore()
if (!settingsStore.appearance.themeColorFollowsCover && settingsStore.appearance.customThemeColor) {
  setPrimaryColor(settingsStore.appearance.customThemeColor)
}

const { theme } = useAutoNaiveTheme()

const route = useRoute()
const isDesktopLyric = computed(() => route.name === 'desktop-lyric')

const playerStore = usePlayerStore()
const playlistStore = usePlaylistStore()
const localMusicStore = useLocalMusicStore()

// 初始化时恢复播放器状态
playerStore.loadPlayerState()

// 初始化时加载歌单数据（确保右键菜单在任何页面都可用）
playlistStore.loadFromStorage()

// 启动时自动扫描本地音乐，确保专辑/歌手页面数据完整
localMusicStore.scanMusic().catch(() => { /* 静默失败，用户可手动扫描 */ })

// 开屏动画状态控制
const appReady = ref(false)
const splashHidden = ref(false)

function handleSplashFadeOutComplete() {
  splashHidden.value = true
}

// 监听关键状态变化并保存，使用统一的防抖工具函数

// 使用防抖函数优化保存操作，避免频繁触发
const debouncedSavePlayerState = debounce(() => {
  playerStore.savePlayerState()
}, 1000) // 1秒防抖

// 监听关键状态变化并保存
watch(
  () => [
    playerStore.currentSong?.id,
    playerStore.playMode,
    playerStore.volume,
    playerStore.playlist.length // 仅监听长度变化，避免频繁触发
  ],
  () => {
    debouncedSavePlayerState()
  }
)

// 定期保存播放进度（每 5 秒一次），并在暂停/停止时立即保存
let saveInterval: ReturnType<typeof setInterval> | null = null
watch(
  () => playerStore.isPlaying,
  (playing) => {
    if (playing) {
      // 开始播放，启动定时保存
      if (saveInterval) clearInterval(saveInterval)
      saveInterval = setInterval(() => {
        playerStore.savePlayerState()
      }, 5000)
    } else {
      // 停止播放，清除定时器并立即保存一次
      if (saveInterval) {
        clearInterval(saveInterval)
        saveInterval = null
      }
      playerStore.savePlayerState()
    }
  },
  { immediate: true }
)

// 重启设置向导
function handleRestartSetupWizard() {
  setupWizardStore.reset()
  setTimeout(() => {
    setupWizardStore.start()
  }, 100)
}

// 在组件卸载时清除定时器和事件监听器
onUnmounted(() => {
  if (saveInterval) {
    clearInterval(saveInterval)
    saveInterval = null
  }

  // 确保设置已保存
  settingsStore.saveSettings()

  // 清除事件监听器
  if (!isDesktopLyric.value) {
    window.electron.ipcRenderer.removeAllListeners('player:control')
    window.electron.ipcRenderer.removeAllListeners('plugin:hot-updated')
  }
  window.removeEventListener('setup-wizard:restart', handleRestartSetupWizard)
})

onMounted(() => {
  if (!isDesktopLyric.value) {
    window.electron.ipcRenderer.on('player:control', (_, action: string) => {
      switch (action) {
        case 'play':
          if (!playerStore.isPlaying) {
            if (playerStore.currentSong) {
              audioEngine.play().then((success) => {
                if (success) playerStore.setPlaying(true)
              })
            }
          }
          break
        case 'pause':
          if (playerStore.isPlaying) {
            audioEngine.pause().then(() => {
              playerStore.setPlaying(false)
            })
          }
          break
        case 'toggle':
          if (playerStore.isPlaying) {
            audioEngine.pause().then(() => {
              playerStore.setPlaying(false)
            })
          } else if (playerStore.currentSong) {
            audioEngine.play().then((success) => {
              if (success) playerStore.setPlaying(true)
            })
          }
          break
        case 'next':
          // 中断智能过渡流程，走现有快速切换路径（与 PlayerBar.handleNext 对齐）
          getTransitionController().abort()
          playerStore.setTransitioning(false)
          playerStore.playNext()
          break
        case 'prev':
          // 中断智能过渡流程，走现有快速切换路径（与 PlayerBar.handlePrev 对齐）
          getTransitionController().abort()
          playerStore.setTransitioning(false)
          playerStore.playPrev()
          break
        case 'toggle-lock':
          settingsStore.playback.desktopLyricsLocked = !settingsStore.playback.desktopLyricsLocked
          break
      }
    })

    // 首次使用引导流程：仅显示设置向导
    // 使用 requestAnimationFrame 确保 DOM 完全渲染后再开始
    const startSetupWizard = () => {
      if (!setupWizardStore.isCompleted) {
        setupWizardStore.start()
      }
    }

    // 等待两帧确保 DOM 渲染完成，然后标记应用就绪
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        startSetupWizard()
        // 应用就绪后触发开屏淡出
        nextTick(() => {
          appReady.value = true
        })
      })
    })
  } else {
    // 桌面歌词窗口不需要开屏
    appReady.value = true
  }

  // 监听全局事件：允许从设置等位置重新启动设置向导
  window.addEventListener('setup-wizard:restart', handleRestartSetupWizard)
})


</script>

<template>
  <template v-if="!isDesktopLyric">
    <SplashScreen :visible="!appReady" @fade-out-complete="handleSplashFadeOutComplete" />
  </template>

  <n-config-provider :theme="isDesktopLyric ? null : theme" :theme-overrides="themeOverridesRef">
    <n-global-style v-if="!isDesktopLyric" />
    <n-notification-provider>
      <n-message-provider>
        <n-dialog-provider>
          <update-notification />
          <PluginUpdateNotifier />
          <SetupWizard />
          <router-view v-show="splashHidden || isDesktopLyric" />
        </n-dialog-provider>
      </n-message-provider>
    </n-notification-provider>
  </n-config-provider>
</template>
