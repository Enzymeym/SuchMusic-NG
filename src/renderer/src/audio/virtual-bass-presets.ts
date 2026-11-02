/**
 * 低频增压（Virtual Bass / 小体积扬声器增强）预设与音量联动曲线
 * ================================================================
 *
 * 本文件是「5 档强度 + 系统音量联动」的**唯一事实来源**：
 *   - Web Audio 模式：`web-audio-dsp.ts` 用它驱动 `such-virtual-bass` worklet；
 *   - WASAPI 模式：渲染端解析出 `(enabled, wetGain, gamma, sigma)` 后经 IPC
 *     下发给 Rust `virtual_bass` 模块 —— Rust 不内置档位表与曲线，改这里即可。
 *
 * 算法本体在 `worklets/virtual-bass.worklet.mjs`（勿改），档位只调三个参数：
 *   - `wetMax`：湿路增益上界（系统音量满格时的值）；
 *   - `gamma`：电平常指数（<1 = 小电平时相对抬升更多，e^γ 增益）；
 *   - `sigma`：谐波簇展宽（有效谐波数 ≈ sigma 决定，高档略宽增强「力量感」）。
 *
 * 数值依据 `docs/spec/virtual-bass/feasibility-report.md` 第八/十节：
 *   - 0.55 = 报告推荐默认；0.70 = 报告「强预设」实测上限（限幅介入 1.9%、边带 -41 dB）；
 *   - gamma 报告允许 0.6~1，取 0.78~0.95 折中低档保守、高档激进；
 *   - fLow / fCross / gateDb / ceiling / 限幅器参数是混叠防护与人声保护的不变量，
 *     与「强度」正交，全档固定（见 `VB_FIXED_CONFIG`），任何档位不得修改。
 */

/** 强度档位（1~5） */
export type VirtualBassStrength = 1 | 2 | 3 | 4 | 5

export interface VirtualBassStrengthPreset {
  label: string
  /** 湿路增益上界（满音量时的 wet 值） */
  wetMax: number
  /** 电平常指数 */
  gamma: number
  /** 谐波簇展宽 */
  sigma: number
}

/** 5 档强度预设（索引 = 档位 - 1） */
export const VB_STRENGTH_PRESETS: readonly VirtualBassStrengthPreset[] = [
  { label: '轻微', wetMax: 0.3, gamma: 0.78, sigma: 1.0 },
  { label: '适中', wetMax: 0.42, gamma: 0.82, sigma: 1.1 },
  { label: '标准', wetMax: 0.55, gamma: 0.85, sigma: 1.2 },
  { label: '强劲', wetMax: 0.63, gamma: 0.9, sigma: 1.35 },
  { label: '激进', wetMax: 0.7, gamma: 0.95, sigma: 1.5 }
] as const

/** 默认档位（报告推荐工作点） */
export const VB_DEFAULT_STRENGTH: VirtualBassStrength = 3

/**
 * 湿路增益硬顶。
 * worklet 的 wet AudioParam 上限是 2.0，但报告热母带压测的「允许上限」是 0.85，
 * 这里做二次钳制，保证最激进档位 + 最大音量联动叠加时也不会越界。
 */
export const VB_WET_HARD_CAP = 0.85

/**
 * 全档位固定的工作点参数（直接下发给 worklet 的 config）。
 * 这些是安全不变量：混叠防护（gate/ceiling）、人声保护（LR8 旁链）、
 * 爆音修复结论（makeup 只按波形峰值归一等都在 worklet 内部，这里不触碰）。
 */
export const VB_FIXED_CONFIG = {
  fLow: 90,
  fCross: 160,
  crossoverSections: 4,
  wetHighpassSections: 2,
  wetHighpass: true,
  dryHighpass: false,
  maxOrder: 10,
  gateDb: -60,
  ceiling: 0.995,
  limitWet: true,
  limitKnee: 0.99,
  limitAttackMs: 2,
  limitReleaseMs: 200,
  limitWindowMs: 30,
  limitEnvReleaseMs: 150,
  envWindowHz: 22,
  envReleaseMs: 20,
  kStarSmooth: 0.15,
  // 「按需补低频」门控：基频已高于 fLow 时不再硬造谐波（否则只有中频敲击声）
  f0Gate: true,
  f0GateSpan: 0.35,
  f0GateFloor: 0.12,
  f0GateSmooth: 0.3,
  useF0: true,
  f0Override: 0
} as const

