import { watch, onBeforeUnmount } from 'vue'
import { usePlayerStore } from '../stores/playerStore'
import { audioEngine } from '../audio/audio-engine'
import { getTransitionController } from '../audio/transition-controller'

/**
 * 系统媒体控制状态
 * 与 preload 中 MediaControlStatus 结构一致。为避免依赖 preload 类型解析，
 * 此处本地定义一份（结构保持同步即可）。
 */
export interface MediaControlStatus {
  title?: string
  artist?: string
  album?: string
  /** data: | http(s): | file: | 本地文件路径 | blob:(渲染层先转 data:) */
  cover?: string
  durationMs?: number
  playing: boolean
  positionMs?: number
}

/** 系统媒体控制命令负载 */
interface MediaControlCommandPayload {
  command: string
  value?: number
}

/** 进度上报节流阈值（毫秒）：进度变化不足该值不重复上报 */
const POSITION_THROTTLE_MS = 1000

/**
 * blob: / http(s): 封面 → data: URL 转换缓存
 * 主进程的 SMTC 无法直接消费 blob: URL，需先转为 data: URL；
 * 同一 URL 只转换一次，避免重复 fetch/读取。
 * data URL 单条可达数 MB，限制条数防止长会话内存无限增长（简单 LRU）。
 */
const blobCoverCache = new Map<string, string>()
const BLOB_COVER_CACHE_MAX = 6

/**
 * 将 blob: / http(s): URL 封面转换为 data: URL
 * 转换失败（fetch 失败 / FileReader 报错 / 跨域）时回退 undefined
 */
async function convertCoverToDataUrl(cover: string): Promise<string | undefined> {
  const cached = blobCoverCache.get(cover)
  if (cached) {
    // 命中时刷新为最近使用，维持 LRU 顺序
    blobCoverCache.delete(cover)
    blobCoverCache.set(cover, cached)
    return cached
  }
  try {
    const res = await fetch(cover)
    const blob = await res.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
    if (blobCoverCache.size >= BLOB_COVER_CACHE_MAX) {
      const oldest = blobCoverCache.keys().next().value
      if (oldest !== undefined) blobCoverCache.delete(oldest)
    }
    blobCoverCache.set(cover, dataUrl)
    return dataUrl
  } catch {
    return undefined
  }
}

/** 已带 scheme 的绝对 URI（data: / blob: / http(s): / file: ...） */
const ABSOLUTE_URI_RE = /^[a-z][a-z0-9+.-]*:/i

/**
 * 归一化封面地址，使其成为主进程 / 原生模块可消费的形式。
 *
 * song.cover 有三种来源：
 * 1. 在线封面（http(s):）与本地音乐封面（data: / blob:）—— 已是绝对 URI 或走既有转换；
 * 2. Vite 静态资源路径：开发态 `/src/assets/default-cover.png`、打包态 `./assets/default-cover-xxx.png`。
 *    这类路径是 UI 占位图（默认封面）被写进 song.cover 的结果，**既不是绝对路径也不是绝对 URI**，
 *    原样下发给 SMTC 会报「不是有效的绝对 URI」(0x80070057)，默认封面因此在系统播放控件里不显示。
 *    这里统一以文档 baseURI 解析为绝对 URL：开发态得到 http(s):（就地内联为 data: URL），
 *    打包态得到 file: URL（交给主进程读盘，asar 内文件由主进程复制出来）。
 *
 * @returns 归一化后的封面；无法解析时返回 undefined（表示无封面）
 */
async function normalizeCover(cover?: string): Promise<string | undefined> {
  if (!cover) return undefined

  if (ABSOLUTE_URI_RE.test(cover)) {
    // 绝对 URI：blob: 需转换，其余原样交给主进程
    return cover.startsWith('blob:') ? await convertCoverToDataUrl(cover) : cover
  }

  // 相对资源路径 → 解析为绝对 URL
  let absolute: string
  try {
    absolute = new URL(cover, document.baseURI).href
  } catch {
    return undefined
  }

  if (absolute.startsWith('blob:')) return convertCoverToDataUrl(absolute)

  if (/^https?:/i.test(absolute)) {
    // 开发态：资源由 Vite dev server 提供，取回后内联，避免依赖 SMTC 再次下载。
    // 若取回的不是图片（例如 dev server 回落成了 HTML），退回绝对 URL 让主进程处理。
    const inlined = await convertCoverToDataUrl(absolute)
    return inlined && inlined.startsWith('data:image/') ? inlined : absolute
  }

  // 打包态：file: URL，由主进程转换为本地路径后交给原生模块
  return absolute
}

/**
 * 后端驱动的系统媒体控制（SMTC）
 *
 * 替代旧的 navigator.mediaSession 实现：
 * - 将播放器状态（歌曲元数据 / 播放状态 / 进度）通过 window.api.mediaControl.update 推送至主进程
 * - 订阅系统媒体控制台命令（play/pause/toggle/next/prev/stop/seek/seekRelative/setVolume）并驱动播放器
 * - 进度上报带节流（≥1000ms 变化才上报），歌曲元数据 / 播放状态变化强制上报
 *
 * preload 未暴露 mediaControl API 时优雅降级，不初始化、不崩溃。
 */
