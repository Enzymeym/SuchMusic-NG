import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSettingsStore } from './settingsStore'
import { usePlayerStore } from './playerStore'
import { usePlaylistStore } from './playlistStore'
import { toLocalSongs } from '../utils/libraryAdapter'
import { coverUrl } from '../../../shared/library/channels'
import type {
  LibraryFolder,
  LibraryTrack,
  ScanProgress,
  ScanStats
} from '../../../shared/library/types'

/**
 * 本地曲库 store。
 *
 * 数据来源已从「扫描时只读文件名 + 渲染层逐首 IPC 补元数据」换成
 * 「主进程 SQLite 曲库」。对外 API 保持兼容（songs / artistList / albumList /
 * scanMusic / getLyrics / loadFullCover），因为十几个组件依赖这个形状；
 * 变的是内部：一次性拿到完整字段、封面走 such-cover:// 协议、不再有 fillMeta。
 */

/** 分组 getter 的版本号：扫描/重载后 +1，让分组缓存失效 */
const metaVersion = ref(0)

const bumpVersion = (): void => {
  metaVersion.value++
}

/** 文件夹歌单排序：固定优先 → 手动顺序 → 层级 → 名称 */
function sortFolders(folders: LibraryFolder[]): LibraryFolder[] {
  return [...folders]
    .filter((f) => !f.hidden)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (a.pinned && b.pinned) return a.sortOrder - b.sortOrder
      if (a.depth !== b.depth) return a.depth - b.depth
      return a.displayName.localeCompare(b.displayName, 'zh-Hans-CN')
    })
}

interface GroupFingerprint {
  version: number
  songsRef: unknown
  songCount: number
  historyRef: unknown
  historyLen: number
  historyHeadTs: number | undefined
}

interface GroupCacheEntry<T> extends GroupFingerprint {
  value: T[]
}

let artistCache: GroupCacheEntry<any> | null = null
let albumCache: GroupCacheEntry<any> | null = null

function buildFingerprint(songs: unknown[], history: Array<{ timestamp?: number }>): GroupFingerprint {
  return {
    version: metaVersion.value,
    songsRef: songs,
    songCount: songs.length,
    historyRef: history,
    historyLen: history.length,
    historyHeadTs: history[0]?.timestamp
  }
}

function isCacheHit(cache: GroupCacheEntry<any> | null, fp: GroupFingerprint): boolean {
  return (
    !!cache &&
    cache.version === fp.version &&
    cache.songsRef === fp.songsRef &&
    cache.songCount === fp.songCount &&
    cache.historyRef === fp.historyRef &&
    cache.historyLen === fp.historyLen &&
    cache.historyHeadTs === fp.historyHeadTs
  )
}

/**
 * 歌词缓存（模块级、非响应式）。
 * 曲库扫描不再预读歌词 —— 只有真正播放过的歌词才值得驻留内存。
 */
const LYRICS_CACHE_MAX = 120
const lyricsCache = new Map<string, string>()

function lyricsKeyOf(song: { id?: string | number; filePath?: string }): string {
  return song.filePath || `id:${String(song.id)}`
}

export function clearLocalLyricsCache(): void {
  lyricsCache.clear()
}

function setLyricsCacheEntry(key: string, text: string): void {
  if (!text) return
  lyricsCache.delete(key)
  lyricsCache.set(key, text)
  while (lyricsCache.size > LYRICS_CACHE_MAX) {
    const oldest = lyricsCache.keys().next().value
    if (oldest === undefined) break
    lyricsCache.delete(oldest)
  }
}

function getLyricsCache(key: string): string | undefined {
  const value = lyricsCache.get(key)
  if (value === undefined) return undefined
  lyricsCache.delete(key)
  lyricsCache.set(key, value)
  return value
}

