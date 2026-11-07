import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginSettingsStore, coerceSettingValue, normalizeSettingSchema } from '../runtime/settings'

describe('normalizeSettingSchema', () => {
  it('保留合法项、丢弃非法项并给出告警', () => {
    const { schema, warnings } = normalizeSettingSchema([
      { key: 'a', type: 'switch', label: 'A', default: true },
      { key: '', type: 'text', label: 'no key' },
      { key: 'b', type: 'weird', label: 'B' },
      { key: 'c', type: 'select', label: 'C', options: [] },
      { key: 'a', type: 'text', label: 'dup' }
    ])
    expect(schema.map((f) => f.key)).toEqual(['a'])
    expect(warnings.length).toBeGreaterThanOrEqual(3)
  })

  it('select 的默认值必须落在 options 内，否则取第一项', () => {
    const { schema } = normalizeSettingSchema([
      {
        key: 'mode',
        type: 'select',
        label: 'Mode',
        default: 'nope',
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' }
        ]
      }
    ])
    expect(schema[0]).toMatchObject({ type: 'select', default: 'a' })
  })
})

describe('coerceSettingValue', () => {
  const [num] = normalizeSettingSchema([
    { key: 'n', type: 'number', label: 'N', default: 5, min: 1, max: 10 }
  ]).schema
  const [sw] = normalizeSettingSchema([
    { key: 's', type: 'switch', label: 'S', default: false }
  ]).schema

  it('数字越界收敛到边界，非数字回落默认值', () => {
    expect(coerceSettingValue(num, 99)).toBe(10)
    expect(coerceSettingValue(num, -5)).toBe(1)
    expect(coerceSettingValue(num, 'abc')).toBe(5)
    expect(coerceSettingValue(num, '7')).toBe(7)
  })

  it('布尔接受字符串与 0/1', () => {
    expect(coerceSettingValue(sw, 'true')).toBe(true)
    expect(coerceSettingValue(sw, 1)).toBe(true)
    expect(coerceSettingValue(sw, 'x')).toBe(false)
  })
})

describe('PluginSettingsStore', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'such-settings-'))
    file = join(dir, 'settings.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('默认值 → hydrate 覆盖 → 落盘往返', async () => {
    const { schema } = normalizeSettingSchema([
      { key: 'a', type: 'switch', label: 'A', default: true },
      { key: 'b', type: 'text', label: 'B', default: 'x' }
    ])
    const store = new PluginSettingsStore(file, schema)
    expect(store.all()).toEqual({ a: true, b: 'x' })

    store.replaceSchema(schema, { b: 'from-disk' })
    expect(store.all()).toEqual({ a: true, b: 'from-disk' })

    await store.set('a', false)
    await store.flush()
    const saved = JSON.parse(await readFile(file, 'utf-8'))
    expect(saved.values).toEqual({ a: false, b: 'from-disk' })
  })

  it('只在值真正变化时通知监听器', async () => {
    const { schema } = normalizeSettingSchema([
      { key: 'a', type: 'switch', label: 'A', default: true }
    ])
    const store = new PluginSettingsStore(file, schema)
    const calls: Array<[string, unknown]> = []
    store.onChange((key, value) => calls.push([key, value]))

    await store.set('a', true)
    expect(calls).toHaveLength(0)

    await store.set('a', false)
    expect(calls).toEqual([['a', false]])
  })

  it('未声明的 key 直接报错', async () => {
    const store = new PluginSettingsStore(file, [])
    await expect(store.set('nope', 1)).rejects.toThrow('没有声明设置项')
  })
})