export function useSystemMediaControl(): void {
  // 优雅降级：无 mediaControl API 时直接返回，避免后续调用崩溃
  if (!window.api?.mediaControl) return

  const player = usePlayerStore()

  // 上次上报的歌曲标识与进度，用于节流判断
  let lastSentSongKey = ''
  let lastSentPositionMs = -1
  /**
   * 上次上报的封面：进度上报是 1Hz 的，若每次都把数 MB 的 data URL 克隆过 IPC，
   * 主进程还要每秒 base64 解码 + 写盘。封面只在真正变化时才携带。
   */
  let lastSentCover = ''

  /**
   * 构建状态并推送给主进程
   * @param force 是否强制上报（忽略进度节流）
   */
  const pushStatus = async (force = false): Promise<void> => {
    const song = player.currentSong
    const songKey = [
      song?.title ?? '',
      song?.artist ?? '',
      song?.album ?? '',
      song?.durationMs ?? ''
    ].join('|')
    const positionMs = player.positionMs

    const songChanged = songKey !== lastSentSongKey
    const positionChanged = Math.abs(positionMs - lastSentPositionMs) >= POSITION_THROTTLE_MS
    if (!force && !songChanged && !positionChanged) return

    // 封面归一化：blob: 转 data:；Vite 资源路径解析为绝对 URI（见 normalizeCover 注释）
    const cover = await normalizeCover(song?.cover)

    const status: MediaControlStatus = {
      title: song?.title,
      artist: song?.artist,
      album: song?.album,
      durationMs: song?.durationMs,
      playing: player.isPlaying,
      positionMs
    }

    // 仅在封面变化时携带该字段：主进程按「键不存在则沿用旧值」做增量合并，
    // 因此不能写成 cover: undefined（会被结构化克隆丢弃，但语义上仍是「未变化」）
    const coverKey = cover ?? ''
    if (coverKey !== lastSentCover) {
      status.cover = coverKey
      lastSentCover = coverKey
    }

    window.api.mediaControl.update(status)

    lastSentSongKey = songKey
    lastSentPositionMs = positionMs
  }

  /**
   * 处理来自系统媒体控制台的命令
   */
  const handleCommand = (payload: MediaControlCommandPayload): void => {
    const { command, value } = payload
    switch (command) {
      case 'play':
        if (!player.isPlaying && player.currentSong) {
          audioEngine.play().then((success) => {
            if (success) player.setPlaying(true)
          })
        }
        break
      case 'pause':
        if (player.isPlaying) {
          audioEngine.pause().then(() => player.setPlaying(false))
        }
        break
      case 'toggle':
        if (player.isPlaying) {
          audioEngine.pause().then(() => player.setPlaying(false))
        } else if (player.currentSong) {
          audioEngine.play().then((success) => {
            if (success) player.setPlaying(true)
          })
        }
        break
      case 'next':
        // 中断可能进行的智能过渡，走常规切歌路径
        getTransitionController().abort()
        player.setTransitioning(false)
        player.playNext()
        break
      case 'prev':
        getTransitionController().abort()
        player.setTransitioning(false)
        player.playPrev()
        break
      case 'stop':
        audioEngine.pause().then(() => player.setPlaying(false))
        player.setPosition(0)
        break
      case 'seek':
        // value 为绝对位置（毫秒），钳制到 [0, durationMs||value]
        if (typeof value === 'number' && player.currentSong) {
          const upper = player.currentSong.durationMs || value
          const target = Math.min(Math.max(value, 0), upper)
          audioEngine.seek(target).then(() => player.setPosition(target))
        }
        break
      case 'seekRelative':
        // value 为带符号偏移（毫秒）
        if (typeof value === 'number' && player.currentSong) {
          const target = Math.max(0, player.positionMs + value)
          audioEngine.seek(target).then(() => player.setPosition(target))
        }
        break
      case 'setVolume':
        // value 为 0..1 音量。
        // 必须同时下发给音频引擎：只改 store 的话，系统媒体控制台（音量键 / 媒体浮层）
        // 调音量只会动 UI，实际响度不变，表现为「音量调节失效」。
        if (typeof value === 'number' && Number.isFinite(value)) {
          const v = Math.min(1, Math.max(0, value))
          player.setVolume(v)
          void audioEngine.setVolume(v)
        }
        break
    }
  }

  // 歌曲元数据变化 → 强制上报；immediate 使挂载时立即推送初始状态（避免 onMounted 重复推送）
  watch(
    () => [
      player.currentSong?.id,
      player.currentSong?.title,
      player.currentSong?.artist,
      player.currentSong?.album,
      player.currentSong?.cover,
      player.currentSong?.durationMs
    ],
    () => {
      void pushStatus(true)
    },
    { immediate: true }
  )

  // 播放状态变化 → 强制上报
  watch(
    () => player.isPlaying,
    () => {
      void pushStatus(true)
    }
  )

  // 播放进度变化 → 节流上报
  watch(
    () => player.positionMs,
    () => {
      void pushStatus(false)
    }
  )

  // 订阅系统媒体控制命令
  window.api.mediaControl.onCommand(handleCommand)

  // 卸载时取消订阅
  onBeforeUnmount(() => {
    window.api.mediaControl.offCommand(handleCommand)
  })
}

export default useSystemMediaControl
