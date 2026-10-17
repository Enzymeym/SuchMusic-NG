import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SourcePluginRegistry, SourcePluginError } from '../registry'

/**
 * 音源路由回归测试
 *
 * 背景（线上问题）：导入音源插件后，在搜索页播放 QQ 音乐曲目仍然提示
 * 「未找到音源插件」。原因是：
 *  1. 插件按 providerId（如 qq / tencent）声明音源，而 QQ 搜索页固定传 tx，
 *     字面比较找不到插件；
 *  2. 渲染层把所有失败都吞成 null，于是「插件解析失败」也显示成「没找到插件」。
 */

const LX_PLUGIN = `/**
 * @name 别名测试洛雪音源
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, ({ action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('unsupported'))
  return Promise.resolve('https://cdn.example.com/' + info.musicInfo.mid + '.mp3')
})
send(EVENT_NAMES.inited, {
  sources: {
    tx: { name: 'QQ音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] }
  }
})
`

/** 澜音插件：providerId 用 qq（而不是洛雪的 tx） */
const CERU_PLUGIN = `exports.manifest = {
  manifestVersion: 2,
  id: 'test.ceru.qq',
  name: '澜音 QQ 音源',
  version: '1.0.0',
  contributes: { providers: [{ id: 'qq', name: 'QQ音乐', protocols: ['music.resolve@1'], qualities: ['128k', '320k'] }] }
}
exports.activate = function (ctx) {
  ctx.providers.register('qq', {
    tracks: {
      async resolve(resource) {
        return { ok: true, url: 'https://cdn.example.com/' + resource.id + '.mp3' }
      }
    }
  })
}
`

/** 洛雪插件：解析必定失败（模拟版权受限 / 上游接口全挂） */
const FAILING_LX_PLUGIN = `/**
 * @name 解析失败测试
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, () => Promise.reject(new Error('版权受限，无法获取播放地址')))
send(EVENT_NAMES.inited, {
  sources: {
    tx: { name: 'QQ音乐', type: 'music', actions: ['musicUrl'], qualitys: ['320k'] }
  }
})
`

function writeTempPlugin(name: string, code: string): string {
  // 直接落在系统临时目录，registry.loadFromFile 只需要可读路径
  const file = join(tmpdir(), name)
  writeFileSync(file, code, 'utf-8')
  return file
}

/** 洛雪插件：把插件实际收到的音质回显到地址里，便于断言「按插件偏好收敛」 */
const QUALITY_LX_PLUGIN = `/**
 * @name 音质偏好测试
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, ({ action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('unsupported'))
  return Promise.resolve('https://cdn.example.com/' + info.musicInfo.mid + '-' + info.type + '.mp3')
})
send(EVENT_NAMES.inited, {
  sources: {
    tx: { name: 'QQ音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] }
  }
})
`

