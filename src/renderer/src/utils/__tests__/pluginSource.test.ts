import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { toCloneable } from '../pluginSource'

/**
 * 回归：跨 IPC 的请求体必须是纯数据。
 *
 * 线上问题：QQ 搜索结果存在 `ref([])` 里，`song.trackRef` 读出来是 Vue 的响应式
 * Proxy，`ipcRenderer.invoke` 结构化克隆失败，渲染层只收到
 * 「无法调用音源插件：An object could not be cloned.」。
 */
describe('toCloneable', () => {
  it('响应式代理会被展开成可结构化克隆的纯对象', () => {
    const song = reactive({
      id: 1,
      trackRef: { mid: '003aAYrm3GE0Ac', data: 'x' }
    })
    const req = toCloneable({ id: String(song.id), ref: song.trackRef })

    expect(() => structuredClone(req)).not.toThrow()
    expect(structuredClone(req)).toEqual({
      id: '1',
      ref: { mid: '003aAYrm3GE0Ac', data: 'x' }
    })
  })

  it('函数 / Symbol 成员被剔除（不可克隆）', () => {
    const req = toCloneable({
      id: '1',
      ref: { mid: 'm', dispose: () => {}, sym: Symbol('s') }
    } as any)
    expect(() => structuredClone(req)).not.toThrow()
    expect((req as any).ref).toEqual({ mid: 'm' })
  })

  it('数组嵌套与 undefined 保持可克隆', () => {
    const req = toCloneable({ list: [{ a: 1 }, undefined, null], missing: undefined })
    expect(() => structuredClone(req)).not.toThrow()
    expect((req as any).list[0]).toEqual({ a: 1 })
  })
})
