<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NProgress, useMessage } from 'naive-ui'
import { useUpdater } from '../../composables/useUpdater'
import { useSettingsStore } from '../../stores/settingsStore'

const message = useMessage()
const settingsStore = useSettingsStore()

const {
  updateInfo,
  downloadProgress,
  error,
  isChecking,
  isUpdateAvailable,
  isDownloading,
  isDownloaded,
  hasError,
  checkUpdate,
  downloadUpdate,
  installUpdate,
  dismissUpdate,
  formatBytes,
  formatSpeed
} = useUpdater()

/**
 * 是否显示通知条
 */
const showNotification = computed(() => {
  return isUpdateAvailable.value || isDownloading.value || isDownloaded.value || hasError.value
})

/**
 * 通知条类型样式
 */
const notificationType = computed(() => {
  if (hasError.value) return 'error'
  if (isDownloaded.value) return 'success'
  if (isDownloading.value) return 'info'
  return 'warning'
})

/**
 * 通知条背景色
 */
const bgColor = computed(() => {
  switch (notificationType.value) {
    case 'error':
      return 'rgba(208, 48, 80, 0.1)'
    case 'success':
      return 'rgba(24, 160, 88, 0.1)'
    case 'info':
      return 'rgba(32, 128, 240, 0.1)'
    default:
      return 'rgba(240, 160, 32, 0.1)'
  }
})

/**
 * 通知条边框色
 */
const borderColor = computed(() => {
  switch (notificationType.value) {
    case 'error':
      return 'rgba(208, 48, 80, 0.3)'
    case 'success':
      return 'rgba(24, 160, 88, 0.3)'
    case 'info':
      return 'rgba(32, 128, 240, 0.3)'
    default:
      return 'rgba(240, 160, 32, 0.3)'
  }
})

/**
 * 处理检查更新
 */
const handleCheck = async () => {
  const result = await checkUpdate(settingsStore.general.updateChannel)
  if (result?.hasUpdate) {
    message.info(`发现新版本: v${result.latestVersion}`)
  } else if (result && !result.hasUpdate) {
    message.success('当前已是最新版本')
  }
}

/**
 * 处理下载更新
 */
const handleDownload = async () => {
  const success = await downloadUpdate()
  if (success) {
    message.success('下载完成，点击安装以应用更新')
  }
}

/**
 * 处理安装更新
 */
const handleInstall = async () => {
  await installUpdate()
}

/**
 * 处理忽略更新
 */
const handleDismiss = () => {
  dismissUpdate()
}

/**
 * 格式化版本号显示
 */
const versionText = computed(() => {
  if (!updateInfo.value) return ''
  return `v${updateInfo.value.currentVersion} → v${updateInfo.value.latestVersion}`
})

/**
 * 获取状态文本
 */
const statusText = computed(() => {
  if (isChecking.value) return '正在检查更新...'
  if (isDownloading.value) return `正在下载更新... ${downloadProgress.value.percent}%`
  if (isDownloaded.value) return '下载完成，准备安装'
  if (hasError.value) return error.value || '更新出错'
  if (isUpdateAvailable.value) return `发现新版本 ${versionText.value}`
  return ''
})
</script>

<template>
  <transition name="update-notification">
    <div
      v-if="showNotification"
      class="update-notification"
      :style="{
        backgroundColor: bgColor,
        borderColor: borderColor
      }"
    >
      <div class="update-notification__content">
        <div class="update-notification__icon">
          <i v-if="isChecking" class="mgc_loading_line update-notification__spin" />
          <i v-else-if="hasError" class="mgc_close_circle_line" />
          <i v-else-if="isDownloaded" class="mgc_check_circle_line" />
          <i v-else-if="isDownloading" class="mgc_download_3_line" />
          <i v-else class="mgc_alert_line" />
        </div>

        <div class="update-notification__info">
          <div class="update-notification__text">{{ statusText }}</div>
          <div v-if="isDownloading && downloadProgress.total > 0" class="update-notification__progress">
            <n-progress
              type="line"
              :percentage="downloadProgress.percent"
              :show-indicator="false"
              :height="4"
              :border-radius="2"
            />
            <div class="update-notification__progress-detail">
              {{ formatBytes(downloadProgress.downloaded) }} / {{ formatBytes(downloadProgress.total) }}
              <span v-if="downloadProgress.speed > 0">({{ formatSpeed(downloadProgress.speed) }})</span>
            </div>
          </div>
        </div>
      </div>

      <div class="update-notification__actions">
        <template v-if="isUpdateAvailable && !isDownloading && !isDownloaded">
          <n-button size="small" type="primary" @click="handleDownload">
            立即下载
          </n-button>
          <n-button size="small" text @click="handleDismiss">
            稍后提醒
          </n-button>
        </template>

        <template v-else-if="isDownloaded">
          <n-button size="small" type="success" @click="handleInstall">
            立即安装
          </n-button>
          <n-button size="small" text @click="handleDismiss">
            稍后安装
          </n-button>
        </template>

        <template v-else-if="hasError">
          <n-button size="small" @click="handleCheck">
            重试
          </n-button>
          <n-button size="small" text @click="handleDismiss">
            关闭
          </n-button>
        </template>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.update-notification {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  border-bottom: 1px solid;
  backdrop-filter: blur(10px);
  transition: all 0.3s ease;
}

.update-notification__content {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.update-notification__icon {
  font-size: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.update-notification__spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.update-notification__info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.update-notification__text {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.update-notification__progress {
  width: 200px;
}

.update-notification__progress-detail {
  font-size: 11px;
  opacity: 0.7;
  margin-top: 2px;
}

.update-notification__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: 16px;
}

/* 过渡动画 */
.update-notification-enter-active,
.update-notification-leave-active {
  transition: all 0.3s ease;
}

.update-notification-enter-from,
.update-notification-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
</style>
