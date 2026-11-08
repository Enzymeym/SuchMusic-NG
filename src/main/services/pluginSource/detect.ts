/**
 * 音源插件类型识别
 *
 * 几类插件在同一目录下可能混杂，加载前需判定归属：
 *  - lx：洛雪 LX Music v2 desktop 自定义源（JSDoc 头 + globalThis.lx）
 *  - ceru：澜音 Ceru v2（exports.manifest / definePlugin）
 *  - such-v2：本应用 v2 插件（JSDoc 头 + such.register），由「设置 → 插件」加载
 *  - such：v1 老插件（window.source），已不再支持
 */
import type { SourcePluginKind } from './types'

export type DetectResult = SourcePluginKind | 'such' | 'such-v2' | 'unknown'

/** 洛雪插件头部元信息 */
export interface LxScriptInfo {
  name?: string
  description?: string
  version?: string
  author?: string
  homepage?: string
}

/**
 * 解析洛雪 JSDoc 头部注释（@name/@description/@version/@author/@homepage）
 */
export function parseLxHeader(code: string): LxScriptInfo {
  const info: LxScriptInfo = {}
  const read = (tag: string): string | undefined => {
    const re = new RegExp(`@${tag}\\s+([^\\r\\n*]+)`, 'i')
    const m = code.match(re)
    return m ? m[1].trim() : undefined
  }
  info.name = read('name')
  info.description = read('description')
  info.version = read('version')
  info.author = read('author')
  info.homepage = read('homepage')
  return info
}

/** 判定插件生态 */
export function detectPluginKind(code: string): DetectResult {
  // 澜音优先：manifest 静态可读 / 使用 SDK 入口
  if (
    /exports\s*\.\s*manifest\s*=/.test(code) ||
    /\bdefinePlugin\s*\(/.test(code) ||
    (/contributes\s*:/.test(code) && /\bproviders\s*:/.test(code))
  ) {
    return 'ceru'
  }

  // Such v2：必须排在洛雪之前！
  // v2 的 JSDoc 头（@name/@version/@author/@homepage）与洛雪完全重合，
  // 若不先判定，v2 插件会被当成洛雪脚本执行并报「未在 5 秒内发送 inited」。
  if (
    /@apiLevel\b/i.test(code) ||
    /\bsuch\s*\.\s*register\s*\(/.test(code) ||
    /globalThis\s*\.\s*such\b/.test(code)
  ) {
    return 'such-v2'
  }

  // 洛雪：JSDoc 头 或 lx 运行时特征
  if (
    /@(name|version|author|homepage|description)\b/.test(code) ||
    /\blx\s*\.\s*send\s*\(/.test(code) ||
    /\blx\s*\.\s*on\s*\(/.test(code) ||
    /EVENT_NAMES/.test(code) ||
    /globalThis\s*\.\s*lx/.test(code)
  ) {
    return 'lx'
  }

  // Such v1 应用插件（已停止支持）
  if (/window\s*\.\s*source\s*=/.test(code)) {
    return 'such'
  }

  return 'unknown'
}

/** 检测是否包含未打包的 ESM 语法（顶层 import / export，澜音产物应为已打包单文件） */
export function hasBareEsmSyntax(code: string): boolean {
  return /(^|\n)\s*(import\s|export\s+(default|const|function|class|\{))/.test(code)
}
