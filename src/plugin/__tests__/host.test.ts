import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { V2PluginHost, type HostDeps } from '../host'
import { ConfirmQueue } from '../runtime/confirm'
import { parsePluginHeader } from '../header'
import type { SuchPluginHeader } from '../types'

const PLUGIN_CODE = `/**
 * @name Demo
 * @id test.demo
 * @version 1.0.0
 * @apiLevel 1
 * @grant ui
 */
such.register({
  sources: {
    demo: {
      name: 'Demo source',
      actions: ['musicUrl', 'musicSearch', 'musicLyric', 'musicPic'],
      qualities: ['128k', '320k']
    }
  },
  settings: [
    { key: 'pageSize', type: 'number', label: '每页数量', default: 2, min: 1, max: 50 },
    { key: 'mode', type: 'select', label: '模式', default: 'a', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }
  ]
})

such.on('musicSearch', ({ keyword, limit }) => ({
  list: [
    { id: '1', name: 'Song ' + keyword, singer: 'Artist', durationMs: 1000 },
    { id: '2', name: 'Second', singer: 'Artist' }
  ].slice(0, limit || 10),
  hasMore: false
}))

such.on('musicUrl', ({ musicInfo, quality }) => ({
  url: 'https://example.com/' + musicInfo.id + '.mp3',
  quality
}))

such.on('musicLyric', () => ({ lyric: '[00:00.00]hi', tlyric: 'trans' }))
such.on('musicPic', ({ musicInfo }) => ({ url: 'https://example.com/' + musicInfo.id + '.jpg' }))
`

/** 搜索返回一条超大候选（> 8KiB） */
const OVERSIZED_CODE = `/**
 * @name Big
 * @id test.big
 * @version 1.0.0
 * @apiLevel 1
 */
such.register({ sources: { big: { name: 'Big', actions: ['musicSearch'] } } })
such.on('musicSearch', () => ({
  list: [
    { id: 'ok', name: 'Fine' },
    { id: 'huge', name: 'Huge', blob: 'x'.repeat(9000) }
  ]
}))
`

/** 未声明 @grant ui 却调用 such.notify */
const NO_GRANT_CODE = `/**
 * @name NoGrant
 * @id test.nogrant
 * @version 1.0.0
 * @apiLevel 1
 */
such.register({ sources: { d: { name: 'D', actions: ['musicUrl'] } } })
try {
  such.notify('hello')
} catch (err) {
  such.storage.set('grantError', err.message)
}
`

let dir: string

function makeDeps(): HostDeps {
  const confirm = new ConfirmQueue({ send: () => {}, isAvailable: () => true })
  return {
    userDataDir: dir,
    appVersion: '9.9.9',
    locale: 'zh-CN',
    confirm,
    playlistOp: async () => ({ requestId: 'x', success: true }),
    writeAudioMeta: async () => true,
    notify: () => {}
  }
}

function headerOf(code: string): SuchPluginHeader {
  const parsed = parsePluginHeader(code)
  if (!parsed.header) throw new Error(parsed.error)
  return parsed.header
}

async function createHost(code: string, filePath = join(dir, 'demo.js')): Promise<V2PluginHost> {
  const host = new V2PluginHost(headerOf(code), filePath, makeDeps())
  await host.init(code)
  return host
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'such-plugin-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('V2PluginHost', () => {
  it('init 后能力与设置 schema 就绪', async () => {
    const host = await createHost(PLUGIN_CODE)
    expect(host.getState()).toBe('running')
    expect(host.getSourceSummaries()).toEqual([
      {
        key: 'demo',
        name: 'Demo source',
        actions: ['musicUrl', 'musicSearch', 'musicLyric', 'musicPic'],
        qualities: ['128k', '320k']
      }
    ])
    expect(host.getSettingsSchema().map((f) => f.key)).toEqual(['pageSize', 'mode'])
    expect(host.getSettings()).toEqual({ pageSize: 2, mode: 'a' })
  })

  it('搜索归一成统一曲目结构', async () => {
    const host = await createHost(PLUGIN_CODE)
    const page = await host.search({ sourceKey: 'demo', keyword: 'rain', limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      pluginId: host.id,
      sourceKey: 'demo',
      id: '1',
      title: 'Song rain',
      artist: 'Artist',
      durationMs: 1000,
      playable: true
    })
    // ref 必须是可持久化的原始候选
    expect((page.items[0].ref as any).id).toBe('1')
  })

  it('播放地址按插件声明的音质收敛（请求 flac → 回落到 320k）', async () => {
    const host = await createHost(PLUGIN_CODE)
    const res = await host.resolveUrl({
      sourceKey: 'demo',
      id: '1',
      ref: { id: '1', name: 'Song' },
      quality: 'flac'
    })
    expect(res.url).toBe('https://example.com/1.mp3')
  })

  it('歌词与封面', async () => {
    const host = await createHost(PLUGIN_CODE)
    const lyric = await host.lyric({ sourceKey: 'demo', id: '1', ref: { id: '1', name: 'S' } })
    expect(lyric).toMatchObject({ lyrics: '[00:00.00]hi', translatedLyrics: 'trans' })
    const pic = await host.pic({ sourceKey: 'demo', id: '1', ref: { id: '1', name: 'S' } })
    expect(pic?.url).toBe('https://example.com/1.jpg')
  })

  it('超过 8KiB 的候选被跳过，其余照常返回', async () => {
    const host = await createHost(OVERSIZED_CODE, join(dir, 'big.js'))
    const page = await host.search({ sourceKey: 'big', keyword: 'x' })
    expect(page.items.map((t) => t.id)).toEqual(['ok'])
    expect(host.logs.entries().some((e) => e.message.includes('8'))).toBe(true)
  })

  it('未声明 @grant 的能力被拒绝', async () => {
    const host = await createHost(NO_GRANT_CODE, join(dir, 'nogrant.js'))
    expect(String(host.storage.get('grantError'))).toContain('@grant ui')
  })

  it('未声明 sources 的插件加载失败', async () => {
    const code = `/**
 * @name Empty
 * @id test.empty
 * @version 1.0.0
 * @apiLevel 1
 */
such.register({})
`
    const host = new V2PluginHost(headerOf(code), join(dir, 'empty.js'), makeDeps())
    await expect(host.init(code)).rejects.toThrow('未声明任何音源')
  })

  it('dispose 后调用被拒绝', async () => {
    const host = await createHost(PLUGIN_CODE)
    await host.dispose()
    await expect(host.search({ sourceKey: 'demo', keyword: 'x' })).rejects.toThrow('已卸载')
    await expect(host.setSetting('pageSize', 3)).rejects.toThrow('已卸载')
  })

  it('设置写入会触发插件侧的 onSettingChange', async () => {
    const code = `/**
 * @name Watch
 * @id test.watch
 * @version 1.0.0
 * @apiLevel 1
 */
such.register({
  sources: { d: { name: 'D', actions: ['musicUrl'] } },
  settings: [{ key: 'v', type: 'text', label: 'V', default: '' }]
})
such.onSettingChange((value, key) => { such.storage.set('seen', key + '=' + value) })
`
    const host = new V2PluginHost(headerOf(code), join(dir, 'watch.js'), makeDeps())
    await host.init(code)
    await host.setSetting('v', 'abc')
    expect(host.getSettings().v).toBe('abc')
    expect(host.storage.get('seen')).toBe('v=abc')
  })
})
