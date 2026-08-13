import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { UpdateCheckResult, DownloadProgress, UpdateStatus } from '../types/update'

/**
 * 格式化字节数为可读字符串
 * @param bytes 字节数
 * @returns 格式化后的字符串，如 "1.5 MB"
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * 格式化下载速度
 * @param bytesPerSecond 字节/秒
 * @returns 格式化后的速度字符串
 */
function formatSpeed(bytesPerSecond: number): string {
  return formatBytes(bytesPerSecond) + '/s'
}

/**
 * 更新系统 Composable
 * 提供检查更新、下载更新、安装更新等功能的响应式封装
 * @returns 更新相关的状态和方法
 */
export function useUpdater() {
  // 状态
  const status = ref<UpdateStatus>('idle')
  const updateInfo = ref<UpdateCheckResult | null>(null)
  const currentVersion = ref<string>('')
  const downloadProgress = ref<DownloadProgress>({
    downloaded: 0,
    total: 0,
    percent: 0,
    speed: 0
  })
  const error = ref<string>('')
  const downloadedFilePath = ref<string>('')

  // 计算属性
  const isChecking = computed(() => status.value === 'checking')
  const isUpdateAvailable = computed(() => status.value === 'available' || (updateInfo.value?.hasUpdate ?? false))
  const isDownloading = computed(() => status.value === 'downloading')
  const isDownloaded = computed(() => status.value === 'downloaded')
  const hasError = computed(() => status.value === 'error')

  /**
   * 初始化获取当前版本号
   */
  const initCurrentVersion = async () => {
    if (window.api?.updater && !currentVersion.value) {
      try {
        currentVersion.value = await window.api.updater.getCurrentVersion()
      } catch (e) {
        currentVersion.value = ''
      }
    }
  }

  // 进度监听回调
  const progressCallback = (progress: DownloadProgress) => {
    downloadProgress.value = progress
  }

  // 自动检查结果监听回调
  const autoCheckCallback = (result: UpdateCheckResult) => {
    if (result.error) {
      // 启动时的自动检查失败（如网络异常）保持静默，不向用户弹错误提示
      console.warn('[useUpdater] 自动检查更新失败:', result.error)
      return
    }

    updateInfo.value = result
    if (result.hasUpdate) {
      status.value = 'available'
    } else {
      status.value = 'idle'
    }
  }

  /**
   * 注册 IPC 事件监听
   */
  const registerListeners = () => {
    if (window.api?.updater) {
      window.api.updater.onProgress(progressCallback)
      window.api.updater.onAutoCheckResult(autoCheckCallback)
    }
  }

  /**
   * 移除 IPC 事件监听
   */
  const removeListeners = () => {
    if (window.api?.updater) {
      window.api.updater.offProgress(progressCallback)
      window.api.updater.offAutoCheckResult(autoCheckCallback)
    }
  }

  onMounted(() => {
    registerListeners()
    initCurrentVersion()
  })

  onUnmounted(() => {
    removeListeners()
  })

  /**
   * 检查更新
   * @param channel 更新通道，'stable' 或 'beta'
   * @returns 更新检查结果
   */
  const checkUpdate = async (channel: 'stable' | 'beta' = 'stable'): Promise<UpdateCheckResult | null> => {
    if (!window.api?.updater) {
      error.value = '更新 API 不可用'
      status.value = 'error'
      return null
    }

    status.value = 'checking'
    error.value = ''

    try {
      const result: UpdateCheckResult = await window.api.updater.check(channel)

      if (result.error) {
        error.value = result.error
        status.value = 'error'
        return result
      }

      updateInfo.value = result

      if (result.hasUpdate) {
        status.value = 'available'
      } else {
        status.value = 'idle'
      }

      return result
    } catch (e: any) {
      error.value = e.message || '检查更新失败'
      status.value = 'error'
      return null
    }
  }

  /**
   * 下载更新
   * @returns 下载是否成功
   */
  const downloadUpdate = async (): Promise<boolean> => {
    if (!window.api?.updater || !updateInfo.value?.downloadUrl) {
      error.value = '没有可用的下载链接'
      status.value = 'error'
      return false
    }

    status.value = 'downloading'
    error.value = ''
    downloadProgress.value = { downloaded: 0, total: 0, percent: 0, speed: 0 }

    try {
      const result = await window.api.updater.download(updateInfo.value.downloadUrl)

      if (result.success && result.filePath) {
        downloadedFilePath.value = result.filePath
        status.value = 'downloaded'
        return true
      } else {
        error.value = result.error || '下载失败'
        status.value = 'error'
        return false
      }
    } catch (e: any) {
      error.value = e.message || '下载更新失败'
      status.value = 'error'
      return false
    }
  }

  /**
   * 安装更新
   * @returns 安装是否成功
   */
  const installUpdate = async (): Promise<boolean> => {
    if (!window.api?.updater) {
      error.value = '更新 API 不可用'
      status.value = 'error'
      return false
    }

    status.value = 'installing'
    error.value = ''

    try {
      const result = await window.api.updater.install(downloadedFilePath.value || undefined)

      if (result.success) {
        return true
      } else {
        error.value = result.error || '安装失败'
        status.value = 'error'
        return false
      }
    } catch (e: any) {
      error.value = e.message || '安装更新失败'
      status.value = 'error'
      return false
    }
  }

  /**
   * 忽略本次更新
   */
  const dismissUpdate = () => {
    status.value = 'idle'
    error.value = ''
  }

  /**
   * 清理下载的更新包
   */
  const cleanup = async () => {
    if (window.api?.updater) {
      await window.api.updater.cleanup()
    }
    downloadedFilePath.value = ''
  }

  /**
   * 获取当前版本号
   * @returns 当前版本号
   */
  const getCurrentVersion = async (): Promise<string> => {
    if (window.api?.updater) {
      return await window.api.updater.getCurrentVersion()
    }
    return ''
  }

  return {
    // 状态
    status,
    updateInfo,
    currentVersion,
    downloadProgress,
    error,
    downloadedFilePath,

    // 计算属性
    isChecking,
    isUpdateAvailable,
    isDownloading,
    isDownloaded,
    hasError,

    // 方法
    checkUpdate,
    downloadUpdate,
    installUpdate,
    dismissUpdate,
    cleanup,
    getCurrentVersion,

    // 工具函数
    formatBytes,
    formatSpeed
  }
}
