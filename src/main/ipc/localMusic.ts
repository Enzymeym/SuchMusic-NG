import { ipcMain, app, dialog } from 'electron'
import { promises as fs } from 'fs'
import { join, extname, basename, dirname } from 'path'
import axios from 'axios'
import { loadNativeDecoder } from '../services/nativeDecoder'

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

export function registerLocalMusicHandlers(): void {
  const { decode_audio_to_pcm } = loadNativeDecoder()

  // 按需读取单个音频文件的元数据（时长 + 封面）
  ipcMain.handle('local-music:get-meta', async (_event, filePath: string) => {
    try {
      // 动态导入 music-metadata (ESM)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mm = await import('music-metadata')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parseFile = (mm as any).parseFile as (filePath: string, options?: any) => Promise<any>

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
        // 如果 metadata 也拿不到时长，最后兜底使用 native 解码结果估算
        try {
          const decoded = decode_audio_to_pcm(filePath)
          if (
            decoded &&
            typeof decoded.sample_rate === 'number' &&
            decoded.sample_rate > 0 &&
            typeof decoded.channels === 'number' &&
            decoded.channels > 0 &&
            Array.isArray(decoded.data) &&
            decoded.data.length > 0
          ) {
            if (!sampleRate) {
              sampleRate = decoded.sample_rate
            }
            const frames = decoded.data.length / decoded.channels
            const secondsFromDecoded = frames / decoded.sample_rate
            if (Number.isFinite(secondsFromDecoded) && secondsFromDecoded > 0.1) {
              durationMs = Math.round(secondsFromDecoded * 1000)
            }
          }
        } catch (e) {
          console.warn('decode_audio_to_pcm 估算时长失败:', filePath, e)
        }
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
      const ext = extname(filePath).toLowerCase()

      // 如果有封面图片数据，转换为 Buffer
      if (tags.image && typeof tags.image.imageBuffer === 'string') {
        tags.image.imageBuffer = Buffer.from(tags.image.imageBuffer, 'base64')
      }

      if (ext === '.mp3') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const NodeID3 = require('node-id3')
        const buffer = await fs.readFile(filePath)

        // 更新 tags
        // node-id3 的 update 方法返回一个新的 buffer
        const success = NodeID3.update(tags, buffer)

        if (!success || success instanceof Error) {
          throw new Error('更新标签失败')
        }

        // 写入文件
        await fs.writeFile(filePath, success as Buffer)
        return true
      } else if (ext === '.flac') {
        return await writeFlacTag(filePath, tags)
      } else if (ext === '.wav') {
        return await writeWavTag(filePath, tags)
      } else {
        throw new Error(`不支持的文件格式: ${ext}`)
      }
    } catch (error) {
      console.error('Failed to write meta:', filePath, error)
      throw error
    }
  })

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

      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(fullPath)
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
    }

    await Promise.all(roots.map((dir) => walk(dir)))

    return {
      rootDir: roots[0],
      rootDirs: roots,
      tracks
    }
  })

  // ==================== 在线播放缓存 ====================

  // 计算缓存目录（如果传入为空，则使用默认目录）
  const resolveCacheDir = async (dir?: string | null): Promise<string> => {
    const base =
      dir && typeof dir === 'string' && dir.trim()
        ? dir
        : join(app.getPath('userData'), 'online-cache')
    await fs.mkdir(base, { recursive: true })
    return base
  }

  // 获取缓存信息：目录、总大小、文件数量
  ipcMain.handle('online-cache:get-info', async (_event, dir?: string | null) => {
    const cacheDir = await resolveCacheDir(dir)
    let sizeBytes = 0
    let fileCount = 0

    const walk = async (p: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(p, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(p, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else {
          try {
            const stat = await fs.stat(full)
            if (stat.isFile()) {
              sizeBytes += stat.size
              fileCount++
            }
          } catch {
            // ignore
          }
        }
      }
    }

    await walk(cacheDir)

    return {
      dir: cacheDir,
      sizeBytes,
      fileCount
    }
  })

  // 弹出目录选择对话框，供用户选择缓存目录
  ipcMain.handle('online-cache:choose-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择在线播放缓存目录',
      properties: ['openDirectory']
    })

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, dir: null as string | null }
    }

    const dir = result.filePaths[0]
    await fs.mkdir(dir, { recursive: true })
    return { canceled: false, dir }
  })

  // 清除缓存目录中的所有文件
  ipcMain.handle('online-cache:clear', async (_event, dir?: string | null) => {
    const cacheDir = await resolveCacheDir(dir)
    try {
      await fs.rm(cacheDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    await fs.mkdir(cacheDir, { recursive: true })
    return { success: true }
  })

  /**
   * 检查在线播放缓存是否存在
   * @param _event - IPC 事件对象
   * @param options - 检查选项
   * @param options.dir - 缓存目录路径，为空则使用默认目录
   * @param options.key - 缓存键值，用于构造文件名
   * @returns 缓存文件路径（如果存在且有效），否则返回 null
   */
  ipcMain.handle(
    'online-cache:check',
    async (_event, options: { dir?: string | null; key: string }) => {
      const { dir, key } = options || ({} as any)

      if (!key || typeof key !== 'string') {
        return null
      }

      const cacheDir = await resolveCacheDir(dir)

      // 构造安全的文件名（与 online-cache:prepare 保持一致）
      const safeKey = key.replace(/[^\w.-]/g, '_')

      // 查找可能的缓存文件（支持任意扩展名）
      try {
        const entries = await fs.readdir(cacheDir)
        for (const entry of entries) {
          if (entry.startsWith(safeKey + '.')) {
            const filePath = join(cacheDir, entry)
            try {
              const stat = await fs.stat(filePath)
              if (stat.isFile() && stat.size > 0) {
                return filePath
              }
            } catch {
              // 忽略单个文件的错误，继续查找
            }
          }
        }
      } catch {
        // 目录不存在或无法读取，返回 null
      }

      return null
    }
  )

  // 准备在线播放缓存：如果已缓存则直接返回本地路径，否则下载后返回本地路径
  ipcMain.handle(
    'online-cache:prepare',
    async (_event, options: { dir?: string | null; key: string; url: string }) => {
      const { dir, key, url } = options || ({} as any)

      if (!url || typeof url !== 'string') {
        throw new Error('无效的播放链接')
      }

      // 非 http(s) 链接不做缓存
      if (!/^https?:\/\//i.test(url)) {
        return { usedCache: false, filePath: null as string | null, url }
      }

      const cacheDir = await resolveCacheDir(dir)

      // 构造安全的文件名
      const safeKey = key.replace(/[^\w.-]/g, '_')
      let ext = ''
      try {
        const u = new URL(url)
        const name = u.pathname.split('/').pop() || ''
        const idx = name.lastIndexOf('.')
        if (idx !== -1 && idx < name.length - 1) {
          ext = name.slice(idx)
        }
      } catch {
        // ignore
      }
      if (!ext) {
        ext = '.dat'
      }

      const filePath = join(cacheDir, `${safeKey}${ext}`)

      try {
        const stat = await fs.stat(filePath)
        if (stat.isFile() && stat.size > 0) {
          return { usedCache: true, filePath, url }
        }
      } catch {
        // 不存在则继续下载
      }

      // 下载远程音频并写入缓存
      const response = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'SuchMusic/OnlineCache'
        }
      })

      if (response.status !== 200 || !response.data) {
        throw new Error(`下载音频失败: HTTP ${response.status}`)
      }

      const buffer = Buffer.from(response.data)
      await fs.writeFile(filePath, buffer)

      return { usedCache: false, filePath, url }
    }
  )

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

