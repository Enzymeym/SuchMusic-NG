import { ipcMain, app, dialog } from 'electron'
import { promises as fs } from 'fs'
import { join, extname, basename, dirname } from 'path'
import { writeAudioMeta } from '../utils/musicMetaWriter'

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

// 懒加载 music-metadata 模块缓存，避免每次 get-meta 重复 import
let _mmParseFile: ((filePath: string, options?: Record<string, unknown>) => Promise<unknown>) | null = null

async function getMusicMetadataParser(): Promise<(filePath: string, options?: Record<string, unknown>) => Promise<unknown>> {
  if (_mmParseFile) return _mmParseFile
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mm = await import('music-metadata')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _mmParseFile = (mm as any).parseFile as (filePath: string, options?: any) => Promise<any>
  return _mmParseFile
}

export function registerLocalMusicHandlers(): void {

  // 按需读取单个音频文件的元数据（时长 + 封面）
  ipcMain.handle('local-music:get-meta', async (_event, filePath: string) => {
    try {
      const parseFile = await getMusicMetadataParser()

      // 优先尝试带时长分析的解析
      let metadata: unknown
      try {
        metadata = await parseFile(filePath, {
          duration: true
        })
      } catch (error) {
        console.warn('parseFile duration=true 失败，尝试降级解析:', filePath, error)
        // 解析失败时降级为默认解析，尽量拿到封面等信息
        metadata = await parseFile(filePath)
      }

      const m = metadata as {
        format: {
          duration?: number
          numberOfSamples?: number
          sampleRate?: number
          bitrate?: number
        }
        common: {
          picture?: Array<{
            format?: string
            data?: Buffer
          }>
          lyrics?: string[]
          year?: number
        }
      }

      const seconds = m.format.duration
      const bitrate = m.format.bitrate
      let sampleRate = m.format.sampleRate
      let durationMs: number | undefined
      if (seconds && Number.isFinite(seconds)) {
        durationMs = Math.round(seconds * 1000)
      } else if (
        typeof m.format.numberOfSamples === 'number' &&
        typeof m.format.sampleRate === 'number' &&
        m.format.numberOfSamples > 0 &&
        m.format.sampleRate > 0
      ) {
        // 部分文件没有直接给出 duration，这里使用采样数与采样率估算
        const secondsFromSamples =
          m.format.numberOfSamples / m.format.sampleRate
        durationMs = Math.round(secondsFromSamples * 1000)
      } else {
        // metadata 无法获取时长时，不兜底使用原生解码器（decode_audio_to_pcm 会将
        // 整个文件解码为 PCM number[]，对 3 分钟立体声歌曲占用 ~127MB，严重浪费内存）。
        // durationMs 返回 undefined，实际播放时音频引擎会通过解码结果自动更新。
        durationMs = undefined
      }

      const picture = m.common.picture?.[0]
      const title =
        typeof (m.common as { title?: unknown }).title === 'string'
          ? ((m.common as { title?: string }).title || '').trim() || undefined
          : undefined
      const artistField = (m.common as { artist?: unknown }).artist
      const artistsField = (m.common as { artists?: unknown }).artists
      const artists: string[] = []
      if (Array.isArray(artistsField)) {
        for (const a of artistsField) {
          const s = String(a || '').trim()
          if (s) artists.push(s)
        }
      }
      if (!artists.length && typeof artistField === 'string') {
        const s = artistField.trim()
        if (s) artists.push(s)
      }
      const album =
        typeof (m.common as { album?: unknown }).album === 'string'
          ? ((m.common as { album?: string }).album || '').trim() || undefined
          : undefined

      // 尝试读取同名 .lrc 歌词文件
      let lyrics = m.common.lyrics?.[0]
      try {
        const lrcPath = filePath.substring(0, filePath.lastIndexOf('.')) + '.lrc'
        // Check if file exists
        await fs.access(lrcPath)
        // Read file
        const lrcContent = await fs.readFile(lrcPath, 'utf-8')
        if (lrcContent) {
           lyrics = lrcContent
        }
      } catch (e) {
        // Ignore if lrc file doesn't exist or read error
      }

      return {
        durationMs,
        bitrate,
        sampleRate,
        cover: (picture && picture.data)
          ? {
              mimeType: picture.format || 'image/jpeg',
              base64: Buffer.from(picture.data).toString('base64')
            }
          : undefined,
        title,
        artists,
        album,
        lyrics,
        year: m.common.year
      }
    } catch (error) {
      console.error('get-meta failed:', filePath, error)
      return {}
    }
  })

  // 保存音乐标签元数据 (目前支持 MP3/FLAC/WAV)
  ipcMain.handle('local-music:write-meta', async (_event, filePath: string, tags: any) => {
    try {
      return await writeAudioMeta(filePath, tags)
    } catch (error) {
      console.error('Failed to write meta:', filePath, error)
      throw error
    }
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

    const exts = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg'])
    const tracks: LocalMusicTrack[] = []
    const seenFiles = new Set<string>()

    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
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

