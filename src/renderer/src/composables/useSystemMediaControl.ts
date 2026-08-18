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
  /** data: | http(s): | 本地文件路径 | blob:(渲染层先转 data:) */
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
 * blob: 封面 URL → data: URL 转换缓存
 * 主进程的 SMTC 无法直接消费 blob: URL，需先转为 data: URL；
 * 同一 blob URL 只转换一次，避免重复 fetch/读取。
 */
const blobCoverCache = new Map<string, string>()

/**
 * 将 blob: URL 封面转换为 data: URL
 * 转换失败（fetch 失败 / FileReader 报错）时回退 undefined
 */
async function convertBlobCoverToDataUrl(cover: string): Promise<string | undefined> {
  const cached = blobCoverCache.get(cover)
  if (cached) return cached
  try {
    const res = await fetch(cover)
    const blob = await res.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
    blobCoverCache.set(cover, dataUrl)
    return dataUrl
  } catch {
    return undefined
  }
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
   * 构建状态并推送给主进程
   * @param force 是否强制上报（忽略节流）
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

    // blob: 封面主进程无法消费，异步转换为 data: URL（失败则回退 undefined）
    let cover: string | undefined = song?.cover
    if (cover && cover.startsWith('blob:')) {
      cover = await convertBlobCoverToDataUrl(cover)
    }

    const status: MediaControlStatus = {
      title: song?.title,
      artist: song?.artist,
      album: song?.album,
      cover,
      durationMs: song?.durationMs,
      playing: player.isPlaying,
      positionMs
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
        // value 为 0..1 音量
        if (typeof value === 'number') player.setVolume(value)
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
