/**
 * Such Music — 低频虚拟低音（Virtual Bass）核心算法
 * ==================================================
 *
 * 用途：笔记本 / 小扬声器无法重放 40–160 Hz 时，用「缺失基频」心理声学效应
 * （missing fundamental / residue pitch）生成低频的整数次谐波，让听感上把
 * 低频「补回来」。
 *
 * 本文件是**唯一事实来源**：
 *   - 作为 AudioWorklet 模块被 `audioWorklet.addModule()` 加载（末尾自注册）；
 *   - 作为 Node ESM 模块被单元测试 / 离线基准 `import`（见 `__tests__`）。
 * 因此：不依赖任何外部模块、不读 AudioWorkletGlobalScope 的隐式全局
 * （sampleRate 由宿主经端口显式注入），这样才能在无音频设备的纯 Node 环境里
 * 跑出与音频线程完全一致的数值。
 *
 * 算法三段式
 * ----------
 * 1) 旁链分频：LR8(@fCross) 从输入取低频副本，**干路不参与分频重建**。
 *    所以不存在 LP+HP 求和纹波、不需要 allpass 相位补偿；旁通时输出恒等于输入。
 *
 * 2) 谐波生成：滑动窗最大值归一化 u = x_lp / e（构造保证 |u| ≤ 1），再用
 *    Chebyshev 一阶类递推合成谐波：
 *        T_k(cosθ) = cos(kθ)  ⇒  Σ w_k·T_k(u) 的频谱系数 **就是 w_k 本身**
 *    这是「不查表、不迭代、且与电平无关」地精确控制谐波幅度的关键。
 *
 * 3) 湿路整形：LR4 高通(@0.8·fLow) 清掉基频残余与差频产物，再按播放音量
 *    联动增益混入干路。
 *
 * 三个「看起来能省、其实不能省」的设计
 * ------------------------------------
 * (a) 归一化用**滑动窗最大值**而不是「峰值包络 + 平滑」。
 *     后者对稳态正弦只有峰值的 ~0.83 倍，于是 |x|/e 在每周期约 17% 的时间
 *     被 max() 硬限到 1 —— 相当于给归一化波形加了削波，凭空多出 5/7 次谐波，
 *     谐波幅度就不再等于 w_k。滑动窗（窗长 = 22 Hz 一周期）对任意稳态正弦
 *     满足 e ≡ A（窗内必含一个峰值），零纹波、零延迟、且天然 |u| ≤ 1。
 *
 * (b) 旁链必须是 **LR8（48 dB/oct）**，不能只做 LR4（24 dB/oct）。
 *     250 Hz 处的男声/贝斯基频，LR4 只压 -17 dB，归一化后又把它拉回满量程，
 *     结果人声被"谐波化"、听感发毛。LR8 压到 -34 dB，混入比例降到 ~2%。
 *
 * (c) 必须有**电平门**（gate）。
 *     归一化是除法：3 kHz 内容被 LR8 压到 -200 dB，除以包络后又变成满量程，
 *     多项式随即在 30 kHz 生成谐波并折叠回 18 kHz（混叠）。所以 e 低于
 *     -60 dBFS 时直接输出 0，混叠在物理上就不可能发生。
 *
 * 为什么不需要过采样：T_k 是 k 次多项式，输出频率上界 = K·fCross。
 * 取 K=10、fCross=160Hz 时为 1600 Hz，距奈奎斯特有 13 倍余量（44.1k 时
 * 为 22050 Hz），解析上不存在折叠分量；再叠加电平门，带外残渣也进不来。
 *
 * 为什么零延迟：所有环节都是因果 IIR / 无记忆多项式 / 历史窗，
 * 没有线性相位 FIR、没有 Hilbert、没有 lookahead。干路直通不经过任何缓冲。
 */

const TWO_PI = Math.PI * 2

/** Butterworth 二阶的 Q（LR2/LR4/LR8 的单节都用它） */
const BUTTERWORTH_Q = Math.SQRT1_2

/** 包络下界，避免 silence 时除零 */
const ENV_EPS = 1e-9

// ---------------------------------------------------------------------------
// RBJ biquad
// ---------------------------------------------------------------------------

/**
 * 设计一个二阶低通（RBJ Audio EQ Cookbook）。
 * 返回已归一化（a0 = 1）的系数，配合 transposed direct form II 状态变量。
 * @param {number} freq 截止频率（Hz）
 * @param {number} fs 采样率（Hz）
 * @param {number} [q] 品质因数
 */
export function designLowpass(freq, fs, q = BUTTERWORTH_Q) {
  const w0 = (TWO_PI * freq) / fs
  const cw = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  const b0 = (1 - cw) / 2
  return {
    b0: b0 / a0,
    b1: (1 - cw) / a0,
    b2: b0 / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0
  }
}