describe('音源路由：平台标识别名', () => {
  it('洛雪插件声明 tx，调用方传 qq 也能命中', async () => {
    const registry = new SourcePluginRegistry()
    await registry.loadFromFile(writeTempPlugin('such-lx-alias.js', LX_PLUGIN), {
      persist: false
    })
    const res = await registry.resolveUrl({
      sourceKey: 'qq',
      id: 'mid-1',
      ref: { mid: 'mid-1' },
      quality: '320k'
    })
    expect(res.url).toBe('https://cdn.example.com/mid-1.mp3')
  })

  it('澜音插件声明 providerId=qq，QQ 搜索页传 tx 也能命中', async () => {
    const registry = new SourcePluginRegistry()
    await registry.loadFromFile(writeTempPlugin('such-ceru-alias.js', CERU_PLUGIN), {
      persist: false
    })
    const res = await registry.resolveUrl({
      sourceKey: 'tx',
      id: 'track-1',
      quality: '320k'
    })
    expect(res.url).toBe('https://cdn.example.com/track-1.mp3')
    expect(res.pluginId).toBe('test.ceru.qq')
  })

  it('没有任何可用插件时给出带错误码的可读原因', async () => {
    const registry = new SourcePluginRegistry()
    await expect(
      registry.resolveUrl({ sourceKey: 'tx', id: 'x', quality: '320k' })
    ).rejects.toMatchObject({ code: 'NO_PLUGIN' })
    try {
      await registry.resolveUrl({ sourceKey: 'tx', id: 'x', quality: '320k' })
    } catch (err) {
      expect(err).toBeInstanceOf(SourcePluginError)
      expect((err as SourcePluginError).message).toContain('tx')
      expect((err as SourcePluginError).message).toContain('没有已加载的音源插件')
    }
  })

  it('插件解析抛错时透出真实原因（不再伪装成「未找到插件」）', async () => {
    const registry = new SourcePluginRegistry()
    await registry.loadFromFile(writeTempPlugin('such-lx-fail.js', FAILING_LX_PLUGIN), {
      persist: false
    })
    await expect(
      registry.resolveUrl({ sourceKey: 'tx', id: 'mid-2', quality: '320k' })
    ).rejects.toMatchObject({ code: 'RESOLVE_FAILED' })
    try {
      await registry.resolveUrl({ sourceKey: 'tx', id: 'mid-2', quality: '320k' })
    } catch (err) {
      expect((err as SourcePluginError).message).toContain('解析失败')
      expect((err as SourcePluginError).message).toContain('版权受限')
    }
  })

  it('歌曲残留已停用插件的 pluginId 时，仍回退到可用插件', async () => {
    const registry = new SourcePluginRegistry()
    const disabled = await registry.loadFromFile(
      writeTempPlugin('such-lx-disabled.js', LX_PLUGIN),
      { persist: false, enabled: false }
    )
    await registry.loadFromFile(writeTempPlugin('such-ceru-alias2.js', CERU_PLUGIN), {
      persist: false
    })

    const res = await registry.resolveUrl({
      pluginId: disabled.id,
      sourceKey: 'tx',
      id: 'track-9',
      quality: '320k'
    })
    expect(res.url).toBe('https://cdn.example.com/track-9.mp3')
    expect(res.pluginId).toBe('test.ceru.qq')
  })
})

describe('音源插件偏好：每个插件独立的音乐源与音质', () => {
  it('插件音质偏好优先于调用方默认音质，显式指定（下载）则反过来', async () => {
    const registry = new SourcePluginRegistry()
    const info = await registry.loadFromFile(
      writeTempPlugin('such-lx-quality.js', QUALITY_LX_PLUGIN),
      { persist: false }
    )
    await registry.setPreferences(info.id, { quality: 'flac' })

    const preferred = await registry.resolveUrl({
      sourceKey: 'tx',
      id: 'q-1',
      quality: '320k'
    })
    expect(preferred.url).toContain('-flac.mp3')

    const explicit = await registry.resolveUrl({
      sourceKey: 'tx',
      id: 'q-2',
      quality: '320k',
      qualityOverride: '128k'
    })
    expect(explicit.url).toContain('-128k.mp3')
  })

  it('关闭的音乐源不再参与解析，并回退到其它插件', async () => {
    const registry = new SourcePluginRegistry()
    const lx = await registry.loadFromFile(writeTempPlugin('such-lx-off.js', QUALITY_LX_PLUGIN), {
      persist: false
    })
    await registry.loadFromFile(writeTempPlugin('such-ceru-off.js', CERU_PLUGIN), {
      persist: false
    })

    // 关掉洛雪插件的 tx → tx 请求应落到澜音插件（providerId=qq 属同一别名组）
    await registry.setPreferences(lx.id, { sources: [] })
    expect(registry.get(lx.id)?.settings?.sources).toEqual([])

    const res = await registry.resolveUrl({ sourceKey: 'tx', id: 'track-off', quality: '320k' })
    expect(res.pluginId).toBe('test.ceru.qq')
  })

  it('只改音质时不会重置已关闭的音乐源', async () => {
    const registry = new SourcePluginRegistry()
    const info = await registry.loadFromFile(writeTempPlugin('such-lx-keep.js', QUALITY_LX_PLUGIN), {
      persist: false
    })
    await registry.setPreferences(info.id, { sources: [] })
    await registry.setPreferences(info.id, { quality: 'flac' })
    expect(registry.get(info.id)?.settings).toMatchObject({ sources: [], quality: 'flac' })
  })
})
