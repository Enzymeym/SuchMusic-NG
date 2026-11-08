/**
 * 插件用户设置
 *
 * 插件在初始化时用 `such.register({ settings: [...] })` 声明设置项，
 * 宿主把声明归一成 schema（供设置模态框渲染表单），并把用户值持久化到
 * `plugin-data/<hash>/settings.json`。
 *
 * 设计要点：
 * - 值永远经过 `coerce()`：磁盘数据被手改、schema 变更后旧值越界，都不会让插件拿到脏数据
 * - 写入 250ms 防抖合并：设置项连续拖动/连点只落一次盘
 * - `onSettingChange` 在**值真正变化**时才触发（重复写同值不打扰插件）
 */
import type { SettingField, SettingValue } from '../../shared/plugin/types'
import { atomicWriteJson, readJsonFile } from './atomicJson'

/** schema 归一化结果 */
export interface NormalizedSchema {
  schema: SettingField[]
  warnings: string[]
}

/** 单次防抖窗口 */
const SAVE_DEBOUNCE_MS = 250

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把插件声明的原始 settings 数组归一成可安全渲染的 schema。
 * 非法条目被丢弃并记录 warning —— 一个坏字段不应该让整个插件加载失败。
 */
export function normalizeSettingSchema(raw: unknown): NormalizedSchema {
  const warnings: string[] = []
  const schema: SettingField[] = []
  if (raw === undefined || raw === null) return { schema, warnings }
  if (!Array.isArray(raw)) {
    warnings.push('register({ settings }) 必须是数组，已忽略')
    return { schema, warnings }
  }

  const seen = new Set<string>()
  raw.forEach((item, index) => {
    if (!isPlainObject(item)) {
      warnings.push(`settings[${index}] 不是对象，已忽略`)
      return
    }
    const key = typeof item.key === 'string' ? item.key.trim() : ''
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    const type = item.type

    if (!key) {
      warnings.push(`settings[${index}] 缺少 key，已忽略`)
      return
    }
    if (seen.has(key)) {
      warnings.push(`settings 中 key "${key}" 重复，已忽略后出现的条目`)
      return
    }
    if (!label) {
      warnings.push(`settings "${key}" 缺少 label，已忽略`)
      return
    }

    const base = {
      key,
      label,
      description: typeof item.description === 'string' ? item.description : undefined
    }

    switch (type) {
      case 'switch': {
        schema.push({
          ...base,
          type: 'switch',
          default: typeof item.default === 'boolean' ? item.default : false
        })
        break
      }
      case 'number': {
        const num = (v: unknown): number | undefined =>
          typeof v === 'number' && Number.isFinite(v) ? v : undefined
        const min = num(item.min)
        const max = num(item.max)
        let def = num(item.default)
        if (def === undefined) def = min ?? 0
        schema.push({ ...base, type: 'number', default: def, min, max, step: num(item.step) })
        break
      }
      case 'text': {
        schema.push({
          ...base,
          type: 'text',
          default: typeof item.default === 'string' ? item.default : '',
          placeholder: typeof item.placeholder === 'string' ? item.placeholder : undefined,
          multiline: item.multiline === true,
          secret: item.secret === true
        })
        break
      }
      case 'select': {
        const options = Array.isArray(item.options)
          ? item.options
              .filter(
                (o): o is { label: string; value: string } =>
                  isPlainObject(o) &&
                  typeof o.label === 'string' &&
                  (typeof o.value === 'string' || typeof o.value === 'number')
              )
              .map((o) => ({ label: o.label, value: String(o.value) }))
          : []
        if (options.length === 0) {
          warnings.push(`settings "${key}" 是 select 但没有有效 options，已忽略`)
          return
        }
        const def =
          typeof item.default === 'string' && options.some((o) => o.value === item.default)
            ? item.default
            : options[0].value
        schema.push({ ...base, type: 'select', default: def, options })
        break
      }
      default:
        warnings.push(`settings "${key}" 的 type "${String(type)}" 不受支持，已忽略`)
        return
    }
    seen.add(key)
  })

  return { schema, warnings }
}

