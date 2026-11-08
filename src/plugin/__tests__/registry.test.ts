import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginRegistry, type RegistryDeps } from '../registry'
import { ConfirmQueue } from '../runtime/confirm'
import type { PluginNotice } from '../../shared/plugin/types'

const CODE = `/**
 * @name Reg Demo
 * @id test.reg-demo
 * @version 1.2.3
 * @description 注册表测试
 * @author tester
 * @apiLevel 1
 */
such.register({
  sources: { demo: { name: 'Demo', actions: ['musicUrl', 'musicSearch'], qualities: ['320k'] } },
  settings: [{ key: 'enabled', type: 'switch', label: '启用', default: true }]
})
such.on('musicSearch', ({ keyword }) => ({ list: [{ id: '1', name: 'Hit ' + keyword }], hasMore: false }))
such.on('musicUrl', ({ musicInfo }) => ({ url: 'https://cdn/' + musicInfo.id + '.mp3' }))
`

let dir: string
let notices: PluginNotice[]

function makeRegistry(): PluginRegistry {
  const confirm = new ConfirmQueue({ send: () => {}, isAvailable: () => true })
  const deps: RegistryDeps = {
    userDataDir: dir,
    appVersion: '1.0.0',
    locale: 'zh-CN',
    confirm,
    playlistOp: async () => ({ requestId: 'x', success: true }),
    writeAudioMeta: async () => true,
    notify: (n) => notices.push(n)
  }
  return new PluginRegistry(deps)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'such-registry-'))
  notices = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('PluginRegistry', () => {
  it('安装 → 列表 → 搜索 → 设置 → 移除', async () => {
    const file = join(dir, 'demo.js')
    await writeFile(file, CODE, 'utf-8')

    const registry = makeRegistry()
    const summary = await registry.install(file)
    expect(summary).toMatchObject({
      name: 'Reg Demo',
      version: '1.2.3',
      headerId: 'test.reg-demo',
      enabled: true,
      state: 'running',
      settingCount: 1
    })
    expect(summary.id.startsWith('v2.')).toBe(true)
    expect(registry.list()).toHaveLength(1)

    // 搜索源目录
    const sources = registry.listSearchSources()
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ kind: 'v2', sourceKey: 'demo', label: 'Demo' })

    // 按 key 搜索
    const page = await registry.search({ pluginId: summary.id, providerId: 'demo', query: 'rain' })
    expect(page.items[0].title).toBe('Hit rain')

    // 播放地址
    const resolved = await registry.resolveUrl({
      pluginId: summary.id,
      sourceKey: 'demo',
      id: '1',
      ref: { id: '1', name: 'Hit rain' }
    })
    expect(resolved.url).toBe('https://cdn/1.mp3')

    // 设置
    expect(registry.getSettings(summary.id).values).toEqual({ enabled: true })
    const values = await registry.setSetting(summary.id, 'enabled', false)
    expect(values.enabled).toBe(false)
    await expect(registry.setSetting(summary.id, 'nope', 1)).rejects.toThrow('没有声明设置项')

    // 移除
    await registry.remove(summary.id)
    expect(registry.list()).toHaveLength(0)
    expect(notices.map((n) => n.type)).toContain('removed')
  })

  it('停用后解析报 PLUGIN_DISABLED，启用后恢复', async () => {
    const file = join(dir, 'demo.js')
    await writeFile(file, CODE, 'utf-8')
    const registry = makeRegistry()
    const summary = await registry.install(file)

    await registry.setEnabled(summary.id, false)
    expect(registry.get(summary.id)?.state).toBe('disabled')
    await expect(
      registry.resolveUrl({ pluginId: summary.id, sourceKey: 'demo', id: '1', ref: { id: '1' } })
    ).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' })

    await registry.setEnabled(summary.id, true)
    const resolved = await registry.resolveUrl({
      pluginId: summary.id,
      sourceKey: 'demo',
      id: '1',
      ref: { id: '1' }
    })
    expect(resolved.url).toBe('https://cdn/1.mp3')
  })

  it('已移除的插件报 PLUGIN_ERROR 而不是 NO_PLUGIN', async () => {
    const registry = makeRegistry()
    await expect(
      registry.resolveUrl({ pluginId: 'v2.gone-000000', sourceKey: 'demo', id: '1' })
    ).rejects.toMatchObject({ code: 'PLUGIN_ERROR' })
  })
})
