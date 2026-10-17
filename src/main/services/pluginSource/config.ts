/**
 * 音源插件配置持久化
 *
 * 文件：userData/source-plugin-config.json
 * 结构：
 * {
 *   "autoGrantNetwork": true,
 *   "defaultQuality": "320k",
 *   "plugins": [
 *     { "id": "...", "filePath": "...", "kind": "lx", "enabled": true,
 *       "config": {...}, "storage": {...} }
 *   ]
 * }
 */
import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import type { SourcePluginKind, SourcePreferences } from './types'

const CONFIG_FILE = 'source-plugin-config.json'

export interface SourcePluginRecord {
  id: string
  filePath: string
  kind: SourcePluginKind
  enabled: boolean
  /** 插件级配置（对应澜音 ctx.config） */
  config?: Record<string, any>
  /** 插件私有存储（对应澜音 ctx.storage） */
  storage?: Record<string, any>
  /** 权限授予记录（对应澜音 ctx.permissions），键为插件自定义权限 key */
  permissions?: Record<string, 'granted' | 'denied'>
  /** 用户偏好：启用的音乐源 / 首选音质（每个插件独立） */
  preferences?: SourcePreferences
}

export interface SourcePluginConfig {
  /** 是否自动授予网络类权限（澜音 ctx.permissions / ctx.http） */
  autoGrantNetwork: boolean
  /** 默认音质（无显式选择时使用） */
  defaultQuality: string
  plugins: SourcePluginRecord[]
}

function configPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE)
}

/** 读取配置（缺省/损坏时返回默认值） */
export async function getSourceConfig(): Promise<SourcePluginConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf-8')
    const data = JSON.parse(raw)
    return {
      autoGrantNetwork: data.autoGrantNetwork !== false,
      defaultQuality: typeof data.defaultQuality === 'string' ? data.defaultQuality : '320k',
      plugins: Array.isArray(data.plugins)
        ? data.plugins.filter(
            (p: any): p is SourcePluginRecord =>
              p && typeof p.id === 'string' && typeof p.filePath === 'string'
          )
        : []
    }
  } catch {
    return { autoGrantNetwork: true, defaultQuality: '320k', plugins: [] }
  }
}

/** 写入配置 */
export async function saveSourceConfig(config: SourcePluginConfig): Promise<void> {
  try {
    await fs.writeFile(configPath(), JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('[PluginSource] 保存音源插件配置失败:', err)
  }
}

/** 新增或更新一条插件记录 */
export async function upsertSourcePlugin(record: SourcePluginRecord): Promise<void> {
  const config = await getSourceConfig()
  const idx = config.plugins.findIndex((p) => p.id === record.id)
  if (idx >= 0) {
    config.plugins[idx] = { ...config.plugins[idx], ...record }
  } else {
    config.plugins.push(record)
  }
  await saveSourceConfig(config)
}

/** 删除插件记录 */
export async function removeSourcePlugin(pluginId: string): Promise<void> {
  const config = await getSourceConfig()
  config.plugins = config.plugins.filter((p) => p.id !== pluginId)
  await saveSourceConfig(config)
}

/** 设置启用状态 */
export async function setSourcePluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  const config = await getSourceConfig()
  const rec = config.plugins.find((p) => p.id === pluginId)
  if (rec) {
    rec.enabled = enabled
    await saveSourceConfig(config)
  }
}

/** 读取单个插件的配置（对应澜音 ctx.config.get） */
export async function getPluginConfigEntry(pluginId: string): Promise<Record<string, any>> {
  const config = await getSourceConfig()
  return config.plugins.find((p) => p.id === pluginId)?.config ?? {}
}

/** 合并写入单个插件的配置 */
export async function setPluginConfig(pluginId: string, patch: Record<string, any>): Promise<void> {
  const config = await getSourceConfig()
  const rec = config.plugins.find((p) => p.id === pluginId)
  if (!rec) return
  rec.config = { ...(rec.config ?? {}), ...patch }
  await saveSourceConfig(config)
}

