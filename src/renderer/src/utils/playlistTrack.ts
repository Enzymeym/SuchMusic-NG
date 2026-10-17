/**
 * 歌单曲目 ↔ 播放器曲目 转换
 *
 * 关键点：音源插件（洛雪 / 澜音）曲目必须**原样透传** pluginId / providerId /
 * sourceKey / trackRef / requestHeaders，否则从歌单播放/下载时会退化为
 * 内置音源查找而失败。
 */
import type { PlaylistTrack } from '../stores/playlistStore'
import type { PlayerSong } from '../stores/playerStore'

/** 歌单曲目 → 播放器曲目 */
export function playlistTrackToPlayerSong(track: PlaylistTrack): PlayerSong {
  const song: PlayerSong = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    cover: track.cover || '',
    durationMs: track.durationMs || 0,
    filePath: track.filePath,
    source: track.source,
    sourceSongId: track.sourceSongId
  }
  if (track.pluginId) song.pluginId = track.pluginId
  if (track.providerId) song.providerId = track.providerId
  if (track.sourceKey) song.sourceKey = track.sourceKey
  if (track.trackRef !== undefined) song.trackRef = track.trackRef
  if (track.requestHeaders) song.requestHeaders = track.requestHeaders
  return song
}

/** 播放器曲目 → 歌单曲目 */
export function playerSongToPlaylistTrack(song: PlayerSong): PlaylistTrack {
  const track: PlaylistTrack = {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    cover: song.cover || undefined,
    filePath: song.filePath,
    durationMs: song.durationMs,
    source: song.source,
    sourceSongId: song.sourceSongId
  }
  if (song.pluginId) track.pluginId = song.pluginId
  if (song.providerId) track.providerId = song.providerId
  if (song.sourceKey) track.sourceKey = song.sourceKey
  if (song.trackRef !== undefined) track.trackRef = song.trackRef
  if (song.requestHeaders) track.requestHeaders = song.requestHeaders
  return track
}

/**
 * 判断歌单曲目是否具备可播放路径：
 * 本地文件、http(s) 直链、内置网易云音源、或携带音源插件元数据（可由插件实时解析）
 */
export function isPlayablePlaylistTrack(track: PlaylistTrack): boolean {
  if (track.filePath) return true
  if (track.source === 'netease' || track.sourceKey === 'wy') return true
  return !!(track.pluginId || track.providerId || track.trackRef)
}