export interface LocalSong {
  id: number | string
  name: string
  al?: { name: string; picUrl?: string }
  ar?: { name: string }[]
  filePath?: string
  dt?: number
  /** 头像/封面：such-cover:// 协议 URL（缩略图） */
  picUrl?: string
  thumbUrl?: string
  lyrics?: string
  quality?: string
  bitrate?: number
  sampleRate?: number
  /** 采样精度（位深） */
  bitsPerSample?: number
  channels?: number
  codec?: string
  fileName?: string
  folderPath?: string
  coverHash?: string
  /** 封面扩展名（不含点），拼原图 URL 用 */
  coverExt?: string
  year?: number
  trackNo?: number
  [key: string]: any
}

interface LocalMusicState {
  songs: LocalSong[]
  folders: LibraryFolder[]
  loading: boolean
  /** 兼容旧调用方：新链路没有「逐首补元数据」阶段，恒为 false */
  fillingMeta: boolean
  scanning: boolean
  scanProgress: ScanProgress | null
  lastStats: ScanStats | null
  lastScanAt: number
  /** 非空表示曲库不可用（数据库驱动缺失 / ABI 不匹配），UI 应展示原因 */
  unavailableReason: string
  /** 是否已经完成过首次从库里加载 */
  bootstrapped: boolean
}

/** 聚合列表中的单曲结构（歌手/专辑分组共用） */
interface GroupedTrack {
  id: string | number
  title: string
  artist: string
  cover: string
  album?: string
  filePath?: string
  durationMs?: number
  year?: number
}

function buildTrack(
  song: {
    id: string | number
    name?: string
    title?: string
    picUrl?: string
    cover?: string
    al?: { name?: string; picUrl?: string }
    album?: string
    filePath?: string
    dt?: number
  },
  artistName: string
): GroupedTrack {
  return {
    id: song.id,
    title: song.title ?? song.name ?? '',
    artist: artistName,
    cover: song.cover ?? song.picUrl ?? song.al?.picUrl ?? '',
    album: song.album ?? song.al?.name,
    filePath: song.filePath,
    durationMs: song.dt
  }
}

function upsertTrack<T extends { songs: GroupedTrack[] }>(
  groups: Map<string, T>,
  seen: Map<string, number>,
  groupName: string,
  track: GroupedTrack
): void {
  const key = `${groupName}\u0000${track.id}`
  if (seen.has(key)) return
  const songs = groups.get(groupName)!.songs
  seen.set(key, songs.length)
  songs.push(track)
}

/** 扫描结束的等待者：scanMusic() 需要等一次完整扫描再返回 */
let scanDoneWaiters: Array<(ok: boolean) => void> = []
/** 每次收到 scan-done 自增，用来识别「扫描在 invoke 返回前就结束了」的竞态 */
let scanTick = 0
let listenersBound = false

function hasLibraryApi(): boolean {
  return typeof window !== 'undefined' && !!window.api?.library
}

