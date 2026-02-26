import convertEventDrivenPlugin from '../manager/converter-event-driven'
import vm from 'vm'

// 插件类型枚举
export type SnowdropPluginType = 'event-driven' | 'suchmusic' | 'legacy' | 'unknown'

// 落雪插件基础元信息
export interface SnowdropPluginMeta {
  name: string
  version: string
  author: string
  description?: string
  homepage?: string
}

// 转换选项
export interface SnowdropTransformOptions {
  sourceType?: 'lx' | 'cr'
}

// 转换统计信息
export interface SnowdropTransformStats {
  durationMs: number
}

// 音源概要信息
export interface SnowdropSourceSummary {
  id: string
  name: string
  qualities: string[]
}

// 转换结果
export interface SnowdropTransformResult {
  meta: SnowdropPluginMeta
  type: SnowdropPluginType
  transformedCode: string
  logs: string[]
  warnings: string[]
  errors: string[]
  stats: SnowdropTransformStats
  sources?: SnowdropSourceSummary[]
  runtimeLogs?: string[]
}

// 性能基准结果
export interface SnowdropBenchmarkResult {
  count: number
  durationMs: number
  averageMs: number
}

// 安全提取基础元信息
function extractMeta(originalCode: string): SnowdropPluginMeta {
  const pick = (pattern: RegExp, fallback: string): string => {
    const m = originalCode.match(pattern)
    return m && m[1] ? m[1].trim() : fallback
  }

  return {
    name: pick(/@name\s+(.+)/, '未知插件'),
    version: pick(/@version\s+(.+)/, '1.0.0'),
    author: pick(/@author\s+(.+)/, 'Unknown'),
    description: pick(/@description\s+(.+)/, '落雪音源插件'),
    homepage: (() => {
      const m = originalCode.match(/@homepage\s+(.+)/)
      return m && m[1] ? m[1].trim() : undefined
    })()
  }
}

