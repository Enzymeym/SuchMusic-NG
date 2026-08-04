/**
 * 起始点检测 ONNX 模型生成脚本
 *
 * 纯 Node.js 实现，零外部依赖：手工编码 ONNX protobuf 二进制格式，
 * 生成一个小型 MLP 起始点检测网络的 .onnx 模型文件与 TS 数据模块
 * （base64 模型字节 + 权重数组，供运行时代码直接内嵌使用）。
 *
 * 网络架构（与 src/renderer/src/audio/onset-model.ts 的参考实现保持一致）：
 * - 输入: features[1, 32] = [上一帧 16 维梅尔幅度特征, 当前帧 16 维梅尔幅度特征]
 * - 隐藏层: Gemm(hidden=16, transB=1) + Relu
 *   h_i = relu(curr_i - prev_i - THRESH)，即逐频带的"正能量跃变"
 * - 输出层: Gemm(1, transB=1) + Sigmoid
 *   score = sum(h) - FLUX_BIAS，即总谱通量减去偏置后经 sigmoid 得到起始点概率
 *
 * 权重为手工设计的启发式权重（近似经典谱通量起始点检测器）：
 * - THRESH = 0.25  : 单频带显著跃变阈值（归一化幅度单位，满幅正弦≈1.0）
 * - FLUX_BIAS = 1.0: 稳态（无跃变时 score=0）输出概率约 0.27，需与
 *   融合逻辑的"概率上升沿"规则配合抑制误报
 *
 * 运行: node scripts/generate-onset-model.mjs
 * 产物:
 * - src/renderer/src/audio/model/onset-model.onnx（可用 Netron 等工具查看）
 * - src/renderer/src/audio/model/onset-model-data.ts（运行时数据模块）
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ====== 模型超参数（与 onset-model.ts 运行时保持一致） ======

const INPUT_SIZE = 32 // 上一帧 16 + 当前帧 16
const HIDDEN_SIZE = 16
const OUTPUT_SIZE = 1
const THRESH = 0.25 // 单频带显著跃变阈值
const FLUX_BIAS = 1.0 // 谱通量输出偏置（稳态抑制）
const MODEL_NAME = 'onset-mlp-v1'
const PRODUCER = 'such-pc-ng'
const OPSET_VERSION = 13
const IR_VERSION = 8
const INPUT_NAME = 'features'
const OUTPUT_NAME = 'onset_prob'

// ====== 权重设计（行主序） ======

// W1 [16, 32]: h_i = relu(curr_i - prev_i - THRESH)
// 输入布局 [prev(16), curr(16)]，W1[i][i] = -1（prev_i），W1[i][16+i] = +1（curr_i）
const W1 = Array.from({ length: HIDDEN_SIZE }, (_, i) => {
  const row = new Array(INPUT_SIZE).fill(0)
  row[i] = -1
  row[HIDDEN_SIZE + i] = 1
  return row
})
const B1 = new Array(HIDDEN_SIZE).fill(-THRESH)
const W2 = new Array(HIDDEN_SIZE).fill(1)
const B2 = [-FLUX_BIAS]

// ====== protobuf wire format 编码器 ======

/** 无符号 varint 编码 */
function varint(value) {
  const bytes = []
  let v = value
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  bytes.push(v)
  return bytes
}

/** 拼接多个字节数组 */
function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0)
  const out = Buffer.alloc(total)
  let off = 0
  for (const arr of arrays) {
    for (const b of arr) out[off++] = b
  }
  return out
}

/** 字段 tag: (field << 3) | wireType */
function tag(field, wireType) {
  return varint((field << 3) | wireType)
}

function fVarint(field, value) {
  return concat(tag(field, 0), varint(value))
}

function fLen(field, payload) {
  return concat(tag(field, 2), varint(payload.length), payload)
}

function fStr(field, str) {
  return fLen(field, Buffer.from(str, 'utf8'))
}

function fFloat(field, value) {
  const b = Buffer.alloc(4)
  b.writeFloatLE(value, 0)
  return concat(tag(field, 5), b)
}

