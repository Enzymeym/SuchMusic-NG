/**
 * Web Audio API 音频输出引擎
 *
 * 使用浏览器内置 AudioContext 进行音频播放，作为跨平台音频输出后端。
 * 与 WASAPI 不同，此引擎直接在渲染进程运行，无需主进程桥接。
 *
 * 数据流：
 *   browser decodeAudioData → AudioBuffer → AudioBufferSourceNode
 *     → (optional) WebAudioDspChain → GainNode → 系统输出
 */

import { WebAudioDspChain } from './web-audio-dsp'

export class WebAudioOutputEngine {
  private audioContext: AudioContext | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private audioBuffer: AudioBuffer | null = null;

  /** Web Audio DSP 处理链（懒初始化） */
  dspChain: WebAudioDspChain | null = null;

  // ====== 音频可视化 ======

  private analyserNode: AnalyserNode | null = null;
  private fftCallbacks: Array<(spectrum: number[]) => void> = [];
  private fftRafId: number | null = null;

  /**
   * 注册 FFT 频谱数据回调（Web Audio 模式）
   * 通过 AnalyserNode 获取实时频谱，RAF 轮询
   *
   * @param callback 接收归一化频谱数据 [0, 1]，128 bins
   * @returns 取消注册函数
   */
  onFftData(callback: (spectrum: number[]) => void): () => void {
    this.fftCallbacks.push(callback);
    if (this.fftCallbacks.length === 1) {
      this.ensureAnalyserNode();
      this.startFftLoop();
    }
    return () => {
      this.fftCallbacks = this.fftCallbacks.filter((cb) => cb !== callback);
      if (this.fftCallbacks.length === 0) {
        this.stopFftLoop();
      }
    };
  }

  /** 确保 AnalyserNode 已插入音频链路 */
  private ensureAnalyserNode(): void {
    if (this.analyserNode || !this.audioContext || !this.gainNode) return;

    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    // 插入到 gainNode 和 destination 之间（在 DSP 链之后）
    // 注意：doPlay 中会重新连接，此处仅创建
    this.analyserNode = analyser;
  }

  /** 启动 RAF 频谱读取循环 */
  private startFftLoop(): void {
    const buffer = new Uint8Array(128);
    const tick = () => {
      if (!this.analyserNode || this.fftCallbacks.length === 0) {
        this.fftRafId = null;
        return;
      }
      this.analyserNode.getByteFrequencyData(buffer);
      const normalized = Array.from(buffer).map((v) => v / 255);
      for (const cb of this.fftCallbacks) {
        cb(normalized);
      }
      this.fftRafId = requestAnimationFrame(tick);
    };
    this.fftRafId = requestAnimationFrame(tick);
  }

  /** 停止 RAF 频谱读取循环 */
  private stopFftLoop(): void {
    if (this.fftRafId !== null) {
      cancelAnimationFrame(this.fftRafId);
      this.fftRafId = null;
    }
  }

  private _isPlaying = false;
  private _isPaused = false;
  private _pausedOffset = 0; // 暂停时的播放位置（秒）
  private _startTime = 0; // context.currentTime 记录
  private _sampleRate = 44100;
  private _channels = 2;
  private _duration = 0; // 音频总时长（秒）

  private onEndedCallback: (() => void) | null = null;

  // ====== 初始化与销毁 ======

  /**
   * 初始化 AudioContext 和 GainNode
   * @param sampleRate 采样率（Hz）
   * @param channels 声道数
   */
  init(sampleRate: number, channels: number): void {
    this.dispose();

    const AudioContextClass = (window as any).AudioContext
      || (window as any).webkitAudioContext;
    const ctx = new AudioContextClass({ sampleRate });
    const gain = ctx.createGain();
    gain.gain.value = 1.0;
    gain.connect(ctx.destination);
    this.audioContext = ctx;
    this.gainNode = gain;

    this._sampleRate = sampleRate;
    this._channels = channels;
  }

