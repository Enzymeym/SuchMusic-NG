/**
 * Apple Music 插件的解析链路测试（不联网）
 *
 * `plugin_test/apple_music.js` 是移植自 Lyrico 的示例源，宿主 API 变化时这里先红。
 * 用假 `such` 直接驱动沙箱里的 handler，因此不依赖 Apple 接口可用性：
 * developer token 抓取、TTML → LRC 与翻译对齐都在本地桩上验证。
 *
 * `plugin_test/` 在 .gitignore 里，文件不存在时整组跳过，避免干净克隆上误报。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSandbox } from '../runtime/sandbox'
import { parsePluginHeader } from '../header'

const PLUGIN_PATH = resolve(__dirname, '../../../plugin_test/apple_music.js')
const HAS_PLUGIN = existsSync(PLUGIN_PATH)

/** 一份最小 TTML：两行正文 + 一份简体中文 replacement 翻译 */
const TTML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>',
  '<p begin="00:00:10.500" end="00:00:13.000" itunes:key="L1">',
  '<span begin="00:00:10.500" end="00:00:10.900">Hello</span> ',
  '<span begin="00:00:10.900" end="00:00:13.000">world</span></p>',
  '<p begin="13s" end="16s" itunes:key="L2">Second &amp; line</p>',
  '<translation xml:lang="zh-Hans" type="replacement">',
  '<text for="L1">你好世界</text><text for="L2">第二行</text>',
  '</translation>',
  '</div></body></tt>'
].join('')

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** 只校验 kid/iss/alg/exp，签名不验 —— 所以这里可以用假签名 */
const NOW = Math.floor(Date.now() / 1000)
const FAKE_JWT = [
  b64url({ alg: 'ES256', kid: 'WebPlayKid' }),
  b64url({ iss: 'AMPWebPlay', iat: NOW, exp: NOW + 86400 }),
  'signature-placeholder-needs-20-chars'
].join('.')

describe.skipIf(!HAS_PLUGIN)('plugin_test/apple_music.js', () => {
  it('插件头合法', async () => {
    const code = await readFile(PLUGIN_PATH, 'utf-8')
    const parsed = parsePluginHeader(code)
    expect(parsed.error).toBeUndefined()
    expect(parsed.header).toMatchObject({
      id: 'such.applemusic',
      version: '0.5.0',
      apiLevel: 1,
      grants: ['network']
    })
  })

  it('注册出 Apple Music 音源与设置项', async () => {
    const code = await readFile(PLUGIN_PATH, 'utf-8')
    let registered: any = null
    const sandbox = createSandbox('test-apple-register', {
      globals: 'v2',
      extra: {
        such: makeSuch({ register: (decl: any) => (registered = decl) })
      }
    })
    sandbox.run(code, 'apple_music.js', 8000)

    expect(registered.sources.apple).toEqual({
      name: 'Apple Music',
      actions: ['musicSearch', 'musicUrl', 'musicLyric', 'musicPic'],
      qualities: ['128k', '320k']
    })
    expect(registered.settings.map((s: any) => s.key)).toEqual([
      'region',
      'language',
      'lyricsProvider',
      'mediaUserToken',
      'coverSize',
      'artistSeparator'
    ])
  })

  it('官方歌词：TTML 转 LRC 并对齐翻译', async () => {
    const code = await readFile(PLUGIN_PATH, 'utf-8')
    let lyricHandler: ((payload: unknown) => unknown) | null = null
    const sandbox = createSandbox('test-apple-lyric', {
      globals: 'v2',
      extra: {
        such: makeSuch({
          settings: { lyricsProvider: 'apple', mediaUserToken: 'dummy' },
          lyric: (handler: (payload: unknown) => unknown) => (lyricHandler = handler),
          ttml: TTML
        })
      }
    })
    sandbox.run(code, 'apple_music.js', 8000)

    const result = (await (lyricHandler as any)({
      source: 'apple',
      musicInfo: { id: '1', name: 'T' }
    })) as { lyric: string; tlyric: string } | null

    expect(result).not.toBeNull()
    expect(result!.lyric).toBe('[00:10.50]Hello world\n[00:13.00]Second & line')
    expect(result!.tlyric).toBe('[00:10.50]你好世界\n[00:13.00]第二行')
  })
})

interface SuchStubOptions {
  register?: (decl: any) => void
  lyric?: (handler: (payload: unknown) => unknown) => void
  settings?: Record<string, unknown>
  ttml?: string
}

/** 造一个最小的 `such` 桩：所有网络请求都从内存返回 */
function makeSuch(options: SuchStubOptions = {}): Record<string, any> {
  const settings: Record<string, unknown> = {
    region: 'cn',
    language: 'zh-Hans',
    lyricsProvider: 'auto',
    mediaUserToken: '',
    coverSize: '3000',
    artistSeparator: ' / ',
    ...(options.settings ?? {})
  }

  return {
    register: (decl: any) => options.register?.(decl),
    on: (action: string, handler: (payload: unknown) => unknown) => {
      if (action === 'musicLyric') options.lyric?.(handler)
    },
    getSetting: (key: string) => settings[key],
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    storage: { get: () => undefined, set: async () => {} },
    utils: {
      base64: { decode: (text: string) => Buffer.from(text, 'base64').toString('utf-8') }
    },
    async request(url: string) {
      if (url === 'https://music.apple.com/') {
        return { status: 200, headers: {}, body: '<script src="/assets/index~abc.js"></script>' }
      }
      if (url.includes('/assets/')) {
        return { status: 200, headers: {}, body: `x="${FAKE_JWT}"` }
      }
      if (url.includes('/catalog/cn/songs/')) {
        return {
          status: 200,
          headers: {},
          body: {
            data: [
              {
                id: '1',
                attributes: { name: 'T' },
                relationships: {
                  'syllable-lyrics': {
                    data: [{ attributes: { ttmlLocalizations: { 'zh-Hans': options.ttml ?? '' } } }]
                  }
                }
              }
            ]
          }
        }
      }
      throw new Error(`未预期的请求：${url}`)
    }
  }
}