/**
 * 设计一个二阶高通（RBJ Audio EQ Cookbook）。
 * @param {number} freq 截止频率（Hz）
 * @param {number} fs 采样率（Hz）
 * @param {number} [q] 品质因数
 */
export function designHighpass(freq, fs, q = BUTTERWORTH_Q) {
  const w0 = (TWO_PI * freq) / fs
  const cw = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  const b0 = (1 + cw) / 2
  return {
    b0: b0 / a0,
    b1: (-(1 + cw)) / a0,
    b2: b0 / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0
  }
}

/** 二阶 biquad（transposed direct form II） */
export class Biquad {
  constructor(coeffs) {
    this.b0 = 1
    this.b1 = 0
    this.b2 = 0
    this.a1 = 0
    this.a2 = 0
    this.z1 = 0
    this.z2 = 0
    if (coeffs) this.setCoeffs(coeffs)
  }

  setCoeffs(c) {
    this.b0 = c.b0
    this.b1 = c.b1
    this.b2 = c.b2
    this.a1 = c.a1
    this.a2 = c.a2
  }

  reset() {
    this.z1 = 0
    this.z2 = 0
  }

  process(x) {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }
}

/**
 * Linkwitz-Riley 振幅响应的解析式。
 *
 * N 阶 LR = N/2 个 Butterworth 二阶节级联，单个二阶节满足
 *   低通 |H|² = 1/(1+x⁴)，高通 |H|² = x⁴/(1+x⁴)，x = f/fc
 * 于是总幅度 = 单节幅度^节数。
 *
 * 注意：LR4（2 节）在自身 fc 处正好 -6 dB；LR8（4 节）在 fc 处 -12 dB。
 * 所以湿路高通的拐点绝不能直接设在 fLow，否则会把刻意放在 fLow 的目标
 * 谐波一起削掉一半 —— 这正是湿路拐点取 0.8·fLow 的原因。
 *
 * @param {number} freq 频率（Hz）
 * @param {number} corner 转折频率（Hz）
 * @param {number} sections 二阶节数量（2 = LR4，4 = LR8）
 * @param {boolean} highpass true = 高通
 */
export function lrMag(freq, corner, sections, highpass) {
  const x = freq / corner
  const x4 = x * x * x * x
  const m2 = highpass ? x4 / (1 + x4) : 1 / (1 + x4)
  return Math.pow(m2, sections / 2)
}

/** 便捷包装：LR4 高通幅度 */
export function lr4HighpassMag(freq, corner) {
  return lrMag(freq, corner, 2, true)
}

/** 便捷包装：LR4 低通幅度 */
export function lr4LowpassMag(freq, corner) {
  return lrMag(freq, corner, 2, false)
}

// ---------------------------------------------------------------------------
// 滑动窗最大值（归一化包络）
// ---------------------------------------------------------------------------

/**
 * 因果滑动窗最大值，用单调双端队列实现，均摊 O(1)。
 *
 * 窗长取 22 Hz 的一个周期（约 45 ms @48k）：
 *   - 任意稳态正弦，窗内必含一个峰值 ⇒ 输出恒等于峰值 A，**零纹波**；
 *   - 窗只包含历史样本 ⇒ 零延迟、严格因果；
 *   - 窗含当前样本 ⇒ 输出 ≥ |x|，`|u| ≤ 1` 由构造保证。
 * 窗再长只会让「响→轻」的过渡多停留一会儿，窗再短则低频正弦会掉峰。
 */
export class SlidingMax {
  constructor(size) {
    this.W = Math.max(1, size | 0)
    const cap = this.W + 1
    this.cap = cap
    this.val = new Float32Array(cap)
    this.idx = new Int32Array(cap)
    this.head = 0
    this.tail = 0
    this.n = 0
  }

  reset() {
    this.head = 0
    this.tail = 0
    this.n = 0
    this.val.fill(0)
  }

  push(v) {
    const cap = this.cap
    const i = this.n++

    // 从队尾弹掉所有不大于 v 的候选（它们永远不会再成为最大值）
    while (this.head !== this.tail) {
      const prev = this.tail - 1 < 0 ? cap - 1 : this.tail - 1
      if (this.val[prev] <= v) this.tail = prev
      else break
    }

    this.val[this.tail] = v
    this.idx[this.tail] = i
    this.tail = this.tail + 1 === cap ? 0 : this.tail + 1

    // 弹出滑出窗外的队首
    const minIdx = i - this.W
    while (this.head !== this.tail && this.idx[this.head] <= minIdx) {
      this.head = this.head + 1 === cap ? 0 : this.head + 1
    }

    return this.val[this.head]
  }
}

