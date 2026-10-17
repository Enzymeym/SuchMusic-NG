import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { CeruSourceHost } from '../ceruHost'
import { createCryptoModule, createEncodingModule } from '../ceru/modules'

/**
 * 澜音（Ceru）打包产物兼容性回归测试
 *
 * 背景：澜音 CLI 会把宿主内建模块编译成
 *   `module.exports = globalThis.__ceruRequire('@ceru/xxx')`
 * 且这些调用出现在**插件文件顶层**（早于 activate）。宿主若不注入 `__ceruRequire`，
 * 导入插件时会直接报 `globalThis.__ceruRequire is not a function`。
 */
const PLUGIN = `
exports.manifest = {
  manifestVersion: 2,
  id: 'test.ceru.require',
  name: '宿主模块兼容',
  version: '1.0.0',
  engines: { hostApi: '^2.0.0', logicRuntime: 'ceru-js@1' },
  contributes: { providers: [{ id: 'demo', name: 'Demo' }] }
}

// 模拟 CLI 产物：文件顶层取宿主模块
var crypto = globalThis.__ceruRequire('@ceru/crypto')
var legacyHttp = globalThis.__ceruRequire('@ceru/legacy-http')
// 依赖 ctx 的模块在求值阶段只做惰性引用，不能抛错
var lazyCeru = globalThis.__ceruRequire('ceru')

var digest = crypto.createHash('md5').update('ceru').digest('hex')
var bridge = legacyHttp.createLegacyHttpBridge(null)
var bridgeApi = ['httpFetch', 'withOperation', 'ensurePermission', 'permissionKey']
  .filter(function (name) { return typeof bridge[name] === 'function' })
  .join(',')

exports.activate = function (ctx) {
  ctx.providers.register('demo', {
    tracks: {
      search: async function () {
        return {
          items: [
            {
              ref: { pluginId: 'test.ceru.require', providerId: 'demo', kind: 'track', id: 'a' },
              title: digest,
              subtitle: bridgeApi,
              metadata: {}
            }
          ]
        }
      }
    }
  })
}
`

describe('澜音宿主模块（__ceruRequire）', () => {
  it('顶层 require 宿主模块不报错，并返回真实实现', async () => {
    const host = new CeruSourceHost('C:/plugins/require.js', PLUGIN)
    expect(host.id).toBe('test.ceru.require')

    await host.init()
    expect(host.getCapabilities().canSearch).toBe(true)

    const page = await host.search({ providerId: 'demo', query: 'x', limit: 1 })
    const track = page.items[0]
    // md5 由宿主 crypto 模块计算
    expect(track.title).toBe(createHash('md5').update('ceru').digest('hex'))
    // legacy-http 必须导出 SDK 约定的 createLegacyHttpBridge
    expect(track.artist).toBe('httpFetch,withOperation,ensurePermission,permissionKey')

    await host.dispose()
  })
})

describe('宿主内建模块', () => {
  it('crypto 输出走 realm 桥（跨 vm 上下文的 Uint8Array）', () => {
    const realm = {
      toBytes: (bytes: Buffer) => ({ realm: true, hex: bytes.toString('hex') })
    }
    const mod = createCryptoModule(realm)
    const digest = mod.createHash('md5').update('ceru').digest()
    expect(digest).toEqual({ realm: true, hex: createHash('md5').update('ceru').digest('hex') })
    // 带 encoding 时仍是字符串
    expect(mod.createHash('md5').update('ceru').digest('hex')).toBe(
      createHash('md5').update('ceru').digest('hex')
    )
  })

  it('encoding 支持 gb18030（Buffer#toString 不支持）', () => {
    const mod = createEncodingModule()
    // 「晴天」的 GB18030 编码
    expect(mod.decode(Buffer.from([0xc7, 0xe7, 0xcc, 0xec]), 'gb18030')).toBe('晴天')
  })
})
