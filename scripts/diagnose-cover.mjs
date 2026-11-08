#!/usr/bin/env node
/**
 * 本地歌曲封面诊断（只读，不修改任何文件）
 *
 * 对目录里的每个音频文件依次跑三个解析源，报告「三源都取不到封面」的文件：
 *   1. native（lofty，resources/native/music_tag_reader.node）
 *   2. music-metadata
 *   3. 手动嗅探（src/main/utils/musicMetaReader.ts，需要 Node ≥ 22.18 的类型剥离）
 *
 * 用法：
 *   node scripts/diagnose-cover.mjs <目录> [--limit 200] [--ext=mp3,flac] [--json out.json] [--concurrency 4]
 *
 * 说明：
 * - 不依赖 electron，也不 import tagReaderService（它 import 'electron'，普通 node 会崩）
 * - native 模块走 N-API，ABI 稳定，可直接 require
 * - 手动嗅探阶段用 `--experimental-strip-types` 动态 import .ts；失败会打印 WARN 并跳过该阶段
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..')

const DEFAULT_EXTS = [
  '.mp3',
  '.flac',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.ape',
  '.wv',
  '.aiff',
  '.aif',
  '.mp4',
  '.m4b'
]

function parseArgs(argv) {
  const args = { dir: '', limit: 0, exts: null, json: '', concurrency: 4 }
  for (const raw of argv) {
    if (raw.startsWith('--limit=')) args.limit = Number(raw.slice(8)) || 0
    else if (raw.startsWith('--ext=')) {
      args.exts = raw
        .slice(6)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .map((s) => (s.startsWith('.') ? s : `.${s}`))
    } else if (raw.startsWith('--json=')) args.json = raw.slice(7)
    else if (raw.startsWith('--concurrency=')) args.concurrency = Math.max(1, Number(raw.slice(14)) || 4)
    else if (!raw.startsWith('--')) args.dir = raw
  }
  if (!args.dir) {
    console.error('用法: node scripts/diagnose-cover.mjs <目录> [--limit 200] [--ext=mp3,flac] [--json out.json]')
    process.exit(2)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const EXTS = new Set(args.exts ?? DEFAULT_EXTS)

async function walk(dir, acc) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    console.warn('读取目录失败:', dir, error.message)
    return
  }
  const subDirs = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) subDirs.push(full)
    else if (EXTS.has(path.extname(entry.name).toLowerCase())) acc.push(full)
  }
  // 顺序遍历子目录，并把结果写回同一个数组，避免大目录树同时持有大量 Dirent
  for (const sub of subDirs) await walk(sub, acc)
}

// ---------------- 三个解析源 ----------------
const require = createRequire(import.meta.url)

let nativeReadTags = null
try {
  const mod = require(path.join(PROJECT_ROOT, 'resources/native/music_tag_reader.node'))
  nativeReadTags = mod.readTags ?? mod.default?.readTags ?? null
} catch (error) {
  console.warn('[WARN] native 标签模块加载失败，native 阶段将跳过:', error.message)
}
if (!nativeReadTags) console.warn('[WARN] native 模块未导出 readTags，native 阶段将跳过')

let mmParseFile = null
try {
  mmParseFile = (await import('music-metadata')).parseFile
} catch (error) {
  console.warn('[WARN] music-metadata 加载失败，该阶段将跳过:', error.message)
}

let readMetaManually = null
try {
  // 用 file URL 动态 import 绝对路径（Windows 盘符路径不能直接 import）
  const mod = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'src/main/utils/musicMetaReader.ts')).href
  )
  readMetaManually = mod.readMetaManually
} catch (error) {
  console.warn(
    '[WARN] 手动嗅探阶段跳过（需要 Node ≥ 22.18 的 TS 类型剥离）:',
    error.message
  )
}

function bytesOfCover(cover) {
  if (!cover) return 0
  if (cover.data && cover.data.length) return cover.data.length
  if (typeof cover.base64 === 'string') return cover.base64.length
  return 0
}

async function diagnoseNative(file) {
  if (!nativeReadTags) return { skipped: true }
  try {
    const info = nativeReadTags(file, { includeCover: true })
    if (!info) return { ok: false, reason: 'readTags 返回 null' }
    return {
      ok: true,
      fileFormat: info.fileFormat,
      title: info.title,
      pictureCount: info.pictureCount,
      pictureType: info.pictureType,
      coverBytes: bytesOfCover(info.picture)
    }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

async function diagnoseMusicMetadata(file) {
  if (!mmParseFile) return { skipped: true }
  try {
    const meta = await mmParseFile(file)
    const pictures = meta?.common?.picture ?? []
    return {
      ok: true,
      title: meta?.common?.title,
      pictures: pictures.length,
      coverBytes: pictures[0]?.data?.length ?? 0,
      coverType: pictures[0]?.type
    }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

async function diagnoseManual(file) {
  if (!readMetaManually) return { skipped: true }
  try {
    const meta = await readMetaManually(file)
    if (!meta) return { ok: false, reason: '无法识别格式' }
    return {
      ok: true,
      title: meta.title,
      coverBytes: bytesOfCover(meta.cover),
      coverMime: meta.cover?.mimeType
    }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

async function diagnoseFile(file) {
  const [native, mm, manual] = await Promise.all([
    diagnoseNative(file),
    diagnoseMusicMetadata(file),
    diagnoseManual(file)
  ])
  const hasCover =
    (native?.coverBytes ?? 0) > 0 || (mm?.coverBytes ?? 0) > 0 || (manual?.coverBytes ?? 0) > 0
  let size = 0
  try {
    size = (await fs.stat(file)).size
  } catch {
    /* 忽略 */
  }
  return { file, size, native, mm, manual, hasCover }
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