// 从转换后的插件代码中提取 sources 概览并收集运行期日志
function extractSourcesSummary(
  transformedCode: string
): { sources: SnowdropSourceSummary[]; runtimeLogs: string[] } {
  try {
    const runtimeLogs: string[] = []

    const pushLog = (level: string, args: unknown[]): void => {
      const parts = args.map((v) => {
        if (typeof v === 'string') return v
        try {
          return JSON.stringify(v)
        } catch {
          return String(v)
        }
      })
      const line = `[${level}] ${parts.join(' ')}`
      runtimeLogs.push(line)
    }

    // 在独立沙箱中执行转换后的插件代码，模拟最小 SuchMusic 运行环境
    const sandbox: {
      module: { exports: unknown }
      exports: unknown
      require: () => unknown
      console: {
        log: (...args: unknown[]) => void
        warn: (...args: unknown[]) => void
        error: (...args: unknown[]) => void
      }
      suchmusic: {
        request: (..._args: unknown[]) => Promise<never>
        utils: {
          buffer: unknown
          crypto: {
            aesEncrypt: (...args: unknown[]) => unknown
            md5: (str: unknown) => string
            randomBytes: (size: number) => unknown
            rsaEncrypt: (data: unknown, _key: unknown) => unknown
          }
        }
        NoticeCenter: (..._args: unknown[]) => void
      }
      setTimeout: typeof setTimeout
      clearTimeout: typeof clearTimeout
      setInterval: typeof setInterval
      clearInterval: typeof clearInterval
      Buffer: typeof Buffer
      JSON: typeof JSON
      process: { env: { NODE_ENV: string; SNOWDROP_SUMMARY?: string } }
    } = {
      module: { exports: {} },
      exports: {},
      require: () => ({}),
      console: {
        log: (...args: unknown[]) => pushLog('log', args),
        warn: (...args: unknown[]) => pushLog('warn', args),
        error: (...args: unknown[]) => pushLog('error', args)
      },
      suchmusic: {
        // 请求在概要解析阶段不可用，避免真正发网请求
        request: async () => {
          throw new Error('suchmusic.request is disabled in Snowdrop summary')
        },
        utils: {
          buffer: {},
          crypto: {
            aesEncrypt: (data: unknown) => data,
            md5: (str: unknown) => String(str),
            randomBytes: (size: number) => {
              if (typeof Buffer !== 'undefined') {
                return Buffer.alloc(size)
              }
              return new Uint8Array(size)
            },
            rsaEncrypt: (data: unknown) => data
          }
        },
        NoticeCenter: () => {}
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Buffer,
      JSON,
      process: { env: { NODE_ENV: 'production', SNOWDROP_SUMMARY: '1' } }
    }

    vm.runInNewContext(transformedCode, sandbox, { timeout: 2000 })

    const exported =
      (sandbox.module && sandbox.module.exports) || sandbox.exports

    if (!exported || typeof exported !== 'object') {
      return { sources: [], runtimeLogs }
    }

    const pluginObj = exported as {
      sources?: unknown
      musicUrl?: unknown
    }

    if (!pluginObj.sources || typeof pluginObj.sources !== 'object') {
      return { sources: [], runtimeLogs }
    }

    const sourcesRecord = pluginObj.sources as Record<string, unknown>
    const result: SnowdropSourceSummary[] = []

    for (const [id, src] of Object.entries(sourcesRecord)) {
      if (!src || typeof src !== 'object') continue

      const srcObj = src as {
        name?: unknown
        qualitys?: unknown
      }

      const rawName =
        typeof srcObj.name === 'string' ? srcObj.name.trim() : ''
      const name = rawName || id

      const qualities: string[] = []
      if (Array.isArray(srcObj.qualitys)) {
        for (const q of srcObj.qualitys) {
          if (typeof q === 'string') {
            const s = q.trim()
            if (s) qualities.push(s)
          }
        }
      }

      result.push({
        id,
        name,
        qualities
      })
    }

    // 尝试调用一次 musicUrl 以触发插件内部日志（如 ID 提取等）
    try {
      if (typeof pluginObj.musicUrl === 'function') {
        const sourceIds = Object.keys(sourcesRecord)
        const testSource = sourceIds[0]
        if (testSource) {
          const fakeMusicInfo = {
            id: 'snowdrop-test',
            name: 'Snowdrop Test Song',
            singer: 'Snowdrop',
            songmid: 'snowdrop-test',
            songId: 'snowdrop-test',
            mid: 'snowdrop-test'
          }
          const invokeMusicUrl = pluginObj.musicUrl as (
            source: string,
            musicInfo: unknown,
            quality: string
          ) => Promise<unknown>
          // 不等待返回值，仅用于触发同步日志输出
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          invokeMusicUrl(testSource, fakeMusicInfo, '128k')
        }
      }
    } catch {
      // 忽略运行期错误，日志收集尽力而为
    }

    return { sources: result, runtimeLogs }
  } catch {
    return { sources: [], runtimeLogs: [] }
  }
}

// 检测插件风格
function detectPluginType(originalCode: string): SnowdropPluginType {
  const lower = originalCode.toLowerCase()

  // 已是 SuchMusic 规范插件
  if (lower.includes('module.exports') && lower.includes('plugininfo')) {
    return 'suchmusic'
  }

  // 事件驱动落雪插件特征（传统写法：直接使用 lx.on / lx.send）
  if (
    lower.includes('lx.event_names') ||
    /lx\.on\s*\(\s*['"`]request['"`]/i.test(originalCode) ||
    /lx\.send\s*\(\s*['"`]inited['"`]/i.test(originalCode)
  ) {
    return 'event-driven'
  }

  // 事件驱动落雪插件特征（解构写法：const { EVENT_NAMES, on, send } = globalThis.lx）
  const hasGlobalLx =
    /globalThis\.lx/i.test(originalCode) || /global\.lx/i.test(originalCode)
  const hasEventNamesRequest = /EVENT_NAMES\.request/.test(originalCode)
  const hasEventNamesInited = /EVENT_NAMES\.inited/.test(originalCode)
  const hasOnCall = /\bon\s*\(/.test(originalCode)
  const hasSendCall = /\bsend\s*\(/.test(originalCode)

  if (
    hasGlobalLx &&
    hasEventNamesRequest &&
    hasEventNamesInited &&
    hasOnCall &&
    hasSendCall
  ) {
    return 'event-driven'
  }

  // 其他含 lx 关键字的视为旧版或非标准落雪插件
  if (lower.includes('lx')) {
    return 'legacy'
  }

  return 'unknown'
}

// 生成降级插件代码
function createFallbackCode(meta: SnowdropPluginMeta, reason: string): string {
  const safeReason = reason.replace(/\r?\n/g, ' ')

  return `const pluginInfo = {
  name: ${JSON.stringify(meta.name)},
  version: ${JSON.stringify(meta.version)},
  author: ${JSON.stringify(meta.author)},
  description: ${JSON.stringify(meta.description || '')}
};

const sources = {};

async function musicUrl() {
  throw new Error(${JSON.stringify(
    `[SnowdropTransform] 不支持的落雪音源插件格式: ${safeReason}`
  )});
}

module.exports = { pluginInfo, sources, musicUrl };`
}

// 核心转换入口
export function transformSnowdropPlugin(
  originalCode: string,
  options: SnowdropTransformOptions = {}
): SnowdropTransformResult {
  const logs: string[] = []
  const warnings: string[] = []
  const errors: string[] = []

  const meta = extractMeta(originalCode)
  const type = detectPluginType(originalCode)
  const sourceLabel = options.sourceType ?? 'unknown'

  logs.push(
    `[SnowdropTransform] 检测到插件类型: ${type} (source=${sourceLabel})`
  )

  const start = process.hrtime.bigint()
  let transformedCode = originalCode

  try {
    if (type === 'event-driven') {
      // 复用现有事件驱动转换逻辑
      transformedCode = convertEventDrivenPlugin(originalCode)
      logs.push('[SnowdropTransform] 已按事件驱动落雪插件路径完成转换')
    } else if (type === 'suchmusic') {
      // 已符合 SuchMusic 规范，直接透传
      warnings.push('[SnowdropTransform] 检测到已是 SuchMusic 插件，跳过转换')
      transformedCode = originalCode
    } else {
      // 旧版或未知格式，生成降级插件
      const reason =
        type === 'legacy'
          ? '检测到 lx 相关调用但缺少事件驱动特征'
          : '未检测到落雪插件关键标记'
      warnings.push(`[SnowdropTransform] ${reason}，将生成降级兼容插件`)
      transformedCode = createFallbackCode(meta, reason)
    }
  } catch (error: unknown) {
    // 将未知错误安全转换为字符串消息
    let msg = '未知错误'
    if (error instanceof Error && error.message) {
      msg = String(error.message)
    } else if (typeof error === 'string') {
      msg = error
    }
    errors.push(`[SnowdropTransform] 转换失败: ${msg}`)
    warnings.push('[SnowdropTransform] 已回退为安全降级插件')
    transformedCode = createFallbackCode(meta, msg)
  }

  const end = process.hrtime.bigint()
  const durationMs = Number(end - start) / 1e6

  logs.push(`[SnowdropTransform] 转换耗时约 ${durationMs.toFixed(3)} ms`)

  const { sources, runtimeLogs } = extractSourcesSummary(transformedCode)
  if (sources.length) {
    logs.push(
      `[SnowdropTransform] 已解析到 ${sources.length} 个音源入口`
    )
  }

  return {
    meta,
    type,
    transformedCode,
    logs,
    warnings,
    errors,
    stats: {
      durationMs
    },
    sources,
    runtimeLogs
  }
}

// 简单性能基准
export function benchmarkSnowdropTransform(
  sampleCode: string,
  count = 1000
): SnowdropBenchmarkResult {
  const start = process.hrtime.bigint()
  let success = 0

  for (let i = 0; i < count; i++) {
    const result = transformSnowdropPlugin(sampleCode)
    if (result.errors.length === 0) {
      success++
    }
  }

  const end = process.hrtime.bigint()
  const durationMs = Number(end - start) / 1e6

  return {
    count: success,
    durationMs,
    averageMs: durationMs / count
  }
}
