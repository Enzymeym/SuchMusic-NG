/**
 * folders 表的维护。
 *
 * 「文件夹歌单」不是一个独立的实体，而是 `tracks.folder_path` 的派生视图：
 * 目录内容一变，歌单立刻跟着变，不需要任何同步逻辑，也不会在库里存两份曲目。
 * 这张表存在的意义只有三个：
 *   1. 把树结构、直接曲目数、含子树曲目数一次算好，UI 不必每次扫全表；
 *   2. 存放用户对文件夹的覆盖（alias / pinned / hidden / sort_order）；
 *   3. 给文件夹一张封面（取第一个有封面的子曲目，父目录再向上继承）。
 */
import type { LibraryFolder } from '../../../shared/library/types'
import { baseName, parentOf, toPosixPath } from '../../../shared/library/normalize'
import type { DbConnection } from './db'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface FolderRow {
  id: number
  path: string
  parent_path: string | null
  name: string
  root_path: string
  depth: number
  track_count: number
  total_track_count: number
  cover_hash: string | null
  cover_ext: string | null
  pinned: number
  hidden: number
  alias: string | null
  sort_order: number
  updated_at: number
}

/** 去掉盘符根末尾的斜杠，便于与 tracks.folder_path 对齐 */
function trimTrailingSlash(value: string): string {
  if (!value) return ''
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

function rowToFolder(row: FolderRow): LibraryFolder {
  const alias = row.alias?.trim()
  return {
    id: Number(row.id),
    path: row.path,
    parentPath: row.parent_path,
    name: row.name,
    displayName: alias || row.name,
    rootPath: row.root_path,
    depth: Number(row.depth) || 0,
    trackCount: Number(row.track_count) || 0,
    totalTrackCount: Number(row.total_track_count) || 0,
    coverHash: row.cover_hash ?? undefined,
    coverExt: row.cover_ext ?? undefined,
    pinned: row.pinned === 1,
    hidden: row.hidden === 1,
    sortOrder: Number(row.sort_order) || 0
  }
}

export function listFolders(conn: DbConnection): LibraryFolder[] {
  const rows = conn
    .prepare(`SELECT * FROM folders ORDER BY depth ASC, sort_order ASC, name COLLATE NOCASE ASC`)
    .all() as FolderRow[]
  return rows.map(rowToFolder)
}

export function getFolderById(conn: DbConnection, id: number): LibraryFolder | null {
  const row = conn.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined
  return row ? rowToFolder(row) : null
}

export function getFolderByPath(conn: DbConnection, path: string): LibraryFolder | null {
  const row = conn.prepare('SELECT * FROM folders WHERE path = ?').get(path) as
    | FolderRow
    | undefined
  return row ? rowToFolder(row) : null
}

export function listChildFolders(conn: DbConnection, parentPath: string): LibraryFolder[] {
  const rows = conn
    .prepare(
      `SELECT * FROM folders WHERE parent_path = ?
       ORDER BY sort_order ASC, name COLLATE NOCASE ASC`
    )
    .all(parentPath) as FolderRow[]
  return rows.map(rowToFolder)
}

/** 更新用户覆盖字段；只写传入的字段，不动其它列 */
export function updateFolder(
  conn: DbConnection,
  id: number,
  patch: { alias?: string | null; pinned?: boolean; hidden?: boolean; sortOrder?: number },
  now: number
): LibraryFolder | null {
  const current = getFolderById(conn, id)
  if (!current) return null

  const aliasRaw = patch.alias === undefined ? current.displayName : patch.alias
  const alias = aliasRaw?.trim() || ''
  const pinned = patch.pinned === undefined ? current.pinned : patch.pinned
  const hidden = patch.hidden === undefined ? current.hidden : patch.hidden
  const sortOrder = patch.sortOrder === undefined ? current.sortOrder : patch.sortOrder

  conn
    .prepare(
      `UPDATE folders SET alias = ?, pinned = ?, hidden = ?, sort_order = ?, updated_at = ? WHERE id = ?`
    )
    .run(alias && alias !== current.name ? alias : null, pinned ? 1 : 0, hidden ? 1 : 0, sortOrder, now, id)

  return getFolderById(conn, id)
}

/** 目录深度：以扫描根为 0，逐级 +1 */
function depthOf(folderPath: string, rootPath: string): number {
  if (!rootPath || folderPath === rootPath) return 0
  const prefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`
  if (!folderPath.startsWith(prefix)) return 0
  return folderPath.slice(prefix.length).split('/').filter(Boolean).length
}

/**
 * 依据当前 tracks 重建 folders 表（幂等，必须在扫描写库完成后、同一事务内调用）。
 *
 * 三个必须保证的点：
 * 1. 用户覆盖字段（alias/pinned/hidden/sort_order）不能被重建冲掉 ——
 *    upsert 只更新结构类与统计类列；
 * 2. 父目录的 `total_track_count` 必须含子树，否则「打开父文件夹」是空的；
 * 3. 已经从磁盘消失的目录必须删掉，否则歌单列表会留下永远打不开的卡片。
 */
export function rebuildFolders(conn: DbConnection, now: number): { folders: number; removed: number } {
  const direct = conn
    .prepare(
      `SELECT folder_path AS path, root_path AS root, COUNT(*) AS c
       FROM tracks GROUP BY folder_path, root_path`
    )
    .all() as Array<{ path: string; root: string; c: number }>

  const existing = new Map<string, FolderRow>()
  for (const row of conn.prepare('SELECT * FROM folders').all() as FolderRow[]) {
    existing.set(row.path, row)
  }

  /** path → { root, own: 该目录直接含有的曲目数 } */
  const nodes = new Map<string, { root: string; own: number }>()

  for (const row of direct) {
    const folderPath = trimTrailingSlash(toPosixPath(row.path))
    const rootPath = trimTrailingSlash(toPosixPath(row.root))
    if (!folderPath) continue

    const node = nodes.get(folderPath) ?? { root: rootPath, own: 0 }
    node.own += Number(row.c) || 0
    nodes.set(folderPath, node)

    // 补齐从根到该目录的所有祖先：父目录即使自己没歌也要出现在树里
    let cursor = folderPath
    let guard = 0
    while (guard++ < 64) {
      const parent = trimTrailingSlash(parentOf(cursor))
      if (!parent || parent === cursor) break
      if (parent.length < rootPath.length) break
      if (!nodes.has(parent)) nodes.set(parent, { root: rootPath, own: 0 })
      if (parent === rootPath) break
      cursor = parent
    }
  }

  // 每个目录自己的封面（取第一个有封面的曲目）
  const coverRows = conn
    .prepare(
      `SELECT folder_path AS path, cover_hash AS hash, cover_ext AS ext
       FROM tracks
       WHERE cover_hash IS NOT NULL AND cover_hash <> ''
       ORDER BY folder_path, file_name`
    )
    .all() as Array<{ path: string; hash: string; ext: string | null }>
  const ownCover = new Map<string, { hash: string; ext: string }>()
  for (const row of coverRows) {
    const key = trimTrailingSlash(toPosixPath(row.path))
    if (!ownCover.has(key)) ownCover.set(key, { hash: row.hash, ext: row.ext || 'jpg' })
  }

  // 子树累计：按深度从深到浅，把每层 own 往父级累加
  const byDepthDesc = [...nodes.keys()].sort((a, b) => b.split('/').length - a.split('/').length)
  const subtree = new Map<string, number>()
  for (const path of byDepthDesc) {
    const node = nodes.get(path)!
    const value = (subtree.get(path) ?? 0) + node.own
    subtree.set(path, value)
    const parent = trimTrailingSlash(parentOf(path))
    if (parent && nodes.has(parent)) {
      subtree.set(parent, (subtree.get(parent) ?? 0) + value)
    }
  }

  const upsert = conn.prepare(
    `INSERT INTO folders (
       path, parent_path, name, root_path, depth, track_count, total_track_count,
       cover_hash, cover_ext, pinned, hidden, alias, sort_order, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 0, ?)
     ON CONFLICT(path) DO UPDATE SET
       parent_path = excluded.parent_path,
       name = excluded.name,
       root_path = excluded.root_path,
       depth = excluded.depth,
       track_count = excluded.track_count,
       total_track_count = excluded.total_track_count,
       cover_hash = excluded.cover_hash,
       cover_ext = excluded.cover_ext,
       updated_at = excluded.updated_at`
  )

  // 父目录没有自己的封面时继承子目录的（自底向上冒泡）。
  // 必须连「自己带封面」的目录一起往上推，否则只有叶子能贡献封面。
  const inherited = new Map<string, { hash: string; ext: string }>()
  for (const path of byDepthDesc) {
    const cover = ownCover.get(path) ?? inherited.get(path)
    if (!cover) continue
    const parent = trimTrailingSlash(parentOf(path))
    if (!parent || !nodes.has(parent)) continue
    if (ownCover.has(parent) || inherited.has(parent)) continue
    inherited.set(parent, cover)
  }

  for (const [path, node] of nodes) {
    const parent = trimTrailingSlash(parentOf(path))
    const cover = ownCover.get(path) ?? inherited.get(path)
    upsert.run(
      path,
      parent && nodes.has(parent) ? parent : null,
      baseName(path) || path,
      node.root,
      depthOf(path, node.root),
      node.own,
      subtree.get(path) ?? node.own,
      cover?.hash ?? null,
      cover?.ext ?? null,
      now
    )
  }

  // 删除已消失的目录
  let removed = 0
  const del = conn.prepare('DELETE FROM folders WHERE id = ?')
  for (const [path, row] of existing) {
    if (nodes.has(path)) continue
    del.run(row.id)
    removed++
  }

  return { folders: nodes.size, removed }
}

/** 文件夹总数（统计页/首页用） */
export function countFolders(conn: DbConnection): number {
  const row = conn.prepare('SELECT COUNT(*) AS c FROM folders').get() as { c?: number } | undefined
  return Number(row?.c) || 0
}
