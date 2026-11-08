/**
 * 本地曲库的 IPC 通道常量。
 *
 * 项目历史上有大量 `'local-music:xxx'` 字面量散落在两端，这里只给**新增**的
 * 曲库通道建立常量表，避免再制造一份「改一端忘另一端」的隐患；旧的
 * `local-music:*` 通道保持原样，不做批量替换。
 */
export const LIBRARY_CHANNELS = {
  bootstrap: 'library:bootstrap',
  scan: 'library:scan',
  scanCancel: 'library:scan-cancel',
  scanProgress: 'library:scan-progress',
  scanDone: 'library:scan-done',
  folderTracks: 'library:folder-tracks',
  folderUpdate: 'library:folder-update',
  folderChildren: 'library:folder-children',
  reloadTracks: 'library:reload-tracks',
  reveal: 'library:reveal',
  coverGc: 'library:cover-gc'
} as const

export type LibraryChannel = (typeof LIBRARY_CHANNELS)[keyof typeof LIBRARY_CHANNELS]

/** 封面自定义协议 */
export const COVER_SCHEME = 'such-cover'
export const COVER_HOST = 'cover'

/** 由封面哈希拼出渲染层可直接使用的 URL */
export function coverUrl(hash: string | undefined, ext: string | undefined, size: 'thumb' | 'full' = 'thumb'): string {
  if (!hash) return ''
  const safeExt = (ext || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg'
  return `${COVER_SCHEME}://${COVER_HOST}/${hash}.${safeExt}?size=${size}`
}
