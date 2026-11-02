import { describe, it, expect } from 'vitest'
import {
  SHAPE_TARGETS,
  STRENGTH_PRESETS,
  EFFICIENCY_PRESETS,
  aggregateBandLevels,
  DynamicEqEngine
} from '../dynamic-eq'

/** 构造一个"低频强/高频弱"的 10 频段能量（dB），锚点 ≈ -30dB */
function bassHeavyLevels(): number[] {
  return [-20, -22, -25, -30, -33, -35, -38, -42, -48, -55]
}

/** 构造"高频强/低频弱"的 10 频段能量（dB） */
function trebleHeavyLevels(): number[] {
  return [-55, -48, -42, -38, -35, -33, -30, -28, -24, -20]
}

describe('SHAPE_TARGETS / 档位映射', () => {
  it('四种走势目标向量均为 10 频段且数值有限', () => {
    for (const targets of Object.values(SHAPE_TARGETS)) {
      expect(targets).toHaveLength(10)
      targets.forEach((v) => expect(Number.isFinite(v)).toBe(true))
    }
  })

  it('强度档 1~5 的延伸比例单调递增且 ≤ 1（不越界）', () => {
    for (let i = 0; i < STRENGTH_PRESETS.length - 1; i++) {
      expect(STRENGTH_PRESETS[i].shapeScale).toBeLessThan(STRENGTH_PRESETS[i + 1].shapeScale)
    }
    STRENGTH_PRESETS.forEach((p) => {
      expect(p.shapeScale).toBeLessThanOrEqual(1)
      expect(p.fineTune).toBeGreaterThan(0)
    })
  })

  it('强度档 Gmax 单调递增且为正', () => {
    for (let i = 0; i < STRENGTH_PRESETS.length - 1; i++) {
      expect(STRENGTH_PRESETS[i].maxDeltaDb).toBeLessThan(STRENGTH_PRESETS[i + 1].maxDeltaDb)
    }
  })

  it('效率档分析间隔单调递减、release τ ≥ 2 × attack τ', () => {
    for (let i = 0; i < EFFICIENCY_PRESETS.length - 1; i++) {
      expect(EFFICIENCY_PRESETS[i].intervalMs).toBeGreaterThan(
        EFFICIENCY_PRESETS[i + 1].intervalMs
      )
    }
    EFFICIENCY_PRESETS.forEach((p) => {
      expect(p.releaseTauSec).toBeGreaterThanOrEqual(p.attackTauSec * 2)
    })
  })
})

describe('aggregateBandLevels', () => {
  it('null / 空输入返回 null', () => {
    expect(aggregateBandLevels([], true, 22050)).toBeNull()
    expect(aggregateBandLevels([0.5, 0.5], true, 0)).toBeNull()
  })

  it('dB 输入：单频正弦能量归入正确频段', () => {
    // 1024 bins @ nyquist 22050 → bin 5 ≈ 107.7Hz → 属于 125Hz 段（边界 45–176.8）
    const spectrum = new Array(1024).fill(-100)
    spectrum[5] = -20
    const levels = aggregateBandLevels(spectrum, false, 22050)!
    expect(levels).toHaveLength(10)
    expect(levels[2]).toBeCloseTo(-20, 5) // 125Hz 段
    // 其他段没有 bin 能量，保持 -100 哨兵
    expect(levels[5]).toBe(-100)
  })

  it('线性 [0,1] 输入：自动转 dB（满刻度 ≈ 0dB）', () => {
    const spectrum = new Array(1024).fill(0) // -120dB 下限
    spectrum.fill(1, 100, 200) // 0dB
    const levels = aggregateBandLevels(spectrum, true, 22050)!
    const maxLevel = Math.max(...levels)
    expect(maxLevel).toBeCloseTo(0, 1)
  })

  it('binCount 自适应：128 bins 与 1024 bins 对同频正弦归入同一频段', () => {
    const mk = (n: number) => {
      const s = new Array(n).fill(-100)
      const nyquist = 22050
      const targetFreq = 1000
      const idx = Math.round((targetFreq / nyquist) * n)
      s[Math.min(idx, n - 1)] = -20
      return s
    }
    const a = aggregateBandLevels(mk(1024), false, 22050)!
    const b = aggregateBandLevels(mk(128), false, 22050)!
    expect(a.indexOf(Math.max(...a))).toBe(b.indexOf(Math.max(...b)))
  })
})

