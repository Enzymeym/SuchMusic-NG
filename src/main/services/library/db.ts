/**
 * 曲库的 SQLite 连接层。
 *
 * 设计要点：
 * 1. **只有主进程打开数据库**。scanner 子进程不碰 SQLite —— 两个进程同时写
 *    同一个库会遇到 WAL 锁竞争与 `SQLITE_BUSY`，而写操作本来就要集中在
 *    主进程做「批事务 + 差集删除」。
 * 2. **驱动用 `require` 懒加载**，且自带最小类型声明。原因是 `better-sqlite3`
 *    不自带 `.d.ts`（要额外装 @types），而这里只用到 5 个方法；同时懒加载让
 *    「驱动缺失 / ABI 不匹配」变成一条可读的降级原因，而不是启动即崩。
 * 3. 迁移用 `PRAGMA user_version`，每次启动顺序执行未应用的版本。
 */
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DbStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint }
  all(...params: any[]): any[]
  get(...params: any[]): any
}

export interface DbConnection {
  prepare(sql: string): DbStatement
  exec(sql: string): void
  pragma(source: string, options?: { simple?: boolean }): any
  transaction<F extends (...args: any[]) => any>(fn: F): F
  close(): void
  readonly open: boolean
}

interface DbOptions {
  readonly?: boolean
  fileMustExist?: boolean
  nativeBinding?: string
}

interface DbConstructor {
  new (filename: string, options?: DbOptions): DbConnection
}

export const SCHEMA_VERSION = 1

let db: DbConnection | null = null
let unavailableReason = ''

/**
 * 优先使用随包分发的原生二进制。
 *
 * better-sqlite3 的 `lib/binding.js` 支持 `nativeBinding` 字符串路径，
 * 命中 `resources/native/better_sqlite3.node` 时优先用它 —— 这条路径与项目里
 * 其它原生模块（audio_napi / music_tag_reader）的交付方式一致，打包后
 * `extraResources` 会自动带上，不需要改 electron-builder 的 filter。
 */
function resolveNativeBinding(): string | undefined {
  try {
    if (!process.resourcesPath) return undefined
    const candidate = join(process.resourcesPath, 'native', 'better_sqlite3.node')
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

/** 数据库文件路径（必须在 `app.name` 设置之后调用，所以是函数而非常量） */
export function libraryDbPath(): string {
  return join(app.getPath('userData'), 'library', 'library.db')
}

function loadDriver(): DbConstructor {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('better-sqlite3')
  const Ctor = (mod?.default ?? mod) as DbConstructor
  if (typeof Ctor !== 'function') {
    throw new Error('better-sqlite3 导出不是构造函数')
  }
  return Ctor
}

const MIGRATIONS: Array<{ version: number; up: (conn: DbConnection) => void }> = [
  {
    version: 1,
    up: (conn) => {
      conn.exec(`
        CREATE TABLE IF NOT EXISTS tracks (
          id             TEXT PRIMARY KEY,
          file_path      TEXT NOT NULL,
          file_name      TEXT NOT NULL,
          folder_path    TEXT NOT NULL,
          root_path      TEXT NOT NULL,
          rel_dir        TEXT NOT NULL DEFAULT '',
          title          TEXT NOT NULL DEFAULT '',
          artists        TEXT NOT NULL DEFAULT '[]',
          artist_sort    TEXT NOT NULL DEFAULT '',
          album          TEXT NOT NULL DEFAULT '',
          album_artist   TEXT,
          track_no       INTEGER,
          disc_no        INTEGER,
          year           INTEGER,
          genre          TEXT,
          duration_ms    INTEGER,
          bitrate        INTEGER,
          sample_rate    INTEGER,
          bits_per_sample INTEGER,
          channels       INTEGER,
          codec          TEXT,
          size           INTEGER NOT NULL DEFAULT 0,
          mtime_ms       INTEGER NOT NULL DEFAULT 0,
          cover_hash     TEXT,
          cover_ext      TEXT,
          has_lyrics     INTEGER NOT NULL DEFAULT 0,
          updated_at     INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_path ON tracks(file_path);
        CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder_path);
        CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_sort);
        CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
        CREATE INDEX IF NOT EXISTS idx_tracks_mtime ON tracks(mtime_ms);

        CREATE TABLE IF NOT EXISTS folders (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          path              TEXT NOT NULL UNIQUE,
          parent_path       TEXT,
          name              TEXT NOT NULL,
          root_path         TEXT NOT NULL,
          depth             INTEGER NOT NULL DEFAULT 0,
          track_count       INTEGER NOT NULL DEFAULT 0,
          total_track_count INTEGER NOT NULL DEFAULT 0,
          cover_hash        TEXT,
          cover_ext         TEXT,
          pinned            INTEGER NOT NULL DEFAULT 0,
          hidden            INTEGER NOT NULL DEFAULT 0,
          alias             TEXT,
          sort_order        INTEGER NOT NULL DEFAULT 0,
          updated_at        INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_path);

        CREATE TABLE IF NOT EXISTS library_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)
    }
  }
]

function migrate(conn: DbConnection): void {
  const row = conn.pragma('user_version', { simple: true }) as number
  const current = typeof row === 'number' ? row : 0
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    const run = conn.transaction(() => {
      migration.up(conn)
      conn.pragma(`user_version = ${migration.version}`)
    })
    run()
    console.log(`[library] 数据库迁移到 v${migration.version}`)
  }
}

/**
 * 打开曲库数据库（幂等）。
 *
 * 失败时不抛异常，把原因记在 `unavailableReason` 里，由 UI 显示
 * 「曲库不可用」而不是整块功能静默消失。
 */
export function openLibrary(): DbConnection | null {
  if (db) return db
  if (unavailableReason) return null
  try {
    const file = libraryDbPath()
    mkdirSync(dirname(file), { recursive: true })
    const Ctor = loadDriver()
    const nativeBinding = resolveNativeBinding()
    db = new Ctor(file, {
      fileMustExist: false,
      ...(nativeBinding ? { nativeBinding } : {})
    })
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    migrate(db)
    console.log(`[library] 数据库就绪：${file}`)
    return db
  } catch (error) {
    unavailableReason =
      error instanceof Error ? error.message : String(error ?? '未知错误')
    console.error('[library] 数据库不可用:', error)
    db = null
    return null
  }
}

export function getLibraryDb(): DbConnection | null {
  return db ?? openLibrary()
}

export function getLibraryUnavailableReason(): string {
  return unavailableReason
}

export function isLibraryAvailable(): boolean {
  return getLibraryDb() !== null
}

export function closeLibrary(): void {
  try {
    if (db?.open) db.close()
  } catch (error) {
    console.warn('[library] 关闭数据库失败:', error)
  }
  db = null
}

/** 读/写 library_meta 里的字符串键值 */
export function getMeta(conn: DbConnection, key: string): string | undefined {
  const row = conn.prepare('SELECT value FROM library_meta WHERE key = ?').get(key) as
    | { value?: string }
    | undefined
  return row?.value
}

export function setMeta(conn: DbConnection, key: string, value: string): void {
  conn
    .prepare(
      'INSERT INTO library_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}
