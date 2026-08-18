import { ipcMain, app, type IpcMainEvent } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { loadNativeDecoder } from '../services/nativeDecoder'
import { getActiveNeteaseCookie } from '../services/neteaseService'

// ====== 在线音频缓存 ======
/** 缓存目录（userData/audio-cache，持久化，跨会话复用以加速在线音频二次播放） */
const MAX_CACHE_SIZE_MB = 512
/** 缓存文件有效期（天），过期后下次播放重新下载刷新 */
const MAX_CACHE_AGE_DAYS = 30
/** URL 哈希 → 缓存文件路径（启动时扫描缓存目录构建，避免每次查询目录） */
const cacheIndex = new Map<string, string>()
/** 进行中的下载 Promise（按 URL 去重，避免并发重复下载同一地址） */
const pendingDownloads = new Map<string, Promise<string>>()

/** 用户自定义缓存目录（空字符串表示使用默认目录）。启动时从 userData/cache-dir.json 加载 */
let customCacheDir = ''

/** 默认缓存目录：userData/audio-cache */
function getDefaultAudioCacheDir(): string {
  return join(app.getPath('userData'), 'audio-cache')
}

/** 加载用户自定义缓存目录配置（应用启动时调用） */
async function loadCustomCacheDir(): Promise<void> {
  try {
    const configPath = join(app.getPath('userData'), 'cache-dir.json')
    const data = await fs.readFile(configPath, 'utf-8')
    const config = JSON.parse(data)
    if (typeof config.cacheDir === 'string' && config.cacheDir.trim()) {
      customCacheDir = config.cacheDir.trim()
    }
  } catch {
    // 配置文件不存在或解析失败时使用默认目录
  }
}

/** 持久化自定义缓存目录配置 */
async function saveCustomCacheDir(dir: string): Promise<void> {
  const configPath = join(app.getPath('userData'), 'cache-dir.json')
  await fs.writeFile(configPath, JSON.stringify({ cacheDir: dir }, null, 2), 'utf-8')
}

/** 获取缓存目录（app ready 后才可安全调用 getPath，故用惰性函数） */
function getAudioCacheDir(): string {
  return customCacheDir || getDefaultAudioCacheDir()
}

/** 当前缓存目录（供 IPC 读取，与渲染进程展示保持一致） */
function getAudioCacheDirForDisplay(): string {
  return getAudioCacheDir()
}

/** 计算 URL 的缓存键（sha256 前 32 位，用作文件名） */
function urlCacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32)
}

/** 构建缓存索引（应用启动时调用），并清理过期缓存文件 */
async function initAudioCache(): Promise<void> {
  try {
    await fs.mkdir(getAudioCacheDir(), { recursive: true })
    const dir = getAudioCacheDir()
    const files = await fs.readdir(dir)
    const now = Date.now()
    const maxAgeMs = MAX_CACHE_AGE_DAYS * 24 * 60 * 60 * 1000
    for (const file of files) {
      const filePath = join(dir, file)
      try {
        const stat = await fs.stat(filePath)
        if (!stat.isFile()) continue
        // 过期缓存直接删除
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.unlink(filePath)
          continue
        }
        cacheIndex.set(file.split('.')[0], filePath)
      } catch {
        // 文件已被删除或读取失败时忽略
      }
    }
  } catch (err) {
    console.error('[AudioCache] init failed:', err)
  }
}

/** 缓存命中时刷新 mtime（作为 LRU 淘汰基准） */
async function touchCacheFile(filePath: string): Promise<void> {
  const now = new Date()
  try {
    await fs.utimes(filePath, now, now)
  } catch {
    // 文件刚被删除等场景静默忽略
  }
}

