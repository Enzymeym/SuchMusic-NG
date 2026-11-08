import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlayerStore, type PlayerSong } from '../playerStore'

/**
 * 队列封面自愈。
 *
 * 队列项里的 `cover` 是入队那一刻的快照，而本地封面地址会随扫描结果变化
 * （重新扫描、编辑标签换封面 → hash 变化），历史数据里还可能是旧实现留下的
 * blob: 或旧 id 形态。这些都会让播放队列抽屉显示空白封面。
 */

const FRESH = 'such-cover://cover/abcdef0123456789.jpg?size=thumb'
const STALE = 'such-cover://cover/0000000000000000.jpg?size=thumb'

function makeSong(over: Partial<PlayerSong> = {}): PlayerSong {
  return {
    id: 'p1',
    title: '稻香',
    artist: '周杰伦',
    cover: '',
    durationMs: 0,
    ...over
  }
}

describe('playerStore.restoreCoversFromLocalSongs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('按 id 命中时补齐空封面', () => {
    const store = usePlayerStore()
    store.playlist = [makeSong({ id: 'p1', filePath: 'C:\\music\\a.flac', cover: '' })]

    store.restoreCoversFromLocalSongs([{ id: 'p1', picUrl: FRESH }])

    expect(store.playlist[0].cover).toBe(FRESH)
  })

  it('刷新已失效的旧地址（重新扫描后 hash 变了）', () => {
    const store = usePlayerStore()
    store.playlist = [makeSong({ id: 'p1', filePath: 'C:\\music\\a.flac', cover: STALE })]

    store.restoreCoversFromLocalSongs([{ id: 'p1', picUrl: FRESH }])

    expect(store.playlist[0].cover).toBe(FRESH)
  })

  it('id 对不上时用 filePath 兜底（老队列里的 id 不是路径）', () => {
    const store = usePlayerStore()
    store.playlist = [makeSong({ id: 42, filePath: 'C:\\music\\a.flac', cover: '' })]

    store.restoreCoversFromLocalSongs([
      { id: 'C:\\music\\a.flac', filePath: 'C:\\music\\a.flac', picUrl: FRESH }
    ])

    expect(store.playlist[0].cover).toBe(FRESH)
  })

  it('不覆盖会话内临时指定的 data: 封面', () => {
    const store = usePlayerStore()
    const inline = 'data:image/png;base64,AAAA'
    store.playlist = [makeSong({ id: 'p1', filePath: 'C:\\music\\a.flac', cover: inline })]

    store.restoreCoversFromLocalSongs([{ id: 'p1', picUrl: FRESH }])

    expect(store.playlist[0].cover).toBe(inline)
  })

  it('同时同步 currentSong', () => {
    const store = usePlayerStore()
    const current = makeSong({ id: 'p1', filePath: 'C:\\music\\a.flac', cover: '' })
    store.currentSong = current
    store.playlist = [current]

    store.restoreCoversFromLocalSongs([{ id: 'p1', picUrl: FRESH }])

    expect(store.currentSong?.cover).toBe(FRESH)
  })

  it('未命中的曲目（在线歌曲等）保持原样', () => {
    const store = usePlayerStore()
    const online = 'https://p1.music.126.net/cover.jpg'
    store.playlist = [makeSong({ id: 'netease-1', cover: online, source: 'netease' })]

    store.restoreCoversFromLocalSongs([{ id: 'p1', filePath: 'C:\\music\\a.flac', picUrl: FRESH }])

    expect(store.playlist[0].cover).toBe(online)
  })
})
