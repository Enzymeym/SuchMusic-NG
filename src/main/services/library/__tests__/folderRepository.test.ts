import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createRequire } from 'module'
import { toPosixPath } from '../../../../shared/library/normalize'
import type { LibraryFolder, ScannedTrack } from '../../../../shared/library/types'
import { closeLibrary, getLibraryUnavailableReason, openLibrary, type DbConnection } from '../db'
import { getFolderByPath, listFolders, rebuildFolders, updateFolder } from '../folderRepository'
import { deleteTracksByPaths, listTracksInFolder, upsertTracks } from '../trackRepository'

/**
 * better-sqlite3 是原生模块，可能尚未安装（或 ABI 与当前 Node 不匹配）。
 * 这种情况下整组用例 skip，而不是红一片 —— 曲库本身会降级为「不可用」。
 */
const sqliteReady = (() => {
  try {
    createRequire(import.meta.url).resolve('better-sqlite3')
    return true
  } catch {
    return false
  }
})()

const describeDb = sqliteReady ? describe : describe.skip

const ROOT = 'C:/Music/Root'
const NOW = 1_700_000_000_000

let conn: DbConnection | null = null

function db(): DbConnection {
  if (!conn) throw new Error('数据库未就绪')
  return conn
}

/** 造一条 ScannedTrack，目录/文件名从路径推出来 */
function track(
  filePath: string,
  options: { coverHash?: string; title?: string } = {}
): ScannedTrack {
  const posix = toPosixPath(filePath)
  const idx = posix.lastIndexOf('/')
  const folderPath = posix.slice(0, idx)
  const fileName = posix.slice(idx + 1)
  return {
    filePath: posix,
    fileName,
    folderPath,
    rootPath: ROOT,
    relDir: folderPath === ROOT ? '' : folderPath.slice(ROOT.length + 1),
    title: options.title ?? fileName.replace(/\.[^.]+$/, ''),
    artists: ['测试'],
    album: '专辑',
    coverHash: options.coverHash,
    coverExt: options.coverHash ? 'jpg' : undefined,
    hasLyrics: false,
    size: 1024,
    mtimeMs: 1
  }
}

function insert(tracks: ScannedTrack[]): void {
  db().transaction(() => {
    upsertTracks(db(), tracks, NOW)
  })()
}

function rebuild(): { folders: number; removed: number } {
  return rebuildFolders(db(), NOW)
}

function folderMap(): Map<string, LibraryFolder> {
  return new Map(listFolders(db()).map((f) => [f.path, f]))
}