// ---------------- 主流程 ----------------
const files = []
await walk(path.resolve(args.dir), files)
const targets = args.limit > 0 ? files.slice(0, args.limit) : files

console.log(`扫描目录: ${path.resolve(args.dir)}`)
console.log(`匹配文件: ${files.length}${args.limit > 0 ? `（仅诊断前 ${targets.length} 个）` : ''}`)
console.log(
  `解析源: native=${nativeReadTags ? 'on' : 'off'} music-metadata=${mmParseFile ? 'on' : 'off'} manual=${readMetaManually ? 'on' : 'off'}\n`
)

if (targets.length === 0) process.exit(0)

let done = 0
const results = await runPool(
  targets,
  async (file) => {
    const result = await diagnoseFile(file)
    done++
    if (done % 50 === 0) process.stderr.write(`  已处理 ${done}/${targets.length}\n`)
    return result
  },
  args.concurrency
)

const summary = { native: 0, mm: 0, manual: 0, none: 0 }
const perExt = new Map()
const failures = []

for (const r of results) {
  const ext = path.extname(r.file).toLowerCase() || '(无扩展名)'
  const bucket = perExt.get(ext) ?? { total: 0, failed: 0 }
  bucket.total++
  if (!r.hasCover) {
    bucket.failed++
    failures.push(r)
    summary.none++
  } else {
    if ((r.native?.coverBytes ?? 0) > 0) summary.native++
    else if ((r.mm?.coverBytes ?? 0) > 0) summary.mm++
    else summary.manual++
  }
  perExt.set(ext, bucket)
}

console.log('\n按扩展名：')
console.log('  扩展名        文件数   无封面   失败率')
for (const [ext, b] of [...perExt.entries()].sort((a, b) => b[1].failed - a[1].failed)) {
  const rate = b.total ? ((b.failed / b.total) * 100).toFixed(1) : '0.0'
  console.log(
    `  ${ext.padEnd(12)} ${String(b.total).padStart(6)} ${String(b.failed).padStart(7)} ${(rate + '%').padStart(8)}`
  )
}

console.log('\n封面来源汇总：')
console.log(`  native            ${summary.native}`)
console.log(`  music-metadata    ${summary.mm}`)
console.log(`  手动嗅探          ${summary.manual}`)
console.log(`  三源都没有封面    ${summary.none}`)

if (failures.length) {
  console.log('\n三源都没取到封面的文件：')
  for (const f of failures) console.log(`  ${f.file}`)

  console.log('\n逐文件明细（仅失败项）：')
  for (const f of failures) {
    const n = f.native ?? {}
    const m = f.mm ?? {}
    const h = f.manual ?? {}
    console.log(
      `  ${path.basename(f.file)}  [${(f.size / 1024 / 1024).toFixed(1)}MB]\n` +
        `    native: ${n.skipped ? 'skipped' : n.ok ? `ok pic=${n.pictureCount ?? '?'} type=${n.pictureType ?? '?'} bytes=${n.coverBytes} fmt=${n.fileFormat ?? '?'}` : `fail (${n.reason})`}\n` +
        `    mm    : ${m.skipped ? 'skipped' : m.ok ? `ok pic=${m.pictures} bytes=${m.coverBytes}` : `fail (${m.reason})`}\n` +
        `    manual: ${h.skipped ? 'skipped' : h.ok ? `ok bytes=${h.coverBytes} mime=${h.coverMime ?? '-'}` : `fail (${h.reason})`}`
    )
  }
}

if (args.json) {
  await fs.writeFile(
    path.resolve(args.json),
    JSON.stringify({ dir: path.resolve(args.dir), total: results.length, summary, results }, null, 2),
    'utf-8'
  )
  console.log(`\n明细已写入 ${path.resolve(args.json)}`)
}