/** 读取插件私有存储中的某个键 */
export async function getPluginStorage<T = any>(pluginId: string, key: string): Promise<T | null> {
  const config = await getSourceConfig()
  const storage = config.plugins.find((p) => p.id === pluginId)?.storage
  if (!storage || !(key in storage)) return null
  return storage[key] as T
}

/** 写入插件私有存储中的某个键 */
export async function setPluginStorage(pluginId: string, key: string, value: any): Promise<void> {
  const config = await getSourceConfig()
  const rec = config.plugins.find((p) => p.id === pluginId)
  if (!rec) return
  rec.storage = { ...(rec.storage ?? {}), [key]: value }
  await saveSourceConfig(config)
}

/** 读取插件全部私有存储 */
export async function getPluginStorageAll(pluginId: string): Promise<Record<string, any>> {
  const config = await getSourceConfig()
  return config.plugins.find((p) => p.id === pluginId)?.storage ?? {}
}

/** 删除插件私有存储中的某个键 */
export async function deletePluginStorage(pluginId: string, key: string): Promise<void> {
  const config = await getSourceConfig()
  const rec = config.plugins.find((p) => p.id === pluginId)
  if (!rec?.storage || !(key in rec.storage)) return
  delete rec.storage[key]
  await saveSourceConfig(config)
}

/** 清空插件私有存储 */
export async function clearPluginStorage(pluginId: string): Promise<void> {
  const config = await getSourceConfig()
  const rec = config.plugins.find((p) => p.id === pluginId)
  if (!rec) return
  rec.storage = {}
  await saveSourceConfig(config)
}

/** 读取插件权限授予记录 */
export async function getPluginPermissions(
  pluginId: string
): Promise<Record<string, 'granted' | 'denied'>> {
  const config = await getSourceConfig()
  return config.plugins.find((p) => p.id === pluginId)?.permissions ?? {}
}

/**
 * 读取单个插件的偏好设置。
 * 正常化 `sources`：只有数组才算「手动指定」，其余一律视为「全部启用」。
 */
export async function getPluginPreferences(pluginId: string): Promise<SourcePreferences> {
  const config = await getSourceConfig()
  const prefs = config.plugins.find((p) => p.id === pluginId)?.preferences
  return normalizePreferences(prefs)
}

/** 合并写入偏好设置，返回归一化后的结果 */
export async function savePluginPreferences(
  pluginId: string,
  patch: SourcePreferences
): Promise<SourcePreferences> {
  const config = await getSourceConfig()
  const rec = config.plugins.find((p) => p.id === pluginId)
  const next = normalizePreferences({ ...(rec?.preferences ?? {}), ...patch })
  if (!rec) return next
  rec.preferences = next
  await saveSourceConfig(config)
  return next
}

/** 归一化偏好：非法字段降级为默认值 */
export function normalizePreferences(input?: SourcePreferences | null): SourcePreferences {
  const prefs = input ?? {}
  const sources = Array.isArray(prefs.sources)
    ? prefs.sources.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
    : null
  const quality = typeof prefs.quality === 'string' && prefs.quality ? prefs.quality : null
  return { sources, quality }
}

/** 读取全局配置（是否自动授予网络类权限等） */
export async function getSourceConfigOptions(): Promise<{
  autoGrantNetwork: boolean
  defaultQuality: string
}> {
  const config = await getSourceConfig()
  return { autoGrantNetwork: config.autoGrantNetwork, defaultQuality: config.defaultQuality }
}

/** 记录插件权限授予结果 */
export async function setPluginPermission(
  pluginId: string,
  key: string,
  status: 'granted' | 'denied'
): Promise<void> {
  const config = await getSourceConfig()
  const rec = config.plugins.find((p) => p.id === pluginId)
  if (!rec) return
  rec.permissions = { ...(rec.permissions ?? {}), [key]: status }
  await saveSourceConfig(config)
}
