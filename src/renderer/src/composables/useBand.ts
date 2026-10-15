/**
 * SuchMusic 手环通信 · 渲染进程组合式函数（Windows 端）
 *
 * 通过 preload 暴露的 `window.electron.ipcRenderer` 与主进程通信：
 * - 向主进程下发配置 / 连接命令 / RPC（`band:set-config` / `band:connect` / `band:request`）；
 * - 订阅主进程推送的 `band:status`（连接状态）与 `band:event`（手机侧事件）。
 *
 * 术语与字段名严格对齐 `docs/ARCH-手环通信.md` §3。
 */

import { ref, onMounted, onBeforeUnmount } from 'vue'

/** 连接状态推送通道（与主进程 band-bridge 一致）。 */
const STATUS_CHANNEL = 'band:status'
/** 手机侧事件推送通道。 */
const EVENT_CHANNEL = 'band:event'

/** 本地配置（镜像主进程 BandConfig）。 */
export interface BandConfig {
  enabled: boolean
  host: string
  port: number
  path: string
  token: string
  pairCode: string
}

/** 连接状态（镜像主进程 BandClientStatus）。 */
export interface BandStatus {
  state: 'disabled' | 'disconnected' | 'connecting' | 'handshaking' | 'ready' | 'error'
  peer: string
  proto: number
  caps: string[]
  lastError: { code: string; message: string; missing?: string } | null
  reconnectAttempts: number
}

/** 歌曲 DTO（§3.5.1）。 */
export interface BandSong {
  id: string
  name: string
  artist: string
  album?: string
  durationMs?: number
  source?: string
  hasCover?: boolean
}

/** 协议播放模式（§3.5）。 */
export type ProtocolPlayMode = 'loop' | 'single' | 'shuffle'

/** 手机侧事件体。 */
interface BandEventMessage {
  event: string
  payload: Record<string, unknown>
}

/** 协议模式 → Windows 模式（与主进程 protocol.ts 保持一致，用于图标/标签）。 */
const PROTOCOL_MODE_LABEL: Record<ProtocolPlayMode, string> = {
  loop: '顺序播放',
  single: '单曲循环',
  shuffle: '乱序播放'
}

const PROTOCOL_MODE_ICON: Record<ProtocolPlayMode, string> = {
  loop: 'mgc_repeat_line',
  single: 'mgc_repeat_one_line',
  shuffle: 'mgc_shuffle_line'
}

function isIpcAvailable(): boolean {
  return !!(window.electron && window.electron.ipcRenderer)
}

export function protocolModeLabel(mode: ProtocolPlayMode): string {
  return PROTOCOL_MODE_LABEL[mode] ?? '顺序播放'
}

export function protocolModeIcon(mode: ProtocolPlayMode): string {
  return PROTOCOL_MODE_ICON[mode] ?? 'mgc_repeat_line'
}

