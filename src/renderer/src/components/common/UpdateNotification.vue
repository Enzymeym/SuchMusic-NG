<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NModal, NProgress, useMessage, useThemeVars } from 'naive-ui'
import { useUpdater } from '../../composables/useUpdater'
import { useSettingsStore } from '../../stores/settingsStore'

const message = useMessage()
const settingsStore = useSettingsStore()
// 弹窗 teleport 到 body 后无法继承 n-config-provider 的 CSS 变量，
// 需通过 useThemeVars 取实际颜色值内联，确保图标/分隔线颜色正常
const themeVars = useThemeVars()

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
 * 弹窗显示状态：仅在「发现更新 / 下载中 / 下载完成 / 出错」时弹出，
 * 启动自动检查未发现更新时保持静默
 */
const showDialog = ref(false)

watch(
  [isUpdateAvailable, isDownloading, isDownloaded, hasError],
  () => {
    showDialog.value =
      isUpdateAvailable.value || isDownloading.value || isDownloaded.value || hasError.value
  },
  { immediate: true }
)

/**
 * 弹窗标题
 */
const dialogTitle = computed(() => {
  if (hasError.value) return '更新出错'
  if (isDownloading.value) return '正在下载更新'
  if (isDownloaded.value) return '更新下载完成'
  return '发现新版本'
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
 * 处理忽略/关闭更新
 */
const handleDismiss = () => {
  dismissUpdate()
  showDialog.value = false
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
  <n-modal
    v-model:show="showDialog"
    preset="card"
    :title="dialogTitle"
    :bordered="false"
    style="width: 440px"
    :mask-closable="!isDownloading"
  >
    <div class="update-dialog__content">
      <div class="update-dialog__status">
        <i
          v-if="isChecking"
          class="mgc_loading_line update-dialog__spin"
          :style="{ color: themeVars.primaryColor }"
        />
        <i
          v-else-if="hasError"
          class="mgc_close_circle_line"
          :style="{ color: themeVars.errorColor }"
        />
        <i
          v-else-if="isDownloaded"
          class="mgc_check_circle_line"
          :style="{ color: themeVars.successColor }"
        />
        <i
          v-else-if="isDownloading"
          class="mgc_download_3_line"
          :style="{ color: themeVars.primaryColor }"
        />
        <i v-else class="mgc_alert_line" :style="{ color: themeVars.warningColor }" />
        <span class="update-dialog__status-text">{{ statusText }}</span>
      </div>

      <div
        v-if="isDownloading && downloadProgress.total > 0"
        class="update-dialog__progress"
      >
        <n-progress
          type="line"
          :percentage="downloadProgress.percent"
          :show-indicator="false"
          :height="4"
          :border-radius="2"
        />
        <div class="update-dialog__progress-detail">
          {{ formatBytes(downloadProgress.downloaded) }} / {{ formatBytes(downloadProgress.total) }}
          <span v-if="downloadProgress.speed > 0">（{{ formatSpeed(downloadProgress.speed) }}）</span>
        </div>
      </div>

      <div
        v-if="isUpdateAvailable && updateInfo?.releaseNotes"
        class="update-dialog__notes"
        :style="{ borderTopColor: themeVars.dividerColor }"
      >
        <div class="update-dialog__notes-title">更新内容</div>
        <pre class="update-dialog__notes-body">{{ updateInfo.releaseNotes }}</pre>
      </div>
    </div>

    <template #footer>
      <div class="update-dialog__actions">
        <template v-if="isUpdateAvailable && !isDownloading && !isDownloaded">
          <n-button type="primary" @click="handleDownload">立即下载</n-button>
          <n-button text @click="handleDismiss">稍后提醒</n-button>
        </template>

        <template v-else-if="isDownloaded">
          <n-button type="primary" @click="handleInstall">立即安装</n-button>
          <n-button text @click="handleDismiss">稍后安装</n-button>
        </template>

        <template v-else-if="isDownloading">
          <n-button text @click="handleDismiss">后台下载</n-button>
        </template>

        <template v-else-if="hasError">
          <n-button @click="handleCheck">重试</n-button>
          <n-button text @click="handleDismiss">关闭</n-button>
        </template>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.update-dialog__content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.update-dialog__status {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
}

.update-dialog__status i {
  font-size: 22px;
  flex-shrink: 0;
}

.update-dialog__status-text {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.update-dialog__spin {
  animation: update-spin 1s linear infinite;
}

@keyframes update-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.update-dialog__progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.update-dialog__progress-detail {
  font-size: 12px;
  opacity: 0.75;
}

.update-dialog__notes {
  border-top: 1px solid var(--n-divider-color);
  padding-top: 12px;
}

.update-dialog__notes-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.update-dialog__notes-body {
  max-height: 180px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.85;
  margin: 0;
  font-family: inherit;
}

.update-dialog__actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
</style>