/** 把任意输入收敛成该设置项的合法值 */
export function coerceSettingValue(field: SettingField, value: unknown): SettingValue {
  switch (field.type) {
    case 'switch': {
      if (typeof value === 'boolean') return value
      if (value === 'true' || value === 1) return true
      if (value === 'false' || value === 0) return false
      return field.default ?? false
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return field.default ?? 0
      let out = n
      if (typeof field.min === 'number') out = Math.max(field.min, out)
      if (typeof field.max === 'number') out = Math.min(field.max, out)
      return out
    }
    case 'text': {
      if (typeof value === 'string') return value
      if (value === null || value === undefined) return field.default ?? ''
      return String(value)
    }
    case 'select': {
      const s = typeof value === 'string' ? value : String(value ?? '')
      if (field.options.some((o) => o.value === s)) return s
      return field.default ?? field.options[0].value
    }
    default:
      return null
  }
}

interface SettingsFile {
  values: Record<string, SettingValue>
  updatedAt: number
}

export class PluginSettingsStore {
  private values: Record<string, SettingValue> = {}
  private listeners = new Set<(key: string, value: SettingValue) => void>()
  private saveTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly file: string,
    public schema: SettingField[] = []
  ) {
    this.resetValues()
  }

  /**
   * 换一套 schema 并重新灌入磁盘值。
   *
   * 插件的 schema 只有在 `such.register()` 时才确定，而 `such.getSetting()` 可能在
   * 脚本执行的同一轮里就被调用 —— 所以宿主复用同一个 store 实例，注册时热替换，
   * 而不是新建一个（否则插件拿到的是旧引用）。
   */
  replaceSchema(schema: SettingField[], stored: Record<string, unknown>): void {
    this.schema = schema
    this.resetValues()
    this.hydrate(stored)
  }

  private resetValues(): void {
    this.values = {}
    for (const field of this.schema) {
      this.values[field.key] = field.default ?? coerceSettingValue(field, undefined)
    }
  }

  /** 读取磁盘值并覆盖默认值 */
  async load(): Promise<void> {
    const data = await readJsonFile<SettingsFile>(this.file)
    this.hydrate(data && isPlainObject(data.values) ? data.values : {})
  }

  /**
   * 用已读出的原始值覆盖默认值（同步）。
   *
   * 插件在初始化阶段（`such.register()` 之后）就可能调用 `such.getSetting()`，
   * 此时不能等异步 IO —— 宿主会在执行脚本前同步读出 settings.json 再灌进来。
   */
  hydrate(stored: Record<string, unknown>): void {
    for (const field of this.schema) {
      if (Object.prototype.hasOwnProperty.call(stored, field.key)) {
        this.values[field.key] = coerceSettingValue(field, stored[field.key])
      }
    }
  }

  get(key: string): SettingValue | undefined {
    return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : undefined
  }

  all(): Record<string, SettingValue> {
    return { ...this.values }
  }

  has(key: string): boolean {
    return this.schema.some((f) => f.key === key)
  }

  /** 写入一个值；返回归一化后的完整值表 */
  async set(key: string, value: unknown): Promise<Record<string, SettingValue>> {
    const field = this.schema.find((f) => f.key === key)
    if (!field) {
      throw new Error(`插件没有声明设置项 "${key}"`)
    }
    const next = coerceSettingValue(field, value)
    const changed = this.values[key] !== next
    this.values[key] = next
    this.scheduleSave()
    if (changed) {
      // 监听器是插件注册的同步回调，异常不能影响设置写入
      for (const fn of this.listeners) {
        try {
          fn(key, next)
        } catch (err) {
          console.error(`[Plugin] onSettingChange("${key}") 抛出异常:`, err)
        }
      }
    }
    return this.all()
  }

  /** 订阅设置变化，返回取消订阅函数 */
  onChange(fn: (key: string, value: SettingValue) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 立即落盘（关闭模态框 / 卸载插件前调用） */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await atomicWriteJson(this.file, { values: this.values, updatedAt: Date.now() })
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush().catch((err) => console.error('[Plugin] 写入 settings 失败:', err))
    }, SAVE_DEBOUNCE_MS)
  }
}
