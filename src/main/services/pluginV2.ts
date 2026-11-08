/**
 * v2 插件服务（主进程装配层）
 *
 * `src/plugin` 是纯运行时，不 import electron / main。所有需要宿主环境的能力
 * （userData 路径、窗口通信、歌单往返、写标签）都在这里注入。
 */
import { app, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { getMainWindow } from '../windows/mainWindow'
import { PluginRegistry, type RegistryDeps } from '../../plugin/registry'
import { ConfirmQueue } from '../../plugin/runtime/confirm'
import { readPluginCodeSync } from '../../plugin/registry'
import { parsePluginHeader } from '../../plugin/header'
import { writeAudioMeta } from '../utils/musicMetaWriter'
import { pluginRouter, type SourceBackend } from './pluginRouter'
import type {
  BatchConfirmResponse,
  PlaylistOpRequest,
  PlaylistOpResponse,
  V2Track
} from '../../plugin/types'
import type { PluginNotice, V2PluginSummary } from '../../shared/plugin/types'
import type { PluginSourceInfo, QualityId, SourceTrack } from './pluginSource/types'

// ==================== 通知 ====================

function sendNotice(notice: PluginNotice): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('plugin:notice', notice)
  }
}

// ==================== 敏感操作确认 ====================

const confirmQueue = new ConfirmQueue({
  send: (request) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send('plugin:request-batch-confirm', request)
  },
  isAvailable: () => {
    const win = getMainWindow()
    return !!win && !win.isDestroyed()
  }
})

/** 渲染层返回确认结果 */
export function resolveV2Confirm(response: BatchConfirmResponse): void {
  confirmQueue.resolve(response)
}

// ==================== 歌单操作往返 ====================

const pendingPlaylistOps = new Map<
  string,
  { resolve: (res: PlaylistOpResponse) => void; timer: NodeJS.Timeout }
>()

function requestPlaylistOp(request: PlaylistOpRequest): Promise<PlaylistOpResponse> {
  return new Promise((resolve) => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) {
      resolve({ requestId: request.requestId, success: false, error: '渲染进程不可用' })
      return
    }
    const timer = setTimeout(() => {
      pendingPlaylistOps.delete(request.requestId)
      resolve({ requestId: request.requestId, success: false, error: '歌单操作超时' })
    }, 15_000)
    pendingPlaylistOps.set(request.requestId, { resolve, timer })
    win.webContents.send('plugin:playlist-op', request)
  })
}

/** 渲染层返回歌单操作结果 */
export function resolveV2PlaylistOp(response: PlaylistOpResponse): void {
  const pending = pendingPlaylistOps.get(response.requestId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingPlaylistOps.delete(response.requestId)
  pending.resolve(response)
}

// ==================== 注册表 ====================

let registry: PluginRegistry | null = null

/** 装配并返回 v2 注册表（需在 app ready 之后调用） */
export function initPluginV2(): PluginRegistry {
  if (registry) return registry

  const deps: RegistryDeps = {
    userDataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    locale: app.getLocale(),
    confirm: confirmQueue,
    playlistOp: requestPlaylistOp,
    writeAudioMeta: (filePath, tags) => writeAudioMeta(filePath, tags as any),
    notify: sendNotice
  }
  registry = new PluginRegistry(deps)
  pluginRouter.setV2Backend(createV2Backend())
  return registry
}

export function getV2Registry(): PluginRegistry {
  if (!registry) throw new Error('v2 插件系统尚未初始化')
  return registry
}

// ==================== 路由后端适配 ====================

/** v2 曲目 → 音源注册表的统一曲目结构 */
function toSourceTrack(track: V2Track): SourceTrack {
  return {
    pluginId: track.pluginId,
    providerId: track.providerId,
    sourceKey: track.sourceKey,
    id: track.id,
    ref: track.ref,
    title: track.title,
    artist: track.artist,
    album: track.album,
    coverUrl: track.coverUrl,
    durationMs: track.durationMs,
    qualities: track.qualities as QualityId[] | undefined,
    playable: track.playable
  }
}

function createV2Backend(): SourceBackend {
  return {
    has: (pluginId) => getV2Registry().has(pluginId),
    async resolveUrl(req) {
      const res = await getV2Registry().resolveUrl({
        pluginId: req.pluginId,
        providerId: req.providerId,
        sourceKey: req.sourceKey,
        id: req.id,
        ref: req.ref,
        quality: req.quality,
        qualityOverride: req.qualityOverride
      })
      return {
        pluginId: res.pluginId,
        url: res.url,
        expiresAt: res.expiresAt,
        requestHeaders: res.requestHeaders
      }
    },
    async lyric(req) {
      return getV2Registry().lyric(req)
    },
    async pic(req) {
      return getV2Registry().pic(req)
    },
    async search(req) {
      const page = await getV2Registry().search({
        pluginId: req.pluginId,
        providerId: req.providerId,
        query: req.query,
        limit: req.limit,
        cursor: req.cursor
      })
      return {
        items: page.items.map(toSourceTrack),
        nextCursor: page.nextCursor,
        totalEstimate: page.totalEstimate
      }
    },
    listSearchSources: () => getV2Registry().listSearchSources(),
    reload: () => getV2Registry().reloadEnabled()
  }
}

// ==================== 更新检查 ====================

/** 简单语义化版本比较：a > b 返回正数 */
function compareVersion(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.replace(/^v/i, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export interface UpdateCheckResult {
  hasNew: boolean
  version?: string
  url?: string
  changelog?: string
}

/** 通过 `@updateUrl` 拉取新版本脚本并比对版本号 */
export async function checkPluginUpdate(pluginId: string): Promise<UpdateCheckResult> {
  const summary: V2PluginSummary | undefined = getV2Registry().get(pluginId)
  if (!summary) throw new Error(`插件「${pluginId}」不存在`)

  const updateUrl = summary.updateAlert?.updateUrl
  if (!updateUrl) return { hasNew: false }

  const remote = await fetchRemoteHeader(updateUrl)
  if (!remote) return { hasNew: false }
  if (compareVersion(remote.version, summary.version) <= 0) return { hasNew: false }
  return {
    hasNew: true,
    version: remote.version,
    url: summary.filePath,
    changelog: `发现新版本 ${remote.version}（当前 ${summary.version}）`
  }
}

/** 拉取远端脚本并只解析插件头 */
export async function fetchRemoteHeader(
  url: string
): Promise<{ version: string; name: string } | null> {
  if (!/^https?:\/\//i.test(url)) return null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const text = await res.text()
    const parsed = parsePluginHeader(text)
    if (!parsed.header) return null
    return { version: parsed.header.version, name: parsed.header.name }
  } catch (err) {
    console.warn('[Plugin] 检查更新失败:', url, err)
    return null
  }
}

/** 读取插件头（供 inspect 通道复用，同步路径） */
export function inspectPluginFileSync(filePath: string): {
  header: ReturnType<typeof parsePluginHeader>['header']
  error?: string
} {
  try {
    const code = readPluginCodeSync(filePath)
    const parsed = parsePluginHeader(code)
    return { header: parsed.header, error: parsed.error }
  } catch (err) {
    return { header: null, error: (err as Error).message }
  }
}

/** 打开插件主页（设置模态框里点作者/主页） */
export function openExternal(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
}

/** 供 IPC 层生成请求 id */
export function newRequestId(): string {
  return randomUUID()
}

/** 兼容类型导出（避免 IPC 层再 import plugin/types） */
export type { PluginSourceInfo }
