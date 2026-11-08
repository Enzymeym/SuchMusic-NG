import { ipcMain, app, dialog } from 'electron'
import { promises as fs } from 'fs'
import { join, extname, basename, dirname } from 'path'
import { writeAudioMeta } from '../utils/musicMetaWriter'
import { resolveAudioMeta } from '../services/audioMetaResolver'
import { getNativeTagReader } from '../services/tagReaderService'

// 本地音乐扫描结果的数据结构
interface LocalMusicTrack {
  id: string
  name: string
  filePath: string
  ar: { name: string }[]
  al: { name: string }
  dt?: number
  quality?: string
  coverId?: string
}

/**
 * 简单并发限制器。
 *
 * 只用于包裹**叶子 I/O**（readdir / stat），不要包裹递归任务本身：
 * 递归任务持有配额再等待子任务会在大目录树上死锁。
 */
function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => queue.push(resolve))
    }
    active++
    try {
      return await fn()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}

export function registerLocalMusicHandlers(): void {

  // 按需读取单个音频文件的元数据（时长 + 封面）
  // options.includeCover=false 时跳过封面提取：调用方只为取歌词时，
  // 不必把数百 KB~数 MB 的 base64 封面克隆过 IPC 再丢弃
  //
  // 解析编排（native → music-metadata → 手动嗅探的多源合并）全部收敛在
  // resolveAudioMeta 里，这里只负责 IPC 边界与异常兜底。
  ipcMain.handle(
    'local-music:get-meta',
    async (_event, filePath: string, options?: { includeCover?: boolean }) => {
      try {
        return await resolveAudioMeta(filePath, {
          includeCover: options?.includeCover,
          reader: getNativeTagReader()
        })
      } catch (error) {
        console.error('get-meta failed:', filePath, error)
        return {}
      }
    }
  )

  // 保存音乐标签元数据 (目前支持 MP3/FLAC/WAV)
  ipcMain.handle('local-music:write-meta', async (_event, filePath: string, tags: any) => {
    try {
      return await writeAudioMeta(filePath, tags)
    } catch (error) {
      console.error('Failed to write meta:', filePath, error)
      throw error
    }
  })

  // 根据封面 URL 下载并返回 base64 数据（供标签编辑弹窗「自动匹配」填充封面，避免渲染层 CORS）
  ipcMain.handle('local-music:fetch-cover', async (_event, url: string) => {
    if (!url || typeof url !== 'string' || !url.trim()) {
      throw new Error('封面 URL 不能为空')
    }
    const response = await fetch(url.trim())
    if (!response.ok) {
      throw new Error(`下载封面失败: HTTP ${response.status}`)
    }
    const contentType = response.headers.get('content-type') || 'image/jpeg'
    const buffer = Buffer.from(await response.arrayBuffer())
    return { mimeType: contentType, base64: buffer.toString('base64') }
  })

  // 根据封面 URL 下载并写入音频文件标签
  ipcMain.handle(
    'local-music:write-cover',
    async (_event, filePath: string, coverUrl: string) => {
      if (!filePath || !coverUrl) {
        throw new Error('filePath 和 coverUrl 不能为空')
      }
      try {
        const response = await fetch(coverUrl)
        if (!response.ok) {
          throw new Error(`下载封面失败: HTTP ${response.status}`)
        }
        const contentType = response.headers.get('content-type') || 'image/jpeg'
        const arrayBuffer = await response.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)
        return await writeAudioMeta(filePath, {
          image: {
            imageBuffer: buffer,
            mime: contentType
          }
        })
      } catch (error) {
        console.error('Failed to write cover from url:', filePath, coverUrl, error)
        throw error
      }
    }
  )

  // 根据网络歌曲信息写入音频文件标签（歌名、歌手、专辑、歌词、封面）
  ipcMain.handle(
    'local-music:write-song-info',
    async (
      _event,
      filePath: string,
      info: {
        title?: string
        artist?: string
        album?: string
        lyrics?: string
        coverUrl?: string
      }
    ) => {
      if (!filePath) {
        throw new Error('filePath 不能为空')
      }
      try {
        const tags: import('../utils/musicMetaWriter').MusicMetaTags = {}
        if (info.title?.trim()) tags.title = info.title.trim()
        if (info.artist?.trim()) tags.artist = info.artist.trim()
        if (info.album?.trim()) tags.album = info.album.trim()
        if (info.lyrics?.trim()) tags.lyrics = info.lyrics.trim()

        if (info.coverUrl) {
          const response = await fetch(info.coverUrl)
          if (!response.ok) {
            throw new Error(`下载封面失败: HTTP ${response.status}`)
          }
          const contentType = response.headers.get('content-type') || 'image/jpeg'
          const arrayBuffer = await response.arrayBuffer()
          tags.image = {
            imageBuffer: Buffer.from(arrayBuffer),
            mime: contentType
          }
        }

        return await writeAudioMeta(filePath, tags)
      } catch (error) {
        console.error('Failed to write song info:', filePath, info, error)
        throw error
      }
    }
  )

  ipcMain.handle('local-music:choose-scan-dirs', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择本地音乐扫描目录',
      properties: ['openDirectory', 'multiSelections']
    })

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, dirs: [] as string[] }
    }

    return {
      canceled: false,
      dirs: result.filePaths
    }
  })

  ipcMain.handle('local-music:scan', async (_event, scanDirs?: string[]) => {
    const defaultDir = app.getPath('music')
    const roots = Array.isArray(scanDirs) && scanDirs.length ? scanDirs : [defaultDir]

    const exts = new Set([
      '.mp3',
      '.flac',
      '.wav',
      '.m4a',
      '.aac',
      '.ogg',
      '.opus',
      '.ape',
      '.wv',
      '.aiff',
      '.aif',
      '.mp4',
      '.m4b'
    ])
    const tracks: LocalMusicTrack[] = []
    const seenFiles = new Set<string>()
    // 深/宽目录树的下钻会瞬间产生数千个并发 readdir，每个未完成的 Dirent[] 都要驻留内存
    const readdirLimited = createLimiter(8)

    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdirLimited(() => fs.readdir(dir, { withFileTypes: true }))
      } catch (error) {
        console.error('读取目录失败:', dir, error)
        return
      }

      const subDirs: string[] = []

      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          subDirs.push(fullPath)
          continue
        }

        const ext = extname(entry.name).toLowerCase()
        if (!exts.has(ext)) continue
        if (seenFiles.has(fullPath)) continue
        seenFiles.add(fullPath)

        const rawName = basename(entry.name, ext)
        let title = rawName
        let artist = '本地音乐'
        const parts = rawName.split('-').map((s) => s.trim())
        if (parts.length === 2) {
          artist = parts[0] || artist
          title = parts[1] || title
        }

        tracks.push({
          id: fullPath,
          name: title,
          filePath: fullPath,
          ar: [{ name: artist }],
          al: { name: dirname(fullPath).split(/[\\/]/).pop() || '本地音乐' },
          dt: undefined,
          quality: 'Standard'
        })
      }

      // 并行遍历子目录
      if (subDirs.length > 0) {
        await Promise.all(subDirs.map((subDir) => walk(subDir)))
      }
    }

    await Promise.all(roots.map((dir) => walk(dir)))

    return {
      rootDir: roots[0],
      rootDirs: roots,
      tracks
    }
  })

  // 批量获取本地音频文件大小（字节）。扫描阶段不逐个 stat 以免拖慢整库扫描，
  // 由统计页按需传入其关心的路径（本地曲库），仅对这些文件做 stat。
  ipcMain.handle('local-music:sizes', async (_event, filePaths: unknown) => {
    const sizes: Record<string, number> = {}
    if (!Array.isArray(filePaths)) return sizes
    const paths = Array.from(
      new Set(filePaths.filter((p): p is string => typeof p === 'string' && !!p))
    )
    // 万级路径一次性 stat 会让线程池排起长队并同时持有大量 Promise/Stats
    const statLimited = createLimiter(16)
    await Promise.all(
      paths.map((filePath) =>
        statLimited(async () => {
          try {
            const stat = await fs.stat(filePath)
            if (stat.isFile()) sizes[filePath] = stat.size
          } catch {
            // 文件已删除 / 无权限时忽略，统计页按缺失处理
          }
        })
      )
    )
    return sizes
  })

  // 批量删除本地音乐文件
  ipcMain.handle('local-music:delete', async (_event, filePaths: string[]) => {
    try {
      if (!Array.isArray(filePaths)) {
        throw new Error('Invalid input: filePaths must be an array')
      }

      const results = await Promise.allSettled(filePaths.map(async (fp) => {
        try {
          await fs.unlink(fp)
          return fp
        } catch (e) {
          // 如果文件不存在，也算删除成功
          if ((e as any).code === 'ENOENT') {
            return fp
          }
          throw e
        }
      }))

      const failed = results.filter(r => r.status === 'rejected')
      if (failed.length > 0) {
        console.error('部分文件删除失败', failed)
        // 可以返回部分失败的信息，或者直接抛出异常
        // 这里简单起见，如果所有都失败才抛错，或者记录日志
      }

      return {
        success: true,
        deletedCount: results.filter(r => r.status === 'fulfilled').length,
        failedCount: failed.length
      }
    } catch (error) {
      console.error('批量删除本地音乐失败', error)
      throw error
    }
  })
}
