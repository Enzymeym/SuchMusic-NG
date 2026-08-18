/**
 * 音乐元数据写入工具
 * 支持 MP3 / FLAC / WAV 格式的标签写入
 * 供 IPC handler 和插件系统共用
 */
import { promises as fs } from 'fs'
import { extname, basename, join } from 'path'
import { tmpdir } from 'os'

export interface MusicMetaTags {
  title?: string
  artist?: string
  album?: string
  year?: number | string
  /** 歌词文本 */
  lyrics?: string
  /** 封面图片 */
  image?: {
    imageBuffer: Buffer | string
    mime?: string
    description?: string
  }
  [key: string]: any
}

/** 可回退的写入类错误（权限 / 文件占用 / 目录缺等） */
const RETRYABLE_WRITE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTDIR', 'ENOENT'])

/**
 * 清除目标文件的只读属性。
 * Windows 上 readonly 文件对 writeFile / rename / copyFile 覆盖都会返回 EPERM，
 * Node 的 chmod 在 Windows 只影响只读位：写入位（0o200）存在即清除只读。
 */
async function clearReadOnly(target: string): Promise<void> {
  try {
    await fs.chmod(target, 0o666)
  } catch {
    // 忽略，交给后续写入重试判断
  }
}

/**
 * 向同一路径写入临时文件后替换目标文件
 * @param useRename true 表示同目录原子替换（先删后 rename）；false 表示跨盘复制覆盖
 */
async function writeTempAndReplace(
  tmpPath: string,
  target: string,
  data: Buffer,
  useRename: boolean
): Promise<void> {
  try {
    await fs.writeFile(tmpPath, data)
    // 目标可能是只读文件，先清除只读再替换
    await clearReadOnly(target)
    if (useRename) {
      try {
        await fs.rename(tmpPath, target)
      } catch {
        // Windows 上目标已存在时 rename 会失败，先删除再重命名
        await fs.unlink(target)
        await fs.rename(tmpPath, target)
      }
    } else {
      await fs.copyFile(tmpPath, target)
    }
  } finally {
    try {
      await fs.unlink(tmpPath)
    } catch {
      // 忽略清理失败
    }
  }
}

/** 单次写入的等待间隔（用于瞬态文件锁，如 Defender / 媒体索引占用） */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 格式化错误为「code message 」以便定位失败阶段 */
function describeErr(e: unknown): string {
  const err = e as NodeJS.ErrnoException
  const code = err?.code ? `${err.code} ` : ''
  return `${code}${err?.message || String(e)}`.trim()
}

/**
 * 单次写入尝试：①直接写入 → ②清除只读后重试 → ③同目录临时文件 + 重命名 → ④系统临时目录 + 复制替换
 */
async function writeFileOnce(filePath: string, data: Buffer): Promise<void> {
  const attemptLog: string[] = []

  // ① 直接写入
  try {
    await fs.writeFile(filePath, data)
    return
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code && !RETRYABLE_WRITE_CODES.has(code)) throw e
    attemptLog.push(`①直接写入: ${describeErr(e)}`)
  }

  // ② 清除只读属性后重试直接写入
  await clearReadOnly(filePath)
  try {
    await fs.writeFile(filePath, data)
    return
  } catch (e) {
    attemptLog.push(`②清只读后写入: ${describeErr(e)}`)
  }

  // ③ 同目录临时文件 + 原子重命名（避免跨盘且降低被拦截概率）
  const bare = filePath.replace(/\.[^/.\\]+$/, '')
  const sameDirTmp = `${bare}.${process.pid}.${Date.now()}.part`
  try {
    await writeTempAndReplace(sameDirTmp, filePath, data, true)
    return
  } catch (e) {
    attemptLog.push(`③同目录替换: ${describeErr(e)}`)
  }

  // ④ 系统临时目录 + 复制替换
  const sysTmp = join(tmpdir(), `${basename(filePath)}.${process.pid}.${Date.now()}.part`)
  try {
    await writeTempAndReplace(sysTmp, filePath, data, false)
  } catch (e) {
    attemptLog.push(`④系统临时替换: ${describeErr(e)}`)
    throw new Error(`写入文件失败: ${filePath}（${attemptLog.join(' | ')}）`, { cause: e })
  }
}

/**
 * 向音频文件写入标签数据。
 * Windows 下只读属性 / 防病毒软件 / 瞬态文件锁（Defender、媒体索引等）会拦截
 * 对原文件的写覆盖（EPERM）。方案：①-④ 多级容错 + ⑤ 指数退避整轮重试，
 * 以扛过保存瞬间出现的短暂文件占用。
 */