// ====== ONNX 消息构造 ======

/** TensorProto：float32 + raw_data */
function tensorProto(name, dims, values) {
  const raw = Buffer.alloc(values.length * 4)
  values.forEach((v, i) => raw.writeFloatLE(v, i * 4))
  return concat(
    fStr(8, name), // TensorProto.name
    fVarint(2, 1), // data_type = FLOAT(1)
    ...dims.map((d) => fVarint(1, d)), // dims（repeated int64）
    fLen(9, raw) // raw_data
  )
}

/** TensorShapeProto.Dimension.dim_value */
function dimension(value) {
  return fVarint(1, value)
}

/**
 * TensorShapeProto { dim: [Dimension, ...] }
 * 注意：dim 是 repeated 字段，每个 dim 必须是独立的 field-1 条目，
 * 不能再用 fLen 整体包裹（否则会被解析成一个含多子字段的 Dimension）。
 */
function tensorShape(dims) {
  return concat(...dims.map((d) => fLen(1, dimension(d))))
}

/** TypeProto { tensor_type: { elem_type, shape } } */
function typeProto(elemType, dims) {
  const tensor = concat(fVarint(1, elemType), fLen(2, tensorShape(dims)))
  return fLen(1, tensor)
}

/** ValueInfoProto { name, type } */
function valueInfo(name, dims) {
  return concat(fStr(1, name), fLen(2, typeProto(1, dims)))
}

/** AttributeProto：FLOAT 类型 */
function attrFloat(name, value) {
  return concat(fStr(1, name), fVarint(20, 1), fFloat(2, value))
}

/** AttributeProto：INT 类型 */
function attrInt(name, value) {
  return concat(fStr(1, name), fVarint(20, 2), fVarint(3, value))
}

/** NodeProto { input, output, name, op_type, attribute } */
function nodeProto(name, opType, inputs, outputs, attrs) {
  return concat(
    ...inputs.map((i) => fStr(1, i)),
    ...outputs.map((o) => fStr(2, o)),
    fStr(3, name),
    fStr(4, opType),
    ...attrs.map((a) => fLen(5, a))
  )
}

/** GraphProto { node, name, initializer, input, output } */
function graphProto(name, nodes, initializers, inputs, outputs) {
  return concat(
    ...nodes.map((n) => fLen(1, n)),
    fStr(2, name),
    ...initializers.map((t) => fLen(5, t)),
    ...inputs.map((vi) => fLen(11, vi)),
    ...outputs.map((vi) => fLen(12, vi))
  )
}

/** ModelProto { ir_version, producer_name, producer_version, opset_import, graph } */
function modelProto(graph) {
  const opset = concat(fStr(1, ''), fVarint(2, OPSET_VERSION))
  return concat(
    fVarint(1, IR_VERSION),
    fStr(2, PRODUCER),
    fStr(3, '1.0.0'),
    fLen(8, opset),
    fLen(7, graph)
  )
}

// ====== 组装模型 ======

const nodes = [
  nodeProto(
    'gemm_hidden',
    'Gemm',
    [INPUT_NAME, 'W1', 'B1'],
    ['hidden'],
    [attrFloat('alpha', 1.0), attrFloat('beta', 1.0), attrInt('transA', 0), attrInt('transB', 1)]
  ),
  nodeProto('relu_hidden', 'Relu', ['hidden'], ['activ'], []),
  nodeProto(
    'gemm_out',
    'Gemm',
    ['activ', 'W2', 'B2'],
    ['score'],
    [attrFloat('alpha', 1.0), attrFloat('beta', 1.0), attrInt('transA', 0), attrInt('transB', 1)]
  ),
  nodeProto('sigmoid_out', 'Sigmoid', ['score'], [OUTPUT_NAME], [])
]

