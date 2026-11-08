import { describe, expect, it } from 'vitest'
import { ConfirmQueue } from '../runtime/confirm'
import type { BatchConfirmRequest } from '../types'

describe('ConfirmQueue', () => {
  it('同一插件的多个操作合并成一批', async () => {
    const sent: BatchConfirmRequest[] = []
    const queue = new ConfirmQueue({ send: (r) => sent.push(r), isAvailable: () => true })

    const a = queue.request('v2.a-1', 'A', 'exec', 'do 1')
    const b = queue.request('v2.a-1', 'A', 'fileWrite', 'do 2')
    await new Promise((r) => setTimeout(r, 150))

    expect(sent).toHaveLength(1)
    expect(sent[0].pluginId).toBe('v2.a-1')
    expect(sent[0].operations).toHaveLength(2)

    queue.resolve({ requestId: sent[0].requestId, confirmed: true, skipSession: false })
    await expect(a).resolves.toBe(true)
    await expect(b).resolves.toBe(true)
  })

  it('不同插件不会串到同一批（v1 的归属错误）', async () => {
    const sent: BatchConfirmRequest[] = []
    const queue = new ConfirmQueue({ send: (r) => sent.push(r), isAvailable: () => true })

    const a = queue.request('v2.a-1', 'A', 'exec', 'a')
    const b = queue.request('v2.b-2', 'B', 'exec', 'b')
    await new Promise((r) => setTimeout(r, 150))

    expect(sent).toHaveLength(2)
    const byPlugin = new Map(sent.map((r) => [r.pluginId, r]))
    expect(byPlugin.get('v2.a-1')?.operations).toHaveLength(1)
    expect(byPlugin.get('v2.b-2')?.operations).toHaveLength(1)

    for (const req of sent) {
      queue.resolve({ requestId: req.requestId, confirmed: true, skipSession: false })
    }
    await expect(a).resolves.toBe(true)
    await expect(b).resolves.toBe(true)
  })

  it('skipSession 后同插件同操作不再询问', async () => {
    const sent: BatchConfirmRequest[] = []
    const queue = new ConfirmQueue({ send: (r) => sent.push(r), isAvailable: () => true })

    const first = queue.request('v2.a-1', 'A', 'exec', 'a')
    await new Promise((r) => setTimeout(r, 150))
    queue.resolve({ requestId: sent[0].requestId, confirmed: true, skipSession: true })
    await expect(first).resolves.toBe(true)

    await expect(queue.request('v2.a-1', 'A', 'exec', 'again')).resolves.toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('窗口不可用时直接拒绝而不是静默放行', async () => {
    const queue = new ConfirmQueue({ send: () => {}, isAvailable: () => false })
    await expect(queue.request('v2.a-1', 'A', 'exec', 'a')).resolves.toBe(false)
  })

  it('取消单条操作只影响它自己', async () => {
    const sent: BatchConfirmRequest[] = []
    const queue = new ConfirmQueue({ send: (r) => sent.push(r), isAvailable: () => true })

    const a = queue.request('v2.a-1', 'A', 'exec', 'a')
    const b = queue.request('v2.a-1', 'A', 'exec', 'b')
    await new Promise((r) => setTimeout(r, 150))

    const rejectedId = sent[0].operations[0].opId
    queue.resolve({
      requestId: sent[0].requestId,
      confirmed: true,
      rejectedOpIds: [rejectedId],
      skipSession: false
    })
    await expect(a).resolves.toBe(false)
    await expect(b).resolves.toBe(true)
  })
})
