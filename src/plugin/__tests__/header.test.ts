import { describe, expect, it } from 'vitest'
import { buildPluginHostId, parsePluginHeader, pluginDataDirName } from '../header'

/** 拼一个带 JSDoc 头的插件脚本 */
function withHeader(lines: string[], body = 'such.register({ sources: { demo: { name: "D", actions: ["musicUrl"] } } })'): string {
  return `/**\n${lines.map((l) => ` * ${l}`).join('\n')}\n */\n${body}\n`
}

const validHeader = [
  '@name Example library',
  '@id you.example-library',
  '@version 1.0.0',
  '@description 示例',
  '@author someone',
  '@apiLevel 1',
  '@grant network ui',
  '@updateUrl https://example.com/p.js'
]

describe('parsePluginHeader', () => {
  it('解析完整头部', () => {
    const { header, unknownGrants } = parsePluginHeader(withHeader(validHeader))
    expect(unknownGrants).toBeUndefined()
    expect(header).toMatchObject({
      name: 'Example library',
      id: 'you.example-library',
      version: '1.0.0',
      description: '示例',
      author: 'someone',
      apiLevel: 1,
      grants: ['network', 'ui'],
      updateUrl: 'https://example.com/p.js'
    })
  })

  it('忽略未知 grant 并单独回报', () => {
    const { header, unknownGrants } = parsePluginHeader(
      withHeader([...validHeader, '@grant filesystem'])
    )
    expect(header?.grants).toEqual(['network', 'ui'])
    expect(unknownGrants).toEqual(['filesystem'])
  })

  it('缺少 @apiLevel 时拒绝', () => {
    const { header, error } = parsePluginHeader(
      withHeader(['@name A', '@id a.b', '@version 1.0.0'])
    )
    expect(header).toBeNull()
    expect(error).toContain('@apiLevel')
  })

  it('旧版 window.source 插件给明确提示', () => {
    const code = `/**
 * @name Old plugin
 * @version 1.0.0
 * @author x
 */
window.source = { id: 'OLD' }
`
    const result = parsePluginHeader(code)
    expect(result.legacy).toBe(true)
    expect(result.error).toContain('v1 插件')
  })

  it('@apiLevel 高于宿主支持时拒绝', () => {
    const { header, error } = parsePluginHeader(
      withHeader(['@name A', '@id a.b', '@version 1.0.0', '@apiLevel 99'])
    )
    expect(header).toBeNull()
    expect(error).toContain('仅支持')
  })
})

describe('buildPluginHostId', () => {
  it('带 v2 前缀与文件哈希，且不引入路径分隔符', () => {
    const header = {
      name: 'A',
      id: '../../evil/id',
      version: '1.0.0',
      apiLevel: 1,
      grants: []
    }
    const id = buildPluginHostId(header, 'C:\\plugins\\a.js')
    expect(id.startsWith('v2.')).toBe(true)
    expect(id).not.toContain('/')
    expect(id).not.toContain('..')
    expect(id).toMatch(/-[0-9a-f]{6}$/)
  })

  it('同 id 不同文件生成不同宿主 id', () => {
    const header = { name: 'A', id: 'a.b', version: '1.0.0', apiLevel: 1, grants: [] }
    expect(buildPluginHostId(header, '/x/1.js')).not.toBe(buildPluginHostId(header, '/x/2.js'))
  })

  it('数据目录名只含十六进制', () => {
    expect(pluginDataDirName('v2.a/b-c')).toMatch(/^[0-9a-f]{16}$/)
  })
})