// Helper function to write FLAC tags
async function writeFlacTag(filePath: string, tags: any): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const flac = require('flac-metadata')

  // 读取整个 FLAC 文件到内存（通常体积可接受，且实现简单可靠）
  const fileBuffer = await fs.readFile(filePath)

  // 校验 FLAC 头部标记
  if (fileBuffer.toString('utf8', 0, 4) !== 'fLaC') {
    throw new Error('文件不是合法的 FLAC 格式')
  }

  let offset = 4
  const keptBlocks: Buffer[] = []
  let last = false

  // 遍历所有原始 MetaDataBlock，保留除 VORBIS_COMMENT / PICTURE 之外的块
  // 这样可以保留 STREAMINFO / SEEKTABLE 等信息，仅替换标签和封面
  while (!last) {
    const header = fileBuffer.readUInt32BE(offset)
    const isLast = (header >>> 31) !== 0
    const type = (header >>> 24) & 0x7f
    const length = header & 0x00ffffff

    const block = fileBuffer.slice(offset, offset + 4 + length)

    if (
      type !== flac.Processor.MDB_TYPE_VORBIS_COMMENT &&
      type !== flac.Processor.MDB_TYPE_PICTURE
    ) {
      keptBlocks.push(block)
    }

    offset += 4 + length
    last = isLast
  }

  // offset 之后即为音频帧数据
  const audioData = fileBuffer.slice(offset)

  // 清除保留块的 isLast 标记（最高位），后续由新插入的最后一个块设置
  const fixedKeptBlocks: Buffer[] = keptBlocks.map((b) => {
    const buf = Buffer.from(b) // 拷贝一份，避免修改原 buffer
    const header = buf.readUInt32BE(0)
    const newHeader = header & 0x7fffffff
    buf.writeUInt32BE(newHeader >>> 0, 0)
    return buf
  })

  // 组装 Vorbis Comment comments
  const comments: string[] = [
    `TITLE=${tags.title || ''}`,
    `ARTIST=${tags.artist || ''}`,
    `ALBUM=${tags.album || ''}`,
    `DATE=${tags.year || ''}`,
    `LYRICS=${(tags.unsynchronisedLyrics?.text || '').replace(/\r\n/g, '\n')}`
  ]

  // 创建 Vorbis Comment 块（先暂时不设置 isLast，后面统一处理）
  const vorbisBlock = flac.data.MetaDataBlockVorbisComment.create(
    false,
    'such-pc-ng',
    comments
  )
  const vorbisBuffer: Buffer = vorbisBlock.publish()

  // 如果有封面，则再创建一个 Picture 块
  let pictureBuffer: Buffer | null = null
  if (tags.image && tags.image.imageBuffer) {
    const { imageBuffer, mime, description } = tags.image
    const pictureBlock = flac.data.MetaDataBlockPicture.create(
      true, // 暂时标记为最后一个块，后续可能调整
      3, // 3 = Front Cover
      mime || 'image/jpeg',
      description || '',
      0,
      0,
      0,
      0,
      imageBuffer
    )
    pictureBuffer = pictureBlock.publish()
  }

  // 修正 Vorbis / Picture 的 isLast 标记，保证只有最后一个块设置 isLast=1
  const blocksToWrite: Buffer[] = [...fixedKeptBlocks]

  if (pictureBuffer) {
    // Vorbis 不是最后一个块
    const vorbisHeader = vorbisBuffer.readUInt32BE(0) & 0x7fffffff
    vorbisBuffer.writeUInt32BE(vorbisHeader >>> 0, 0)
    // Picture 是最后一个块（create 时已设置 isLast=true）
    blocksToWrite.push(vorbisBuffer, pictureBuffer)
  } else {
    // 只有 Vorbis，需要将其标记为最后一个块
    const vorbisHeader = vorbisBuffer.readUInt32BE(0) | 0x80000000
    vorbisBuffer.writeUInt32BE(vorbisHeader >>> 0, 0)
    blocksToWrite.push(vorbisBuffer)
  }

  // 计算新文件大小并组装：'fLaC' + 所有 metadata blocks + 原始音频数据
  const metaSize = blocksToWrite.reduce((sum, b) => sum + b.length, 0)
  const outBuffer = Buffer.alloc(4 + metaSize + audioData.length)

  outBuffer.write('fLaC', 0, 'ascii')
  let pos = 4
  for (const b of blocksToWrite) {
    b.copy(outBuffer, pos)
    pos += b.length
  }
  audioData.copy(outBuffer, pos)

  await fs.writeFile(filePath, outBuffer)
  return true
}

// Helper function to write WAV tags
async function writeWavTag(filePath: string, tags: any): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WaveFile } = require('wavefile')

  const buffer = await fs.readFile(filePath)
  const wav = new WaveFile(buffer)

  // Set ID3v2 tags
  // Note: WaveFile might throw if file format is invalid, handle in try/catch block outside

  if (tags.title) wav.setTag('TIT2', tags.title)
  if (tags.artist) wav.setTag('TPE1', tags.artist)
  if (tags.album) wav.setTag('TALB', tags.album)
  if (tags.year) wav.setTag('TYER', String(tags.year))

  // Image
  if (tags.image && tags.image.imageBuffer) {
    wav.setTag('APIC', {
      type: 3,
      data: tags.image.imageBuffer,
      mime: tags.image.mime || 'image/jpeg',
      description: tags.image.description || ''
    })
  }

  // Write back
  const newBuffer = wav.toBuffer()
  await fs.writeFile(filePath, newBuffer)
  return true
}
