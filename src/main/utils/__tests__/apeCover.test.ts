import { describe, expect, it } from 'vitest'
import { parseApeTag } from '../musicMetaReader'

/** 造一张「魔数正确」的假 JPEG / PNG（嗅探只看前 16 字节） */
function fakeImage(bytes: number[]): Buffer {
  const buf = Buffer.alloc(96)
  Buffer.from(bytes).copy(buf)
  return buf
}

const JPEG = fakeImage([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const PNG = fakeImage([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** APEv2 项：valueSize(u32LE) + itemFlags(u32LE) + key(\0) + value */
function apeItem(key: string, value: Buffer, isBinary = false): Buffer {
  return rawItem(key, value.length, value, isBinary ? 2 : 0)
}

/** 同上，但允许谎报 valueSize（用于构造截断/损坏的用例） */
function rawItem(key: string, valueSize: number, value: Buffer, flags = 0): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32LE(valueSize, 0)
  head.writeUInt32LE(flags, 4)
  return Buffer.concat([head, Buffer.from(key, 'latin1'), Buffer.from([0]), value])
}

/** APEv2 标签块：items + 32 字节 footer */
function apeTag(
  items: Buffer[],
  opts?: { flags?: number; tagSize?: number; itemCount?: number }
): Buffer {
  const body = Buffer.concat(items)
  const footer = Buffer.alloc(32)
  footer.write('APETAGEX', 0, 'latin1')
  footer.writeUInt32LE(2000, 8)
  footer.writeUInt32LE(opts?.tagSize ?? body.length + 32, 12)
  footer.writeUInt32LE(opts?.itemCount ?? items.length, 16)
  footer.writeUInt32LE(opts?.flags ?? 0, 20)
  return Buffer.concat([body, footer])
}

/** APEv2 的封面值是「文件名 \0 图片数据」 */
function coverValue(fileName: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(fileName, 'latin1'), Buffer.from([0]), data])
}

describe('parseApeTag', () => {
  it('从 Cover Art (Front) 二进制项里取出封面，并读出文本标签', () => {
    const tag = apeTag([
      apeItem('Title', Buffer.from('测试标题', 'utf8')),
      apeItem('Artist', Buffer.from('测试歌手', 'utf8')),
      apeItem('Cover Art (Front)', coverValue('cover.jpg', JPEG), true)
    ])

    const meta = parseApeTag(tag)
    expect(meta).not.toBeNull()
    expect(meta!.title).toBe('测试标题')
    expect(meta!.artists).toEqual(['测试歌手'])
    // 文件名前缀必须被剥掉，留下的是纯图片字节
    expect(Buffer.from(meta!.cover!.data).equals(JPEG)).toBe(true)
  })

  it('前封面优先于封底，与项顺序无关', () => {
    const back = apeItem('Cover Art (Back)', coverValue('back.png', PNG), true)
    const front = apeItem('Cover Art (Front)', coverValue('front.jpg', JPEG), true)

    for (const items of [[back, front], [front, back]]) {
      const meta = parseApeTag(apeTag(items))
      expect(Buffer.from(meta!.cover!.data).equals(JPEG)).toBe(true)
    }
  })

  it('兼容省略文件名的裸图片值', () => {
    const meta = parseApeTag(apeTag([apeItem('Cover Art (Front)', JPEG, true)]))
    expect(Buffer.from(meta!.cover!.data).equals(JPEG)).toBe(true)
  })

  it('tagSize 溢出时放弃解析（损坏文件不猜）', () => {
    const tag = apeTag([apeItem('Title', Buffer.from('x'))], { tagSize: 999999 })
    expect(parseApeTag(tag)).toBeNull()
  })

  it('valueSize 谎报导致越界时停止解析', () => {
    const items = rawItem('Title', 100000, Buffer.from('x'))
    expect(parseApeTag(apeTag([items]))).toBeNull()
  })

  it('footer 后面还跟着 128 字节 ID3v1 标签也能找到 footer', () => {
    const id3v1 = Buffer.alloc(128)
    id3v1.write('TAG', 0, 'latin1')
    const buf = Buffer.concat([
      apeTag([apeItem('Cover Art (Front)', coverValue('a.jpg', JPEG), true)]),
      id3v1
    ])
    const meta = parseApeTag(buf)
    expect(Buffer.from(meta!.cover!.data).equals(JPEG)).toBe(true)
  })

  it('没有封面时照样返回文本标签', () => {
    const meta = parseApeTag(apeTag([apeItem('Album', Buffer.from('专辑名', 'utf8'))]))
    expect(meta?.album).toBe('专辑名')
    expect(meta?.cover).toBeUndefined()
  })

  it('完全不是 APEv2 的数据返回 null', () => {
    expect(parseApeTag(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'))).toBeNull()
  })
})
