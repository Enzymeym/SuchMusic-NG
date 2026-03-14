import type { DecodedAudio } from '../apis/audio-decoder.types'
import { usePlayerStore } from '../stores/playerStore'

// 全局 Web Audio 引擎，用于统一管理播放
class WebAudioEngine {
  private audioContext: AudioContext | null = null
  private gainNode: GainNode | null = null
  private limiterNode: DynamicsCompressorNode | null = null
  private limiterStrength: number = 0.6 // 压限强度（0-1）
  private eqNodes: BiquadFilterNode[] = [] // 均衡器滤波节点
  private eqGains: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] // 各频段增益（dB）
  private eqEnabled: boolean = false // 是否启用均衡器
  private currentSource: AudioBufferSourceNode | null = null
  private currentBuffer: AudioBuffer | null = null
  private startOffset: number = 0
  private startTime: number = 0
  private streamSources: AudioBufferSourceNode[] = []
  private streamSampleRate: number | null = null
  private streamChannels: number | null = null
  private streamCursorTime = 0
  private mediaElement: HTMLAudioElement | null = null
  private positionTimer: number | null = null
  private volume: number = 1

  // 确保 AudioContext 初始化
  private ensureContext(): void {
    if (this.audioContext) return

    const Ctx =
      window.AudioContext ||
      // 兼容部分旧浏览器
      (window as any).webkitAudioContext

    const context = new Ctx()
    const gain = context.createGain()
    const limiter = context.createDynamicsCompressor()

    // 创建 10 段均衡器：低频到高频
    const freqs = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    this.eqNodes = freqs.map((freq) => {
      const biquad = context.createBiquadFilter()
      biquad.type = 'peaking'
      biquad.frequency.value = freq
      biquad.Q.value = 1
      biquad.gain.value = 0
      return biquad
    })

    // 连接顺序：增益 -> EQ 链 -> 压限器 -> 输出
    gain.connect(this.eqNodes[0])
    for (let i = 0; i < this.eqNodes.length - 1; i += 1) {
      this.eqNodes[i].connect(this.eqNodes[i + 1])
    }
    this.eqNodes[this.eqNodes.length - 1].connect(limiter)
    limiter.connect(context.destination)

    this.audioContext = context
    this.gainNode = gain
    this.limiterNode = limiter

    // 根据当前设定应用压限与 EQ 参数
    this.applyLimiterStrength(this.limiterStrength)
    this.applyEqSettings()
  }

  // 停止位置更新，防止切歌时进度条跳变
  private stopProgressUpdates(): void {
    if (this.positionTimer !== null) {
      window.clearInterval(this.positionTimer)
      this.positionTimer = null
    }
    if (this.mediaElement) {
      this.mediaElement.ontimeupdate = null
    }
  }

  // 停止当前播放
  stop(): void {
    // 停止进度更新
    this.stopProgressUpdates()

    if (this.currentSource) {
      this.currentSource.stop()
      this.currentSource.disconnect()
      this.currentSource = null
    }

    // 停止所有正在流式播放的音频
    if (this.streamSources.length > 0) {
      this.streamSources.forEach((source) => {
        try {
          source.stop()
          source.disconnect()
        } catch {
          // 忽略停止过程中的异常
        }
      })
      this.streamSources = []
    }

    this.streamSampleRate = null
    this.streamChannels = null
    this.streamCursorTime = 0

    // 停止并重置基于 HTMLAudioElement 的播放
    if (this.mediaElement) {
      this.mediaElement.pause()
      this.mediaElement.currentTime = 0
    }

    this.currentBuffer = null
    this.startOffset = 0
    this.startTime = 0
  }

  private fadeTo(target: number, durationMs: number): void {
    if (!this.audioContext || !this.gainNode) return
    const now = this.audioContext.currentTime
    const gain = this.gainNode.gain
    const current = gain.value
    const durationSec = Math.max(durationMs, 0) / 1000
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(current, now)
    gain.linearRampToValueAtTime(target, now + durationSec)
  }

  public async fadeOutAndStop(durationMs: number): Promise<void> {
    // 立即停止进度更新，防止切歌时进度条跳变
    this.stopProgressUpdates()

    if (!this.audioContext || !this.gainNode) {
      this.stop()
      return
    }
    const originalVolume = this.volume
    this.fadeTo(0, durationMs)
    await new Promise((resolve) => setTimeout(resolve, durationMs))
    this.stop()
    this.gainNode.gain.value = 0
    this.volume = originalVolume
  }

  // 暂停播放
  async pause(): Promise<void> {
    if (this.audioContext?.state === 'running') {
      await this.audioContext.suspend()
    }
    if (this.positionTimer !== null) {
      window.clearInterval(this.positionTimer)
      this.positionTimer = null
    }
  }

  // 恢复播放（同时恢复 AudioContext 和播放源）
  async play(): Promise<boolean> {
    this.ensureContext()
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume()
    }

    if (this.mediaElement && !this.currentBuffer) {
      // 恢复 HTMLAudioElement 播放
      try {
        await this.mediaElement.play()
        this.fadeTo(this.volume, 200)
        // 恢复位置更新定时器
        this.startPositionTimer()
        return true
      } catch (e) {
        console.error('Failed to play media element', e)
        return false
      }
    } else if (this.currentBuffer) {
      // 恢复 Buffer 播放
      // 如果当前没有 source 在播放（例如刚加载完或者已停止），则重新开始
      if (!this.currentSource) {
        const p = usePlayerStore()
        const offset = p.positionMs / 1000
        this.playBuffer(this.currentBuffer, offset)
        this.gainNode!.gain.value = 0
        this.fadeTo(this.volume, 200)
      }
      // 恢复位置更新定时器
      this.startPositionTimer()
      return true
    }
    
    return false
  }

  // 仅恢复 AudioContext（不触发播放源的 play）
  async resume(): Promise<void> {
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume()
    }
    
    // 恢复位置更新定时器
    if (this.positionTimer === null && (this.currentSource || (this.mediaElement && !this.mediaElement.paused)) && this.audioContext) {
      this.startPositionTimer()
    }
  }

  private startPositionTimer() {
    if (this.positionTimer !== null) {
      window.clearInterval(this.positionTimer)
    }

    const p = usePlayerStore()
    const durationMs = p.currentSong?.durationMs ?? 0 // 当前歌曲总时长（毫秒）

    this.positionTimer = window.setInterval(() => {
      if (!this.audioContext) return
      
      // 计算当前播放位置：(当前时间 - 播放开始时间) + 偏移量
      const elapsed = this.audioContext.currentTime - this.startTime
      const currentPos = (elapsed + this.startOffset) * 1000

      // 先做下限裁剪，避免出现负数
      let clamped = Math.max(currentPos, 0)

      // 当已知总时长时再做上限裁剪，避免出现“回跳到 0”现象
      if (durationMs > 0) {
        clamped = Math.min(clamped, durationMs)
      }

      p.setPosition(clamped)
    }, 250)
  }

  // 播放指定的 buffer
  private playBuffer(buffer: AudioBuffer, offset: number) {
    if (!this.audioContext || !this.gainNode) return

    // 停止旧 source
    if (this.currentSource) {
      try {
        this.currentSource.stop()
        this.currentSource.disconnect()
      } catch (e) {
        // ignore
      }
    }

    const source = this.audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(this.gainNode)
    
    this.startOffset = offset
    this.startTime = this.audioContext.currentTime
    
    source.start(0, offset)
    this.currentSource = source
    
    this.startPositionTimer()
  }

  // 跳转到指定位置
  seek(positionMs: number) {
    // 优先处理基于 HTMLAudioElement 的播放（例如 URL 播放）
    if (this.mediaElement && !this.currentBuffer) {
      const seconds = Math.max(positionMs / 1000, 0)
      this.mediaElement.currentTime = seconds

      const p = usePlayerStore()
      p.setPosition(positionMs)
      return
    }

    // 处理基于 AudioBuffer 的本地播放
    if (!this.currentBuffer || !this.audioContext) return
    const offset = positionMs / 1000
    this.playBuffer(this.currentBuffer, offset)
    
    // 立即更新 store
    const p = usePlayerStore()
    p.setPosition(positionMs)
  }


  // 设置全局音量（0.0 - 1.0）
  setVolume(volume: number): void {
    this.ensureContext()
    if (!this.gainNode) return
    this.volume = Math.min(Math.max(volume, 0), 1)
    this.gainNode.gain.value = this.volume
  }

  // 配置压限器强度（0-1，数值越大限制越明显）
  setLimiterStrength(strength: number): void {
    this.ensureContext()
    this.applyLimiterStrength(strength)
  }

  // 实际应用压限参数
  private applyLimiterStrength(strength: number): void {
    this.limiterStrength = Math.min(Math.max(strength, 0), 1)
    if (!this.limiterNode) return

    const s = this.limiterStrength
    // 阈值从 -2dB ~ -10dB
    const threshold = -2 - s * 8
    // 压缩比从 4:1 ~ 20:1
    const ratio = 4 + s * 16

    this.limiterNode.threshold.value = threshold
    this.limiterNode.knee.value = 0
    this.limiterNode.ratio.value = ratio
    this.limiterNode.attack.value = 0.003
    this.limiterNode.release.value = 0.1
  }

  // 设置均衡器启用状态
  setEqEnabled(enabled: boolean): void {
    this.ensureContext()
    this.eqEnabled = enabled
    this.applyEqSettings()
  }

  // 设置均衡器各频段增益（长度为 5 的数组，单位 dB）
  setEqGains(gains: number[]): void {
    this.ensureContext()
    if (!gains || gains.length === 0) return
    const bands = this.eqNodes.length || gains.length
    const clamped: number[] = []
    for (let i = 0; i < bands; i += 1) {
      const g = gains[i] ?? 0
      // 限制在 -12dB ~ +12dB
      clamped.push(Math.min(Math.max(g, -12), 12))
    }
    this.eqGains = clamped
    this.applyEqSettings()
  }

  // 应用当前 EQ 设置到滤波节点
  private applyEqSettings(): void {
    if (!this.eqNodes || this.eqNodes.length === 0) return

    for (let i = 0; i < this.eqNodes.length; i += 1) {
      const node = this.eqNodes[i]
      const gain = this.eqEnabled ? (this.eqGains[i] ?? 0) : 0
      node.gain.value = gain
    }
  }

  // 使用解码好的 PCM 数据播放
  async playDecodedAudio(decoded: DecodedAudio): Promise<void> {
    this.ensureContext()
    if (!this.audioContext || !this.gainNode) return

    await this.fadeOutAndStop(200)

    // 同时兼容 sample_rate / sampleRate 两种字段命名
    const sampleRate =
      (decoded as any).sample_rate ?? (decoded as any).sampleRate

    const channels = decoded.channels
    const totalSamples = decoded.data.length
    const totalFrames = totalSamples / channels

    // 控制首帧准备时间：只构造前 1 秒的缓冲区
    const effectiveSampleRate = sampleRate || this.audioContext.sampleRate
    const maxFrames = Math.min(
      totalFrames,
      Math.floor(effectiveSampleRate * 1) // 1 秒
    )

    const buffer = this.audioContext.createBuffer(
      channels,
      maxFrames,
      effectiveSampleRate
    )

    // 将交错布局的数据拆分填充到各个声道，只处理前 1 秒的数据
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const channelData = buffer.getChannelData(channelIndex)
      for (let frameIndex = 0; frameIndex < maxFrames; frameIndex += 1) {
        const sourceIndex = frameIndex * channels + channelIndex
        channelData[frameIndex] = decoded.data[sourceIndex] ?? 0
      }
    }

    const source = this.audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(this.gainNode)

    source.start()
    this.currentSource = source

    this.gainNode.gain.value = 0
    this.fadeTo(this.volume, 200)
  }

  // 使用原始文件二进制数据播放
  async playFromFileData(data: ArrayBuffer): Promise<void> {
    await this.loadFromFileData(data)
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume()
    }
    if (this.currentBuffer) {
      this.playBuffer(this.currentBuffer, 0)
      this.gainNode!.gain.value = 0
      this.fadeTo(this.volume, 200)
    }
  }

  // 加载文件数据但不播放
  async loadFromFileData(data: ArrayBuffer): Promise<void> {
    this.ensureContext()
    if (!this.audioContext || !this.gainNode) return

    await this.fadeOutAndStop(200)

    const bufferCopy = data.slice(0)
    const audioBuffer = await this.audioContext.decodeAudioData(bufferCopy)
    const durationMs = audioBuffer.duration * 1000

    const player = usePlayerStore()
    // 同步总时长到全局 store
    player.setDuration(durationMs)

    this.currentBuffer = audioBuffer
  }

  // 通过 URL 播放音频，内部使用 HTMLAudioElement + Web Audio 管线
  async playFromUrl(url: string): Promise<void> {
    await this.loadFromUrl(url)
    if (this.mediaElement) {
      if (this.audioContext!.state === 'suspended') {
        await this.audioContext!.resume()
      }
      await this.mediaElement.play()
      this.gainNode!.gain.value = 0
      this.fadeTo(this.volume, 200)
    }
  }

  // 加载 URL 但不播放
  async loadFromUrl(url: string): Promise<void> {
    this.ensureContext()
    if (!this.audioContext || !this.gainNode) return

    await this.fadeOutAndStop(200)

    if (!this.mediaElement) {
      const element = new Audio()
      // 提前缓冲，降低首帧等待时间
      element.preload = 'auto'
      element.crossOrigin = 'anonymous'
      this.mediaElement = element

      // 创建 MediaElementAudioSource 连接到全局增益节点
      const source = this.audioContext.createMediaElementSource(element)
      source.connect(this.gainNode)
    }

    this.mediaElement.src = url
    this.mediaElement.currentTime = 0

    // 同步 HTMLAudioElement 的时长和进度到全局 store
    const p = usePlayerStore()
    this.mediaElement.onloadedmetadata = () => {
      if (!this.mediaElement) return
      const durationMs = (this.mediaElement.duration || 0) * 1000
      p.setDuration(durationMs)
    }

    this.mediaElement.ontimeupdate = () => {
      if (!this.mediaElement) return
      const positionMs = this.mediaElement.currentTime * 1000
      p.setPosition(positionMs)
    }
  }

  // 开始流式播放会话
  startStream(sampleRate: number, channels: number): void {
    this.ensureContext()
    if (!this.audioContext || !this.gainNode) return

    void this.fadeOutAndStop(200)

    // 初始化流式播放时间轴，从当前时间开始排队
    this.streamSampleRate = sampleRate || this.audioContext.sampleRate
    this.streamChannels = channels
    this.streamCursorTime = this.audioContext.currentTime
  }

  // 追加一块流式解码得到的 PCM 数据
  appendStreamChunk(chunk: {
    sampleRate: number
    channels: number
    data: number[]
    finished?: boolean
  }): void {
    if (!this.audioContext || !this.gainNode) return

    const sampleRate =
      chunk.sampleRate || this.streamSampleRate || this.audioContext.sampleRate
    const channels = chunk.channels || this.streamChannels || 1

    const totalSamples = chunk.data.length
    if (totalSamples === 0) return

    const frames = totalSamples / channels
    const buffer = this.audioContext.createBuffer(
      channels,
      frames,
      sampleRate
    )

    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const channelData = buffer.getChannelData(channelIndex)
      for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
        const sourceIndex = frameIndex * channels + channelIndex
        channelData[frameIndex] = chunk.data[sourceIndex] ?? 0
      }
    }

    const source = this.audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(this.gainNode)

    const now = this.audioContext.currentTime
    // 确保不会把播放时间排在「已经过去」的时间点，避免被 Web Audio 直接丢弃
    const startTime = Math.max(now, this.streamCursorTime)
    const duration = frames / sampleRate

    source.start(startTime)

    this.streamCursorTime = startTime + duration
    this.streamSources.push(source)
  }
}

// 导出全局单例
export const webAudioEngine = new WebAudioEngine()
