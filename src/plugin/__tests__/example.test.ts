/**
 * 示例插件冒烟测试
 *
 * `plugin_test/v2_demo_netease.js` 是文档里引用的对照模板，必须始终能被当前宿主加载：
 * 一旦 API 变更导致示例失效，这里先红，避免把过期的示例发给插件作者。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { V2PluginHost, type HostDeps } from '../host'
import { ConfirmQueue } from '../runtime/confirm'
import { parsePluginHeader } from '../header'

const EXAMPLE_PATH = resolve(__dirname, '../../../plugin_test/v2_demo_netease.js')
/** `plugin_test/` 在 .gitignore 里，干净克隆上没有该文件 */
const HAS_EXAMPLE = existsSync(EXAMPLE_PATH)

let dir: string
let code: string

function makeDeps(): HostDeps {
  return {
    userDataDir: dir,
    appVersion: '9.9.9',
    locale: 'zh-CN',
    confirm: new ConfirmQueue({ send: () => {}, isAvailable: () => true }),
    playlistOp: async () => ({ requestId: 'x', success: true }),
    writeAudioMeta: async () => true,
    notify: () => {}
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'such-example-'))
  code = await readFile(EXAMPLE_PATH, 'utf-8')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe.skipIf(!HAS_EXAMPLE)('plugin_test/v2_demo_netease.js', () => {
  it('插件头合法且能在沙箱里完成注册', async () => {
    const parsed = parsePluginHeader(code)
    expect(parsed.error).toBeUndefined()
    expect(parsed.header).toMatchObject({
      id: 'such.demo.netease',
      version: '1.0.0',
      apiLevel: 1,
      grants: ['network']
    })

    const host = new V2PluginHost(parsed.header!, join(dir, 'demo.js'), makeDeps())
    await host.init(code)

    expect(host.getState()).toBe('running')
    expect(host.getSourceSummaries()).toEqual([
      {
        key: 'wy',
        name: '网易云音乐',
        actions: ['musicSearch', 'musicUrl', 'musicLyric', 'musicPic'],
        qualities: ['128k', '320k', 'flac']
      }
    ])
    // 声明的设置项要能渲染出默认值
    expect(host.getSettingsSchema().map((f) => f.key)).toEqual(['searchLimit', 'preferHires'])
    expect(host.getSettings()).toEqual({ searchLimit: 30, preferHires: false })
  })
})