/** 下限 / 上限音量拐点：≥90% 满力度基准，≤10% 到达最大增强 */
const VOL_FULL = 0.9
const VOL_LOW = 0.1
/**
 * 最大力度系数（音量 ≤10% 时）。
 *
 * 原本取 1.5；实测听感反馈「谐波过强会压过音乐本身、只剩敲击感」，
 * 收到 1.3：小音量下仍能明显补足等响损失，但不再让谐波喧宾夺主。
 */
const FACTOR_MAX = 1.3

/**
 * 系统音量（0..1）→ 力度系数（1.0 ~ 1.3）。
 *
 * - 满音量（≥90%）= 1.0 基准：热母带时削顶余量趋零，不能再加；
 * - 低音量（≤10%）= 1.3：等响曲线在 40 phon 以下低频段陡升，
 *   且 masterGain / Rust volume_gain 都在 DSP 之前，小音量削顶余量大；
 * - 中间线性过渡。
 *
 * WASAPI shared 下系统音量作用于会话混音器（应用输出之后），联动主要是
 * 等响感知补偿；exclusive 下系统音量对输出无效，联动仍按同一语义工作
 * （只读系统音量，从不写入）。
 */
export function vbVolumeFactor(systemVolume: number): number {
  const v = Math.min(1, Math.max(0, systemVolume))
  if (!Number.isFinite(v)) return 1
  if (v >= VOL_FULL) return 1
  if (v <= VOL_LOW) return FACTOR_MAX
  return 1 + (FACTOR_MAX - 1) * ((VOL_FULL - v) / (VOL_FULL - VOL_LOW))
}

/** 解析档位（越界/非法值回落到默认档） */
export function clampStrength(strength: unknown): VirtualBassStrength {
  const s = Math.round(Number(strength))
  if (!Number.isFinite(s)) return VB_DEFAULT_STRENGTH
  return Math.min(5, Math.max(1, s)) as VirtualBassStrength
}

/** 取档位预设（越界回落默认档） */
export function getStrengthPreset(strength: unknown): VirtualBassStrengthPreset {
  return VB_STRENGTH_PRESETS[clampStrength(strength) - 1]
}

/**
 * 计算最终下发参数。
 *
 * @param strength 强度档（1~5）
 * @param systemVolume 系统音量（0..1）；null/undefined = 联动不可用，按满音量
 * @param enabled 功能开关；关闭时 wet = 0（旁路严格无损，节点保留）
 * @returns wet（已按 VB_WET_HARD_CAP 钳制）+ gamma/sigma
 */
export function computeVirtualBassDrive(
  strength: number,
  systemVolume: number | null | undefined,
  enabled: boolean
): { wet: number; gamma: number; sigma: number } {
  const preset = getStrengthPreset(strength)
  if (!enabled) return { wet: 0, gamma: preset.gamma, sigma: preset.sigma }
  const v = typeof systemVolume === 'number' && Number.isFinite(systemVolume) ? systemVolume : 1
  const wet = Math.min(VB_WET_HARD_CAP, Math.max(0, preset.wetMax * vbVolumeFactor(v)))
  return { wet, gamma: preset.gamma, sigma: preset.sigma }
}

/**
 * 旧版持久化字段（intensity 0~100 / crossoverFreq）迁移到新档位模型。
 * intensity 50→3、60→3、80→4、100→5；crossoverFreq 丢弃（算法固定 fLow=90）。
 */
export function migrateVirtualBassParams(saved: {
  enabled?: boolean
  intensity?: number
  crossoverFreq?: number
  strength?: number
  followSystemVolume?: boolean
}): { enabled: boolean; strength: VirtualBassStrength; followSystemVolume: boolean } {
  const strength =
    typeof saved.strength === 'number'
      ? clampStrength(saved.strength)
      : clampStrength(Math.round((saved.intensity ?? 50) / 20))
  return {
    enabled: saved.enabled === true,
    strength,
    followSystemVolume: saved.followSystemVolume !== false
  }
}
