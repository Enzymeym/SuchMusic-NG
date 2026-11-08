// 生成 virtual_bass Rust 对拍测试的 fixture（JSON）。
//
// 用法：node scripts/generate-vb-fixture.mjs
// 输出：native/rust-audio-engine/audio-processor/tests/fixtures/vb_fixture.json
//
// 直接 import 渲染层 worklet（Node 下是纯模块），用固定输入向量跑
// VbCore.processBlock，把输出原样写进 JSON。Rust 侧的
// tests/virtual_bass_crosscheck.rs 读同一份文件断言 max|Δ| < 1e-9。

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { VbCore } = await import(
  pathToFileURL(
    join(here, '../src/renderer/src/audio/worklets/virtual-bass.worklet.mjs')
  ).href
)

const FS = 48000
const BLOCK = 256
const BLOCKS = 6

/** 生成确定性的双声道测试信号 */
function makeBlocks(kind) {
  const blocks = []
  for (let b = 0; b < BLOCKS; b++) {
    const ch0 = new Float32Array(BLOCK)
    const ch1 = new Float32Array(BLOCK)
    for (let i = 0; i < BLOCK; i++) {
      const t = (b * BLOCK + i) / FS
      if (kind === 'silence') {
        ch0[i] = 0
        ch1[i] = 0
      } else if (kind === 'sine60') {
        ch0[i] = 0.5 * Math.sin(2 * Math.PI * 60 * t)
        ch1[i] = 0.3 * Math.sin(2 * Math.PI * 60 * t + Math.PI / 3)
      } else if (kind === 'multipartial') {
        // 模拟真实音乐：基频 45 Hz + 2/3 次谐波 + 宽带噪声音缀
        const phase = 2 * Math.PI * 45 * t
        const burst = Math.sin(2 * Math.PI * 3 * t) > 0.7 ? 0.12 * Math.sin(2 * Math.PI * 800 * t) : 0
        ch0[i] = Math.min(0.95, 0.55 * Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase) + burst)
        ch1[i] = Math.min(0.95, 0.45 * Math.sin(phase + 0.5) + 0.2 * Math.sin(2 * phase + 1.0) + 0.08 * Math.sin(3 * phase + 2.0))
      }
    }
    blocks.push([ch0, ch1])
  }
  return blocks
}

function runScenario(name, kind, overrides) {
  const core = new VbCore({ fs: FS, ...overrides })
  const blocks = makeBlocks(kind)
  const out = []
  for (const [in0, in1] of blocks) {
    const out0 = new Float32Array(in0.length)
    const out1 = new Float32Array(in1.length)
    core.processBlock([in0, in1], [out0, out1], in0.length, overrides.__wetGain ?? 0.55, false)
    out.push([Array.from(out0), Array.from(out1)])
  }
  return {
    name,
    config: { fs: FS, ...overrides, __wetGain: undefined },
    wetGain: overrides.__wetGain ?? 0.55,
    input: blocks.map(([a, b]) => [Array.from(a), Array.from(b)]),
    expected: out,
  }
}

const fixture = {
  fs: FS,
  block: BLOCK,
  scenarios: [
    // f0 自相关跟踪开启（默认参数）
    runScenario('sine60-tracker', 'sine60', { __wetGain: 0.55 }),
    // 固定 f0，跳过跟踪器（离线路径），更高湿路增益
    runScenario('multipartial-override', 'multipartial', { f0Override: 55, __wetGain: 0.7 }),
    // 静音输入：测 e→eps 归一化与电平门下沿
    runScenario('silence', 'silence', { __wetGain: 0.8 }),
  ],
}

const outPath = join(
  here,
  '../native/rust-audio-engine/audio-processor/tests/fixtures/vb_fixture.json'
)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(fixture))
console.log('fixture written:', outPath)
console.log('scenarios:', fixture.scenarios.map((s) => s.name).join(', '))
