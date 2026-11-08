/**
 * tracks 表的读写。
 *
 * 所有写操作都走「预编译语句 + 外部事务」：调用方（scanService）负责把
 * 500~1000 行包成一个事务，这里只提供单条 / 批量执行原语，避免仓库层
 * 自己决定事务边界导致嵌套。
 */
import type { LibraryTrack, ScannedTrack } from '../../../shared/library/types'
import { pathKey } from '../../../shared/library/normalize'
import type { DbConnection } from './db'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface TrackRow {
  id: string
  file_path: string
  file_name: string
  folder_path: string
  root_path: string
  rel_dir: string
  title: string
  artists: string
  artist_sort: string
  album: string
  album_artist: string | null
  track_no: number | null
  disc_no: number | null
  year: number | null
  genre: string | null
  duration_ms: number | null
  bitrate: number | null
  sample_rate: number | null
  bits_per_sample: number | null
  channels: number | null
  codec: string | null
  size: number
  mtime_ms: number
  cover_hash: string | null
  cover_ext: string | null
  has_lyrics: number
  updated_at: number
}

function parseArtists(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map((v) => String(v ?? '').trim()).filter((v) => v.length > 0)
    }
  } catch {
    // 历史脏数据：退回按逗号拆
  }
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function rowToTrack(row: TrackRow): LibraryTrack {
  return {
    id: row.id,
    filePath: row.file_path,
    fileName: row.file_name,
    folderPath: row.folder_path,
    rootPath: row.root_path,
    relDir: row.rel_dir,
    title: row.title || row.file_name,
    artists: parseArtists(row.artists),
    album: row.album ?? '',
    albumArtist: row.album_artist ?? undefined,
    trackNo: row.track_no ?? undefined,
    discNo: row.disc_no ?? undefined,
    year: row.year ?? undefined,
    genre: row.genre ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    bitrate: row.bitrate ?? undefined,
    sampleRate: row.sample_rate ?? undefined,
    bitsPerSample: row.bits_per_sample ?? undefined,
    channels: row.channels ?? undefined,
    codec: row.codec ?? undefined,
    coverHash: row.cover_hash ?? undefined,
    coverExt: row.cover_ext ?? undefined,
    size: row.size,
    mtimeMs: row.mtime_ms,
    hasLyrics: row.has_lyrics === 1,
    updatedAt: row.updated_at
  }
}

/** 曲库内所有曲目，按目录 + 文件名排序（列表默认顺序即目录顺序，便于浏览） */
export function listAllTracks(conn: DbConnection): LibraryTrack[] {
  const rows = conn
    .prepare(
      `SELECT * FROM tracks ORDER BY folder_path COLLATE NOCASE, file_name COLLATE NOCASE`
    )
    .all() as TrackRow[]
  return rows.map(rowToTrack)
}

export function getKnownFiles(conn: DbConnection): Array<[string, number, number]> {
  const rows = conn.prepare('SELECT id, size, mtime_ms FROM tracks').all() as Array<{
    id: string
    size: number
    mtime_ms: number
  }>
  return rows.map((r) => [r.id, Number(r.size) || 0, Number(r.mtime_ms) || 0])
}

export function countTracks(conn: DbConnection): number {
  const row = conn.prepare('SELECT COUNT(*) AS c FROM tracks').get() as { c?: number } | undefined
  return Number(row?.c) || 0
}

function bindRow(track: ScannedTrack, id: string, now: number): any[] {
  const artistSort = (track.artists[0] || '').trim()
  return [
    id,
    track.filePath,
    track.fileName,
    track.folderPath,
    track.rootPath,
    track.relDir,
    track.title || track.fileName,
    JSON.stringify(track.artists),
    artistSort,
    track.album || '',
    track.albumArtist ?? null,
    track.trackNo ?? null,
    track.discNo ?? null,
    track.year ?? null,
    track.genre ?? null,
    track.durationMs ?? null,
    track.bitrate ?? null,
    track.sampleRate ?? null,
    track.bitsPerSample ?? null,
    track.channels ?? null,
    track.codec ?? null,
    track.size,
    track.mtimeMs,
    track.coverHash ?? null,
    track.coverExt ?? null,
    track.hasLyrics ? 1 : 0,
    now
  ]
}

