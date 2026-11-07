/**
 * 酷狗音乐插件的解析链路测试（不联网）
 *
 * `plugin_test/kugou_music.js` 移植自 Lyrico `com.kugou.source` 0.5.0。
 * 这里用假 `such` 驱动沙箱里的 handler，锁定三件容易回归的事：
 * 1. 注册声明与设置项
 * 2. 搜索响应 → 候选字段（播放/歌词要用的 hash、albumId 不能丢）
 * 3. KRC → YRC 的逐字时间换算、尖括号换圆括号，以及翻译逐行对齐
 *
 * `plugin_test/` 在 .gitignore 里，文件不存在时整组跳过。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSandbox } from '../runtime/sandbox'
import { parsePluginHeader } from '../header'

const PLUGIN_PATH = resolve(__dirname, '../../../plugin_test/kugou_music.js')
const HAS_PLUGIN = existsSync(PLUGIN_PATH)

/** 解密后的 KRC 明文：两行正文 + 一份 type=1 的中文翻译 */
const KRC_TEXT = [
  '[ti:测试歌曲]',
  '[0,1000]<0,500,0>你<500,500,0>好',
  '[1000,1000]<0,1000,0>世界',
  `[language:${Buffer.from(
    JSON.stringify({ content: [{ type: 1, lyricContent: [['你好'], ['世界']] }] })
  ).toString('base64')}]`
].join('\n')

/** 搜索接口的响应（截自真实返回，只保留插件用到的字段） */
const SEARCH_BODY = {
  error_code: 0,
  data: {
    total: 434,
    lists: [
      {
        ID: 32042828,
        SongName: '稻香',
        FileHash: '8909E1809908CD8E3BF6CF85D98B93F0',
        AlbumID: '960399',
        Duration: 223,
        Singers: [{ name: '周杰伦' }],
        Image: 'http://imge.kugou.com/stdmusic/{size}/20241118/cover.jpg',
        Grp: [
          {
            ID: 615188888,
            SongName: '稻香 (现场版)',
            FileHash: 'AAAA1111',
            Duration: 230,
            Singers: [{ name: '周杰伦' }],
            Image: 'http://imge.kugou.com/stdmusic/{size}/live.jpg'
          }
        ]
      }
    ]
  }
}

describe.skipIf(!HAS_PLUGIN)('plugin_test/kugou_music.js', () => {
  it('插件头合法', async () => {
    const code = await readFile(PLUGIN_PATH, 'utf-8')
    const parsed = parsePluginHeader(code)
    expect(parsed.error).toBeUndefined()
    expect(parsed.header).toMatchObject({
      id: 'kugou-music',
      version: '1.0.0',
      apiLevel: 1,
      grants: ['network']
    })
  })

  it('注册出酷狗音源与三个设置项', async () => {
    const code = await readFile(PLUGIN_PATH, 'utf-8')
    let registered: any = null
    const sandbox = createSandbox('test-kugou-register', {
      globals: 'v2',
      extra: { such: makeSuch({ register: (decl: any) => (registered = decl) }) }
    })
    sandbox.run(code, 'kugou_music.js', 8000)

    expect(registered.sources.kugou).toEqual({
      name: '酷狗音乐',
      actions: ['musicSearch', 'musicUrl', 'musicLyric', 'musicPic'],
      qualities: ['128k', '320k']
    })
    expect(registered.settings.map((s: any) => s.key)).toEqual([
      'includeVersions',
      'lyricTranslation',
      'coverSize'
    ])
  })

  it('搜索：展开 Grp 版本并保留播放/歌词所需的内部标识', async () => {
    const code = await readFile(PLUGIN_PATH, 'utf-8')
    let handler: ((payload: unknown) => unknown) | null = null
    const sandbox = createSandbox('test-kugou-search', {
      globals: 'v2',
      extra: {
        such: makeSuch({
          search: (h: (payload: unknown) => unknown) => (handler = h),
          body: SEARCH_BODY
        })
      }
    })
    sandbox.run(code, 'kugou_music.js', 8000)

    const result = (await (handler as any)({ keyword: '稻香', page: 1, limit: 10 })) as {
      list: any[]
      total: number
      hasMore: boolean
    }

    expect(result.list).toHaveLength(2)
    expect(result.total).toBe(434)
    expect(result.hasMore).toBe(true)
    expect(result.list[0]).toMatchObject({
      id: '32042828',
      name: '稻香',
      singer: '周杰伦',
      album: '',
      durationMs: 223000,
      hash: '8909E1809908CD8E3BF6CF85D98B93F0',
      albumId: '960399',
      // 封面里的 {size} 要按设置替换掉
      cover: 'https://imge.kugou.com/stdmusic/480/20241118/cover.jpg'
    })
    expect(result.list[1].name).toBe('稻香 (现场版)')
  })

  it('歌词：KRC 转成逐字 YRC，并对齐翻译', async () => {
    const code = await readFile(PLUGIN_PATH, 'utf-8')
    let handler: ((payload: unknown) => unknown) | null = null
    const sandbox = createSandbox('test-kugou-lyric', {
      globals: 'v2',
      extra: {
        such: makeSuch({
          lyric: (h: (payload: unknown) => unknown) => (handler = h),
          // download 接口返回的密文内容，解密由 zlib 桩直接给出明文
          download: { contenttype: 0, content: Buffer.from('fake-krc-body').toString('base64') },
          krc: KRC_TEXT
        })
      }
    })
    sandbox.run(code, 'kugou_music.js', 8000)

    const result = (await (handler as any)({
      source: 'kugou',
      musicInfo: { id: '1', name: '测试歌曲', singer: '某人', hash: 'HASH', durationMs: 2000 }
    })) as { lyric: string; tlyric: string }

    // 行级 [起点,时长] + 词级 (绝对起点,时长,0) —— 词时间要从行内相对换算成绝对
    expect(result.lyric.split('\n')).toEqual([
      '[0,1000](0,500,0)你(500,500,0)好',
      '[1000,1000](1000,1000,0)世界'
    ])
    expect(result.tlyric).toBe('[00:00.00]你好\n[00:01.00]世界')
  })
})