const initializers = [
  tensorProto('W1', [HIDDEN_SIZE, INPUT_SIZE], W1.flat()),
  tensorProto('B1', [HIDDEN_SIZE], B1),
  tensorProto('W2', [OUTPUT_SIZE, HIDDEN_SIZE], W2),
  tensorProto('B2', [OUTPUT_SIZE], B2)
]

const inputs = [valueInfo(INPUT_NAME, [1, INPUT_SIZE])]
const outputs = [valueInfo(OUTPUT_NAME, [1, OUTPUT_SIZE])]

const graph = graphProto(MODEL_NAME, nodes, initializers, inputs, outputs)
const modelBytes = modelProto(graph)

// ====== 自检：解析回权重与形状，验证编码一致性 ======

function parseFloat32LE(bytes) {
  const out = new Float32Array(bytes.length / 4)
  for (let i = 0; i < out.length; i++) {
    out[i] = bytes.readFloatLE(i * 4)
  }
  return out
}

/** 读取 varint，返回 [值, 新位置] */
function readVarintAt(buf, p) {
  let v = 0
  let shift = 0
  while (true) {
    const b = buf[p++]
    v += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return [v, p]
}

/**
 * 精确解析 TensorShapeProto 字节：
 * dim(field1, wire2) 为 repeated 条目，每条内层是 Dimension.dim_value(field1, wire0)。
 * 返回 [dim_value, ...]；形状不合法（解析不到 dim_value）时返回 null。
 */
function parseShapeBytes(bytes) {
  const dims = []
  let p = 0
  while (p < bytes.length) {
    const tagByte = bytes[p++]
    const field = tagByte >> 3
    const wire = tagByte & 7
    if (wire === 0) {
      p = readVarintAt(bytes, p)[1]
    } else if (wire === 2) {
      const [len, np] = readVarintAt(bytes, p)
      p = np
      if (field === 1 && len >= 2 && bytes[p] === 0x08) {
        // Dimension { dim_value = field1 varint }
        p += 1
        const [v, np2] = readVarintAt(bytes, p)
        p = np2
        dims.push(v)
      } else {
        p += len // 其他字段（如 dim_param）跳过
      }
    } else if (wire === 5) {
      p += 4
    } else {
      p += 8
    }
  }
  return dims
}

/** 解析 ValueInfoProto.type 的 shape：[1, 32] 这类 */
function parseValueInfoShape(bytes) {
  // TypeProto { tensor_type(field1, wire2) { shape(field2, wire2) } }
  let p = 0
  while (p < bytes.length) {
    const tagByte = bytes[p++]
    const field = tagByte >> 3
    const wire = tagByte & 7
    if (wire === 2) {
      const [len, np] = readVarintAt(bytes, p)
      p = np
      if (field === 1) {
        // tensor_type 内找 shape(field2)
        let q = p
        const end = p + len
        while (q < end) {
          const t = bytes[q++]
          const f2 = t >> 3
          const w2 = t & 7
          if (w2 === 2) {
            const [l2, nq] = readVarintAt(bytes, q)
            q = nq
            if (f2 === 2) return parseShapeBytes(bytes.subarray(q, q + l2))
            q += l2
          } else if (w2 === 0) {
            q = readVarintAt(bytes, q)[1]
          } else if (w2 === 5) {
            q += 4
          } else {
            q += 8
          }
        }
      }
      p += len
    } else if (wire === 0) {
      p = readVarintAt(bytes, p)[1]
    } else if (wire === 5) {
      p += 4
    } else {
      p += 8
    }
  }
  return null
}

/** 极简 protobuf 遍历：提取 initializer 权重 + graph input/output 形状 */
function selfCheck(buf) {
  const tensors = []
  const ioShapes = []
  const walk = (start, end, depth) => {
    let p = start
    while (p < end) {
      const tagByte = buf[p]
      p += 1
      const field = tagByte >> 3
      const wire = tagByte & 7
      if (wire === 0) {
        const [v, np] = readVarintAt(buf, p)
        p = np
        if (depth === 0 && field === 1) {
          if (v !== IR_VERSION) throw new Error(`ir_version 不匹配: ${v}`)
        }
        continue
      }
      if (wire === 2) {
        const [len, np] = readVarintAt(buf, p)
        p = np
        const payloadStart = p
        const payloadEnd = p + len
        if (depth === 0 && field === 7) {
          walk(payloadStart, payloadEnd, 1)
        } else if (depth === 1 && field === 5) {
          // GraphProto.initializer → 解析 TensorProto 的 name/raw_data/dims
          let q = payloadStart
          let name = ''
          let raw = null
          let dims = null
          while (q < payloadEnd) {
            const t = buf[q++]
            const f2 = t >> 3
            const w2 = t & 7
            if (w2 === 2) {
              const [l2, nq] = readVarintAt(buf, q)
              q = nq
              if (f2 === 8) name = buf.subarray(q, q + l2).toString('utf8')
              if (f2 === 9) raw = buf.subarray(q, q + l2)
              q += l2
            } else if (w2 === 0) {
              const [v, nq] = readVarintAt(buf, q)
              q = nq
              // TensorProto.dims（repeated int64, field 1）
              if (f2 === 1) {
                if (!dims) dims = []
                dims.push(v)
              }
            } else if (w2 === 5) {
              q += 4
            } else {
              q += 8
            }
          }
          if (name) tensors.push({ name, raw, dims })
        } else if (depth === 1 && (field === 11 || field === 12)) {
          // GraphProto.input/output → ValueInfoProto { name, type.shape }
          let q = payloadStart
          let name = ''
          let shape = null
          while (q < payloadEnd) {
            const t = buf[q++]
            const f2 = t >> 3
            const w2 = t & 7
            if (w2 === 2) {
              const [l2, nq] = readVarintAt(buf, q)
              q = nq
              if (f2 === 1) name = buf.subarray(q, q + l2).toString('utf8')
              if (f2 === 2) shape = parseValueInfoShape(buf.subarray(q, q + l2))
              q += l2
            } else if (w2 === 0) {
              q = skipVarint(buf, q)
            } else if (w2 === 5) {
              q += 4
            } else {
              q += 8
            }
          }
          ioShapes.push({ kind: field === 11 ? 'input' : 'output', name, shape })
        }
        p = payloadEnd
        continue
      }
      if (wire === 5) {
        p += 4
        continue
      }
      p += 8
    }
  }
  walk(0, buf.length, 0)
  return { tensors, ioShapes }
}

/** 跳过当前 varint（p 指向 varint 首个字节） */
function skipVarint(buf, p) {
  return readVarintAt(buf, p)[1]
}

const { tensors, ioShapes } = selfCheck(modelBytes)

// ---- 权重一致性 ----
const parsed = new Map(tensors.map((t) => [t.name, parseFloat32LE(t.raw)]))
const flatW1 = W1.flat()
for (const [name, values] of parsed) {
  const expected = name === 'W1' ? flatW1 : name === 'B1' ? B1 : name === 'W2' ? W2 : B2
  if (values.length !== expected.length) {
    throw new Error(`权重 ${name} 长度不一致: ${values.length} != ${expected.length}`)
  }
  for (let i = 0; i < expected.length; i++) {
    if (Math.abs(values[i] - expected[i]) > 1e-6) {
      throw new Error(`权重 ${name}[${i}] 不一致: ${values[i]} != ${expected[i]}`)
    }
  }
}

// ---- 形状一致性（修复过 shape 编码 bug，必须逐维校验） ----
const expectedShapes = [
  { kind: 'input', name: INPUT_NAME, shape: [1, INPUT_SIZE] },
  { kind: 'output', name: OUTPUT_NAME, shape: [1, OUTPUT_SIZE] }
]
for (const exp of expectedShapes) {
  const found = ioShapes.find((s) => s.kind === exp.kind && s.name === exp.name)
  if (!found) throw new Error(`缺少 graph ${exp.kind}: ${exp.name}`)
  if (JSON.stringify(found.shape) !== JSON.stringify(exp.shape)) {
    throw new Error(`graph ${exp.kind} ${exp.name} 形状不一致: [${found.shape}] != [${exp.shape}]`)
  }
}
const shapeCheck = [
  { name: 'W1', dims: [HIDDEN_SIZE, INPUT_SIZE] },
  { name: 'B1', dims: [HIDDEN_SIZE] },
  { name: 'W2', dims: [OUTPUT_SIZE, HIDDEN_SIZE] },
  { name: 'B2', dims: [OUTPUT_SIZE] }
]
for (const exp of shapeCheck) {
  const t = tensors.find((x) => x.name === exp.name)
  if (JSON.stringify(t.dims) !== JSON.stringify(exp.dims)) {
    throw new Error(`initializer ${exp.name} 形状不一致: [${t.dims}] != [${exp.dims}]`)
  }
}

console.log(`自检通过: ${parsed.size} 个 initializer 权重与形状均与设计一致`)
console.log(`  graph input  ${expectedShapes[0].name}: [${expectedShapes[0].shape}]`)
console.log(`  graph output ${expectedShapes[1].name}: [${expectedShapes[1].shape}]`)

// ====== 写出产物 ======

const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
  'src',
  'audio',
  'model'
)
mkdirSync(outDir, { recursive: true })

