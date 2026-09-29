/**
 * 网易云歌单导入共享工具
 * 提供歌单链接/ID 解析、歌曲转换与歌单拉取封装，供导入弹窗与歌单详情页同步复用
 */

import type { PlaylistTrack } from '../stores/playlistStore'

/** 从预加载桥类型推导的网易云归一化歌曲结构 */
type NeteaseSong = Awaited<ReturnType<typeof window.api.netease.playlistTracks>>[number]

/** 从预加载桥类型推导的网易云歌单摘要 */
export type NeteasePlaylistSummary = Awaited<
  ReturnType<typeof window.api.netease.userPlaylists>
>[number]

/** 歌单导入载荷（可直接写入 playlistStore） */
export interface NeteasePlaylistPayload {
  name: string
  cover: string
  description: string
  sourcePlaylistId: number
  tracks: PlaylistTrack[]
}

/**
 * 解析用户输入为网易云歌单 ID
 * 支持：纯数字、music.163.com 分享链接（#/playlist?id=、/playlist/<id>、?id=）
 * @param input 用户输入的链接或 ID
 * @returns 歌单 ID；无法识别时返回 null
 */
export function parseNeteasePlaylistId(input: string): number | null {
  const text = (input || '').trim()
  if (!text) return null

  let matched: string | null = null
  if (/^\d+$/.test(text)) {
    matched = text
  } else {
    const patterns = [/\/playlist\/(\d+)/, /playlist\?[^#]*\bid=(\d+)/, /[?&#]id=(\d+)/]
    for (const pattern of patterns) {
      const m = text.match(pattern)
      if (m) {
        matched = m[1]
        break
      }
    }
  }

  if (!matched) return null
  const id = Number(matched)
  return Number.isFinite(id) && id > 0 ? id : null
}

/**
 * 将网易云歌曲转换为本地歌单曲目
 * @param songs 归一化网易云歌曲列表
 */
export function toPlaylistTracks(songs: NeteaseSong[]): PlaylistTrack[] {
  return songs.map((song) => {
    const id = Number(song.id)
    return {
      id: `wy-${id}`,
      title: song.name,
      artist: song.ar?.map((a) => a.name).join(' / ') || '未知歌手',
      album: song.al?.name,
      cover: song.al?.picUrl || '',
      durationMs: song.dt || 0,
      filePath: '',
      source: 'netease',
      sourceSongId: id
    }
  })
}

/**
 * 拉取网易云歌单详情与全部曲目
 * @param id 网易云歌单 ID
 * @returns 可直接写入 store 的载荷；歌单不存在或获取失败时返回 null
 */
export async function fetchNeteasePlaylist(id: number): Promise<NeteasePlaylistPayload | null> {
  const detail = await window.api.netease.playlistDetail(id)
  if (!detail) return null
  const songs = await window.api.netease.playlistTracks(id)
  if (!songs.length) return null
  return {
    name: detail.name,
    cover: detail.cover,
    description: (detail.description || '').trim(),
    sourcePlaylistId: detail.id,
    tracks: toPlaylistTracks(songs)
  }
}
