/**
 * 音乐元数据写入工具
 * 支持 MP3 / FLAC / WAV 格式的标签写入
 * 供 IPC handler 和插件系统共用
 */
import { promises as fs } from 'fs'
import { extname } from 'path'

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

  await fs.writeFile(filePath, success as Buffer)
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

  await fs.writeFile(filePath, outBuffer)
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
  await fs.writeFile(filePath, newBuffer)
  return true
}