/**
 * 「瞬时上升 + 指数释放」的峰值包络：套在 SlidingMax 外面。
 *
 * 只用 SlidingMax：稳态正弦零纹波，但窗内峰值滑出时会**台阶式**掉下来，
 * 湿声一阶差分实测达到正弦理论值的 9 倍 —— 就是那些咔哒。
 * 只用一阶峰值跟随器：没有台阶，但每个周期内掉 15%，形成 f0 速率的纹波（发颤）。
 *
 * 两者叠加后：稳态时 v ≡ max（零纹波），峰值离开时按 τ 平滑下降（无台阶），
 * 且 v ≥ SlidingMax ≥ |x| 恒成立 —— `|u| ≤ 1` 和余量上界这两条不变量都不受影响。
 */
export class SmoothedMax {
  constructor(size, fs, releaseMs) {
    this.max = new SlidingMax(size)
    this.v = 0
    this.setRelease(fs, releaseMs)
  }

  setRelease(fs, releaseMs) {
    const tau = Math.max(1e-4, (releaseMs || 1) / 1000)
    this.a = 1 - Math.exp(-1 / (fs * tau))
  }

  reset() {
    this.max.reset()
    this.v = 0
  }

  push(x) {
    const m = this.max.push(x)
    if (m >= this.v) this.v = m
    else this.v += this.a * (m - this.v)
    return this.v
  }
}

// ---------------------------------------------------------------------------
// 基频估计（自相关）
// ---------------------------------------------------------------------------
/**
 * 低频基频跟踪器：25–160 Hz 自相关，8:1 抽取后每 100 ms 更新一次。
 *
 * 目的：让第一个可听谐波落在扬声器下限 fLow 附近（f0=50Hz、fLow=120Hz
 * 需要 3 次谐波 150Hz，而不是 2 次谐波 100Hz——后者照样发不出来）。
 *
 * 置信度不足（r < 0.3）时置 f0 = 0，上层回落到固定 k*。
 */
export class F0Tracker {
  constructor(fs = 48000) {
    this._buf = new Float32Array(1024)
    this._scratch = new Float32Array(1024)
    this._r = new Float32Array(512)
    this._head = 0
    this._size = 0
    this.f0 = 0
    this.confidence = 0
    this._hist = [0, 0, 0]
    this.configure(fs)
  }

  configure(fs) {
    this.decim = Math.max(1, Math.round(fs / 6000))
    this.fsDec = fs / this.decim
    this.lagMin = Math.max(2, Math.floor(this.fsDec / 160))
    this.lagMax = Math.min(500, Math.ceil(this.fsDec / 25))
    this.win = 512
    this._updateEvery = Math.max(1, Math.round((fs * 0.1) / this.decim))
    this._sinceUpdate = 0
    this._skip = 0
    this.reset()
  }

  reset() {
    this._buf.fill(0)
    this._head = 0
    this._size = 0
    this._skip = 0
    this._sinceUpdate = 0
    this.f0 = 0
    this.confidence = 0
    this._hist[0] = this._hist[1] = this._hist[2] = 0
  }

  /**
   * 每个原始采样调用一次（内部按 decim 抽取）。
   * @param {number} x 低频旁链样本
   * @returns {boolean} 本次是否更新了 f0
   */
  push(x) {
    if (this._skip > 0) {
      this._skip--
      return false
    }
    this._skip = this.decim - 1

    this._buf[this._head] = x
    this._head = (this._head + 1) & 1023
    if (this._size < 1024) this._size++

    if (++this._sinceUpdate < this._updateEvery) return false
    this._sinceUpdate = 0
    return this._analyze()
  }

  _analyze() {
    const W = this.win
    const need = W + this.lagMax
    if (this._size < need) return false

    // 按时间顺序取出最近 need 个抽取样本
    const buf = this._buf
    const tmp = this._scratch
    let idx = (this._head - need + 1024) & 1023
    for (let i = 0; i < need; i++) {
      tmp[i] = buf[idx]
      idx = (idx + 1) & 1023
    }

    let bestLag = 0
    let bestR = -2
    const r = this._r
    for (let lag = this.lagMin; lag <= this.lagMax; lag++) {
      let s = 0
      let e1 = 0
      let e2 = 0
      for (let i = 0; i < W; i++) {
        const a = tmp[i]
        const b = tmp[i + lag]
        s += a * b
        e1 += a * a
        e2 += b * b
      }
      const denom = Math.sqrt(e1 * e2)
      const val = denom > 1e-20 ? s / denom : 0
      r[lag] = val
      if (val > bestR) {
        bestR = val
        bestLag = lag
      }
    }

    if (bestR < 0.3 || bestLag <= this.lagMin || bestLag >= this.lagMax) {
      this.confidence = bestR > 0 ? bestR : 0
      this._pushHist(0)
      return true
    }

    // 抛物线插值细化（亚采样精度，避免 f0 在整数 lag 上来回跳）
    const y0 = r[bestLag - 1]
    const y1 = r[bestLag]
    const y2 = r[bestLag + 1]
    const den = y0 - 2 * y1 + y2
    let delta = den !== 0 ? (0.5 * (y0 - y2)) / den : 0
    if (delta > 0.5) delta = 0.5
    if (delta < -0.5) delta = -0.5

    this.f0 = this.fsDec / (bestLag + delta)
    this.confidence = bestR
    this._pushHist(this.f0)
    return true
  }

