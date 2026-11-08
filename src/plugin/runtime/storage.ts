/**
 * 插件 KV 存储
 *
 * 每个插件独立一个 `storage.json`，跨重启持久化，卸载时随插件目录一起删除。
 * 值必须是 JSON 可序列化的：从 vm 沙箱拿到的对象可能是另一个 realm 的实例，
 * 因此写入前统一做一次 JSON 往返，顺带剥掉 Proxy 与函数。
 */
import { readFileSync } from 'node:fs'
import { atomicWriteJson, readJsonFile } from './atomicJson'

/** 配额（超过直接抛错，让插件自己收敛，而不是默默把磁盘写爆） */
export const STORAGE_LIMITS = {
  /** key 名最大长度 */
  keyLength: 256,
  /** 单个值序列化后最大字节数 */
  valueBytes: 64 * 1024,
  /** 文件总字节数 */
  fileBytes: 1024 * 1024,
  /** key 数量上限 */
  keys: 512
} as const

interface StorageFile {
  values: Record<string, unknown>
  updatedAt: number
}

/** JSON 往返：剥离 Proxy / 类实例 / undefined，并做可序列化校验 */
function toPlainJson(value: unknown): unknown {
  if (value === undefined) return undefined
  const text = JSON.stringify(value)
  if (text === undefined) {
    throw new Error('storage 的值必须可 JSON 序列化')
  }
  return JSON.parse(text)
}

export class PluginStorage {
  private values: Record<string, unknown> = {}
  private writeChain: Promise<void> = Promise.resolve()
  private dirty = false

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    const data = await readJsonFile<StorageFile>(this.file)
    this.values = data && typeof data.values === 'object' && data.values ? { ...data.values } : {}
  }

  /**
   * 同步读取（宿主在执行插件脚本前调用）。
   * 插件可能在初始化阶段直接 `such.storage.get()`，此时必须已经有值。
   */
  loadSync(): void {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf-8')) as StorageFile
      this.values = data && typeof data.values === 'object' && data.values ? { ...data.values } : {}
    } catch {
      this.values = {}
    }
  }

  get(key: string): unknown {
    return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : undefined
  }

  keys(): string[] {
    return Object.keys(this.values)
  }

  async set(key: string, value: unknown): Promise<void> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('storage 的 key 必须是非空字符串')
    }
    if (key.length > STORAGE_LIMITS.keyLength) {
      throw new Error(`storage 的 key 过长（上限 ${STORAGE_LIMITS.keyLength} 字符）`)
    }

    const plain = toPlainJson(value)
    if (plain === undefined) {
      await this.remove(key)
      return
    }

    const size = Buffer.byteLength(JSON.stringify(plain), 'utf8')
    if (size > STORAGE_LIMITS.valueBytes) {
      throw new Error(
        `storage 值过大（${size} 字节，上限 ${STORAGE_LIMITS.valueBytes}）；大数据请改用 such.system.file 落盘`
      )
    }

    const next = { ...this.values, [key]: plain }
    if (Object.keys(next).length > STORAGE_LIMITS.keys) {
      throw new Error(`storage 的 key 数量已达上限（${STORAGE_LIMITS.keys}）`)
    }
    const fileSize = Buffer.byteLength(JSON.stringify({ values: next, updatedAt: 0 }), 'utf8')
    if (fileSize > STORAGE_LIMITS.fileBytes) {
      throw new Error(`storage 总容量已达上限（${STORAGE_LIMITS.fileBytes} 字节）`)
    }

    this.values = next
    await this.flush()
  }

  async remove(key: string): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(this.values, key)) return
    const next = { ...this.values }
    delete next[key]
    this.values = next
    await this.flush()
  }

  async clear(): Promise<void> {
    this.values = {}
    await this.flush()
  }

  /** 落盘（串行化，避免并发写互相覆盖） */
  async flush(): Promise<void> {
    if (this.dirty) {
      await this.writeChain
      this.dirty = false
    }
    this.dirty = true
    this.writeChain = this.writeChain
      .then(() => atomicWriteJson(this.file, { values: this.values, updatedAt: Date.now() }))
      .catch((err) => {
        console.error('[Plugin] 写入 storage 失败:', err)
      })
    await this.writeChain
  }
}
