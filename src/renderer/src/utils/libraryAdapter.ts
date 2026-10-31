/**
 * LibraryTrack → LocalSong 的适配层。
 *
 * 存在的唯一理由：`LocalSong` 的形状被 12 个文件依赖（列表、分组、播放转换、
 * 标签编辑、统计页…），全量改造成本高且回归面大。把「新数据结构 → 旧形状」
 * 收在一个函数里，将来真要换形状时只改这里。
 */
import type { LibraryTrack } from '../../../shared/library/types'
import { coverUrl } from '../../../shared/library/channels'
import { formatQuality } from './quality'
import type { LocalSong } from '../stores/localMusicStore'

export const UNKNOWN_ARTIST = '未知歌手'
export const UNKNOWN_ALBUM = '未知专辑'

export function toLocalSong(track: LibraryTrack): LocalSong {
  const thumb = coverUrl(track.coverHash, track.coverExt, 'thumb')
  const full = coverUrl(track.coverHash, track.coverExt, 'full')
  const artists = track.artists.length > 0 ? track.artists : [UNKNOWN_ARTIST]

  return {
    // id 保持「真实路径」语义（旧数据里 id 就是路径），避免播放历史/歌单里的
    // 旧记录与新曲目对不上；去重与主键由数据库侧的归一化 id 负责。
    id: track.filePath,
    name: track.title || track.fileName,
    ar: artists.map((name) => ({ name })),
    al: { name: track.album || UNKNOWN_ALBUM, picUrl: full || undefined },
    filePath: track.filePath,
    fileName: track.fileName,
    folderPath: track.folderPath,
    dt: track.durationMs,
    picUrl: thumb || undefined,
    thumbUrl: thumb || undefined,
    quality: formatQuality(track.bitrate, track.sampleRate, track.bitsPerSample),
    bitrate: track.bitrate,
    sampleRate: track.sampleRate,
    bitsPerSample: track.bitsPerSample,
    channels: track.channels,
    codec: track.codec,
    coverHash: track.coverHash,
    // 必须一起带上：`loadFullCover` / `getFullCoverUrl` 要用它拼原图 URL，
    // 缺了会退回假定 .jpg，封面实际是 png/webp 时原图地址直接 404
    coverExt: track.coverExt,
    year: track.year,
    trackNo: track.trackNo
  }
}

/** 批量转换（扫描完成后一次性替换曲库用） */
export function toLocalSongs(tracks: LibraryTrack[]): LocalSong[] {
  return tracks.map(toLocalSong)
}