  /**
   * 加载 PCM 数据并创建 AudioBuffer
   * @param pcmData f32 交错 PCM 数据
   * @param sampleRate 采样率
   * @param channels 声道数
   */
  loadPcm(pcmData: Float32Array, sampleRate: number, channels: number): boolean {
    if (!this.audioContext || !this.gainNode) {
      return false;
    }

    this.stop();

    this._sampleRate = sampleRate;
    this._channels = channels;

    const sampleCount = Math.floor(pcmData.length / channels);
    this.audioBuffer = this.audioContext.createBuffer(channels, sampleCount, sampleRate);
    this._duration = sampleCount / sampleRate;

    // 交错 PCM → 分离声道
    if (channels === 1) {
      this.audioBuffer.copyToChannel(pcmData as Float32Array<ArrayBuffer>, 0);
    } else {
      // 多声道：分离交错数据
      const channelData: Float32Array[] = [];
      for (let ch = 0; ch < channels; ch++) {
        channelData.push(new Float32Array(sampleCount));
      }
      for (let i = 0; i < sampleCount; i++) {
        for (let ch = 0; ch < channels; ch++) {
          channelData[ch][i] = pcmData[i * channels + ch];
        }
      }
      for (let ch = 0; ch < channels; ch++) {
        this.audioBuffer.copyToChannel(channelData[ch] as Float32Array<ArrayBuffer>, ch);
      }
    }

    return true;
  }