export function useBand() {
  const config = ref<BandConfig>({
    enabled: false,
    host: '',
    port: 8787,
    path: '/suchmusic',
    token: '',
    pairCode: ''
  })

  const status = ref<BandStatus>({
    state: 'disabled',
    peer: '',
    proto: 1,
    caps: [],
    lastError: null,
    reconnectAttempts: 0
  })

  // 手机侧播放状态（经事件推送）
  const song = ref<BandSong | null>(null)
  const playState = ref<'idle' | 'loading' | 'playing' | 'paused' | 'error'>('idle')
  const playing = ref(false)
  const positionMs = ref(0)
  const durationMs = ref(0)
  const mode = ref<ProtocolPlayMode>('loop')
  const volume = ref<number | null>(null)
  const queue = ref<{ count: number; currentIndex: number }>({ count: 0, currentIndex: -1 })
  const lyricMeta = ref<{ has: boolean; count: number } | null>(null)
  const lyricLine = ref<{ songId: string; index: number; text: string; t: number } | null>(null)
  const lyricWindow = ref<Array<{ t: number; text: string }>>([])

  const logs = ref<string[]>([])
  const busy = ref(false)

  function pushLog(message: string): void {
    const stamp = new Date().toLocaleTimeString()
    logs.value = [`[${stamp}] ${message}`, ...logs.value].slice(0, 100)
  }

  /** 读取配置与状态（挂载时调用）。 */
  async function refresh(): Promise<void> {
    if (!isIpcAvailable()) return
    try {
      config.value = await window.electron.ipcRenderer.invoke('band:get-config')
      status.value = await window.electron.ipcRenderer.invoke('band:get-status')
    } catch (error) {
      pushLog(`读取配置失败：${String(error)}`)
    }
  }

  /** 局部更新配置（主进程负责持久化与必要的重连）。 */
  async function saveConfig(partial: Partial<BandConfig>): Promise<void> {
    if (!isIpcAvailable()) return
    config.value = { ...config.value, ...partial }
    config.value = await window.electron.ipcRenderer.invoke('band:set-config', partial)
  }

  async function connect(): Promise<void> {
    if (!isIpcAvailable()) return
    busy.value = true
    try {
      status.value = await window.electron.ipcRenderer.invoke('band:connect')
    } catch (error) {
      pushLog(`连接失败：${String(error)}`)
    } finally {
      busy.value = false
    }
  }

  async function disconnect(): Promise<void> {
    if (!isIpcAvailable()) return
    status.value = await window.electron.ipcRenderer.invoke('band:disconnect')
  }

  /** 发送一次 RPC（§3.5）。 */
  async function request(
    method: string,
    payload: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    if (!isIpcAvailable()) throw new Error('IPC 不可用')
    return window.electron.ipcRenderer.invoke('band:request', method, payload)
  }

  // --- 控制便捷方法（对齐 §3.5 方法名） ---
  const play = (): Promise<unknown> => request('playback.play')
  const pause = (): Promise<unknown> => request('playback.pause')
  const toggle = (): Promise<unknown> => request('playback.toggle')
  const next = (): Promise<unknown> => request('playback.next')
  const prev = (): Promise<unknown> => request('playback.prev')
  const seek = (value: number): Promise<unknown> =>
    request('playback.seek', { positionMs: Math.max(0, Math.round(value)) })
  const setMode = (value: ProtocolPlayMode): Promise<unknown> =>
    request('playback.setMode', { mode: value })

  /** 应用 `StateSnapshot`（state.get 响应 / 兜底重同步）。 */
  function applySnapshot(payload: Record<string, unknown>): void {
    if (typeof payload.state === 'string') {
      playState.value = payload.state as typeof playState.value
    }
    if (typeof payload.playing === 'boolean') playing.value = payload.playing
    if (payload.song && typeof payload.song === 'object') {
      song.value = payload.song as BandSong
    }
    if (typeof payload.positionMs === 'number') positionMs.value = payload.positionMs
    if (typeof payload.durationMs === 'number') durationMs.value = payload.durationMs
    if (typeof payload.mode === 'string' && isProtocolMode(payload.mode)) mode.value = payload.mode
    if (typeof payload.volume === 'number') volume.value = payload.volume
    if (payload.queue && typeof payload.queue === 'object') {
      queue.value = payload.queue as { count: number; currentIndex: number }
    }
    if (payload.lyric && typeof payload.lyric === 'object') {
      lyricMeta.value = payload.lyric as { has: boolean; count: number }
    }
  }

  function isProtocolMode(value: string): value is ProtocolPlayMode {
    return value === 'loop' || value === 'single' || value === 'shuffle'
  }

  /** 处理主进程推来的手机侧事件（§3.6）。 */
  function applyEvent(name: string, payload: Record<string, unknown>): void {
    switch (name) {
      case 'player.state':
        if (typeof payload.state === 'string') playState.value = payload.state as typeof playState.value
        if (typeof payload.playing === 'boolean') playing.value = payload.playing
        break
      case 'player.song':
        if (payload.song && typeof payload.song === 'object') song.value = payload.song as BandSong
        break
      case 'player.progress':
        if (typeof payload.positionMs === 'number') positionMs.value = payload.positionMs
        if (typeof payload.durationMs === 'number') durationMs.value = payload.durationMs
        break
      case 'player.mode':
        if (typeof payload.mode === 'string' && isProtocolMode(payload.mode)) mode.value = payload.mode
        break
      case 'player.volume':
        if (typeof payload.volume === 'number') volume.value = payload.volume
        break
      case 'player.queue':
        queue.value = {
          count: typeof payload.count === 'number' ? payload.count : 0,
          currentIndex: typeof payload.currentIndex === 'number' ? payload.currentIndex : -1
        }
        break
      case 'lyric.line':
        lyricLine.value = {
          songId: String(payload.songId ?? ''),
          index: typeof payload.index === 'number' ? payload.index : 0,
          text: String(payload.text ?? ''),
          t: typeof payload.t === 'number' ? payload.t : 0
        }
        break
      case 'lyric.meta':
        lyricMeta.value = {
          has: payload.has === true,
          count: typeof payload.count === 'number' ? payload.count : 0
        }
        break
      case 'state.snapshot':
        applySnapshot(payload)
        break
      case 'xfer.complete':
        handleXferComplete(payload)
        break
      case 'sys.hello_ack':
        pushLog(`握手完成：server=${JSON.stringify(payload.server ?? {})}`)
        break
      case 'sys.error':
        pushLog(`错误 ${String(payload.code ?? '')}：${String(payload.message ?? '')}`)
        break
      case 'band.toast':
        pushLog(`提示：${String(payload.text ?? '')}`)
        break
      default:
        pushLog(`事件 ${name}`)
        break
    }
  }

  /** 处理分片组装完成（§3.8）：歌词窗口直接落 UI；搜索结果仅记录。 */
  function handleXferComplete(payload: Record<string, unknown>): void {
    const kind = String(payload.kind ?? '')
    const text = String(payload.text ?? '')
    if (kind === 'lyric_window') {
      try {
        const parsed = JSON.parse(text) as { lines?: Array<{ t: number; text: string }> }
        lyricWindow.value = Array.isArray(parsed.lines) ? parsed.lines : []
      } catch {
        pushLog('歌词窗口解析失败')
      }
    } else {
      pushLog(`收到分片载荷：${kind} (${text.length} 字符)`)
    }
  }

  const onStatus = (_event: unknown, payload: BandStatus): void => {
    status.value = payload
  }

  const onEvent = (_event: unknown, message: BandEventMessage): void => {
    if (!message || typeof message.event !== 'string') return
    applyEvent(message.event, message.payload ?? {})
  }

  onMounted(() => {
    if (!isIpcAvailable()) return
    window.electron.ipcRenderer.on(STATUS_CHANNEL, onStatus)
    window.electron.ipcRenderer.on(EVENT_CHANNEL, onEvent)
    void refresh()
  })

  onBeforeUnmount(() => {
    if (!isIpcAvailable()) return
    window.electron.ipcRenderer.removeListener(STATUS_CHANNEL, onStatus)
    window.electron.ipcRenderer.removeListener(EVENT_CHANNEL, onEvent)
  })

  return {
    // 状态
    config,
    status,
    song,
    playState,
    playing,
    positionMs,
    durationMs,
    mode,
    volume,
    queue,
    lyricMeta,
    lyricLine,
    lyricWindow,
    logs,
    busy,
    // 操作
    refresh,
    saveConfig,
    connect,
    disconnect,
    request,
    play,
    pause,
    toggle,
    next,
    prev,
    seek,
    setMode,
    // 工具
    protocolModeLabel,
    protocolModeIcon
  }
}
