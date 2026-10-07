/**
 * Markdown 渲染器（渲染进程共用）
 *
 * 统一封装 markdown-it 初始化，供「设置 → 关于 → 更新日志」与「更新弹窗 → 更新内容」复用。
 * 两处都用动态 import 的组件引用本模块，打包时 markdown-it 会落到同一个公共 chunk，
 * 不会重复打包。
 *
 * 安全约定（更新内容来自 GitHub Release，属于外部数据）：
 * - `html: false`：源文本里的裸 HTML 会被转义，不会直出到 v-html；
 * - markdown-it 默认的 validateLink 已拦截 javascript: / vbscript: / file: 等危险协议；
 * - 链接统一补 `target="_blank"` + `rel="noopener noreferrer nofollow"`，点击后走主窗口的
 *   `setWindowOpenHandler` → `shell.openExternal`，即用系统浏览器打开，也避免渲染进程被导航走。
 */

import MarkdownIt from 'markdown-it'
import { full as emoji } from 'markdown-it-emoji'
import markdownItGitHubAlerts from 'markdown-it-github-alerts'
import 'markdown-it-github-alerts/styles/github-colors-light.css'
import 'markdown-it-github-alerts/styles/github-colors-dark-class.css'
import 'markdown-it-github-alerts/styles/github-base.css'

/** markdown-it 实例（懒建 + 单例） */
let renderer: MarkdownIt | null = null
/** 初始化已失败过，不再重试，避免每次渲染都抛异常 */
let initFailed = false

function createRenderer(): MarkdownIt | null {
  try {
    // 兼容 default / named 两种导出形态（打包器差异）
    const MarkdownItClass = (MarkdownIt as unknown as { default?: typeof MarkdownIt }).default ?? MarkdownIt
    const instance = new MarkdownItClass({
      html: false,
      linkify: true,
      typographer: true
    })

    instance.use(emoji)
    instance.use(markdownItGitHubAlerts)

    // 外链一律新窗口打开，交给主进程用系统浏览器处理
    const defaultLinkOpen = instance.renderer.rules.link_open
    instance.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      tokens[idx].attrSet('target', '_blank')
      tokens[idx].attrSet('rel', 'noopener noreferrer nofollow')
      return defaultLinkOpen
        ? defaultLinkOpen(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options)
    }

    return instance
  } catch (e) {
    initFailed = true
    console.error('[markdown] MarkdownIt 初始化失败:', e)
    return null
  }
}

function getRenderer(): MarkdownIt | null {
  if (!renderer && !initFailed) renderer = createRenderer()
  return renderer
}

/** 转义 HTML，用于渲染器不可用时的纯文本兜底 */
function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

/** Markdown 渲染器是否可用（不可用时调用方应退化为纯文本展示） */
export function isMarkdownAvailable(): boolean {
  return getRenderer() !== null
}

/**
 * 把 Markdown 源文本渲染为 HTML 字符串（可直接绑 `v-html`）。
 *
 * 传入空内容返回空串；渲染异常时返回转义后的纯文本兜底，不会把异常抛给调用方。
 */
export function renderMarkdown(source: string | null | undefined): string {
  const text = (source ?? '').trim()
  if (!text) return ''

  const instance = getRenderer()
  if (!instance) return `<p>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</p>`

  try {
    return instance.render(text)
  } catch (e) {
    console.error('[markdown] 渲染失败:', e)
    return `<p>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</p>`
  }
}
