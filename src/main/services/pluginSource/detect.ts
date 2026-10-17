/**
 * 音源插件类型识别
 *
 * 三类插件在同一目录下可能混杂，加载前需判定归属：
 *  - lx：洛雪 LX Music v2 desktop 自定义源（JSDoc 头 + globalThis.lx）
 *  - ceru：澜音 Ceru v2（exports.manifest / definePlugin）
 *  - such：本应用 Such 插件（window.source），应走「插件管理」而非音源插件
 */
import type { SourcePluginKind } from './types'

export type DetectResult = SourcePluginKind | 'such' | 'unknown'

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

  // Such 应用插件
  if (/window\s*\.\s*source\s*=/.test(code)) {
    return 'such'
  }

  return 'unknown'
}

/** 检测是否包含未打包的 ESM 语法（顶层 import / export，澜音产物应为已打包单文件） */
export function hasBareEsmSyntax(code: string): boolean {
  return /(^|\n)\s*(import\s|export\s+(default|const|function|class|\{))/.test(code)
}
