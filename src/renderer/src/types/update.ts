/**
 * 更新系统类型定义
 * 定义 GitHub Release 相关数据结构及更新检查返回结果
 */

/**
 * GitHub Release 资源文件信息
 */
export interface GitHubReleaseAsset {
  /** 资源文件名 */
  name: string
  /** 资源下载地址 */
  browser_download_url: string
  /** 文件大小（字节） */
  size: number
}

/**
 * GitHub Release 信息
 */
export interface GitHubRelease {
  /** Release 标签名，如 v0.2.1 */
  tag_name: string
  /** Release 标题 */
  name: string
  /** Release 说明（Markdown 格式） */
  body: string
  /** 是否为预发布版本 */
  prerelease: boolean
  /** 发布时间 */
  published_at: string
  /** 资源文件列表 */
  assets: GitHubReleaseAsset[]
}

/**
 * 更新检查结果
 */
export interface UpdateCheckResult {
  /** 是否有可用更新 */
  hasUpdate: boolean
  /** 当前版本号 */
  currentVersion: string
  /** 远程最新版本号 */
  latestVersion: string
  /** Release 标题 */
  releaseName: string
  /** 更新说明 */
  releaseNotes: string
  /** 下载链接 */
  downloadUrl: string | null
  /** 发布时间 */
  publishedAt: string
  /** 是否为预发布版本 */
  isPrerelease: boolean
  /** 错误信息（检查失败时） */
  error?: string
}

/**
 * 下载进度信息
 */
export interface DownloadProgress {
  /** 已下载字节数 */
  downloaded: number
  /** 总字节数 */
  total: number
  /** 下载百分比（0-100） */
  percent: number
  /** 下载速度（字节/秒） */
  speed: number
}

/**
 * 更新状态枚举
 */
export type UpdateStatus =
  | 'idle'      // 空闲
  | 'checking'  // 检查中
  | 'available' // 有更新
  | 'downloading' // 下载中
  | 'downloaded'  // 下载完成
  | 'installing'  // 安装中
  | 'error'       // 出错
