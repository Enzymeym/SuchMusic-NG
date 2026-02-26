import { defineStore } from 'pinia'

// 播放器当前歌曲信息结构
export interface PlayerSong {
  id: string | number | null
  title: string
  artist: string
  cover: string
  durationMs: number
  album?: string
  filePath?: string
  lyrics?: string
   source?: string // 音源平台标识（如 netease、本地等）
   sourceSongId?: string | number // 在对应平台上的原始歌曲 ID
}

export interface PlayRecord {
  songId: string | number
  title: string
  artist: string
  album?: string
  cover: string
  filePath?: string // 本地文件路径（用于从本地重新获取封面等信息）
  timestamp: number
}

export type PlaylistSource = 'search' | 'recent' | 'local'

// 使用 Pinia 定义全局播放器 store
export const usePlayerStore = defineStore('player', {
  // 播放器全局状态
  state: () => ({
    currentSong: null as PlayerSong | null, // 当前播放歌曲
    isPlaying: false, // 是否正在播放
    volume: 0.8, // 音量（0.0 - 1.0）
    positionMs: 0, // 当前播放进度（毫秒）
    isLoading: false, // 是否正在加载
    playHistory: [] as PlayRecord[], // 播放历史记录
    playlist: [] as PlayerSong[], // 当前播放列表
    playlistSource: 'search' as PlaylistSource, // 当前播放列表来源
    searchPlaylist: [] as PlayerSong[], // 最近一次搜索结果播放列表
    localPlaylist: [] as PlayerSong[], // 最近一次本地音乐播放列表
    playMode: 'list' as 'list' | 'loop' | 'shuffle', // 播放模式
    currentIndex: -1, // 当前播放索引
    isPlayerPageShown: false // 是否显示播放页
  }),
  actions: {
    setPlayerPageShown(show: boolean) {
      this.isPlayerPageShown = show
    },
    play() {
      if (this.currentSong) {
        this.isPlaying = true
      }
    },
    pause() {
      this.isPlaying = false
    },

    // 播放列表操作
    setPlaylist(list: PlayerSong[]) {
      this.playlist = list
    },

    // 设置指定来源的播放列表
    setPlaylistForSource(source: PlaylistSource, list: PlayerSong[], setActive = true) {
      if (source === 'search') {
        this.searchPlaylist = list
      } else if (source === 'local') {
        this.localPlaylist = list
      }
      if (setActive) {
        this.playlistSource = source
        this.playlist = list
      }
    },
    addToPlaylist(song: PlayerSong) {
      if (!this.playlist.some((s) => s.id === song.id)) {
        this.playlist.push(song)
      }
    },
    removeFromPlaylist(songId: string | number) {
      const index = this.playlist.findIndex((s) => s.id === songId)
      if (index !== -1) {
        this.playlist.splice(index, 1)
        if (this.currentIndex > index) {
          this.currentIndex--
        } else if (this.currentIndex === index) {
          // If removing current song, currentIndex now points to the next song (or out of bounds)
          if (this.playlist.length === 0) {
             this.currentIndex = -1
             this.currentSong = null
             this.isPlaying = false
          } else if (this.currentIndex >= this.playlist.length) {
             this.currentIndex = 0
          }
        }
      }
    },
    clearPlaylist() {
      this.playlist = []
      this.currentIndex = -1
      this.currentSong = null
      this.isPlaying = false
    },

    // 切换播放列表来源
    switchPlaylistSource(source: PlaylistSource) {
      this.playlistSource = source

      if (source === 'search') {
        this.playlist = [...this.searchPlaylist]
      } else if (source === 'local') {
        this.playlist = [...this.localPlaylist]
      } else if (source === 'recent') {
        // 由最近播放记录构造播放列表，并按歌曲去重（保留最新一条）
        const seen = new Set<string | number>()
        const recentList: PlayerSong[] = []

        for (const r of this.playHistory) {
          if (seen.has(r.songId)) continue
          seen.add(r.songId)

          recentList.push({
            id: r.songId,
            title: r.title,
            artist: r.artist,
            album: r.album,
            cover: r.cover,
            filePath: r.filePath,
            durationMs: 0
          })
        }

        this.playlist = recentList
      }

      // 切换列表后保持当前歌曲位置
      if (this.currentSong) {
        const idx = this.playlist.findIndex((s) => s.id === this.currentSong!.id)
        this.currentIndex = idx
      } else {
        this.currentIndex = this.playlist.length > 0 ? 0 : -1
      }
    },
    
    // 播放模式切换
    togglePlayMode() {
      const modes: ('list' | 'loop' | 'shuffle')[] = ['list', 'loop', 'shuffle']
      const nextIndex = (modes.indexOf(this.playMode) + 1) % modes.length
      this.playMode = modes[nextIndex]
    },

    // 切歌逻辑
    playNext() {
      if (this.playlist.length === 0) return

      let nextIndex = this.currentIndex
      if (this.playMode === 'shuffle') {
        nextIndex = Math.floor(Math.random() * this.playlist.length)
      } else if (this.playMode === 'loop') {
         // 单曲循环模式下，如果是用户手动切歌，通常也是切到下一首，或者重新开始当前首
         // 这里实现为切换到下一首（类似列表循环），只有自动结束时才单曲循环
         nextIndex = (this.currentIndex + 1) % this.playlist.length
      } else {
        // 列表循环
        nextIndex = (this.currentIndex + 1) % this.playlist.length
      }
      
      this.playSongAtIndex(nextIndex)
    },
    
    playPrev() {
      if (this.playlist.length === 0) return

      let prevIndex = this.currentIndex
      if (this.playMode === 'shuffle') {
         prevIndex = Math.floor(Math.random() * this.playlist.length)
      } else {
        prevIndex = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length
      }
      
      this.playSongAtIndex(prevIndex)
    },

    playSongAtIndex(index: number) {
      if (index >= 0 && index < this.playlist.length) {
        this.currentIndex = index
        const song = this.playlist[index]
        // 这里不直接调 setCurrentSong，因为需要触发播放逻辑，可能需要外部监听 currentSong 变化
        // 或者直接在这里处理播放逻辑？
        // 为了保持简单，我们更新 currentSong，外部 LocalMusicView 或者 PlayerBar 监听到变化后负责实际播放？
        // 不，Store 应该只管状态。实际播放逻辑（调用音频引擎）目前在 View 层。
        // 我们需要一种机制通知 View 层播放。
        // 暂时先更新 currentSong，View 层需要监听 currentSong 的变化来触发播放。
        this.currentSong = song
        this.positionMs = 0
        this.isPlaying = true 
        this.recordPlay(song)
      }
    },

    // 初始化时加载历史记录
    loadHistory() {
      const history = localStorage.getItem('player_history')
      if (history) {
        try {
          this.playHistory = JSON.parse(history)
        } catch (e) {
          console.error('Failed to parse play history', e)
          this.playHistory = []
        }
      }
    },
    // 记录一次播放
    recordPlay(song: PlayerSong) {
      if (!song.id) return

      // 避免重复添加相同的最近播放记录（如果最新的一条就是这首歌）
      if (this.playHistory.length > 0 && this.playHistory[0].songId === song.id) {
        // 更新时间戳即可
        this.playHistory[0].timestamp = Date.now()
        this.saveHistory()
        return
      }

      const record: PlayRecord = {
        songId: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        // 优化：不存储完整的 cover base64 字符串，如果太长的话
        // 但这里为了简单，先假设 cover 是 URL 或较短的字符串。
        // 如果是 base64，可能会非常大，导致 LocalStorage 爆满。
        // 策略：如果 cover 是 data:image 开头且长度超过 1000，则不存入历史记录
        cover:
          song.cover && song.cover.startsWith('data:image') && song.cover.length > 1024
            ? ''
            : song.cover,
        // 保留文件路径，便于“最近播放”等页面按需重新提取本地封面
        filePath: song.filePath,
        timestamp: Date.now()
      }
      
      this.playHistory.unshift(record)
      
      // 限制历史记录数量，大幅降低上限，例如最近 200 条
      // LocalStorage 通常限制 5MB，10000 条肯定会超
      if (this.playHistory.length > 200) {
        this.playHistory = this.playHistory.slice(0, 200)
      }
      
      this.saveHistory()
    },
    // 保存历史记录
    saveHistory() {
      try {
        localStorage.setItem('player_history', JSON.stringify(this.playHistory))
      } catch (e) {
        console.error('Failed to save play history to localStorage', e)
        // 如果存储失败（如 QuotaExceededError），尝试清理旧记录再存
        if (this.playHistory.length > 50) {
           this.playHistory = this.playHistory.slice(0, 50)
           try {
             localStorage.setItem('player_history', JSON.stringify(this.playHistory))
           } catch (retryError) {
             console.error('Retry save history failed', retryError)
           }
        }
      }
    },
    // 设置当前播放歌曲
    setCurrentSong(song: PlayerSong | null): void {
      this.currentSong = song
      this.positionMs = 0
      
      // 更新 currentIndex
      if (song) {
        const index = this.playlist.findIndex((s) => s.id === song.id)
        if (index !== -1) {
          this.currentIndex = index
        } else {
          // 如果不在播放列表中，添加并设置
          this.playlist.push(song)
          this.currentIndex = this.playlist.length - 1
        }
      }
    },
    // 更新播放状态
    setPlaying(playing: boolean): void {
      this.isPlaying = playing
    },
    // 更新音量（0.0 - 1.0）
    setVolume(volume: number): void {
      const v = Math.min(Math.max(volume, 0), 1)
      this.volume = v
    },
    // 更新播放进度（毫秒）
    setPosition(positionMs: number): void {
      this.positionMs = Math.max(positionMs, 0)
    },
    // 更新当前歌曲总时长（毫秒）
    setDuration(durationMs: number): void {
      if (!this.currentSong) return
      this.currentSong = {
        ...this.currentSong,
        durationMs
      }
    }
  }
})