async function writeFileRobust(filePath: string, data: Buffer): Promise<void> {
  // 16 次尝试：首轮立即，之后逐步退避到 10s。
  // Windows Defender 实时防护扫描新写入的音频文件（尤其大 FLAC）会短暂加锁（EPERM），
  // 只要扫描窗口是瞬态的，增大重试次数与间隔即可错开并最终写入成功。
  const retries = 16
  const backoff = [0, 100, 200, 300, 500, 800, 1200, 1800, 2500, 3500, 4500, 5500, 6500, 7500, 8500, 10000]
  let lastError: unknown

  for (let i = 0; i < retries; i++) {
    if (i > 0) {
      await sleep(backoff[Math.min(i, backoff.length - 1)])
    }
    try {
      await writeFileOnce(filePath, data)
      return
    } catch (e) {
      lastError = e
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`写入文件失败: ${filePath}（${reason}）`, { cause: lastError })
}

/**
 * 向音频文件写入元数据标签
 * @param filePath 音频文件路径
 * @param tags 标签数据
 */
export async function writeAudioMeta(filePath: string, tags: MusicMetaTags): Promise<boolean> {
  const ext = extname(filePath).toLowerCase()

  // 如果有封面图片数据，转换为 Buffer
  if (tags.image && typeof tags.image.imageBuffer === 'string') {
    tags.image.imageBuffer = Buffer.from(tags.image.imageBuffer, 'base64')
  }

  if (ext === '.mp3') {
    return writeMp3Tag(filePath, tags)
  } else if (ext === '.flac') {
    return writeFlacTag(filePath, tags)
  } else if (ext === '.wav') {
    return writeWavTag(filePath, tags)
  } else {
    throw new Error(`不支持的音频格式: ${ext}`)
  }
}

// ==================== MP3 标签写入 ====================

async function writeMp3Tag(filePath: string, tags: MusicMetaTags): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const NodeID3 = require('node-id3')

  const buffer = await fs.readFile(filePath)
  const success = NodeID3.update(tags, buffer)

  if (!success || success instanceof Error) {
    throw new Error('MP3 标签更新失败')
  }

  await writeFileRobust(filePath, success as Buffer)
  return true
}

// ==================== FLAC 标签写入 ====================

async function writeFlacTag(filePath: string, tags: MusicMetaTags): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const flac = require('flac-metadata')

  const fileBuffer = await fs.readFile(filePath)

  if (fileBuffer.toString('utf8', 0, 4) !== 'fLaC') {
    throw new Error('文件不是合法的 FLAC 格式')
  }

  let offset = 4
  const keptBlocks: Buffer[] = []
  let last = false

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

  const audioData = fileBuffer.slice(offset)

  const fixedKeptBlocks: Buffer[] = keptBlocks.map((b) => {
    const buf = Buffer.from(b)
    const header = buf.readUInt32BE(0)
    const newHeader = header & 0x7fffffff
    buf.writeUInt32BE(newHeader >>> 0, 0)
    return buf
  })

  const comments: string[] = [
    `TITLE=${tags.title || ''}`,
    `ARTIST=${tags.artist || ''}`,
    `ALBUM=${tags.album || ''}`,
    `DATE=${tags.year || ''}`,
    `LYRICS=${(tags.lyrics || '').replace(/\r\n/g, '\n')}`
  ]

  const vorbisBlock = flac.data.MetaDataBlockVorbisComment.create(
    false,
    'such-pc-ng',
    comments
  )
  const vorbisBuffer: Buffer = vorbisBlock.publish()

  let pictureBuffer: Buffer | null = null
  if (tags.image && (tags.image as any).imageBuffer) {
    const { imageBuffer, mime, description } = tags.image as any
    const pictureBlock = flac.data.MetaDataBlockPicture.create(
      true,
      3,
      mime || 'image/jpeg',
      description || '',
      0, 0, 0, 0,
      imageBuffer
    )
    pictureBuffer = pictureBlock.publish()
  }

  const blocksToWrite: Buffer[] = [...fixedKeptBlocks]

  if (pictureBuffer) {
    const vorbisHeader = vorbisBuffer.readUInt32BE(0) & 0x7fffffff
    vorbisBuffer.writeUInt32BE(vorbisHeader >>> 0, 0)
    blocksToWrite.push(vorbisBuffer, pictureBuffer)
  } else {
    const vorbisHeader = vorbisBuffer.readUInt32BE(0) | 0x80000000
    vorbisBuffer.writeUInt32BE(vorbisHeader >>> 0, 0)
    blocksToWrite.push(vorbisBuffer)
  }

  const metaSize = blocksToWrite.reduce((sum, b) => sum + b.length, 0)
  const outBuffer = Buffer.alloc(4 + metaSize + audioData.length)

  outBuffer.write('fLaC', 0, 'ascii')
  let pos = 4
  for (const b of blocksToWrite) {
    b.copy(outBuffer, pos)
    pos += b.length
  }
  audioData.copy(outBuffer, pos)

  await writeFileRobust(filePath, outBuffer)
  return true
}

// ==================== WAV 标签写入 ====================

async function writeWavTag(filePath: string, tags: MusicMetaTags): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WaveFile } = require('wavefile')

  const buffer = await fs.readFile(filePath)
  const wav = new WaveFile(buffer)

  if (tags.title) wav.setTag('TIT2', tags.title)
  if (tags.artist) wav.setTag('TPE1', tags.artist)
  if (tags.album) wav.setTag('TALB', tags.album)
  if (tags.year) wav.setTag('TYER', String(tags.year))

  if (tags.image && (tags.image as any).imageBuffer) {
    wav.setTag('APIC', {
      type: 3,
      data: (tags.image as any).imageBuffer,
      mime: (tags.image as any).mime || 'image/jpeg',
      description: (tags.image as any).description || ''
    })
  }

  const newBuffer = wav.toBuffer()
  await writeFileRobust(filePath, newBuffer)
  return true
}
