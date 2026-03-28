import { ipcMain, dialog, app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import axios from 'axios'
import {
  benchmarkSnowdropTransform,
  transformSnowdropPlugin,
  type SnowdropPluginMeta,
  type SnowdropPluginType,
  type SnowdropSourceSummary,
  type SnowdropTransformResult
} from '../../plugin/utils/snowdrop-transform'
import {
  getPluginConfig,
  addPluginPaths,
  removePluginPath,
  savePluginConfig
} from '../services/pluginConfig'
import SuchMusicPluginHost from '../../plugin/manager/SuchMusicPluginHost'

interface ProcessPluginFileResult {
  canceled: boolean
  filePath: string
  originalCodePreview: string
  meta: SnowdropPluginMeta
  type: SnowdropPluginType
  stats: {
    singleDurationMs: number
    batchDurationMs: number
    averageMs: number
    count: number
    estimatedMemoryDeltaMb: number
  }
  sources: SnowdropSourceSummary[]
  logs: string[]
  warnings: string[]
  errors: string[]
  runtimeLogs: string[]
  transformedCodePreview: string
  transformedCode?: string
}

async function processPluginFile(filePath: string): Promise<ProcessPluginFileResult> {
  const originalCode = await fs.readFile(filePath, 'utf-8')

  // 简单判断是否已经是 SuchMusic 插件
  const isSuchMusic = originalCode.includes('cerumusic') && !originalCode.includes('lx.on(')

  let single: SnowdropTransformResult

  if (isSuchMusic) {
     // 如果已经是转换后的插件，直接解析信息
     // 这里为了复用 ProcessPluginFileResult 结构，我们构造一个伪造的 result
     // 实际上应该使用 SuchMusicPluginHost 来解析
     // 但为了简单，我们假设它不需要转换，或者再次转换也不会出错（如果转换器足够健壮）
     // 暂时我们还是调用转换器，但期望它能处理或者我们手动构造
     
     // 由于 transformSnowdropPlugin 是专门针对 lx 的，我们不能用它解析 SuchMusic 插件
     // 我们需要手动提取 meta 和 sources
    const host = new SuchMusicPluginHost(originalCode)
    const info = host.getPluginInfo()
    const rawSources = host.getSupportedSources()

    let sources: any[] = []
    if (Array.isArray(rawSources)) {
      sources = rawSources
    } else if (typeof rawSources === 'object' && rawSources !== null) {
      sources = Object.entries(rawSources).map(([k, v]: [string, any]) => ({
        id: k,
        ...v
      }))
    }

    single = {
      transformedCode: originalCode,
      meta: {
        name: info.name,
        version: info.version,
        author: info.author,
        description: info.description
      },
      type: 'suchmusic',
      sources: sources.map((s, index) => ({
        id: (s as any).id ?? `src_${index}`,
        name: s.name,
        qualities: s.qualities || []
      })),
      logs: [],
      warnings: [],
      errors: [],
      runtimeLogs: [],
      stats: {
        durationMs: 0
      }
    }
  } else {
    // 使用统一转换器解析本地落雪插件
    single = transformSnowdropPlugin(originalCode, { sourceType: 'lx' })
  }

  const singleDurationMs = single.stats.durationMs

  // 在主进程控制台输出解析日志
  console.group('[SnowdropTransform] 本地文件解析结果')
  console.log('file:', filePath)
  console.log('meta:', single.meta)
  console.log('type:', single.type)
  console.log('durationMs:', singleDurationMs)
  if (single.warnings.length) {
    console.warn('warnings:', single.warnings)
  }
  if (single.errors.length) {
    console.error('errors:', single.errors)
  }
  if (single.logs.length) {
    console.log('logs:')
    for (const log of single.logs) {
      console.log('  ', log)
    }
  }
  console.groupEnd()

  return {
    canceled: false,
    filePath,
    originalCodePreview: originalCode.slice(0, 2000),
    meta: single.meta,
    type: single.type,
    stats: {
      singleDurationMs,
      batchDurationMs: singleDurationMs,
      averageMs: singleDurationMs,
      count: 1,
      estimatedMemoryDeltaMb: 0
    },
    sources: single.sources ?? [],
    logs: single.logs,
    warnings: single.warnings,
    errors: single.errors,
    runtimeLogs: single.runtimeLogs ?? [],
    transformedCodePreview: single.transformedCode.slice(0, 2000),
    transformedCode: single.transformedCode
  }
}

export function registerPluginHandlers(): void {
  // 从本地选择落雪音源插件文件并解析（支持多选）
  ipcMain.handle('snowdrop:transform:open-file', async () => {
    // 弹出对话框选择本地 js 插件文件
    const result = await dialog.showOpenDialog({
      title: '请选择本地落雪音源插件 JS 文件',
      filters: [
        { name: 'JavaScript 文件', extensions: ['js'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    })

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true }
    }

    const filePaths = result.filePaths
    const results: ProcessPluginFileResult[] = []
    const errors: string[] = []

    // 并行处理所有选中的文件
    await Promise.all(
      filePaths.map(async (fp) => {
        try {
          const res = await processPluginFile(fp)
          results.push(res)
        } catch (err) {
          console.error(`Failed to process plugin file ${fp}:`, err)
          errors.push(String(err))
        }
      })
    )

    // 成功处理后保存路径
    if (results.length > 0) {
      const savedPaths: string[] = []
      const pluginsDir = path.join(app.getPath('userData'), 'plugins')
      await fs.mkdir(pluginsDir, { recursive: true })

      for (const res of results) {
        if (res.transformedCode) {
          const fileName = `plugin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.js`
          const savePath = path.join(pluginsDir, fileName)
          await fs.writeFile(savePath, res.transformedCode, 'utf-8')
          savedPaths.push(savePath)
          // 更新结果中的 path，以便前端显示正确路径
          res.filePath = savePath
        } else {
          savedPaths.push(res.filePath)
        }
      }
      await addPluginPaths(savedPaths)
    }

    return {
      canceled: false,
      results,
      errors
    }
  })

  // 通过在线 URL 下载并解析落雪音源插件
  ipcMain.handle('snowdrop:transform:download-url', async (_event, url: string) => {
    if (!url || typeof url !== 'string') {
      return {
        canceled: true,
        results: [],
        errors: ['无效的 URL 地址']
      }
    }

    const errors: string[] = []

    try {
      // 下载远程插件代码
      const response = await axios.get<string>(url, {
        timeout: 30000,
        responseType: 'text',
        headers: {
          'User-Agent': 'SuchMusic/SnowdropPlugin'
        }
      })

      if (response.status !== 200) {
        errors.push(`下载失败: HTTP ${response.status}`)
      } else if (!response.data || !response.data.trim()) {
        errors.push('下载的文件内容为空')
      }

      if (errors.length) {
        return {
          canceled: false,
          results: [],
          errors
        }
      }

      const code = response.data

      // 将远程插件保存到应用数据目录，便于后续再次加载
      const userDataDir = app.getPath('userData')
      const pluginsDir = path.join(userDataDir, 'snowdrop-plugins')
      await fs.mkdir(pluginsDir, { recursive: true })

      const urlObj = new URL(url)
      const baseName = path.basename(urlObj.pathname || 'snowdrop-plugin.js') || 'snowdrop-plugin.js'
      const safeName =
        baseName.toLowerCase().endsWith('.js') ? baseName : `${baseName || 'snowdrop-plugin'}.js`
      const filePath = path.join(
        pluginsDir,
        `${Date.now().toString(16)}-${safeName.replace(/[^\w.\-]/g, '_')}`
      )

      await fs.writeFile(filePath, code, 'utf-8')

      // 解析并登记到配置中
      const result = await processPluginFile(filePath)
      await addPluginPaths([filePath])

      return {
        canceled: false,
        results: [result],
        errors
      }
    } catch (err) {
      errors.push(`下载或解析失败: ${String(err)}`)
      return {
        canceled: false,
        results: [],
        errors
      }
    }
  })

  // 加载所有保存的插件文件
  ipcMain.handle('snowdrop:plugin:load-all', async () => {
    const config = await getPluginConfig()
    const paths = config.pluginPaths
    if (!paths.length) {
      return { canceled: true, reason: 'no-paths', results: [] }
    }

    const results: ProcessPluginFileResult[] = []
    const errors: string[] = []

    // 并行加载所有插件
    await Promise.all(
      paths.map(async (fp) => {
        try {
          // 检查文件是否存在
          await fs.access(fp)
          const res = await processPluginFile(fp)
          results.push(res)
        } catch (err) {
          console.error(`Failed to load plugin ${fp}:`, err)
          // 如果文件不存在或读取失败，可以选择不报错，或者记录错误
          // 这里我们简单记录错误
          errors.push(`File ${fp}: ${String(err)}`)
        }
      })
    )

    return {
      canceled: false,
      results,
      errors,
      // 当前被选中的插件路径，供前端高亮与使用
      activeFilePath: config.activePluginPath ?? null
    }
  })

  // 移除指定的插件路径
  ipcMain.handle('snowdrop:plugin:remove', async (_event, filePath: string) => {
    await removePluginPath(filePath)
    return { success: true }
  })

  // 设置当前使用的落雪插件路径（一次只能选一个）
  ipcMain.handle('snowdrop:plugin:set-active', async (_event, filePath: string | null) => {
    const config = await getPluginConfig()
    let nextActive: string | null = null

    if (filePath && config.pluginPaths.includes(filePath)) {
      nextActive = filePath
    }

    config.activePluginPath = nextActive
    await savePluginConfig(config)

    return {
      success: true,
      activePluginPath: nextActive
    }
  })

  // 测试落雪音源插件转换与性能
  ipcMain.handle('snowdrop:transform:test', async () => {
    const sampleCode = `
/**
 * @name 示例落雪音源插件
 * @version 1.0.0
 * @author test
 * @description 用于测试的事件驱动落雪插件
 */

lx.on(lx.EVENT_NAMES.request, async (data) => {
  if (data.action === 'musicUrl') {
    return 'https://example.com/test-' + data.source
  }
})

lx.send(lx.EVENT_NAMES.inited, {
  sources: {
    kw: { type: 'music', qualitys: ['128k', '320k'] }
  }
})
`

    const memoryBefore = process.memoryUsage().heapUsed
    const single = transformSnowdropPlugin(sampleCode, { sourceType: 'lx' })
    const singleDurationMs = single.stats.durationMs

    const bench = benchmarkSnowdropTransform(sampleCode, 1000)
    const memoryAfter = process.memoryUsage().heapUsed
    const memoryDeltaMb = (memoryAfter - memoryBefore) / (1024 * 1024)

    return {
      ...single,
      stats: {
        singleDurationMs,
        batchDurationMs: bench.durationMs,
        averageMs: bench.averageMs,
        count: bench.count,
        estimatedMemoryDeltaMb: memoryDeltaMb
      }
    }
  })

  // 调用当前激活插件获取音乐 URL
  ipcMain.handle('snowdrop:plugin:get-music-url', async (_event, source: string, musicInfo: any, quality: string) => {
    const config = await getPluginConfig()
    const activePath = config.activePluginPath

    if (!activePath) {
      throw new Error('未设置激活的音源插件')
    }

    try {
      // 临时每次请求都加载插件（后续应优化为缓存插件实例）
      const host = new SuchMusicPluginHost()
      await host.loadPlugin(activePath)
      
      const url = await host.getMusicUrl(source, musicInfo, quality)
      return { url }
    } catch (error: any) {
      console.error('获取音乐URL失败:', error)
      throw new Error(error.message || '获取播放链接失败')
    }
  })
}
