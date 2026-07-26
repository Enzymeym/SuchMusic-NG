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
  translatedLyrics?: string // 翻译歌词原始文本
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
  source?: string // 音源平台标识
}

export const usePlayerStore = defineStore('player', {
  // 播放器全局状态
  state: () => ({
    currentSong: null as PlayerSong | null, // 当前播放歌曲
    isPlaying: false, // 是否正在播放
    volume: 0.8, // 音量（0.0 - 1.0）
    positionMs: 0, // 当前播放进度（毫秒）
    isLoading: false, // 是否正在加载
    isChangingSong: false, // 是否正在切歌，防止连续触发
    playHistory: [] as PlayRecord[], // 播放历史记录
    playlist: [] as PlayerSong[], // 当前播放列表
    playlistSessionStart: 0, // 当前播放会话的起始索引（用于区分批量设置与单独追加的歌曲）
    playMode: 'list' as 'list' | 'loop' | 'shuffle', // 播放模式
    currentIndex: -1, // 当前播放索引
    isPlayerPageShown: false, // 是否显示播放页
    shouldAutoPlay: true, // 是否自动播放（用于恢复状态时不自动播放）
    preloadStatus: 'idle' as 'idle' | 'loading' | 'loaded' | 'error', // 预加载状态
    preloadError: null as string | null, // 预加载错误信息
    nextSongToPreload: null as PlayerSong | null, // 准备预加载的下一首歌曲
    transitionEnabled: true, // 是否启用智能过渡
    transitionDuration: 3000, // 过渡时长（毫秒）
    transitionType: 'smart' as 'crossfade' | 'fade' | 'smart', // 过渡效果类型
    isTransitioning: false // 是否正在过渡
  }),
  getters: {
    /**
     * 获取当前播放歌曲索引，无歌曲时返回 -1
     * @returns 当前播放歌曲在播放列表中的索引
     */
    currentSongIndex(state): number {
      return state.currentIndex
    },
    /**
     * 获取下一首要播放的歌曲，用于预加载
     * @returns 下一首歌曲对象，播放列表为空时返回 null
     */
    nextSong(state): PlayerSong | null {
      if (state.playlist.length === 0) return null
      let nextIndex = state.currentIndex
      if (state.playMode === 'shuffle') {
        const sessionSize = state.playlist.length - state.playlistSessionStart
        nextIndex = state.playlistSessionStart + Math.floor(Math.random() * sessionSize)
      } else {
        nextIndex = (state.currentIndex + 1) % state.playlist.length
      }
      return state.playlist[nextIndex] || null
    },
    /**
     * 获取上一首歌曲
     * @returns 上一首歌曲对象，播放列表为空时返回 null
     */
    prevSong(state): PlayerSong | null {
      if (state.playlist.length === 0) return null
      let prevIndex = state.currentIndex
      if (state.playMode === 'shuffle') {
        const sessionSize = state.playlist.length - state.playlistSessionStart
        prevIndex = state.playlistSessionStart + Math.floor(Math.random() * sessionSize)
      } else {
        prevIndex = (state.currentIndex - 1 + state.playlist.length) % state.playlist.length
      }
      return state.playlist[prevIndex] || null
    }
  },
  actions: {
    setPlayerPageShown(show: boolean) {
      this.isPlayerPageShown = show
    },
    play() {
      if (this.currentSong) {
        this.isPlaying = true
        this.shouldAutoPlay = true
      }
    },
    pause() {
      this.isPlaying = false
    },

  /**
   * 处理歌曲播放结束后的自动切歌逻辑
   * 根据当前播放模式决定下一首播放的歌曲
   */
  handleSongEnd() {
    if (this.playlist.length === 0 || this.isChangingSong || this.isTransitioning) return

    switch (this.playMode) {
      case 'loop':
        if (this.currentIndex >= 0 && this.currentIndex < this.playlist.length) {
          this.playSongAtIndex(this.currentIndex)
        }
        break
      case 'shuffle':
        {
          const sessionSize = this.playlist.length - this.playlistSessionStart
          let randomIndex: number
          if (sessionSize > 1) {
            do {
              randomIndex = this.playlistSessionStart + Math.floor(Math.random() * sessionSize)
            } while (randomIndex === this.currentIndex)
          } else {
            randomIndex = this.currentIndex
          }
          this.playSongAtIndex(randomIndex)
        }
        break
      case 'list':
      default:
        // 列表循环：自动切到下一首，始终循环（与 playNext 行为一致）
        this.playNext()
        break
    }
  },

    // 播放列表操作
    setPlaylist(list: PlayerSong[]) {
      // 限制播放列表大小，避免占用过多内存
      const MAX_PLAYLIST_SIZE = 500
      if (list.length > MAX_PLAYLIST_SIZE) {
        list = list.slice(0, MAX_PLAYLIST_SIZE)
        console.warn(`Playlist size exceeded limit, truncated to ${MAX_PLAYLIST_SIZE} songs`)
      }

      this.playlist = list
      this.playlistSessionStart = 0
      if (list.length === 0) {
        this.currentIndex = -1
        this.currentSong = null
        this.isPlaying = false
      } else {
        // 如果当前有歌曲，且不在新列表中，则重置当前歌曲
        if (this.currentSong && !list.find(s => s.id === this.currentSong!.id)) {
           this.currentIndex = 0
           this.currentSong = list[0]
        } else if (this.currentSong) {
           this.currentIndex = list.findIndex(s => s.id === this.currentSong!.id)
        }
      }
    },
    addToPlaylist(song: PlayerSong) {
      // 限制播放列表大小，避免占用过多内存
      const MAX_PLAYLIST_SIZE = 500
      if (this.playlist.length >= MAX_PLAYLIST_SIZE) {
        console.warn('Playlist size exceeded limit, cannot add more songs')
        return
      }

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
      this.playlistSessionStart = 0
      this.currentIndex = -1
      this.currentSong = null
      this.isPlaying = false
    },

    // 播放模式切换
    togglePlayMode() {
      const modes: ('list' | 'loop' | 'shuffle')[] = ['list', 'loop', 'shuffle']
      const nextIndex = (modes.indexOf(this.playMode) + 1) % modes.length
      this.playMode = modes[nextIndex]
    },

    // 切歌逻辑
  playNext() {
    if (this.playlist.length === 0 || this.isChangingSong) return

    this.isChangingSong = true
    try {
      let nextIndex = this.currentIndex
      if (this.playMode === 'shuffle') {
        const sessionSize = this.playlist.length - this.playlistSessionStart
        nextIndex = this.playlistSessionStart + Math.floor(Math.random() * sessionSize)
      } else if (this.playMode === 'loop') {
         // 单曲循环模式下，如果是用户手动切歌，通常也是切到下一首，或者重新开始当前首
         // 这里实现为切换到下一首（类似列表循环），只有自动结束时才单曲循环
         nextIndex = (this.currentIndex + 1) % this.playlist.length
      } else {
        // 列表循环
        nextIndex = (this.currentIndex + 1) % this.playlist.length
      }

      this.playSongAtIndex(nextIndex)
    } finally {
      // 确保即使发生错误也能重置状态
      setTimeout(() => {
        this.isChangingSong = false
      }, 300) // 300ms 延迟，确保切歌操作完成
    }
  },

  playPrev() {
    if (this.playlist.length === 0 || this.isChangingSong) return

    this.isChangingSong = true
    try {
      let prevIndex = this.currentIndex
      if (this.playMode === 'shuffle') {
        const sessionSize = this.playlist.length - this.playlistSessionStart
        prevIndex = this.playlistSessionStart + Math.floor(Math.random() * sessionSize)
      } else {
        prevIndex = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length
      }

      this.playSongAtIndex(prevIndex)
    } finally {
      // 确保即使发生错误也能重置状态
      setTimeout(() => {
        this.isChangingSong = false
      }, 300) // 300ms 延迟，确保切歌操作完成
    }
  },

    playSongAtIndex(index: number) {
    if (index >= 0 && index < this.playlist.length) {
      this.currentIndex = index
      const song = this.playlist[index]
      // 为了触发 watch 监听器，创建一个新的对象引用
      this.currentSong = { ...song }
      this.positionMs = 0
      this.shouldAutoPlay = true // 用户主动切歌，自动播放
      // isPlaying 由 PlayerBar.doLoadAndPlaySong 在音频引擎成功启动后设置，
      // 避免在播放失败（如文件不存在）时出现 UI 状态不一致
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
    // 保存播放器状态（当前歌曲、歌单、进度等）
    savePlayerState() {
      // 剥离大字段以避免 localStorage 配额溢出（base64 封面、歌词等可能达数 MB）
      const stripSong = (song: PlayerSong | null) => {
        if (!song) return null
        return {
          id: song.id,
          title: song.title,
          artist: song.artist,
          album: song.album,
          durationMs: song.durationMs,
          filePath: song.filePath,
          source: song.source,
          sourceSongId: song.sourceSongId,
          cover:
            song.cover && song.cover.startsWith('data:') ? '' : song.cover
        } as PlayerSong
      }
      const state = {
        currentSong: stripSong(this.currentSong),
        playlist: this.playlist.map(stripSong),
        playMode: this.playMode,
        currentIndex: this.currentIndex,
        volume: this.volume,
        positionMs: this.positionMs,
        transitionEnabled: this.transitionEnabled,
        transitionDuration: this.transitionDuration,
        transitionType: this.transitionType
      }
      try {
        localStorage.setItem('player_state', JSON.stringify(state))
      } catch (e) {
        console.error('Failed to save player state', e)
      }
    },
    // 加载播放器状态
    loadPlayerState() {
      const stateStr = localStorage.getItem('player_state')
      if (stateStr) {
        try {
          const state = JSON.parse(stateStr)

          // 关键：必须在设置 currentSong 之前将 shouldAutoPlay 设为 false，
          // 否则 PlayerBar 的 watch(currentSong) 触发时会误判为需要自动播放
          this.shouldAutoPlay = false // 恢复状态时不自动播放
          this.isPlaying = false // 确保不处于播放状态

          if (state.currentSong) this.currentSong = state.currentSong
          if (state.playlist) this.playlist = state.playlist
          if (state.playMode) this.playMode = state.playMode
          if (typeof state.currentIndex === 'number') this.currentIndex = state.currentIndex
          if (typeof state.volume === 'number') this.volume = state.volume
          if (typeof state.positionMs === 'number') this.positionMs = state.positionMs
          if (typeof state.transitionEnabled === 'boolean') this.transitionEnabled = state.transitionEnabled
          if (typeof state.transitionDuration === 'number') this.transitionDuration = state.transitionDuration
          if (state.transitionType) this.transitionType = state.transitionType
        } catch (e) {
          console.error('Failed to parse player state', e)
        }
      }
    },
    /**
     * 根据本地歌曲已加载的封面恢复当前歌曲和播放队列封面
     * 启动时从持久化恢复的状态会剥离 base64 封面，本地音乐扫描完后调用此方法补全
     */
    restoreCoversFromLocalSongs(localSongs: { id: string | number; picUrl?: string }[]): void {
      const coverMap = new Map<string | number, string>()
      localSongs.forEach((song) => {
        if (song.picUrl) {
          coverMap.set(song.id, song.picUrl)
        }
      })

      if (this.currentSong && this.currentSong.id != null && !this.currentSong.cover && coverMap.has(this.currentSong.id)) {
        this.currentSong.cover = coverMap.get(this.currentSong.id)!
      }

      this.playlist.forEach((song) => {
        if (song.id != null && !song.cover && coverMap.has(song.id)) {
          song.cover = coverMap.get(song.id)!
        }
      })
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
        timestamp: Date.now(),
        source: song.source || (song.filePath ? 'local' : 'local') // 记录来源
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
    /**
     * 设置当前播放歌曲
     * 自动保留已有的 lyrics 和 translatedLyrics，防止被覆盖为空
     * 仅当歌曲 ID 变化时才重置 positionMs，同歌曲更新时保留现有进度
     * @param song 要设置的歌曲对象
     */
    setCurrentSong(song: PlayerSong | null): void {
      if (!song) {
        this.currentSong = null
        return
      }

      const isSameSong = !!(this.currentSong && song.id === this.currentSong.id)

      if (song) {
        // 如果新对象没有 lyrics 且当前歌曲是同 id 且有 lyrics，则保留
        if (!song.lyrics && this.currentSong?.lyrics && this.currentSong.id === song.id) {
          song = { ...song, lyrics: this.currentSong.lyrics }
        }
        // 如果新对象没有 translatedLyrics 且当前歌曲是同 id 且有，则保留
        if (!song.translatedLyrics && this.currentSong?.translatedLyrics && this.currentSong.id === song.id) {
          song = { ...song, translatedLyrics: this.currentSong.translatedLyrics }
        }
      }
      this.currentSong = song
      // 仅当歌曲不同时才重置进度，同歌曲更新时保留现有进度
      if (!isSameSong) {
        this.positionMs = 0
        this.shouldAutoPlay = true // 用户主动切歌，自动播放
      }

      // 更新 currentIndex
      const index = this.playlist.findIndex((s) => s.id === song.id)
      if (index !== -1) {
        this.currentIndex = index
      } else {
        this.playlistSessionStart = this.playlist.length
        this.playlist.push(song)
        this.currentIndex = this.playlist.length - 1
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
    /**
     * 更新当前歌曲总时长（毫秒）
     * 直接修改 currentSong 对象的 durationMs 属性，避免创建新对象引用触发 watcher
     * @param durationMs 音轨总时长（毫秒）
     */
    setDuration(durationMs: number): void {
      if (!this.currentSong) return
      // 直接修改属性而非创建新对象，避免触发 currentSong 的 watcher 导致重复加载
      this.currentSong.durationMs = durationMs
    },
    /**
     * 更新当前歌曲歌词
     * 直接修改属性而非创建新对象，避免触发 currentSong 的 watcher 导致重复加载
     * @param lyrics 歌词字符串
     */
    setLyrics(lyrics: string): void {
      if (!this.currentSong) return
      this.currentSong.lyrics = lyrics

      // 同时更新播放列表中对应歌曲的歌词
      const index = this.playlist.findIndex((s) => s.id === this.currentSong?.id)
      if (index !== -1) {
        this.playlist[index] = {
          ...this.playlist[index],
          lyrics
        }
      }
    },
    /**
     * 更新当前歌曲的翻译歌词
     * 直接修改属性而非创建新对象，避免触发 currentSong 的 watcher 导致重复加载
     * @param lyrics 翻译歌词原始文本
     */
    setTranslatedLyrics(lyrics: string): void {
      if (!this.currentSong) return
      this.currentSong.translatedLyrics = lyrics

      const index = this.playlist.findIndex((s) => s.id === this.currentSong?.id)
      if (index !== -1) {
        this.playlist[index] = {
          ...this.playlist[index],
          translatedLyrics: lyrics
        }
      }
    },
    /**
     * 更新当前歌曲封面
     * 直接修改属性而非创建新对象，避免触发 currentSong 的 watcher 导致重复加载
     * @param cover 封面 URL
     */
    setCover(cover: string): void {
      if (!this.currentSong || !cover) return
      this.currentSong.cover = cover

      const index = this.playlist.findIndex((s) => s.id === this.currentSong?.id)
      if (index !== -1) {
        this.playlist[index] = {
          ...this.playlist[index],
          cover
        }
      }
    },

    // 设置预加载状态
    setPreloadStatus(status: 'idle' | 'loading' | 'loaded' | 'error'): void {
      this.preloadStatus = status
    },

    // 设置预加载错误信息
    setPreloadError(error: string | null): void {
      this.preloadError = error
    },

    // 设置准备预加载的下一首歌曲
    setNextSongToPreload(song: PlayerSong | null): void {
      this.nextSongToPreload = song
    },

    // 获取下一首歌曲信息，用于预加载
    getNextSong(): PlayerSong | null {
      if (this.playlist.length === 0) return null

      let nextIndex = this.currentIndex
      if (this.playMode === 'shuffle') {
        const sessionSize = this.playlist.length - this.playlistSessionStart
        nextIndex = this.playlistSessionStart + Math.floor(Math.random() * sessionSize)
      } else if (this.playMode === 'list') {
        // 列表模式：播放下一首歌曲
        nextIndex = (this.currentIndex + 1) % this.playlist.length
      } else if (this.playMode === 'loop') {
        // 单曲循环模式：仍然预加载下一首歌曲
        nextIndex = (this.currentIndex + 1) % this.playlist.length
      }

      return this.playlist[nextIndex] || null
    },

    // 重置预加载状态
    resetPreloadState(): void {
      this.preloadStatus = 'idle'
      this.preloadError = null
      this.nextSongToPreload = null
    },

    // 设置过渡功能启用状态
    setTransitionEnabled(enabled: boolean): void {
      this.transitionEnabled = enabled
      this.savePlayerState()
    },

    // 设置过渡时长
    setTransitionDuration(duration: number): void {
      this.transitionDuration = Math.max(500, Math.min(duration, 10000)) // 限制在0.5-10秒之间
      this.savePlayerState()
    },

    // 设置过渡效果类型
    setTransitionType(type: 'crossfade' | 'fade' | 'smart'): void {
      this.transitionType = type
      this.savePlayerState()
    },

    // 设置过渡状态
    setTransitioning(isTransitioning: boolean): void {
      this.isTransitioning = isTransitioning
    },


  }
})
