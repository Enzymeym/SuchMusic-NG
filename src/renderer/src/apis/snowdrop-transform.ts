// 落雪插件转换测试结果类型
export interface SnowdropTransformTestStats {
  singleDurationMs: number
  batchDurationMs: number
  averageMs: number
  count: number
  estimatedMemoryDeltaMb: number
}

// 音源概要信息
export interface SnowdropTransformSourceSummary {
  id: string
  name: string
  qualities: string[]
}

export interface SnowdropTransformTestMeta {
  name: string
  version: string
  author: string
  description?: string
  homepage?: string
}

export interface SnowdropTransformTestResult {
  meta: SnowdropTransformTestMeta
  type: string
  stats: SnowdropTransformTestStats
  sources: SnowdropTransformSourceSummary[]
  logs: string[]
  warnings: string[]
  errors: string[]
  transformedCodePreview: string
  filePath?: string
  originalCodePreview?: string
  runtimeLogs?: string[]
}

const CHANNEL_SNOWDROP_TEST = 'snowdrop:transform:test'
const CHANNEL_SNOWDROP_OPEN_FILE = 'snowdrop:transform:open-file'
const CHANNEL_SNOWDROP_DOWNLOAD_URL = 'snowdrop:transform:download-url'
const CHANNEL_SNOWDROP_LOAD_ALL = 'snowdrop:plugin:load-all'
const CHANNEL_SNOWDROP_REMOVE = 'snowdrop:plugin:remove'
const CHANNEL_SNOWDROP_SET_ACTIVE = 'snowdrop:plugin:set-active'
const CHANNEL_SNOWDROP_GET_MUSIC_URL = 'snowdrop:plugin:get-music-url'

// 调用主进程的落雪插件转换测试 IPC
export async function runSnowdropTransformTest(): Promise<SnowdropTransformTestResult> {
  const result = await window.electron.ipcRenderer.invoke(CHANNEL_SNOWDROP_TEST)
  return result as SnowdropTransformTestResult
}

export interface SnowdropTransformBatchResult {
  canceled: boolean
  results: SnowdropTransformTestResult[]
  errors?: string[]
  // 当前被选中的插件文件路径
  activeFilePath?: string | null
}

// 选择本地落雪插件文件并解析（支持多选）
export async function runSnowdropTransformFromFile(): Promise<SnowdropTransformBatchResult> {
  const result = await window.electron.ipcRenderer.invoke(CHANNEL_SNOWDROP_OPEN_FILE)
  return result as SnowdropTransformBatchResult
}

// 通过在线 URL 下载并解析落雪插件
export async function runSnowdropTransformFromUrl(
  url: string
): Promise<SnowdropTransformBatchResult> {
  const result = await window.electron.ipcRenderer.invoke(
    CHANNEL_SNOWDROP_DOWNLOAD_URL,
    url
  )
  return result as SnowdropTransformBatchResult
}

// 加载所有保存的插件文件
export async function runSnowdropLoadAllPlugins(): Promise<SnowdropTransformBatchResult> {
  const result = await window.electron.ipcRenderer.invoke(CHANNEL_SNOWDROP_LOAD_ALL)
  return result as SnowdropTransformBatchResult
}

// 移除指定的插件
export async function runSnowdropRemovePlugin(filePath: string): Promise<{ success: boolean }> {
  return await window.electron.ipcRenderer.invoke(CHANNEL_SNOWDROP_REMOVE, filePath)
}

// 设置当前使用的落雪插件（一次只能选一个）
export async function runSnowdropSetActivePlugin(
  filePath: string | null
): Promise<{ success: boolean; activePluginPath: string | null }> {
  const result = await window.electron.ipcRenderer.invoke(
    CHANNEL_SNOWDROP_SET_ACTIVE,
    filePath
  )
  return result as { success: boolean; activePluginPath: string | null }
}

// 调用当前激活插件获取音乐 URL
export async function runSnowdropGetMusicUrl(
  source: string,
  musicInfo: any,
  quality: string,
  retryCount: number = 3
): Promise<{ url: string }> {
  let lastError: any

  for (let i = 0; i <= retryCount; i++) {
    try {
      if (i > 0) {
        console.warn(`[Snowdrop] 获取音乐链接失败，正在进行第 ${i}/${retryCount} 次重试...`)
        // 简单的退避策略：每次重试前等待 1s * 次数
        await new Promise((resolve) => setTimeout(resolve, 1000 * i))
      }

      const result = await window.electron.ipcRenderer.invoke(
        CHANNEL_SNOWDROP_GET_MUSIC_URL,
        source,
        musicInfo,
        quality
      )

      // 简单验证结果是否包含 url
      if (result && result.url) {
        return result as { url: string }
      }
      
      // 如果没有抛出异常但没有 url，也视为失败，抛出错误以触发重试
      throw new Error('Plugin returned empty URL')

    } catch (error) {
      console.error(`[Snowdrop] 获取音乐链接出错 (尝试 ${i + 1}/${retryCount + 1}):`, error)
      lastError = error
    }
  }

  throw lastError || new Error('Failed to get music url after retries')
}