describe('DynamicEqEngine', () => {
  it('低音增强走势：高频段修正恒为 0（不被内容偏差顶起来）', () => {
    const eng = new DynamicEqEngine()
    eng.setStrength(4)
    eng.setEfficiency(3)
    eng.setShapeTarget(SHAPE_TARGETS.bassBoost)
    let delta = new Array(10).fill(0)
    let t = 0
    for (let n = 0; n < 300; n++) {
      t += 100
      delta = eng.update(bassHeavyLevels(), t)
    }
    const gmax = STRENGTH_PRESETS[3].maxDeltaDb
    // 走势目标为 0 的频段（500Hz 以上）不参与微调
    for (let i = 4; i < 10; i++) {
      expect(delta[i]).toBe(0)
    }
    // 低频段仍按内容自适应提升
    expect(delta[0]).toBeGreaterThan(0)
    expect(delta[0]).toBeLessThanOrEqual(gmax + 1e-9)
  })

  it('回归：低音增强 + 高频偏瘦内容，不得出现高频过度增强', () => {
    // 典型流行乐：低中频饱满，高频相对锚点低 20dB 以上
    const levels = [-18, -24, -30, -34, -38, -42, -46, -50, -56, -62]
    const run = (strength: number) => {
      const eng = new DynamicEqEngine()
      eng.setStrength(strength)
      eng.setEfficiency(5)
      eng.setShapeTarget(SHAPE_TARGETS.bassBoost)
      let delta = new Array(10).fill(0)
      let t = 0
      for (let n = 0; n < 600; n++) {
        t += 60
        delta = eng.update(levels, t)
      }
      return delta
    }
    for (const strength of [1, 3, 5]) {
      const delta = run(strength)
      for (let i = 5; i < 10; i++) {
        expect(delta[i]).toBe(0) // 原本会顶到 +Gmax
      }
      expect(Math.max(...delta.slice(5))).toBe(0)
    }
  })

  it('高音增强走势对称：低频段修正恒为 0', () => {
    const eng = new DynamicEqEngine()
    eng.setStrength(5)
    eng.setEfficiency(3)
    eng.setShapeTarget(SHAPE_TARGETS.trebleBoost)
    let delta = new Array(10).fill(0)
    let t = 0
    for (let n = 0; n < 400; n++) {
      t += 100
      delta = eng.update(bassHeavyLevels(), t)
    }
    for (let i = 0; i < 4; i++) {
      expect(delta[i]).toBe(0)
    }
    expect(delta[9]).toBeGreaterThan(0)
  })

  it('走势覆盖的频段只沿走势方向修正（内容过量时最多回到 0，不反向削减）', () => {
    const eng = new DynamicEqEngine()
    eng.setStrength(5)
    eng.setEfficiency(5)
    eng.setShapeTarget(SHAPE_TARGETS.bassBoost)
    // 低频比锚点高出 30dB 以上的极端内容
    const levels = [0, -2, -10, -30, -35, -40, -45, -50, -55, -60]
    let delta = new Array(10).fill(0)
    let t = 0
    for (let n = 0; n < 600; n++) {
      t += 60
      delta = eng.update(levels, t)
    }
    expect(delta[0]).toBeGreaterThanOrEqual(0)
    expect(delta[0]).toBeLessThan(0.5) // 已收敛到几乎不补
  })

  it('无频谱数据的频段（-100dB 哨兵）不被当成"内容很瘦"拉满修正', () => {
    const eng = new DynamicEqEngine()
    eng.setStrength(5)
    eng.setEfficiency(5)
    eng.setShapeTarget(SHAPE_TARGETS.bassBoost)
    // 32Hz 段没有可用 bin（低分辨率频谱常见），其余正常
    const levels = [-100, -22, -25, -30, -33, -35, -38, -42, -48, -55]
    let delta = new Array(10).fill(0)
    let t = 0
    for (let n = 0; n < 600; n++) {
      t += 60
      delta = eng.update(levels, t)
    }
    // 只保留走势延伸项（S·T = 8），不被 70dB 的假偏差推到 Gmax 之外
    expect(delta[0]).toBeCloseTo(STRENGTH_PRESETS[4].shapeScale * 8, 1)
    expect(delta[0]).toBeLessThan(STRENGTH_PRESETS[4].maxDeltaDb)
  })

  it('低频不足内容 + 低音增强走势 → 低频获得正修正', () => {
    const eng = new DynamicEqEngine()
    eng.setStrength(4)
    eng.setEfficiency(3)
    eng.setShapeTarget(SHAPE_TARGETS.bassBoost)
    let delta = new Array(10).fill(0)
    let t = 0
    for (let n = 0; n < 300; n++) {
      t += 100
      delta = eng.update(trebleHeavyLevels(), t)
    }
    expect(delta[0]).toBeGreaterThan(0)
  })

  it('自适应：低频不足内容的低频修正 > 低频偏重内容的低频修正', () => {
    const run = (levels: number[]) => {
      const eng = new DynamicEqEngine()
      eng.setStrength(4)
      eng.setEfficiency(3)
      eng.setShapeTarget(SHAPE_TARGETS.bassBoost)
      let delta = new Array(10).fill(0)
      let t = 0
      for (let n = 0; n < 300; n++) {
        t += 100
        delta = eng.update(levels, t)
      }
      return delta
    }
    const bassDelta = run(bassHeavyLevels())
    const trebleDelta = run(trebleHeavyLevels())
    expect(trebleDelta[0]).toBeGreaterThan(bassDelta[0])
  })

  it('delta 始终被硬限幅在 ±Gmax 内', () => {
    const eng = new DynamicEqEngine()
    eng.setStrength(1) // Gmax = STRENGTH_PRESETS[0].maxDeltaDb
    const gmax = STRENGTH_PRESETS[0].maxDeltaDb
    eng.setShapeTarget(SHAPE_TARGETS.trebleBoost)
    let t = 0
    for (let n = 0; n < 500; n++) {
      t += 100
      const delta = eng.update(bassHeavyLevels(), t)
      delta.forEach((d) => {
        expect(Math.abs(d)).toBeLessThanOrEqual(gmax + 1e-9)
      })
    }
  })

  it('单步变化 ≤ MAX_STEP_DB（无超调突跳）', () => {
    const eng = new DynamicEqEngine()
    eng.setStrength(5)
    eng.setEfficiency(5)
    eng.setShapeTarget(SHAPE_TARGETS.vShape)
    let prev = new Array(10).fill(0)
    let t = 0
    for (let n = 0; n < 100; n++) {
      t += 60
      const delta = eng.update(trebleHeavyLevels(), t)
      for (let i = 0; i < 10; i++) {
        expect(Math.abs(delta[i] - prev[i])).toBeLessThanOrEqual(0.5 + 1e-9)
      }
      prev = delta
    }
  })

  it('开启后从 0 起步逐步延伸（不是瞬间套用走势）', () => {
    const eng = new DynamicEqEngine()
    eng.setStrength(5)
    eng.setEfficiency(3)
    eng.setShapeTarget(SHAPE_TARGETS.bassBoost)
    const first = eng.update(bassHeavyLevels(), 100)
    // 首帧修正量应远小于目标走势（渐变延伸，不是跳变）
    expect(Math.abs(first[0])).toBeLessThan(2)
    expect(Math.abs(first[0])).toBeGreaterThan(0)
  })

  it('内容与走势匹配时：修正量收敛到延伸项 S·T（微调项归零）', () => {
    const eng = new DynamicEqEngine()
    eng.setStrength(5) // shapeScale = 1，便于对照
    eng.setShapeTarget(SHAPE_TARGETS.invertedV)
    // 构造偏差恰好等于目标曲线的内容（锚点 40dB 避开静音门）
    const levels = SHAPE_TARGETS.invertedV.map((t) => 40 + t)
    let t = 0
    let delta = new Array(10).fill(0)
    for (let n = 0; n < 400; n++) {
      t += 140
      delta = eng.update(levels, t)
    }
    // 微调项 β·(T−d) ≈ 0，剩余 delta ≈ S·T = T（S=1）
    delta.forEach((d, i) => {
      expect(Math.abs(d - SHAPE_TARGETS.invertedV[i])).toBeLessThan(0.8)
    })
  })

  it('静音输入冻结当前 delta（不漂移也不归零）', () => {
    const eng = new DynamicEqEngine()
    eng.setStrength(4)
    eng.setShapeTarget(SHAPE_TARGETS.bassBoost)
    // 先用响亮内容建立修正
    let t = 0
    for (let n = 0; n < 300; n++) {
      t += 100
      eng.update(bassHeavyLevels(), t)
    }
    // 平滑能量需要若干个周期才会沉到静音门下，之后 delta 应完全冻结
    const silent = bassHeavyLevels().map((v) => v - 60)
    let stable = new Array(10).fill(0)
    for (let n = 0; n < 300; n++) {
      t += 100
      stable = eng.update(silent, t)
    }
    const frozen = eng.update(silent, t + 100)
    expect(frozen).toEqual(stable)
    // 继续静音，保持冻结
    const frozen2 = eng.update(silent, t + 200)
    expect(frozen2).toEqual(stable)
  })

  it('非法输入返回当前 delta（不崩溃）', () => {
    const eng = new DynamicEqEngine()
    expect(eng.update([], 0)).toHaveLength(10)
    expect(eng.update(new Array(10).fill(NaN), 100)).toHaveLength(10)
    expect(eng.update(bassHeavyLevels(), 200)).toHaveLength(10)
  })

  it('reset 清零修正量与内部状态', () => {
    const eng = new DynamicEqEngine()
    eng.setStrength(5)
    eng.setShapeTarget(SHAPE_TARGETS.bassBoost)
    let t = 0
    for (let n = 0; n < 200; n++) {
      t += 100
      eng.update(bassHeavyLevels(), t)
    }
    eng.reset()
    expect(eng.getDelta()).toEqual(new Array(10).fill(0))
  })
})