/** 缓存总大小超出上限时，按 mtime 从旧到新淘汰，直到低于上限 */
async function evictCacheIfNeeded(): Promise<void> {
  try {
    const dir = getAudioCacheDir()
    const files = await fs.readdir(dir)
    const entries: { path: string; mtimeMs: number; size: number }[] = []
    let totalSize = 0
    for (const file of files) {
      const filePath = join(dir, file)
      try {
        const stat = await fs.stat(filePath)
        if (!stat.isFile()) continue
        entries.push({ path: filePath, mtimeMs: stat.mtimeMs, size: stat.size })
        totalSize += stat.size
      } catch {
        // 忽略读取失败的文件
      }
    }
    const maxSize = MAX_CACHE_SIZE_MB * 1024 * 1024
    if (totalSize <= maxSize) return
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of entries) {
      if (totalSize <= maxSize) break
      try {
        await fs.unlink(entry.path)
        totalSize -= entry.size
        cacheIndex.delete(entry.path.split(/[\\/]/).pop()!.split('.')[0])
      } catch {
        // 删除失败（文件被占用等）时跳过
      }
    }
  } catch (err) {
    console.error('[AudioCache] evict failed:', err)
  }
}

/** 下载远程音频并写入缓存目录，返回本地文件路径 */
async function downloadOnlineAudio(url: string, hash: string): Promise<string> {
  await fs.mkdir(getAudioCacheDir(), { recursive: true })
  // 附加登录态：网易云登录后返回的 VIP/高音质 CDN 地址需携带同一 Cookie 才能下载，
  // 否则裸请求会 403 导致「在线音频加载失败」
  const cookie = getActiveNeteaseCookie()
  const headers: Record<string, string> = {}
  if (cookie) headers['Cookie'] = cookie
  headers['User-Agent'] =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  headers['Referer'] = 'https://music.163.com'
  const resp = await fetch(url, { headers })
  if (!resp.ok) {
    throw new Error(`下载音频失败: HTTP ${resp.status}`)
  }
  const contentType = resp.headers.get('content-type')
  const ext = inferAudioExt(contentType, url)
  let filePath = join(getAudioCacheDir(), `${hash}.${ext}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length === 0) {
    throw new Error('下载音频失败: 内容为空')
  }
  // 写入缓存文件。Windows EPERM 通常由防病毒扫描/只读属性引起，
  // 先删后写重试一次；仍失败则回退到系统临时目录，避免播放中断
  try {
    await fs.writeFile(filePath, buf)
  } catch (writeErr: any) {
    if (writeErr.code === 'EPERM') {
      await fs.unlink(filePath).catch(() => {})
      try {
        await fs.writeFile(filePath, buf)
      } catch {
        const tempDir = join(require('os').tmpdir(), 'such-music-audio-cache')
        await fs.mkdir(tempDir, { recursive: true })
        filePath = join(tempDir, `${hash}.${ext}`)
        await fs.writeFile(filePath, buf)
      }
    } else {
      throw writeErr
    }
  }
  cacheIndex.set(hash, filePath)
  // 新写入文件 mtime 即为最新，作为 LRU 基准；随后按容量上限淘汰旧缓存
  await evictCacheIfNeeded()
  return filePath
}

/** 根据 Content-Type / URL 后缀推断音频扩展名 */
function inferAudioExt(contentType: string | null, url: string): string {
  const mimeMap: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac'
  }
  if (contentType) {
    const type = contentType.split(';')[0].trim().toLowerCase()
    if (mimeMap[type]) return mimeMap[type]
  }
  const pathname = url.split('?')[0]
  const match = /\.([a-z0-9]{2,4})$/i.exec(pathname)
  if (match) return match[1].toLowerCase()
  return 'mp3'
}

export function registerAudioHandlers(): void {
  // 初始化本地音频解码 IPC，调用 native/symphonia_napi_decoder.node
  const { decode_audio_to_pcm, decode_audio_stream } = loadNativeDecoder()

  // 先加载自定义缓存目录配置，再构建缓存索引（异步，不阻塞启动）
  loadCustomCacheDir()
    .catch(() => {})
    .finally(() => {
      initAudioCache().catch(() => {})
    })

  // 获取缓存目录与统计信息（文件数量、总大小）
  ipcMain.handle('audio:get-cache-info', async () => {
    const dir = getAudioCacheDirForDisplay()
    let fileCount = 0
    let totalSize = 0
    try {
      const files = await fs.readdir(dir)
      for (const file of files) {
        const filePath = join(dir, file)
        try {
          const stat = await fs.stat(filePath)
          if (stat.isFile()) {
            fileCount += 1
            totalSize += stat.size
          }
        } catch {
          // 忽略读取失败的文件
        }
      }
    } catch {
      // 目录不存在（如首次使用）时返回空统计
    }
    return {
      dir,
      isDefault: !customCacheDir,
      fileCount,
      totalSize,
      maxSize: MAX_CACHE_SIZE_MB * 1024 * 1024
    }
  })

  // 更新缓存目录：清空旧索引 → 迁移/创建新目录 → 重建索引 → 持久化配置
  ipcMain.handle('audio:set-cache-dir', async (_event, dir: string) => {
    const newDir = (dir || '').trim()
    const oldDir = getAudioCacheDirForDisplay()
    if (newDir === oldDir) return { success: true, dir: oldDir }
    if (!newDir) {
      // 恢复默认目录
      customCacheDir = ''
      await saveCustomCacheDir('')
    } else {
      customCacheDir = newDir
      await saveCustomCacheDir(newDir)
    }
    cacheIndex.clear()
    const targetDir = getAudioCacheDir()
    await fs.mkdir(targetDir, { recursive: true }).catch(() => {})
    // 尽力迁移旧缓存文件到新目录（文件被占用等失败时跳过），避免旧目录残留
    if (oldDir !== targetDir) {
      try {
        const oldFiles = await fs.readdir(oldDir)
        for (const file of oldFiles) {
          const src = join(oldDir, file)
          const dst = join(targetDir, file)
          try {
            const stat = await fs.stat(src)
            if (!stat.isFile()) continue
            await fs.rename(src, dst)
          } catch {
            try {
              await fs.copyFile(src, dst)
              await fs.unlink(src).catch(() => {})
            } catch {
              // 文件被占用等场景跳过
            }
          }
        }
        // 迁移后若旧目录为空则删除
        const remaining = await fs.readdir(oldDir)
        if (remaining.length === 0) {
          await fs.rmdir(oldDir).catch(() => {})
        }
      } catch {
        // 旧目录不存在或迁移失败时忽略
      }
    }
    await initAudioCache().catch(() => {})
    return { success: true, dir: getAudioCacheDirForDisplay() }
  })

  // 清空缓存目录
  ipcMain.handle('audio:clear-cache', async () => {
    const dir = getAudioCacheDirForDisplay()
    let removedCount = 0
    let removedSize = 0
    try {
      const files = await fs.readdir(dir)
      for (const file of files) {
        const filePath = join(dir, file)
        try {
          const stat = await fs.stat(filePath)
          if (stat.isFile()) {
            await fs.unlink(filePath)
            removedCount += 1
            removedSize += stat.size
          }
        } catch {
          // 文件被占用或删除失败时跳过
        }
      }
    } catch {
      // 目录不存在时忽略
    }
    cacheIndex.clear()
    return { success: true, removedCount, removedSize }
  })

  ipcMain.handle('audio:decode', async (_event, filePath: string) => {
    // 调用本地解码器，将路径交给 Rust NAPI 插件处理
    const result = await decode_audio_to_pcm(filePath)
    return result
  })

  // 流式解码：一边解码一边通过 IPC 推送音频数据块
  ipcMain.on('audio:decode-stream:start', (event, filePath: string) => {
    if (!decode_audio_stream) {
      event.sender.send('audio:decode-stream:error', '当前 native 模块不支持流式解码')
      return
    }

    const webContents = event.sender
    let cancelled = false

    const stopChannel = 'audio:decode-stream:stop'
    const stopHandler = (stopEvent: IpcMainEvent): void => {
      if (stopEvent.sender === webContents) {
        cancelled = true
        webContents.send('audio:decode-stream:stopped')
        ipcMain.removeListener(stopChannel, stopHandler)
      }
    }

    ipcMain.on(stopChannel, stopHandler)

    try {
      decode_audio_stream(filePath, (chunkRaw: unknown) => {
        if (cancelled) return

        const chunk = chunkRaw as {
          sample_rate?: number
          sampleRate?: number
          channels: number
          data: number[]
          finished?: boolean
        }

        const sampleRate = chunk.sample_rate ?? chunk.sampleRate ?? 44_100
        const basePayload = {
          sampleRate,
          channels: chunk.channels,
          data: Array.isArray(chunk.data) ? chunk.data : [],
          finished: !!chunk.finished
        }

        // 兜底：如果 native 没有正确标记 finished，
        // 则当数据块长度小于满块大小时认为是最后一块
        const framesPerChunk = 2048
        const expectedSamplesPerChunk = framesPerChunk * basePayload.channels
        const isLastChunk =
          basePayload.finished ||
          basePayload.data.length < expectedSamplesPerChunk

        const payload = {
          ...basePayload,
          finished: isLastChunk
        }

        webContents.send('audio:decode-stream:chunk', payload)

        if (isLastChunk) {
          webContents.send('audio:decode-stream:finished')
          ipcMain.removeListener(stopChannel, stopHandler)
        }
      })
    } catch (error) {
      console.error('audio:decode-stream failed:', error)
      webContents.send('audio:decode-stream:error', String(error))
      ipcMain.removeListener(stopChannel, stopHandler)
    }
  })

  // 读取本地音频文件为二进制数据，提供给渲染进程创建 Blob URL
  ipcMain.handle('audio:load-file', async (_event, filePath: string) => {
    const data = await fs.readFile(filePath)
    // 仅返回底层 ArrayBuffer，便于在渲染进程直接创建 Blob
    return data.buffer
  })

  // 解析在线音频：优先返回本地缓存（命中则跳过网络下载，加快播放速度）；
  // 未命中时下载并写入缓存目录持久化复用。返回 { path, cached } 便于调用方区分
  ipcMain.handle(
    'audio:get-online-audio',
    async (_event, url: string): Promise<{ path: string; cached: boolean }> => {
      if (!url || !/^https?:\/\//i.test(url)) {
        throw new Error(`无效的音频地址: ${url}`)
      }

      const hash = urlCacheKey(url)

      // 1. 命中缓存：直接返回本地路径，免去网络下载
      const cachedPath = cacheIndex.get(hash)
      if (cachedPath) {
        try {
          const stat = await fs.stat(cachedPath)
          if (stat.isFile() && stat.size > 0) {
            touchCacheFile(cachedPath).catch(() => {})
            console.log(`[AudioCache] cache hit: ${url} -> ${cachedPath}`)
            return { path: cachedPath, cached: true }
          }
          // 缓存文件损坏/为空时回退重新下载
          await fs.unlink(cachedPath).catch(() => {})
          cacheIndex.delete(hash)
        } catch {
          cacheIndex.delete(hash)
        }
      }

      // 2. 并发去重：同一 URL 的并发请求复用同一个下载 Promise
      const inflight = pendingDownloads.get(url)
      if (inflight) {
        const path = await inflight
        return { path, cached: true }
      }

      const downloadPromise = downloadOnlineAudio(url, hash).finally(() => {
        pendingDownloads.delete(url)
      })
      pendingDownloads.set(url, downloadPromise)

      try {
        const path = await downloadPromise
        return { path, cached: false }
      } catch (err) {
        // 下载失败（如登录态失效导致 403）时回退到已有缓存，尽力继续播放
        if (cachedPath) {
          try {
            const stat = await fs.stat(cachedPath)
            if (stat.isFile() && stat.size > 0) {
              console.warn('[AudioCache] download failed, fallback to cache:', err)
              return { path: cachedPath, cached: true }
            }
          } catch {
            // 缓存也不可用时抛出原始错误
          }
        }
        throw err
      }
    }
  )

  // 清理播放用临时文件（兼容旧逻辑：仅允许删除缓存目录外的文件）
  ipcMain.handle('audio:cleanup-temp', async (_event, filePath: string) => {
    if (!filePath) return
    // 缓存目录内的文件由缓存淘汰策略管理，禁止在此删除
    if (filePath.startsWith(getAudioCacheDir())) return
    try {
      await fs.unlink(filePath)
    } catch {
      // 文件不存在或已删除时静默忽略
    }
  })
}
