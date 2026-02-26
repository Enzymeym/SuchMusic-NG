import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'

const PLUGIN_CONFIG_FILE = 'plugin-config.json'

export interface PluginConfig {
  // 所有已保存的落雪插件路径
  pluginPaths: string[]
  // 当前被选中的插件路径（一次只能使用一个）
  activePluginPath?: string | null
}

export async function getPluginConfig(): Promise<PluginConfig> {
  try {
    const configPath = join(app.getPath('userData'), PLUGIN_CONFIG_FILE)
    const data = await fs.readFile(configPath, 'utf-8')
    const config = JSON.parse(data)
    // 兼容旧版本：如果有 lastPluginPath，迁移到 pluginPaths
    if (config.lastPluginPath && !config.pluginPaths) {
      config.pluginPaths = [config.lastPluginPath]
    }
    const pluginPaths = Array.isArray(config.pluginPaths) ? config.pluginPaths : []
    const activePluginPath =
      typeof config.activePluginPath === 'string' ? config.activePluginPath : null
    return { pluginPaths, activePluginPath }
  } catch {
    return { pluginPaths: [], activePluginPath: null }
  }
}

export async function savePluginConfig(config: PluginConfig): Promise<void> {
  try {
    const configPath = join(app.getPath('userData'), PLUGIN_CONFIG_FILE)
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('Failed to save plugin config:', err)
  }
}

export async function addPluginPaths(newPaths: string[]): Promise<void> {
  const config = await getPluginConfig()
  const set = new Set(config.pluginPaths)
  for (const p of newPaths) {
    set.add(p)
  }
  config.pluginPaths = Array.from(set)
  await savePluginConfig(config)
}

export async function removePluginPath(pathToRemove: string): Promise<void> {
  const config = await getPluginConfig()
  config.pluginPaths = config.pluginPaths.filter((p) => p !== pathToRemove)
  if (config.activePluginPath === pathToRemove) {
    // 如果删除的是当前使用的插件，则重置激活状态
    config.activePluginPath = null
  }
  await savePluginConfig(config)
}