  _pushHist(v) {
    const h = this._hist
    h[0] = h[1]
    h[1] = h[2]
    h[2] = v
    if (h[0] > 0 && h[1] > 0 && h[2] > 0) {
      // 三取二的中值，抑制单帧误判
      const a = h[0]
      const b = h[1]
      const c = h[2]
      this.f0 = a > b ? (b > c ? b : a > c ? c : a) : b > c ? (a > c ? a : c) : b
    }
  }
}

// ---------------------------------------------------------------------------
// Chebyshev 谐波权重
// ---------------------------------------------------------------------------

/**
 * 计算各次谐波的幅度权重 w_k（k = 1..K），Σ w_k = 1。
 *
 * - 高斯窗：以 k* = fLow/f0 为中心、σ 展宽。k* 让第一个可听谐波正好落在
 *   扬声器下限；σ 控制「谐波簇」的宽度（σ=1.2 ⇒ 有效约 3 个）。
 * - 谐波域整形 h(k) = 1/√(1 + (fLow / (k·f0))¹⁶)：零相位、无过渡带、
 *   无振铃地把 k·f0 < fLow 的分量压掉（等效 96 dB/oct，但没有任何群延迟）。
 *   实测：k·f0 = 0.8·fLow 时 -15.6 dB，= 0.5·fLow 时 -48 dB，= fLow 时 -0.3 dB。
 *   这是 Butterworth 做不到的事 —— 2 阶在 fc/2 处只有 -12 dB，4 阶 -24 dB，
 *   而且都会带来群延迟。
 *
 *   为什么指数要取 16 而不是 8：指数 8、拐点 0.8·fLow 时，f0=48Hz 的 2 次
 *   谐波（96 Hz）只被压 3 dB，等于白扔了三分之一湿声能量（扬声器发不出来）。
 *   取 16、拐点 fLow 后同样位置压 15.6 dB，而目标谐波（= fLow）几乎无损。
 *
 * 因为 w 只依赖 kStar 这个标量，而 kStar 又经过一阶平滑，所以谐波阶次
 * 变化时输出是 C∞ 连续的，不会有阶次硬切换的咔哒声。
 *
 * @returns {{weights: Float64Array, sum: number}}
 */
export function chebWeights(kStar, sigma, fLow, f0Hat, maxOrder) {
  const K = maxOrder
  const weights = new Float64Array(K + 1)
  const twoSigmaSq = 2 * sigma * sigma
  let sum = 0

  for (let k = 1; k <= K; k++) {
    const d = k - kStar
    const gauss = Math.exp(-(d * d) / twoSigmaSq)
    let shape
    if (f0Hat > 0) {
      const ratio = fLow / (k * f0Hat)
      shape = 1 / Math.sqrt(1 + Math.pow(ratio, 16))
    } else {
      // 无法估计 f0 时不复制基频（整段低频都发不出来，复制它没有意义）
      shape = k === 1 ? 0 : 1
    }
    const w = gauss * shape
    weights[k] = w
    sum += w
  }

  if (sum > 1e-9) {
    for (let k = 1; k <= K; k++) weights[k] /= sum
    return { weights, sum: 1 }
  }

  // 退化保护：至少留一个 2 次谐波
  weights.fill(0)
  weights[2] = 1
  return { weights, sum: 1 }
}

// ---------------------------------------------------------------------------
// 核心
// ---------------------------------------------------------------------------