const UPSERT_SQL = `
INSERT INTO tracks (
  id, file_path, file_name, folder_path, root_path, rel_dir,
  title, artists, artist_sort, album, album_artist,
  track_no, disc_no, year, genre,
  duration_ms, bitrate, sample_rate, bits_per_sample, channels, codec,
  size, mtime_ms, cover_hash, cover_ext, has_lyrics, updated_at
) VALUES (
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?
)
ON CONFLICT(id) DO UPDATE SET
  file_path = excluded.file_path,
  file_name = excluded.file_name,
  folder_path = excluded.folder_path,
  root_path = excluded.root_path,
  rel_dir = excluded.rel_dir,
  title = excluded.title,
  artists = excluded.artists,
  artist_sort = excluded.artist_sort,
  album = excluded.album,
  album_artist = excluded.album_artist,
  track_no = excluded.track_no,
  disc_no = excluded.disc_no,
  year = excluded.year,
  genre = excluded.genre,
  duration_ms = excluded.duration_ms,
  bitrate = excluded.bitrate,
  sample_rate = excluded.sample_rate,
  bits_per_sample = excluded.bits_per_sample,
  channels = excluded.channels,
  codec = excluded.codec,
  size = excluded.size,
  mtime_ms = excluded.mtime_ms,
  cover_hash = excluded.cover_hash,
  cover_ext = excluded.cover_ext,
  has_lyrics = excluded.has_lyrics,
  updated_at = excluded.updated_at
`

/**
 * 批量写入（必须在调用方的事务内执行）。
 * @returns 新增 / 更新条数
 */
export function upsertTracks(
  conn: DbConnection,
  tracks: ScannedTrack[],
  now: number
): { added: number; updated: number } {
  if (tracks.length === 0) return { added: 0, updated: 0 }
  const upsert = conn.prepare(UPSERT_SQL)
  const exists = conn.prepare('SELECT 1 AS hit FROM tracks WHERE id = ?')
  let added = 0
  let updated = 0
  for (const track of tracks) {
    const id = pathKey(track.filePath)
    if (exists.get(id)) updated++
    else added++
    upsert.run(...bindRow(track, id, now))
  }
  return { added, updated }
}

/** 按 id 分批删除（SQLite 单语句参数上限 999，这里固定 500 一批） */
export function deleteTracksByIds(conn: DbConnection, ids: string[]): number {
  if (ids.length === 0) return 0
  const stmt = conn.prepare('DELETE FROM tracks WHERE id = ?')
  let removed = 0
  for (const id of ids) {
    const res = stmt.run(id)
    removed += Number(res.changes) || 0
  }
  return removed
}

/**
 * LIKE 模式里的特殊字符必须转义。
 *
 * 目录名常含 `_`（如 `Rock_Band`），而 `_` 在 LIKE 里匹配任意单字符，
 * 不转义就会让 `a_b` 把 `axb` 的曲目一起捞出来。
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** 文件夹（含子目录）里的曲目分页 */
export function listTracksInFolder(
  conn: DbConnection,
  folderPath: string,
  options: { includeSubfolders?: boolean; limit?: number; offset?: number } = {}
): LibraryTrack[] {
  const limit = Math.min(Math.max(options.limit ?? 5000, 1), 10000)
  const offset = Math.max(options.offset ?? 0, 0)
  let rows: TrackRow[]
  if (options.includeSubfolders) {
    // 前缀匹配：`/music/` 命中 `/music/a` 但不命中 `/music2`
    rows = conn
      .prepare(
        `SELECT * FROM tracks
         WHERE folder_path = ? OR folder_path LIKE ? ESCAPE '\\'
         ORDER BY folder_path COLLATE NOCASE, file_name COLLATE NOCASE
         LIMIT ? OFFSET ?`
      )
      .all(folderPath, `${escapeLike(folderPath)}/%`, limit, offset) as TrackRow[]
  } else {
    rows = conn
      .prepare(
        `SELECT * FROM tracks WHERE folder_path = ?
         ORDER BY file_name COLLATE NOCASE
         LIMIT ? OFFSET ?`
      )
      .all(folderPath, limit, offset) as TrackRow[]
  }
  return rows.map(rowToTrack)
}

/** 按路径批量重新读取（标签编辑后刷新用） */
export function listTracksByPaths(conn: DbConnection, filePaths: string[]): LibraryTrack[] {
  if (filePaths.length === 0) return []
  const stmt = conn.prepare('SELECT * FROM tracks WHERE id = ?')
  const out: LibraryTrack[] = []
  for (const p of filePaths) {
    const row = stmt.get(pathKey(p)) as TrackRow | undefined
    if (row) out.push(rowToTrack(row))
  }
  return out
}

export function deleteTracksByPaths(conn: DbConnection, filePaths: string[]): number {
  return deleteTracksByIds(
    conn,
    filePaths.map((p) => pathKey(p))
  )
}

/** 曲库引用的所有封面哈希（孤儿封面 GC 用） */
export function listReferencedCoverHashes(conn: DbConnection): Set<string> {
  const rows = conn
    .prepare("SELECT DISTINCT cover_hash FROM tracks WHERE cover_hash IS NOT NULL AND cover_hash <> ''")
    .all() as Array<{ cover_hash: string }>
  return new Set(rows.map((r) => r.cover_hash))
}

/** 全部曲目路径键（差集删除用，比拿整行便宜） */
export function listAllTrackIds(conn: DbConnection): string[] {
  const rows = conn.prepare('SELECT id FROM tracks').all() as Array<{ id: string }>
  return rows.map((r) => r.id)
}