interface SuchStubOptions {
  register?: (decl: any) => void
  search?: (handler: (payload: unknown) => unknown) => void
  lyric?: (handler: (payload: unknown) => unknown) => void
  body?: unknown
  download?: { contenttype: number; content: string }
  krc?: string
}

/** 造一个最小的 `such` 桩：网络请求全部从内存返回 */
function makeSuch(options: SuchStubOptions = {}): Record<string, any> {
  const settings: Record<string, unknown> = {
    includeVersions: true,
    lyricTranslation: true,
    coverSize: '480'
  }
  const store: Record<string, unknown> = {}

  return {
    register: (decl: any) => options.register?.(decl),
    on: (action: string, handler: (payload: unknown) => unknown) => {
      if (action === 'musicSearch') options.search?.(handler)
      if (action === 'musicLyric') options.lyric?.(handler)
    },
    getSetting: (key: string) => settings[key],
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    storage: {
      get: (key: string) => store[key],
      set: (key: string, value: unknown) => {
        store[key] = value
      }
    },
    utils: {
      // 插件内的 md5 只用于签名，这里固定返回定长字符串即可
      crypto: { md5: () => 'stub-md5-value' },
      base64: { decode: (text: string) => Buffer.from(text, 'base64').toString('utf-8') },
      buffer: {
        from: (data: any, encoding?: string) =>
          Buffer.isBuffer(data) ? data : Buffer.from(String(data), (encoding as BufferEncoding) ?? 'utf8'),
        bufToString: (buf: any, encoding?: string) =>
          Buffer.from(buf).toString((encoding as BufferEncoding) ?? 'utf8')
      },
      // XOR 之后的字节不重要：直接给出 KRC 明文
      zlib: { inflate: () => Buffer.from(options.krc ?? '', 'utf-8') }
    },
    async request(url: string) {
      if (url.includes('complexsearch.kugou.com')) {
        return { status: 200, headers: {}, body: JSON.stringify(options.body ?? {}) }
      }
      if (url.includes('lyrics.kugou.com/v1/search')) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ candidates: [{ id: 'c1', accesskey: 'ak' }] })
        }
      }
      if (url.includes('lyrics.kugou.com/download')) {
        return { status: 200, headers: {}, body: JSON.stringify(options.download ?? {}) }
      }
      throw new Error(`未预期的请求：${url}`)
    }
  }
}
