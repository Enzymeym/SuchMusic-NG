<script setup lang="ts">
import { onMounted, onUnmounted, computed, watch, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import {
  NConfigProvider,
  NGlobalStyle,
  NNotificationProvider,
  NMessageProvider,
  NDialogProvider
} from 'naive-ui'
import 'mingcute_icon/font/Mingcute.css'
// 引入 highlight.js 提供代码高亮能力
import hljs from 'highlight.js'
import { themeOverridesRef, setPrimaryColor } from './themes'
import { useSettingsStore } from './stores/settingsStore'
import { usePlayerStore } from './stores/playerStore'
import { useAutoNaiveTheme } from './themes/autoNaiveTheme'
import PluginUpdateNotifier from './components/common/PluginUpdateNotifier.vue'
import OnboardingOverlay from './components/common/OnboardingOverlay.vue'
import SetupWizard from './components/common/SetupWizard.vue'
import { useOnboardingStore } from './stores/onboardingStore'
import { useSetupWizardStore } from './stores/setupWizardStore'

const UpdateNotification = defineAsyncComponent(
  () => import('./components/common/UpdateNotification.vue')
)

// 初始化主题主色为默认值，后续由设置中的主题色控制
setPrimaryColor('#2C8EFD')

// 从设置中读取用户配置的主题色并应用
const settingsStore = useSettingsStore()
const onboardingStore = useOnboardingStore()
const setupWizardStore = useSetupWizardStore()
if (!settingsStore.appearance.themeColorFollowsCover && settingsStore.appearance.customThemeColor) {
  setPrimaryColor(settingsStore.appearance.customThemeColor)
}

const { theme } = useAutoNaiveTheme()

const route = useRoute()
const isDesktopLyric = computed(() => route.name === 'desktop-lyric')

const playerStore = usePlayerStore()

// 初始化时恢复播放器状态
playerStore.loadPlayerState()

// 监听关键状态变化并保存，使用自定义防抖函数

// 自定义防抖函数
function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null
  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      func(...args)
    }, wait)
  }
}

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
})

onMounted(() => {
  if (!isDesktopLyric.value) {
    window.electron.ipcRenderer.on('player:control', (_, action: string) => {
      switch (action) {
        case 'play':
          if (!playerStore.isPlaying) {
            import('./audio/audio-engine').then(async ({ webAudioEngine }) => {
              if (playerStore.currentSong) {
                await webAudioEngine.play()
                playerStore.setPlaying(true)
              }
            })
          }
          break
        case 'pause':
          if (playerStore.isPlaying) {
            import('./audio/audio-engine').then(async ({ webAudioEngine }) => {
              await webAudioEngine.pause()
              playerStore.setPlaying(false)
            })
          }
          break
        case 'toggle':
          import('./audio/audio-engine').then(async ({ webAudioEngine }) => {
            if (playerStore.isPlaying) {
              await webAudioEngine.pause()
              playerStore.setPlaying(false)
            } else if (playerStore.currentSong) {
              await webAudioEngine.play()
              playerStore.setPlaying(true)
            }
          })
          break
        case 'next':
          playerStore.playNext()
          break
        case 'prev':
          playerStore.playPrev()
          break
        case 'toggle-lock':
          settingsStore.playback.desktopLyricsLocked = !settingsStore.playback.desktopLyricsLocked
          break
      }
    })

    // 首次使用引导流程：设置向导 > 功能引导
    // 延迟确保 DOM 完全渲染后再开始
    setTimeout(() => {
      if (!setupWizardStore.isCompleted) {
        // 未完成设置向导 → 先显示设置向导
        setupWizardStore.start()
        // 监听设置向导完成后，自动启动功能引导
        const stopWatch = watch(
          () => setupWizardStore.isActive,
          (active) => {
            if (!active && setupWizardStore.isCompleted && !onboardingStore.isCompleted) {
              // 设置向导已完成，延迟启动功能引导
              setTimeout(() => {
                onboardingStore.start()
              }, 400)
              stopWatch()
            }
          }
        )
      } else if (!onboardingStore.isCompleted) {
        // 设置向导已完成，但功能引导未完成 → 直接启动功能引导
        onboardingStore.start()
      }
    }, 500)
  }

  // 监听全局事件：允许从设置等位置重新启动引导
  window.addEventListener('onboarding:restart', () => {
    onboardingStore.restart()
  })
})


</script>

<template>
  <n-config-provider
    :theme="isDesktopLyric ? null : theme"
    :theme-overrides="themeOverridesRef"
    :hljs="hljs"
  >
    <n-global-style v-if="!isDesktopLyric" />
    <n-notification-provider>
      <n-message-provider>
      <n-dialog-provider>
        <update-notification />
        <PluginUpdateNotifier />
        <SetupWizard />
        <OnboardingOverlay />
        <router-view />
      </n-dialog-provider>
    </n-message-provider>
  </n-notification-provider>
  </n-config-provider>
</template>

