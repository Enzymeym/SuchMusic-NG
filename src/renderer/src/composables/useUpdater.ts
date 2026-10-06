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

// ===== 模块级共享状态 =====
// 多个组件（更新弹窗、设置-关于页）共享同一份更新状态，避免状态不一致与重复下载
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
const isUpdateAvailable = computed(
  () => status.value === 'available' || (updateInfo.value?.hasUpdate ?? false)
)
const isDownloading = computed(() => status.value === 'downloading')
const isDownloaded = computed(() => status.value === 'downloaded')
const hasError = computed(() => status.value === 'error')

// 进度监听回调（模块级，避免重复注册同一函数导致无法移除）
const progressCallback = (progress: DownloadProgress) => {
  downloadProgress.value = progress
}

// 订阅者引用计数：首个组件挂载时注册 IPC 监听，最后一个卸载时移除
let subscriberCount = 0

const registerListeners = () => {
  if (!window.api?.updater) return
  if (subscriberCount === 0) {
    window.api.updater.onProgress(progressCallback)
  }
  subscriberCount++
}

const removeListeners = () => {
  if (!window.api?.updater) return
  subscriberCount = Math.max(0, subscriberCount - 1)
  if (subscriberCount === 0) {
    window.api.updater.offProgress(progressCallback)
  }
}

/**
 * 初始化获取当前版本号
 */
const initCurrentVersion = async () => {
  if (window.api?.updater && !currentVersion.value) {
    try {
      currentVersion.value = await window.api.updater.getCurrentVersion()
    } catch {
      currentVersion.value = ''
    }
  }
}

/**
 * 检查更新
 * @param channel 更新通道，'stable' 或 'beta'
 * @param options autoDownload: 发现更新后自动下载（默认 true）；silent: 失败时不弹错误（默认 false）
 * @returns 更新检查结果
 */
const checkUpdate = async (
  channel: 'stable' | 'beta' = 'stable',
  options: { autoDownload?: boolean; silent?: boolean } = {}
): Promise<UpdateCheckResult | null> => {
  const { autoDownload = true, silent = false } = options

  if (!window.api?.updater) {
    if (!silent) {
      error.value = '更新 API 不可用'
      status.value = 'error'
    }
    return null
  }

  // 正在下载时忽略重复检查，避免并发下载
  if (status.value === 'downloading') {
    return updateInfo.value
  }

  status.value = 'checking'
  error.value = ''

  try {
    const result: UpdateCheckResult = await window.api.updater.check(channel)

    if (result.error) {
      error.value = result.error
      status.value = silent ? 'idle' : 'error'
      if (silent) error.value = ''
      return result
    }

    updateInfo.value = result

    if (result.hasUpdate) {
      status.value = 'available'
      // 发现更新后自动开始下载，下载完成后由 UI 提示安装
      if (autoDownload) {
        await downloadUpdate()
      }
    } else {
      status.value = 'idle'
    }

    return result
  } catch (e: any) {
    error.value = e.message || '检查更新失败'
    status.value = silent ? 'idle' : 'error'
    if (silent) error.value = ''
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

/**
 * 更新系统 Composable
 * 提供检查更新、下载更新、安装更新等功能的响应式封装
 * @returns 更新相关的状态和方法
 */
export function useUpdater() {
  onMounted(() => {
    registerListeners()
    initCurrentVersion()
  })

  onUnmounted(() => {
    removeListeners()
  })

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
