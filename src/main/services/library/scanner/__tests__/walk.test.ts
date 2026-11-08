import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { toPosixPath } from '../../../../../shared/library/normalize'
import { guessCodec, walkRoots, type WalkedFile } from '../walk'

let root = ''

/** 造一棵带干扰项的目录树：文本文件、排除目录、隐藏目录、符号链接、深达三层的子目录 */
beforeAll(() => {
  root = toPosixPath(mkdtempSync(join(tmpdir(), 'such-walk-')))

  const touch = (relative: string): void => {
    const target = join(root, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, 'x')
  }

  touch('a.flac')
  touch('b.mp3')
  touch('note.txt')
  touch('cover.jpg')
  touch('sub/c.wav')
  touch('sub/deep/d.m4a')
  touch('node_modules/e.mp3')
  touch('.hidden/f.mp3')
  touch('@eaDir/g.mp3')

  try {
    symlinkSync(root, join(root, 'loop'))
  } catch {
    // Windows 无权限建符号链接时忽略，环检测另有单测价值但非必需
  }
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

async function walk(overrides: Partial<Parameters<typeof walkRoots>[0]> = {}): Promise<{
  files: WalkedFile[]
  scanned: number
  errors: number
  skippedRoots: string[]
}> {
  const files: WalkedFile[] = []
  const result = await walkRoots({
    roots: [root],
    onFile: (file) => files.push(file),
    isCancelled: () => false,
    ...overrides
  })
  files.sort((a, b) => a.filePath.localeCompare(b.filePath))
  return { files, ...result }
}

describe('walkRoots', () => {
  it('递归收集音频文件，忽略非音频与排除目录', async () => {
    const { files, errors } = await walk()
    const names = files.map((f) => f.fileName).sort()
    expect(names).toEqual(['a.flac', 'b.mp3', 'c.wav', 'd.m4a'])
    expect(errors).toBe(0)
  })

  it('记录所在目录、扫描根与相对目录', async () => {
    const { files } = await walk()
    const byName = new Map(files.map((f) => [f.fileName, f]))

    expect(byName.get('a.flac')?.folderPath).toBe(root)
    expect(byName.get('a.flac')?.relDir).toBe('')
    expect(byName.get('c.wav')?.relDir).toBe('sub')
    expect(byName.get('d.m4a')?.relDir).toBe('sub/deep')
    expect(byName.get('d.m4a')?.folderPath).toBe(`${root}/sub/deep`)
    expect(byName.get('d.m4a')?.rootPath).toBe(root)
  })

  it('路径统一为正斜杠，且带 size / mtimeMs', async () => {
    const { files } = await walk()
    for (const file of files) {
      expect(file.filePath).not.toContain('\\')
      expect(file.filePath.startsWith(`${root}/`)).toBe(true)
      expect(file.size).toBeGreaterThanOrEqual(0)
      expect(file.mtimeMs).toBeGreaterThan(0)
    }
  })

  it('不跟随符号链接（防环）', async () => {
    const { files } = await walk()
    // 若跟随 loop，会因环而无限展开或重复计入；这里只断言没有重复路径
    const paths = files.map((f) => f.filePath)
    expect(new Set(paths).size).toBe(paths.length)
    expect(files).toHaveLength(4)
  })

  it('根不存在时记入 skippedRoots 而不是抛异常', async () => {
    const missing = join(root, 'nope')
    const result = await walk({ roots: [missing] })
    expect(result.skippedRoots).toEqual([missing])
    expect(result.scanned).toBe(0)
  })

  it('根指向文件时也算跳过', async () => {
    const file = join(root, 'a.flac')
    const result = await walk({ roots: [file] })
    expect(result.skippedRoots).toEqual([file])
  })

  it('isCancelled 返回 true 时立即停止', async () => {
    const { files } = await walk({ isCancelled: () => true })
    expect(files).toHaveLength(0)
  })

  it('onDir 至少对每个实际遍历过的目录回调一次', async () => {
    const dirs: number[] = []
    await walk({ onDir: (count) => dirs.push(count) })
    // root / sub / sub/deep 三个目录（排除目录不计）
    expect(dirs.length).toBeGreaterThanOrEqual(3)
    expect(dirs[dirs.length - 1]).toBe(dirs.length)
  })
})

describe('guessCodec', () => {
  it('按扩展名给出可读编码名', () => {
    expect(guessCodec('a.flac')).toBe('FLAC')
    expect(guessCodec('a.MP3')).toBe('MP3')
    expect(guessCodec('a.m4a')).toBe('AAC')
    expect(guessCodec('a.opus')).toBe('Opus')
    expect(guessCodec('a.ape')).toBe('APE')
  })

  it('未知扩展名返回 undefined', () => {
    expect(guessCodec('a.txt')).toBeUndefined()
    expect(guessCodec('noext')).toBeUndefined()
  })
})
