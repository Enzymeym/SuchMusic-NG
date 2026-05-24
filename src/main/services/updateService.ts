import { app, shell, BrowserWindow } from 'electron'
import axios from 'axios'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createWriteStream } from 'fs'
import type { GitHubRelease, UpdateCheckResult, DownloadProgress } from '../../renderer/src/types/update'

// GitHub 仓库配置
const GITHUB_OWNER = 'Enzymeym'
const GITHUB_REPO = 'SuchMusic-NG'
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`

// 缓存配置
let cachedRelease: GitHubRelease | null = null
let cacheTimestamp = 0
const CACHE_DURATION = 30 * 60 * 1000 // 30 分钟

/**
 * 获取当前应用版本号（去除开头的 v）
 * @returns 当前版本号字符串
 */
export function getCurrentVersion(): string {
  const version = app.getVersion()
  return version.startsWith('v') ? version.slice(1) : version
}

/**
 * 解析版本号字符串为数字数组
 * @param version 版本号字符串，如 "0.2.1" 或 "v0.2.1"
 * @returns 版本号数字数组，如 [0, 2, 1]
 */
function parseVersion(version: string): number[] {
  const clean = version.startsWith('v') ? version.slice(1) : version
  return clean.split('.').map(Number)
}

/**
 * 比较两个版本号
 * @param current 当前版本号
 * @param remote 远程版本号
 * @returns 负数表示当前版本较旧（需要更新），0 表示相同，正数表示当前版本较新
 */
export function compareVersions(current: string, remote: string): number {
  const currentParts = parseVersion(current)
  const remoteParts = parseVersion(remote)
  const maxLen = Math.max(currentParts.length, remoteParts.length)

  for (let i = 0; i < maxLen; i++) {
    const cur = currentParts[i] || 0
    const rem = remoteParts[i] || 0
    if (cur !== rem) {
      return cur - rem
    }
  }
  return 0
}

/**
 * 获取当前平台对应的文件扩展名
 * @returns 平台对应的安装包扩展名
 */
function getPlatformExtension(): string {
  switch (process.platform) {
    case 'win32':
      return '.exe'
    case 'darwin':
      return '.dmg'
    case 'linux':
      return '.AppImage'
    default:
      return ''
  }
}

/**
 * 从 Release 中获取当前平台对应的下载链接
 * @param release GitHub Release 对象
 * @returns 下载链接或 null
 */
export function getDownloadUrl(release: GitHubRelease): string | null {
  const ext = getPlatformExtension()
  if (!ext) return null

  const asset = release.assets.find((a) => a.name.toLowerCase().endsWith(ext))
  return asset?.browser_download_url || null
}

/**
 * 发送下载进度到渲染进程
 * @param progress 下载进度信息
 */
function sendProgress(progress: DownloadProgress): void {
  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (mainWindow) {
    mainWindow.webContents.send('update:progress', progress)
  }
}

/**
 * 获取最新 Release（带缓存）
 * @param channel 更新通道，stable 只获取正式版，beta 获取所有
 * @returns GitHub Release 对象或 null
 */
export async function fetchLatestRelease(channel: 'stable' | 'beta' = 'stable'): Promise<GitHubRelease | null> {
  // 检查缓存
  const now = Date.now()
  if (cachedRelease && now - cacheTimestamp < CACHE_DURATION) {
    // 缓存有效，检查通道是否匹配
    if (channel === 'beta' || !cachedRelease.prerelease) {
      return cachedRelease
    }
  }

  try {
    const { data } = await axios.get<GitHubRelease[]>(GITHUB_API_URL, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'SuchMusic-Updater'
      },
      params: { per_page: 10 },
      timeout: 15000
    })

    if (!Array.isArray(data) || data.length === 0) {
      return null
    }

    // 根据通道筛选
    const release =
      channel === 'stable'
        ? data.find((r) => !r.prerelease)
        : data[0]

    if (release) {
      cachedRelease = release
      cacheTimestamp = now
    }

    return release || null
  } catch (error) {
    console.error('获取 GitHub Release 失败:', error)
    return null
  }
}

/**
 * 检查是否有可用更新
 * @param channel 更新通道
 * @returns 更新检查结果
 */
export async function checkForUpdate(channel: 'stable' | 'beta' = 'stable'): Promise<UpdateCheckResult> {
  const currentVersion = getCurrentVersion()

  try {
    const release = await fetchLatestRelease(channel)

    if (!release) {
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion: currentVersion,
        releaseName: '',
        releaseNotes: '',
        downloadUrl: null,
        publishedAt: '',
        isPrerelease: false,
        error: '未找到可用的 Release'
      }
    }

    const latestVersion = release.tag_name.startsWith('v')
      ? release.tag_name.slice(1)
      : release.tag_name

    const comparison = compareVersions(currentVersion, latestVersion)
    const hasUpdate = comparison < 0

    return {
      hasUpdate,
      currentVersion,
      latestVersion,
      releaseName: release.name,
      releaseNotes: release.body || '',
      downloadUrl: hasUpdate ? getDownloadUrl(release) : null,
      publishedAt: release.published_at,
      isPrerelease: release.prerelease
    }
  } catch (error: any) {
    return {
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      releaseName: '',
      releaseNotes: '',
      downloadUrl: null,
      publishedAt: '',
      isPrerelease: false,
      error: error.message || '检查更新失败'
    }
  }
}

/**
 * 下载更新包
 * @param url 下载链接
 * @returns 下载后的本地文件路径
 */
export async function downloadUpdate(url: string): Promise<string> {
  const tempDir = app.getPath('temp')
  const fileName = path.basename(url) || `SuchMusic-Update-${Date.now()}${getPlatformExtension()}`
  const filePath = path.join(tempDir, fileName)

  return new Promise((resolve, reject) => {
    axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: 300000, // 5 分钟超时
      headers: {
        'User-Agent': 'SuchMusic-Updater'
      }
    })
      .then((response) => {
        const total = parseInt(response.headers['content-length'] || '0', 10)
        let downloaded = 0
        let lastReported = 0
        const startTime = Date.now()

        const writer = createWriteStream(filePath)
        response.data.pipe(writer)

        response.data.on('data', (chunk: Buffer) => {
          downloaded += chunk.length

          // 每下载 5% 或每 500ms 报告一次进度
          const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0
          const now = Date.now()
          if (percent - lastReported >= 5 || now - startTime > 500) {
            lastReported = percent
            const elapsed = (now - startTime) / 1000
            const speed = elapsed > 0 ? Math.round(downloaded / elapsed) : 0
            sendProgress({
              downloaded,
              total,
              percent,
              speed
            })
          }
        })

        writer.on('finish', () => {
          // 发送 100% 进度
          sendProgress({
            downloaded,
            total,
            percent: 100,
            speed: 0
          })
          resolve(filePath)
        })

        writer.on('error', (err) => {
          reject(err)
        })

        response.data.on('error', (err: Error) => {
          reject(err)
        })
      })
      .catch((error) => {
        reject(error)
      })
  })
}

/**
 * 安装更新包
 * @param filePath 更新包本地路径
 */
export function installUpdate(filePath: string): void {
  shell.openPath(filePath)
}

/**
 * 清理旧的更新包文件
 * @param filePath 要删除的文件路径
 */
export async function cleanupUpdateFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch {
    // 忽略清理错误
  }
}