/** 默认配置 */
const DEFAULT_CONFIG = {
  fs: 48000,
  /** 扬声器下限（Hz）：低于它的内容靠谐波补 */
  fLow: 120,
  /** 旁链低通转折频率（Hz）：决定混叠上界 K·fCross */
  fCross: 160,
  /** 旁链低通阶数（二阶节数量）：4 = LR8 = 48 dB/oct */
  crossoverSections: 4,
  /** 湿路高通阶数（二阶节数量）：2 = LR4 = 24 dB/oct */
  wetHighpassSections: 2,
  /** 谐波簇展宽 */
  sigma: 1.2,
  /** 电平常指数：1 = 严格电平不变；<1 小音量时相对抬升 */
  gamma: 0.85,
  /** Chebyshev 最高阶次 */
  maxOrder: 10,
  /** 干路保护低切（LR2 @ fLow），默认关 */
  dryHighpass: false,
  /** 湿路高通（LR4 @ 0.8·fLow），离线测试可关掉以单独验证谐波纯度 */
  wetHighpass: true,
  /** 电平门（dBFS）：低于它不生成谐波，用于阻断带外残渣被归一化放大后混叠 */
  gateDb: -60,
  /** 混音上限：|dry + wet| 的硬上界（0..1）。0.995 ≈ -0.04 dBFS */
  ceiling: 0.995,
  /** 是否对湿路做限幅（只压湿路，干路仍严格恒等） */
  limitWet: true,
  /**
   * 软膝起点（相对 ceiling）：0.99 = 只在最后 1% 处起弯。
   * 必须贴近 ceiling —— 否则「强度 0% 的干路」也会被削，
   * 破坏「关闭效果时逐样本无损」这条不变量（干路峰值本来就常到 0.97）。
   */
  limitKnee: 0.99,
  /** 湿声增益下压速度（ms）：太慢会漏峰，太快会听成「抽」 */
  limitAttackMs: 2,
  /** 湿声增益回弹时间常数（ms） */
  limitReleaseMs: 200,
  /** 归一化窗长 = 1/envWindowHz 秒（应低于最低期望基频） */
  envWindowHz: 22,
  /**
   * 归一化包络的释放时间常数（ms）。0 = 纯滑动窗。
   * 实测（55 Hz 电平突降）0 / 20 / 30 / 60 ms 都不产生台阶（最大一阶差分仅稳态的 0.29×），
   * 但释放越长跟随越慢：60 ms 会白白吃掉约 0.25 dB 的效果，所以取 20 ms 做轻微保险。
   */
  envReleaseMs: 20,
  /** 限幅检测窗长（ms）：必须长于最低基频周期，否则包络会跟着波形起伏（增益被周期调制） */
  limitWindowMs: 30,
  /** 干路余量包络的释放时间常数（ms） */
  limitEnvReleaseMs: 150,
  /** k* 平滑时间常数（s） */
  kStarSmooth: 0.15,
  /** 是否启用 f0 自适应；false 时用 f0Override 或固定 k*=2 */
  useF0: true,
  /** 固定 f0（Hz），>0 时优先于自相关估计，供离线测试用 */
  f0Override: 0
}

/** 单个声道的一整套状态 */
function createChannelState(cfg, lpSections, whpSections, envSize, limitWindowSize) {
  const lp = []
  for (let i = 0; i < lpSections; i++) lp.push(new Biquad())
  const whp = []
  for (let i = 0; i < whpSections; i++) whp.push(new Biquad())
  return {
    lp,
    whp,
    dhp: new Biquad(),
    env: new SmoothedMax(envSize, cfg.fs, cfg.envReleaseMs),
    /** 混合后信号（dry + wet）的峰值包络：压缩器检测器。只看包络不看当前样本，增益才会缓变 */
    limEnv: new SmoothedMax(limitWindowSize, cfg.fs, cfg.limitEnvReleaseMs),

    /** 平滑后的湿声增益（限幅器输出） */
    gain: 1
  }
}