describeDb('folderRepository（依赖 better-sqlite3）', () => {
  beforeAll(() => {
    conn = openLibrary()
    if (!conn) throw new Error(`曲库打不开：${getLibraryUnavailableReason()}`)
  })

  afterAll(() => {
    closeLibrary()
  })

  beforeEach(() => {
    // 每个用例独立：清空两张表（folders 是 tracks 的派生视图）
    db().exec('DELETE FROM tracks')
    db().exec('DELETE FROM folders')
  })

  it('按目录生成文件夹，直接数/子树数分别统计', () => {
    insert([
      track(`${ROOT}/a.flac`, { coverHash: 'aaaa' }),
      track(`${ROOT}/sub/b.flac`, { coverHash: 'bbbb' }),
      track(`${ROOT}/sub/c.flac`),
      track(`${ROOT}/sub/deep/d.flac`)
    ])

    const result = rebuild()
    expect(result).toEqual({ folders: 3, removed: 0 })

    const folders = folderMap()
    expect([...folders.keys()].sort()).toEqual([ROOT, `${ROOT}/sub`, `${ROOT}/sub/deep`].sort())

    expect(folders.get(ROOT)).toMatchObject({
      parentPath: null,
      name: 'Root',
      depth: 0,
      trackCount: 1,
      totalTrackCount: 4
    })
    expect(folders.get(`${ROOT}/sub`)).toMatchObject({
      parentPath: ROOT,
      name: 'sub',
      depth: 1,
      trackCount: 2,
      totalTrackCount: 3
    })
    expect(folders.get(`${ROOT}/sub/deep`)).toMatchObject({
      parentPath: `${ROOT}/sub`,
      depth: 2,
      trackCount: 1,
      totalTrackCount: 1
    })
  })

  it('父目录自己没有曲目时也会补齐（否则树是断的）', () => {
    insert([track(`${ROOT}/a/b/c/x.flac`)])

    expect(rebuild().folders).toBe(4)
    const folders = folderMap()
    expect([...folders.keys()].sort()).toEqual(
      [ROOT, `${ROOT}/a`, `${ROOT}/a/b`, `${ROOT}/a/b/c`].sort()
    )
    expect(folders.get(ROOT)).toMatchObject({ trackCount: 0, totalTrackCount: 1 })
    expect(folders.get(`${ROOT}/a/b/c`)).toMatchObject({ depth: 3, totalTrackCount: 1 })
  })

  it('封面自底向上继承：父目录无自己的封面时取子目录的', () => {
    insert([
      track(`${ROOT}/sub/b.flac`, { coverHash: 'bbbb' }),
      track(`${ROOT}/sub/deep/d.flac`)
    ])

    rebuild()
    const folders = folderMap()
    // 根目录自己没有带封面的曲目 → 继承 sub 的
    expect(folders.get(ROOT)).toMatchObject({ coverHash: 'bbbb', coverExt: 'jpg' })
    expect(folders.get(`${ROOT}/sub`)).toMatchObject({ coverHash: 'bbbb' })
    // 更深的叶子没有封面，也不该凭空多出一个
    expect(folders.get(`${ROOT}/sub/deep`)?.coverHash).toBeUndefined()
  })

  it('父目录自己有封面时优先用自己的', () => {
    insert([
      track(`${ROOT}/a.flac`, { coverHash: 'aaaa' }),
      track(`${ROOT}/sub/b.flac`, { coverHash: 'bbbb' })
    ])

    rebuild()
    expect(folderMap().get(ROOT)?.coverHash).toBe('aaaa')
  })

  it('重建不会冲掉用户覆盖（alias / pinned / hidden）', () => {
    insert([track(`${ROOT}/sub/b.flac`)])
    rebuild()

    const sub = getFolderByPath(db(), `${ROOT}/sub`)
    expect(sub).not.toBeNull()
    const updated = updateFolder(db(), sub!.id, { alias: '我的歌单', pinned: true, hidden: true }, NOW)
    expect(updated).toMatchObject({ displayName: '我的歌单', pinned: true, hidden: true })

    rebuild()
    expect(folderMap().get(`${ROOT}/sub`)).toMatchObject({
      name: 'sub',
      displayName: '我的歌单',
      pinned: true,
      hidden: true
    })
  })

  it('曲目被删除后对应目录一并消失', () => {
    insert([track(`${ROOT}/a.flac`), track(`${ROOT}/sub/b.flac`), track(`${ROOT}/sub/deep/d.flac`)])
    rebuild()
    expect(folderMap().size).toBe(3)

    deleteTracksByPaths(db(), [`${ROOT}/sub/deep/d.flac`])
    expect(rebuild()).toEqual({ folders: 2, removed: 1 })
    expect(folderMap().has(`${ROOT}/sub/deep`)).toBe(false)
    expect(folderMap().get(`${ROOT}/sub`)?.totalTrackCount).toBe(1)

    db().exec('DELETE FROM tracks')
    expect(rebuild()).toEqual({ folders: 0, removed: 2 })
    expect(listFolders(db())).toEqual([])
  })

  it('分母目录里的曲目查询不串目录（LIKE 里的下划线要转义）', () => {
    insert([
      track(`C:/Music/a_b/x.flac`),
      track(`C:/Music/axb/y.flac`),
      track(`C:/Music/a_b/sub/z.flac`)
    ])

    const own = listTracksInFolder(db(), 'C:/Music/a_b')
    expect(own.map((t) => t.fileName)).toEqual(['x.flac'])

    const withSub = listTracksInFolder(db(), 'C:/Music/a_b', { includeSubfolders: true })
    expect(withSub.map((t) => t.fileName).sort()).toEqual(['x.flac', 'z.flac'])
  })

  it('分页 limit / offset 生效', () => {
    insert([
      track(`${ROOT}/sub/a.flac`),
      track(`${ROOT}/sub/b.flac`),
      track(`${ROOT}/sub/c.flac`)
    ])

    const page = listTracksInFolder(db(), `${ROOT}/sub`, { limit: 2 })
    expect(page).toHaveLength(2)
    const next = listTracksInFolder(db(), `${ROOT}/sub`, { limit: 2, offset: 2 })
    expect(next).toHaveLength(1)
    expect(page[0].filePath).not.toBe(next[0].filePath)
  })
})