writeFileSync(join(outDir, 'onset-model.onnx'), modelBytes)

const base64 = modelBytes.toString('base64')
const fmt = (arr) => `[\n    ${[...arr].map((v) => v.toFixed(4)).join(',\n    ')}\n  ]`
const ts = `/**
 * 起始点检测 ONNX 模型数据（AUTO-GENERATED by scripts/generate-onset-model.mjs）
 *
 * 请勿手动编辑；如需修改网络/权重，请编辑生成脚本后重新执行：
 *   npm run generate:model
 *
 * 模型: ${MODEL_NAME}（MLP，输入 [1, ${INPUT_SIZE}]，输出起始点概率 [1, 1]）
 * 架构: features → Gemm(hidden=${HIDDEN_SIZE}, transB=1) → Relu → Gemm(1, transB=1) → Sigmoid
 * 权重: 手工设计的启发式谱通量权重（详见生成脚本头部注释）
 */
export const ONSET_MODEL_NAME = '${MODEL_NAME}'
export const ONSET_MODEL_INPUT_NAME = '${INPUT_NAME}'
export const ONSET_MODEL_OUTPUT_NAME = '${OUTPUT_NAME}'
export const ONSET_MODEL_INPUT_SIZE = ${INPUT_SIZE}
export const ONSET_MODEL_HIDDEN_SIZE = ${HIDDEN_SIZE}
export const ONSET_MODEL_OUTPUT_SIZE = ${OUTPUT_SIZE}

/** ONNX 模型字节（base64，供 onnxruntime-web 创建推理会话） */
export const ONSET_MODEL_BASE64 = '${base64}'

/** 隐藏层权重 W1 [${HIDDEN_SIZE}, ${INPUT_SIZE}]（行主序，参考实现使用） */
export const ONSET_MODEL_W1: number[] = ${fmt(W1.flat())}

/** 隐藏层偏置 B1 [${HIDDEN_SIZE}] */
export const ONSET_MODEL_B1: number[] = ${fmt(B1)}

/** 输出层权重 W2 [${OUTPUT_SIZE}, ${HIDDEN_SIZE}] */
export const ONSET_MODEL_W2: number[] = ${fmt(W2)}

/** 输出层偏置 B2 [${OUTPUT_SIZE}] */
export const ONSET_MODEL_B2: number[] = ${fmt(B2)}
`

writeFileSync(join(outDir, 'onset-model-data.ts'), ts)

console.log(`已生成: src/renderer/src/audio/model/onset-model.onnx (${modelBytes.length} bytes)`)
console.log(
  `已生成: src/renderer/src/audio/model/onset-model-data.ts (${Buffer.byteLength(ts)} bytes)`
)