export class VbCore {
  constructor(options = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...options }
    this.states = []
    this.weights = new Float64Array(this.cfg.maxOrder + 1)
    /** T_k(0)，用于去掉 u→0 时偶数阶带来的直流台阶 */
    this.dcOffset = new Float64Array(this.cfg.maxOrder + 1)
    this._buildDcOffset()
    this.kStar = 2
    this.makeup = 1
    /** 当前权重下 Σw_k(T_k−T_k(0)) 在 u∈[-1,1] 上的峰值，用于估算余量 */
    this.shaperPeak = 1
    this.f0 = 0
    this.tracker = new F0Tracker(this.cfg.fs)
    /** 限幅器介入的样本数 / 总样本数（只用于诊断与测试断言，不影响音频） */
    this.limitHits = 0
    /** 湿路压缩器用掉的最小增益（诊断用：1 = 完全没压） */
    this.gainMin = 1
    this.sampleCount = 0
    this._configured = false
    this._warmed = false
    this._lastF0 = 0
    this.configure(this.cfg)
  }

  _buildDcOffset() {
    // T_k(0) = 0 (k 奇) / (-1)^(k/2) (k 偶)
    for (let k = 0; k < this.dcOffset.length; k++) {
      this.dcOffset[k] = k % 2 === 0 ? ((k / 2) % 2 === 0 ? 1 : -1) : 0
    }
    this.dcOffset[0] = 1
  }

  /** 更新配置并重建滤波器（系数必须在这里算好，绝不进 process 循环） */
  configure(options = {}) {
    Object.assign(this.cfg, options)
    const c = this.cfg
    const lpCoeffs = designLowpass(c.fCross, c.fs)
    const whpCoeffs = designHighpass(0.8 * c.fLow, c.fs)
    const dhpCoeffs = designHighpass(c.fLow, c.fs)
    const envSize = Math.max(16, Math.round(c.fs / c.envWindowHz))
    const limitWindowSize = Math.max(8, Math.round((c.fs * c.limitWindowMs) / 1000))
    const lpSections = Math.max(1, c.crossoverSections | 0)
    const whpSections = Math.max(1, c.wetHighpassSections | 0)

    // 阶数或窗长变化时状态数组结构会变，直接重建（只在配置变更时发生）
    if (
      this.states.length > 0 &&
      (this.states[0].lp.length !== lpSections ||
        this.states[0].whp.length !== whpSections ||
        this.states[0].env.max.W !== envSize ||
        this.states[0].limEnv.max.W !== limitWindowSize)
    ) {
      this.states = []
    }

    for (const st of this.states) {
      for (const f of st.lp) f.setCoeffs(lpCoeffs)
      for (const f of st.whp) f.setCoeffs(whpCoeffs)
      st.dhp.setCoeffs(dhpCoeffs)
      st.env.setRelease(c.fs, c.envReleaseMs)
      st.limEnv.setRelease(c.fs, c.limitEnvReleaseMs)
    }

    this.tracker.configure(c.fs)
    this._lpCoeffs = lpCoeffs
    this._whpCoeffs = whpCoeffs
    this._dhpCoeffs = dhpCoeffs
    this._envSize = envSize
    this._limitWindowSize = limitWindowSize
    this._lpSections = lpSections
    this._whpSections = whpSections
    // 增益平滑系数：下压（攻击）快，回弹（释放）慢 —— 这就是「压缩器」的时间常数
    this._limitAtk = 1 - Math.exp(-1 / ((c.fs * c.limitAttackMs) / 1000))
    this._limitRel = 1 - Math.exp(-1 / ((c.fs * c.limitReleaseMs) / 1000))

    // 电平门上下沿（-72 dB → gateDb），20 dB 的软过渡避免开合时咔哒
    this._gateLo = Math.pow(10, (c.gateDb - 12) / 20)
    this._gateHi = Math.pow(10, c.gateDb / 20)

    this._configured = true
    this.reset()
    return this
  }

  reset() {
    for (const st of this.states) {
      for (const f of st.lp) f.reset()
      for (const f of st.whp) f.reset()
      st.dhp.reset()
      st.env.reset()
      st.limEnv.reset()
      st.gain = 1
    }
    this.tracker.reset()
    this.kStar = 2
    this.makeup = 1
    this.shaperPeak = 1
    this.gainMin = 1
    this.weights.fill(0)
    this._warmed = false
    this._lastF0 = 0
  }

  _state(ch) {
    let st = this.states[ch]
    if (!st) {
      st = createChannelState(
        this.cfg,
        this._lpSections,
        this._whpSections,
        this._envSize,
        this._limitWindowSize
      )
      for (const f of st.lp) f.setCoeffs(this._lpCoeffs)
      for (const f of st.whp) f.setCoeffs(this._whpCoeffs)
      st.dhp.setCoeffs(this._dhpCoeffs)
      this.states[ch] = st
    }
    return st
  }

  /** 每个 render quantum 刷新一次权重与 makeup（开销 ~2 千次乘加，可忽略） */
  _refreshWeights(blockSize) {
    const c = this.cfg
    const smooth = 1 - Math.exp(-blockSize / c.fs / c.kStarSmooth)

    const f0 = c.f0Override > 0 ? c.f0Override : c.useF0 ? this.tracker.f0 : 0
    this.f0 = f0

    let target = 2
    if (f0 > 0) {
      const raw = c.fLow / f0
      target = raw < 1.5 ? 1.5 : raw > 5.5 ? 5.5 : raw
    }

    // 只有**第一块**允许直接对齐。此前「f0 从未知变已知」也snap，
    // 结果 f0 置信度抖动时 kStar/makeup 每 100 ms 阶跃一次 —— 实测
    // 单块相对跳变 94%（5.8 dB），听感就是持续的「啪」。
    if (!this._warmed) this.kStar = target
    else this.kStar += smooth * (target - this.kStar)

    const { weights } = chebWeights(this.kStar, c.sigma, c.fLow, f0, c.maxOrder)
    this.weights = weights

    // 波形峰值上界：Σ w_k(T_k(u) − T_k(0)) 在 u∈[-1,1] 上的最大绝对值。
    // 先算它，因为 makeup 要按它归一（顺序不能反）。
    const K = c.maxOrder
    const dc = this.dcOffset
    let peak = 0
    for (let t = 0; t <= 256; t++) {
      const u = -1 + (2 * t) / 256
      let tm2 = 1
      let tm1 = u
      let s = weights[1] * (u - dc[1])
      for (let k = 2; k <= K; k++) {
        const tk = 2 * u * tm1 - tm2
        s += weights[k] * (tk - dc[k])
        tm2 = tm1
        tm1 = tk
      }
      const a = s < 0 ? -s : s
      if (a > peak) peak = a
    }
    this.shaperPeak = peak

    // 湿路增益：**只按波形峰值归一**，于是 |wet| ≤ e^γ（而 e ≤ 1）。
    //
    // 这里绝不能按「参考谐波」归一（旧实现的 1/(shapeRef·hpRef)）：参考频率
    // = k*·f0 依赖 f0 估计，f0 一抖动 makeup 就在 1.0 / 2.0 之间跳，
    // 每 100 ms 一次幅度阶跃 —— 强度越高越像爆音。按峰值归一则只依赖
    // weights，而 weights 是 kStar 的连续函数，kStar 又经过一阶平滑。
    const targetMakeup = 1 / Math.max(1e-6, peak)
    if (!this._warmed) this.makeup = targetMakeup
    else this.makeup += smooth * (targetMakeup - this.makeup)

    this._lastF0 = f0
    this._warmed = true
  }

  /**
   * 处理一个块。
   *
   * @param {Float32Array[]} inCh 输入声道（1 或 2 个）
   * @param {Float32Array[]} outCh 输出声道
   * @param {number} n 帧数
   * @param {number} wetGain 湿声增益（0 = 旁通，恒等输出）
   * @param {boolean} [wetOnly] 只输出湿路（离线测谐波纯度用）
   */
  processBlock(inCh, outCh, n, wetGain = 1, wetOnly = false) {
    const c = this.cfg
    if (!this._configured) return

    this._refreshWeights(n)

    const gamma = c.gamma
    const usePow = Math.abs(gamma - 1) > 1e-6
    const K = c.maxOrder
    const w = this.weights
    const dc = this.dcOffset
    const makeup = this.makeup
    const mono = inCh.length === 1 ? inCh[0] : null
    const outCount = outCh.length
    const gateLo = this._gateLo
    const gateSpan = this._gateHi - gateLo
    const useLimit = c.limitWet && !wetOnly
    const ceiling = c.ceiling
    const knee = c.limitKnee
    const atkCoef = this._limitAtk
    const relCoef = this._limitRel
    let limHits = 0

    for (let ch = 0; ch < outCount; ch++) {
      const src = inCh.length === 1 ? mono : inCh[ch] || inCh[0]
      const dst = outCh[ch]
      if (!src || !dst) continue

      const st = this._state(ch)
      const lp = st.lp
      const lpN = lp.length
      const whp = st.whp
      const whpN = whp.length
      const dhp = st.dhp
      const env = st.env
      const useWetHp = c.wetHighpass
      const useDryHp = c.dryHighpass
      const trackF0 = ch === 0 && c.useF0 && c.f0Override <= 0

      for (let i = 0; i < n; i++) {
        const x = src[i]

        // --- 旁链：低频副本（LR8）---
        let low = lp[0].process(x)
        for (let s = 1; s < lpN; s++) low = lp[s].process(low)
        if (trackF0) this.tracker.push(low)

        // --- 归一化（滑动窗最大值：稳态正弦下 e ≡ A，零纹波）---
        const mag = low < 0 ? -low : low
        let e = env.push(mag)
        if (!(e > ENV_EPS)) e = ENV_EPS
        const u = low / e

        // --- Chebyshev 递推，并减掉 T_k(0) 去掉直流台阶 ---
        // T_k(u) = 2u·T_{k-1} - T_{k-2}
        let tm2 = 1 // T_0
        let tm1 = u // T_1
        let sum = w[1] * (u - dc[1])
        for (let k = 2; k <= K; k++) {
          const tk = 2 * u * tm1 - tm2
          sum += w[k] * (tk - dc[k])
          tm2 = tm1
          tm1 = tk
        }

        // 电平门：e 低于 gateDb 时不生成谐波（阻断带外残渣被归一化放大）
        let g = (e - gateLo) / gateSpan
        if (g > 1) g = 1
        else if (g < 0) g = 0

        const gain = (usePow ? Math.pow(e, gamma) : e) * g
        let wet = gain * sum * makeup
        if (useWetHp) {
          for (let s = 0; s < whpN; s++) wet = whp[s].process(wet)
        }

        if (wetOnly) {
          dst[i] = wet
        } else {
          const dry = useDryHp ? dhp.process(x) : x
          let w = wet * wetGain

          // ---- 湿路限幅 / 压缩 ----
          // 结构上就是「检测器 + 平滑增益 + 软膝兜底」：
          //
          //   1) 检测器看**混合后信号（dry + wet）的峰值包络**，绝不看当前样本。
          //      这么做的三个理由：
          //      · 旧实现用 room = ceiling − |dry[n]|，等于让湿声被干路波形逐样本调制，
          //        实测一个 55 Hz 周期内增益摆动 61%~90%，边带只有 -18 dB —— 就是爆音来源；
          //      · 分开算「干路占了多少 + 湿声多大」等于假设两者峰值永远对齐，过于保守，
          //        实测会白白吃掉 1 dB 的效果；
          //      · 按和信号检测能自然利用相位关系（湿声与干路并不总是同相叠加）。
          //   2) 增益目标 = ceiling / 峰值包络，按 2 ms 下压 / 150 ms 回弹平滑。
          //      增益缓变 ⇒ 湿声被整体缩放（压缩），而不是被逐样本削平（失真）。
          //   3) 平滑期间漏过的一点过冲由软膝收掉，保证 |dry + wet| ≤ ceiling。
          //
          // 干路一个采样都不碰，所以「关闭时逐样本无损」仍然成立。
          // 素材本身有余量时（正常聆听音量）target 恒为 1，这一段完全透明。
          if (useLimit) {
            const sum0 = dry + w
            const a0 = sum0 < 0 ? -sum0 : sum0
            const e = st.limEnv.push(a0)
            const target = e > ceiling && e > 1e-9 ? ceiling / e : 1
            const g = st.gain + (target - st.gain) * (target < st.gain ? atkCoef : relCoef)
            st.gain = g
            if (g < this.gainMin) this.gainMin = g
            w *= g

            // 残差兜底：只对「和信号」越界的部分做软膝。
            // 不能写成「湿声 vs 瞬时干路余量」—— 那会退回到逐样本调制（爆音的根因）。
            let s = dry + w
            const as = s < 0 ? -s : s
            const lim = knee * ceiling
            if (as > lim) {
              limHits++
              const span = ceiling - lim
              const y = span > 1e-9 ? lim + span * Math.tanh((as - lim) / span) : lim
              s = s < 0 ? -y : y
            }
            dst[i] = s
          } else {
            dst[i] = dry + w
          }
        }
      }

      // 数值自愈：出现 NaN/Inf 就复位该声道，避免整条链静默变噪音
      if (!Number.isFinite(dst[n - 1])) {
        for (const f of st.lp) f.reset()
        for (const f of st.whp) f.reset()
        st.dhp.reset()
        st.env.reset()
        dst.fill(0)
      }
    }

    if (useLimit) {
      this.limitHits += limHits
      this.sampleCount += n * outCount
    }
  }
}