export const useLocalMusicStore = defineStore('localMusic', {
  state: (): LocalMusicState => ({
    songs: [],
    folders: [],
    loading: false,
    fillingMeta: false,
    scanning: false,
    scanProgress: null,
    lastStats: null,
    lastScanAt: 0,
    unavailableReason: '',
    bootstrapped: false
  }),

  getters: {
    /** 按歌手聚合的音乐列表，利用 Pinia getter 缓存避免 SingerView 每次 computed 重建 Map */
    artistList(state) {
      const playerStore = usePlayerStore()
      const fingerprint = buildFingerprint(state.songs, playerStore.playHistory)
      if (isCacheHit(artistCache, fingerprint)) return artistCache!.value

      const groups = new Map<
        string,
        { name: string; cover: string; playCount: number; songCount: number; songs: GroupedTrack[] }
      >()
      const seen = new Map<string, number>()

      const ensureGroup = (name: string) => {
        let group = groups.get(name)
        if (!group) {
          group = { name, cover: '', playCount: 0, songCount: 0, songs: [] }
          groups.set(name, group)
        }
        return group
      }

      state.songs.forEach((song) => {
        const artistName = song.ar?.[0]?.name || '未知歌手'
        const group = ensureGroup(artistName)
        if (!group.cover && song.picUrl) group.cover = song.picUrl
        if (!group.cover && song.al?.picUrl) group.cover = song.al.picUrl
        upsertTrack(groups, seen, artistName, buildTrack(song, artistName))
      })

      playerStore.playHistory.forEach((record) => {
        const artistName = record.artist || '未知歌手'
        const group = ensureGroup(artistName)
        group.playCount++
        if (!group.cover && record.cover) group.cover = record.cover
        upsertTrack(
          groups,
          seen,
          artistName,
          buildTrack(
            {
              id: record.songId,
              title: record.title,
              cover: record.cover,
              album: record.album,
              filePath: record.filePath
            },
            artistName
          )
        )
      })

      for (const group of groups.values()) {
        group.songCount = group.songs.length
        if (group.songs.length > 0) {
          group.cover = group.songs.find((s) => s.cover)?.cover || group.cover
        }
      }
      const value = Array.from(groups.values())
      artistCache = { ...fingerprint, value }
      return value
    },

    /** 按专辑聚合的音乐列表 */
    albumList(state) {
      const playerStore = usePlayerStore()
      const fingerprint = buildFingerprint(state.songs, playerStore.playHistory)
      if (isCacheHit(albumCache, fingerprint)) return albumCache!.value

      const groups = new Map<
        string,
        { name: string; artist: string; cover: string; playCount: number; songs: GroupedTrack[] }
      >()
      const seen = new Map<string, number>()

      const ensureGroup = (name: string, artist: string) => {
        let group = groups.get(name)
        if (!group) {
          group = { name, artist, cover: '', playCount: 0, songs: [] }
          groups.set(name, group)
        }
        return group
      }

      state.songs.forEach((song) => {
        const albumName = song.al?.name || '未知专辑'
        const artist = song.ar?.[0]?.name || '未知歌手'
        const group = ensureGroup(albumName, artist)
        if (!group.cover && song.picUrl) group.cover = song.picUrl
        if (!group.cover && song.al?.picUrl) group.cover = song.al.picUrl

        const track = buildTrack(song, artist)
        const year =
          (song as any).year ??
          ((song as any).publishTime ? new Date((song as any).publishTime).getFullYear() : undefined)
        if (year !== undefined) track.year = year
        upsertTrack(groups, seen, albumName, track)
      })

      playerStore.playHistory.forEach((record) => {
        const albumName = record.album || '未知专辑'
        const artist = record.artist || '未知歌手'
        const group = ensureGroup(albumName, artist)
        group.playCount++
        if (!group.cover && record.cover) group.cover = record.cover
        upsertTrack(
          groups,
          seen,
          albumName,
          buildTrack(
            {
              id: record.songId,
              title: record.title,
              cover: record.cover,
              album: record.album,
              filePath: record.filePath
            },
            artist
          )
        )
      })

      const value = Array.from(groups.values())
      albumCache = { ...fingerprint, value }
      return value
    },

    /**
     * 文件夹歌单列表：隐藏的过滤掉，固定的排前面，其余按目录层次 + 名称。
     * 返回给 PlaylistView 直接渲染，不需要页面自己再排序。
     */
    folderList(state): LibraryFolder[] {
      return sortFolders(state.folders)
    },

    /** 有曲目的文件夹（空目录不生成歌单卡片） */
    folderPlaylists(state): LibraryFolder[] {
      return sortFolders(state.folders).filter((f) => f.totalTrackCount > 0)
    }
  },

  actions: {
    /** 绑定主进程推送（只绑一次） */
    ensureListeners() {
      if (listenersBound || !hasLibraryApi()) return
      listenersBound = true

      window.api.library.onScanProgress((progress: ScanProgress) => {
        this.scanning = true
        this.scanProgress = progress
      })

      window.api.library.onScanDone((event) => {
        scanTick++
        this.scanning = false
        this.scanProgress = null
        if (event?.stats) this.lastStats = event.stats
        if (event?.lastScanAt) this.lastScanAt = event.lastScanAt
        if (event?.ok) {
          void this.loadFromLibrary()
        }
        const waiters = scanDoneWaiters
        scanDoneWaiters = []
        waiters.forEach((resolve) => resolve(!!event?.ok))
      })
    },
    /** 首次进入时从库里读取（秒级，不触发扫描） */
    async bootstrap() {
      if (this.bootstrapped) return
      if (!hasLibraryApi()) {
        this.unavailableReason = '曲库接口不可用（preload 未更新）'
        return
      }
      this.ensureListeners()
      this.loading = true
      try {
        const data = await window.api.library.bootstrap()
        this.applyBootstrap(data)
        this.bootstrapped = true
      } catch (error) {
        console.error('加载曲库失败', error)
        this.unavailableReason = '读取曲库失败'
      } finally {
        this.loading = false
      }
    },

    /** 从库里重新读一遍（扫描完成后调用） */
    async loadFromLibrary() {
      if (!hasLibraryApi()) return
      try {
        const data = await window.api.library.bootstrap()
        this.applyBootstrap(data)
      } catch (error) {
        console.error('刷新曲库失败', error)
      }
    },

    applyBootstrap(data: {
      tracks: LibraryTrack[]
      folders: LibraryFolder[]
      stats: ScanStats | null
      scanning: boolean
      lastScanAt: number
      unavailableReason?: string
    }) {
      this.revokeCovers()
      this.songs = toLocalSongs(data.tracks || [])
      this.folders = data.folders || []
      this.lastStats = data.stats ?? this.lastStats
      this.lastScanAt = data.lastScanAt || this.lastScanAt
      this.scanning = !!data.scanning
      this.unavailableReason = data.unavailableReason || ''
      bumpVersion()

      // 封面是稳定 URL，歌单/播放器里缓存的旧封面可以就地刷新
      if (this.songs.length > 0) {
        const playerStore = usePlayerStore()
        const playlistStore = usePlaylistStore()
        playerStore.restoreCoversFromLocalSongs(this.songs)
        playlistStore.restoreCoversFromLocalSongs(this.songs)
      }
    },

    /**
     * 扫描本地音乐（保持旧语义：await 结束时曲库已更新）。
     *
     * 首次调用会先把库里已有的曲目读出来（首屏不等扫描），随后触发一次
     * 增量扫描：mtime + size 没变的文件不会重新读标签，热扫千首在秒级。
     */
    async scanMusic() {
      if (!hasLibraryApi()) {
        this.unavailableReason = '曲库接口不可用（preload 未更新）'
        return
      }
      this.ensureListeners()
      await this.bootstrap()
      if (this.scanning) return

      const settingsStore = useSettingsStore()
      const rawDirs = settingsStore.local.scanDirs
      const dirs = Array.isArray(rawDirs) ? [...rawDirs].filter((d) => !!d) : []

      const tickBefore = scanTick
      let settle: ((ok: boolean) => void) | null = null
      const done = new Promise<boolean>((resolve) => {
        settle = resolve
        scanDoneWaiters.push(resolve)
      })

      this.scanning = true
      try {
        const result = await window.api.library.scan(dirs.length > 0 ? dirs : undefined)
        if (!result?.started) {
          // 已有扫描在跑，或数据库不可用（后者主进程已推 scan-done）
          scanDoneWaiters = scanDoneWaiters.filter((w) => w !== settle)
          return
        }
        // 库里没有变化时子进程可能在本次 invoke 返回前就结束了，
        // 那时 waiter 还没入队，直接判定已完成，否则 await 会永远挂住
        if (scanTick !== tickBefore) return
        await done
      } catch (error) {
        console.error('扫描本地音乐失败', error)
        this.scanning = false
        throw error
      }
    },

    async cancelScan() {
      if (!hasLibraryApi()) return
      try {
        await window.api.library.cancelScan()
      } catch (error) {
        console.warn('取消扫描失败', error)
      }
    },

    /** 标签编辑后重读指定文件，并同步内存里的曲目 */
    async reloadTracks(filePaths: string[]) {
      if (!hasLibraryApi() || filePaths.length === 0) return
      try {
        await window.api.library.reloadTracks(filePaths)
        await this.loadFromLibrary()
      } catch (error) {
        console.warn('重读标签失败', error)
      }
    },

    /** 某个文件夹下的曲目（从库里分页取，不占内存） */
    async getFolderTracks(
      folderId: number,
      options: { includeSubfolders?: boolean; limit?: number; offset?: number } = {}
    ): Promise<LocalSong[]> {
      if (!hasLibraryApi()) return []
      const tracks = await window.api.library.folderTracks(folderId, options)
      return toLocalSongs(tracks)
    },

    async updateFolder(
      folderId: number,
      patch: { alias?: string | null; pinned?: boolean; hidden?: boolean }
    ): Promise<LibraryFolder | null> {
      if (!hasLibraryApi()) return null
      const updated = await window.api.library.updateFolder(folderId, patch)
      if (updated) {
        const idx = this.folders.findIndex((f) => f.id === updated.id)
        if (idx >= 0) this.folders.splice(idx, 1, updated)
        else this.folders.push(updated)
      }
      return updated
    },

    async revealInFolder(filePath: string): Promise<void> {
      if (!hasLibraryApi()) return
      await window.api.library.reveal(filePath)
    },

    /**
     * 释放旧实现创建的 Blob URL。
     * 曲库封面现在是 such-cover:// 协议 URL，不需要释放；这里只兜底处理
     * 歌单/搜索结果里遗留的 blob: 封面。
     */
    revokeCovers(): void {
      this.songs.forEach((song) => {
        if (song.picUrl && song.picUrl.startsWith('blob:')) URL.revokeObjectURL(song.picUrl)
        if (song.thumbUrl && song.thumbUrl.startsWith('blob:')) URL.revokeObjectURL(song.thumbUrl)
      })
    },

    findByPath(filePath?: string): LocalSong | undefined {
      if (!filePath) return undefined
      return this.songs.find((song) => song.filePath === filePath || song.id === filePath)
    },

    /**
     * 取高清封面 URL（同步命中，供播放页大图与背景）。
     * 现在是稳定协议地址，不需要 IPC，也不需要 LRU 释放。
     */
    async loadFullCover(songId: string | number, filePath?: string): Promise<string | null> {
      const song = this.findByPath(filePath) ?? this.songs.find((s) => s.id === songId)
      if (!song?.coverHash) return null
      return coverUrl(song.coverHash, song.coverExt, 'full') || null
    },

    getFullCoverUrl(songId: string | number): string | null {
      const song = this.songs.find((s) => s.id === songId)
      if (!song?.coverHash) return null
      return coverUrl(song.coverHash, song.coverExt, 'full') || null
    },

    /** 取某首歌缓存的歌词（模块级 LRU，非响应式） */
    getLyrics(song: { id?: string | number; filePath?: string }): string {
      return getLyricsCache(lyricsKeyOf(song)) ?? ''
    },

    cacheLyrics(song: { id?: string | number; filePath?: string }, text: string): void {
      setLyricsCacheEntry(lyricsKeyOf(song), text)
    },

    clear(): void {
      this.revokeCovers()
      clearLocalLyricsCache()
      this.songs = []
      this.folders = []
      this.loading = false
      this.fillingMeta = false
      this.scanning = false
      this.scanProgress = null
      this.bootstrapped = false
      bumpVersion()
    }
  }
})

/** 供模块外部（如设置页改目录后）主动让分组缓存失效 */
export function invalidateLocalGroups(): void {
  bumpVersion()
}