  /**
   * 从原始音频文件 Buffer 加载（使用浏览器原生解码器）
   * MP3/FLAC/OGG/WAV 等常见格式均支持，无需 Rust 端解码
   * 首次调用自动创建 AudioContext
   * @param buffer 原始音频文件 Buffer
   * @returns Promise，解析成功返回 true
   */
  async loadFromArrayBuffer(buffer: ArrayBuffer): Promise<boolean> {
    let ctx = this.audioContext;
    let gain = this.gainNode;

    // 自动初始化（首次调用时创建 AudioContext + GainNode）
    if (!ctx) {
      const AudioContextClass = (window as any).AudioContext
        || (window as any).webkitAudioContext;
      ctx = new AudioContextClass() as AudioContext;
      gain = ctx.createGain();
      gain.gain.value = 1.0;
      gain.connect(ctx.destination);
      this.audioContext = ctx;
      this.gainNode = gain;
    }

    // 确保 AudioContext 处于运行状态（某些环境可能自动挂起）
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    this.stop();

    try {
      this.audioBuffer = await ctx.decodeAudioData(buffer);
      this._sampleRate = this.audioBuffer.sampleRate;
      this._channels = this.audioBuffer.numberOfChannels;
      this._duration = this.audioBuffer.duration;
      return true;
    } catch (err) {
      console.error('[WebAudioEngine] decodeAudioData 失败:', err);
      return false;
    }
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.stop();
    this.stopFftLoop();
    if (this.dspChain) {
      this.dspChain.dispose();
      this.dspChain = null;
    }
    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch((err) => {
        console.warn('[WebAudioEngine] AudioContext close failed:', err);
      });
      this.audioContext = null;
    }
    this.gainNode = null;
    this.audioBuffer = null;
    this._isPlaying = false;
    this._isPaused = false;
  }

  // ====== 播放控制 ======

  /**
   * 开始/恢复播放
   * @param offsetSeconds 从指定秒数开始播放（用于 seek），默认 0
   */
  play(offsetSeconds: number = 0): void {
    if (!this.audioContext || !this.audioBuffer || !this.gainNode) {
      return;
    }

    // 确保 AudioContext 运行 — 但即使 resume 失败也要尝试播放（start 会在挂起的 context 上排队）
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume()
        .then(() => this.doPlay(offsetSeconds))
        .catch((err) => {
          console.warn('[WebAudioEngine] AudioContext resume failed, attempting playback:', err);
          this.doPlay(offsetSeconds);
        });
      return;
    }

    this.doPlay(offsetSeconds);
  }

  /** 实际执行播放的内部方法 */
  private doPlay(offsetSeconds: number): void {
    if (!this.audioContext || !this.audioBuffer || !this.gainNode) return;

    // 停止当前 playback（如果有）
    this.stopSourceNode();

    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;

    // 连接链路：sourceNode -> gainNode -> [可选 DSP 链] -> [可选 AnalyserNode] -> destination
    // 音量增益放在 DSP 链之前，让限制器/软限幅器捕获 boost 后的峰值
    this.sourceNode.connect(this.gainNode);

    // 确定最终输出目标：经过 AnalyserNode 后到达 destination
    const finalDest = this.analyserNode
      ? (this.analyserNode.connect(this.audioContext.destination), this.analyserNode)
      : this.audioContext.destination;

    if (this.dspChain) {
      this.dspChain.disconnect();
      this.dspChain.connect(this.gainNode, finalDest);
    } else {
      this.gainNode.connect(finalDest);
    }

    const offset = this._pausedOffset > 0 ? this._pausedOffset : offsetSeconds;
    this._pausedOffset = 0;

    this.sourceNode.onended = () => {
      this._isPlaying = false;
      this._isPaused = false;
      if (this.sourceNode?.buffer === this.audioBuffer) {
        this.onEndedCallback?.();
      }
    };

    this.sourceNode.start(0, offset);
    this._startTime = this.audioContext.currentTime - offset;
    this._isPlaying = true;
    this._isPaused = false;
  }

  /**
   * 暂停播放（保持 position）
   */
  pause(): void {
    if (!this.audioContext || !this._isPlaying) {
      return;
    }

    this._isPaused = true;
    this._isPlaying = false;

    if (this.audioContext.state === 'running') {
      // Capture position at suspend time for accuracy
      const posBeforeSuspend = this.getPositionSeconds();
      this.audioContext.suspend().then(() => {
        // Re-read after suspend to get precise stop position
        this._pausedOffset = this.getPositionSeconds();
      }).catch(() => {
        this._pausedOffset = posBeforeSuspend;
      });
    } else {
      this._pausedOffset = this.getPositionSeconds();
    }
  }

  /**
   * 恢复播放
   */
  resume(): void {
    if (!this.audioContext || !this._isPaused) {
      return;
    }
    this.play();
  }

  /**
   * 停止播放并重置
   */
  stop(): void {
    this.stopSourceNode();
    this._isPlaying = false;
    this._isPaused = false;
    this._pausedOffset = 0;
    this._startTime = 0;
  }

  /**
   * 跳转到指定位置
   * @param positionMs 目标位置（毫秒）
   */
  seek(positionMs: number): void {
    const offsetSeconds = Math.max(0, Math.min(positionMs / 1000, this._duration));
    this.stopSourceNode();
    this._pausedOffset = offsetSeconds;
    this._isPlaying = false;
    this._isPaused = false;
  }

  // ====== 音频控制 ======

  /**
   * 设置输出音量/增益
   * @param volume 音量增益（>= 0.0，可大于 1.0 用于增强）
   */
  setVolume(volume: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, volume);
    }
  }

  // ====== 状态查询 ======

  /** 是否正在播放 */
  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /** 是否处于暂停状态 */
  get isPaused(): boolean {
    return this._isPaused;
  }

  /** 是否已初始化 */
  get isReady(): boolean {
    return this.audioContext !== null && this.audioBuffer !== null;
  }

  /**
   * 获取当前播放位置（毫秒）
   */
  getPositionMs(): number {
    if (!this.audioContext) return 0;
    if (this._isPaused) {
      return Math.round(this._pausedOffset * 1000);
    }
    if (!this._isPlaying) {
      return this._pausedOffset > 0 ? Math.round(this._pausedOffset * 1000) : 0;
    }
    return Math.round(this.getPositionSeconds() * 1000);
  }

  /**
   * 获取当前播放位置（秒）
   */
  getPositionSeconds(): number {
    if (!this.audioContext || !this._isPlaying) return this._pausedOffset;
    const elapsed = this.audioContext.currentTime - this._startTime;
    return Math.max(0, elapsed);
  }

  /**
   * 获取音频总时长（毫秒）
   */
  getDurationMs(): number {
    return Math.round(this._duration * 1000);
  }

  /**
   * 获取采样率
   */
  get sampleRate(): number {
    return this._sampleRate;
  }

  /**
   * 获取声道数
   */
  get channels(): number {
    return this._channels;
  }

  // ====== 事件回调 ======

  /**
   * 设置播放结束回调
   * @param callback 回调函数
   */
  setOnEnded(callback: (() => void) | null): void {
    this.onEndedCallback = callback;
  }

  // ====== 内部方法 ======

  /**
   * 停止并清理当前 sourceNode
   */
  private stopSourceNode(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.onended = null;
        this.sourceNode.stop();
      } catch {
        // 可能已经停止
      }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
  }
}

/** 全局 Web Audio 引擎单例 */
export const webAudioOutputEngine = new WebAudioOutputEngine();

export default webAudioOutputEngine;
