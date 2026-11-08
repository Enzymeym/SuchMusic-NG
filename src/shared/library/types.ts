/**
 * 本地曲库的跨进程数据契约。
 *
 * 这里的类型同时被三处使用，任何字段改动都要三边一致：
 * - 主进程（SQLite 行 ⇄ 对象）
 * - scanner utilityProcess（扫描产物）
 * - 渲染进程（列表 / 分组 / 搜索）
 *
 * 约定：`id` 是「归一化路径键」（见 main/services/library/paths.ts），
 * 用于去重与主键；`filePath` 是真实 OS 路径，用于播放与文件操作。
 */

/** 单曲元数据（扫描阶段产出的、与路径无关的部分） */
export interface LibraryTrackMeta {
  /** 含扩展名的文件名，搜索时按文件名匹配用 */
  fileName: string
  title: string
  artists: string[]
  album: string
  albumArtist?: string
  trackNo?: number
  discNo?: number
  year?: number
  genre?: string
  durationMs?: number
  /** bps，音乐标签里通常是平均码率 */
  bitrate?: number
  sampleRate?: number
  /** 采样精度（位深），无损格式才有意义 */
  bitsPerSample?: number
  channels?: number
  /** 容器/编码格式，如 FLAC / MP3 / ALAC */
  codec?: string
  /** 封面内容哈希（sha1 前 16 位），空表示无封面 */
  coverHash?: string
  /** 封面扩展名（不含点），如 jpg / png / webp */
  coverExt?: string
  /** 是否存在歌词（同名 .lrc 或内嵌） */
  hasLyrics: boolean
}

/** 扫描器交给主进程的一条完整记录 */
export interface ScannedTrack extends LibraryTrackMeta {
  filePath: string
  /** 所在目录（Posix 分隔符） */
  folderPath: string
  /** 命中的扫描根 */
  rootPath: string
  /** 相对扫描根的目录，空串表示就在根下 */
  relDir: string
  size: number
  mtimeMs: number
}

/** 落库后的曲目 */
export interface LibraryTrack extends ScannedTrack {
  id: string
  updatedAt: number
}

/** 文件夹（同时充当「文件夹歌单」） */
export interface LibraryFolder {
  id: number
  path: string
  parentPath: string | null
  /** 磁盘上的目录名 */
  name: string
  /** 展示名：alias ?? name */
  displayName: string
  rootPath: string
  depth: number
  /** 直接位于该目录的曲目数 */
  trackCount: number
  /** 含所有子目录的曲目数 */
  totalTrackCount: number
  coverHash?: string
  coverExt?: string
  pinned: boolean
  hidden: boolean
  sortOrder: number
}

export type ScanPhase = 'walk' | 'tags' | 'finalize'

export interface ScanProgress {
  phase: ScanPhase
  /** 已遍历到的音频文件数 */
  scanned: number
  /** 已读取标签的文件数 */
  tagged: number
  /** 发现的需要读标签的文件总数（walk 完成后才有值） */
  total?: number
  /** 当前处理的路径，仅用于进度提示 */
  currentPath?: string
}

export interface ScanStats {
  scanned: number
  added: number
  updated: number
  unchanged: number
  removed: number
  errors: number
  durationMs: number
}

export interface LibraryBootstrap {
  tracks: LibraryTrack[]
  folders: LibraryFolder[]
  stats: ScanStats | null
  scanning: boolean
  /** 上次扫描完成时间（epoch ms），从未扫描过为 0 */
  lastScanAt: number
  /** SQLite 不可用时的降级原因，非空表示曲库功能不可用 */
  unavailableReason?: string
}

/** 文件夹曲目分页查询参数 */
export interface FolderTracksQuery {
  folderId: number
  limit?: number
  offset?: number
  /** true=含子目录 */
  includeSubfolders?: boolean
}

export interface FolderPatch {
  alias?: string | null
  pinned?: boolean
  hidden?: boolean
  sortOrder?: number
}

/** 扫描器 → 主进程的消息 */
export type ScannerMessage =
  | { type: 'ready' }
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'track-batch'; items: ScannedTrack[] }
  | {
      type: 'done'
      /** 库里存在、但本次扫描没再遇到的曲目 id（已被删除/移出扫描根） */
      deletedIds: string[]
      scanned: number
      added: number
      unchanged: number
      errors: number
      durationMs: number
    }
  | { type: 'error'; message: string; filePath?: string }

/** 主进程 → 扫描器的消息 */
export interface ScannerInitPayload {
  roots: string[]
  /** 归一化后的绝对路径 → [size, mtimeMs] */
  known: Array<[string, number, number]>
  /** music_tag_reader.node 的绝对路径，空串表示走纯 JS 链路 */
  nativePath: string
  coversDir: string
  /** 标签批读的并发上限 */
  concurrency: number
  /** 单批回传条数 */
  batchSize: number
}

export type ScannerCommand =
  | { type: 'init'; payload: ScannerInitPayload }
  | { type: 'cancel' }