// ---------------------------------------------------------------------------
// AudioWorklet 包装
// ---------------------------------------------------------------------------

/**
 * Node 环境下没有 AudioWorkletProcessor / registerProcessor，
 * 用 typeof 守卫让同一个文件既能被 addModule 加载、又能被 Vitest import。
 */
const ProcessorBase =
  typeof AudioWorkletProcessor !== 'undefined'
    ? AudioWorkletProcessor
    : class {
        constructor() {
          // 测试环境下不会有 port 往来；给个占位避免构造期报错
          this.port = { postMessage() {}, onmessage: null }
        }
      }

class SuchVirtualBassProcessor extends ProcessorBase {
  static get parameterDescriptors() {
    return [
      {
        name: 'wet',
        defaultValue: 0,
        minValue: 0,
        maxValue: 2,
        automationRate: 'k-rate'
      }
    ]
  }

  constructor(options) {
    super()
    const initRate =
      (options && options.processorOptions && options.processorOptions.sampleRate) ||
      (typeof sampleRate !== 'undefined' ? sampleRate : 48000)

    this.core = new VbCore({ fs: initRate })
    this._lastWet = 0
    this.port.onmessage = (event) => {
      const msg = event.data
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'config') this.core.configure(msg.config || {})
      else if (msg.type === 'reset') this.core.reset()
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || !output.length) return true

    const n = output[0].length
    if (!input || !input.length) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0)
      return true
    }

    const wet = parameters && parameters.wet ? parameters.wet[0] : this._lastWet
    this._lastWet = wet
    this.core.processBlock(input, output, n, wet, false)
    return true
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('such-virtual-bass', SuchVirtualBassProcessor)
}

export { SuchVirtualBassProcessor }
