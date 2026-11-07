/**
 * v2 插件头解析
 *
 * 插件以单个 JS 文件交付，元信息写在文件开头的 JSDoc 注释里（行首 `@tag 值`）：
 * `@name` / `@id` / `@version` / `@description` / `@author` / `@homepage` /
 * `@apiLevel` / `@grant` / `@updateUrl`。
 *
 * 之所以用注释头而不是 `exports.manifest`：单文件脚本不需要模块系统，
 * 宿主可以在**执行代码之前**完成校验与展示（拒绝高版本插件、列出权限）。
 */
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { SUCH_API_LEVEL, SUCH_GRANTS, type SuchPluginHeader } from './types'

/** 头解析结果 */
export interface HeaderParseResult {
  header: SuchPluginHeader | null
  /** 解析/校验失败原因（header 为 null 时有值） */
  error?: string
  /** 声明了但宿主不认识的 @grant（忽略，仅提示） */
  unknownGrants?: string[]
  /** 看起来是旧版 `window.source` 插件 */
  legacy?: boolean
}

/** 从代码里读一个 @tag 的值 */
function readTag(code: string, tag: string): string | undefined {
  // 只匹配注释内、行首的 @tag，避免把正文里的 @ 误当元信息
  const re = new RegExp(`^\\s*\\*?\\s*@${tag}\\s+([^\\r\\n]+)`, 'im')
  const m = code.match(re)
  if (!m) return undefined
  return m[1].replace(/\*\/\s*$/, '').trim()
}

/**
 * 读一个可能出现多次的 @tag（如 `@grant` 可以一行写多个，也可以写多行）。
 */
function readTags(code: string, tag: string): string[] {
  const re = new RegExp(`^\\s*\\*?\\s*@${tag}\\s+([^\\r\\n]+)`, 'gim')
  const out: string[] = []
  for (const m of code.matchAll(re)) {
    const value = m[1].replace(/\*\/\s*$/, '').trim()
    if (value) out.push(value)
  }
  return out
}

/**
 * 解析插件头的元信息。
 *
 * 只扫描文件前 8 KB：头必须写在最前面，也避免为大文件做全量正则。
 */
export function parsePluginHeader(code: string): HeaderParseResult {
  const head = code.slice(0, 8192)

  // 旧版插件（window.source / suchmusic）在这里给出明确提示，
  // 而不是让它掉进「缺少 @apiLevel」这种看不懂的报错里。
  if (/window\s*\.\s*source\s*=/.test(head) && !/@apiLevel\b/i.test(head)) {
    return {
      header: null,
      legacy: true,
      error: '这是 v1 插件（window.source），新版插件系统已不再支持，请改用 such.register() 的 v2 规范'
    }
  }

  const name = readTag(head, 'name')
  const id = readTag(head, 'id')
  const version = readTag(head, 'version')
  const apiLevelRaw = readTag(head, 'apiLevel')

  const missing = [
    !name && '@name',
    !id && '@id',
    !version && '@version',
    !apiLevelRaw && '@apiLevel'
  ].filter(Boolean) as string[]

  if (missing.length > 0) {
    return {
      header: null,
      error: `插件头缺少必填字段：${missing.join('、')}（应为文件开头的 JSDoc 注释）`
    }
  }

  const apiLevel = Number(apiLevelRaw)
  if (!Number.isFinite(apiLevel) || apiLevel < 1) {
    return { header: null, error: `@apiLevel 必须是 ≥1 的整数，当前值：${apiLevelRaw}` }
  }
  if (apiLevel > SUCH_API_LEVEL) {
    return {
      header: null,
      error: `插件要求 API level ${apiLevel}，当前 Such 仅支持 ${SUCH_API_LEVEL}，请升级应用后再安装`
    }
  }

  const declared = readTags(head, 'grant').flatMap((value) => value.split(/[\s,]+/)).filter(Boolean)
  const known = new Set<string>(SUCH_GRANTS)
  const grants = declared.filter((g) => known.has(g))
  const unknownGrants = declared.filter((g) => !known.has(g))

  return {
    header: {
      name: name as string,
      id: id as string,
      version: version as string,
      description: readTag(head, 'description'),
      author: readTag(head, 'author'),
      homepage: readTag(head, 'homepage'),
      apiLevel,
      grants,
      updateUrl: readTag(head, 'updateUrl')
    },
    unknownGrants: unknownGrants.length > 0 ? unknownGrants : undefined
  }
}

/**
 * 生成宿主内唯一的插件 id。
 *
 * - 加 `v2.` 前缀，与洛雪/澜音的 id 命名空间隔离，路由层据此判定生态
 * - 追加 `filePath` 的短哈希：同名插件装两份、或作者改了 `@id` 都不会互相覆盖
 * - slug 只保留安全字符，杜绝 `@id` 里的 `../` 造成路径穿越
 */
export function buildPluginHostId(header: SuchPluginHeader, filePath: string): string {
  const raw = (header.id || header.name || basename(filePath)).trim()
  const slug =
    raw
      .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
      // 连续点会被当成上级目录，统一压掉
      .replace(/\.{2,}/g, '_')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 48) || 'plugin'
  const suffix = createHash('sha1').update(filePath).digest('hex').slice(0, 6)
  return `v2.${slug}-${suffix}`
}

/** 目录名用 id 哈希，进一步隔离任何非法字符 */
export function pluginDataDirName(pluginId: string): string {
  return createHash('sha1').update(pluginId).digest('hex').slice(0, 16)
}
