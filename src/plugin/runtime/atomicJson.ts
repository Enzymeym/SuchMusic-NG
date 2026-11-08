/**
 * 原子写 JSON
 *
 * 先写 `.tmp` 再 rename：避免应用被强杀时留下半截 JSON，
 * 下次启动读到损坏文件就把插件的全部设置丢掉。
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  const dir = dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${randomUUID()}.tmp`)
  const text = `${JSON.stringify(data, null, 2)}\n`
  try {
    await fs.writeFile(tmp, text, 'utf-8')
    await fs.rename(tmp, file)
  } catch (err) {
    // rename 在 Windows 上偶发 EPERM（杀软/索引占用），重试一次
    try {
      await fs.rm(tmp, { force: true })
    } catch {
      /* 忽略 */
    }
    await fs.writeFile(file, text, 'utf-8')
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[Plugin] 原子写失败，已退化为直接写:', file, err)
    }
  }
}

/** 读 JSON，文件不存在或损坏时返回 null */
export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
