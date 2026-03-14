<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, onMounted } from 'vue'
import { NSlider, NIcon, NText, NButton, NPopover, useThemeVars, NDrawer, NDrawerContent, NEmpty, NDropdown, useMessage } from 'naive-ui'
import { usePlayerStore, type PlayerSong } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import defaultCover from '@renderer/assets/icon.png'
import { webAudioEngine } from '../../audio/audio-engine'
import PlayerPage from './PlayerPage.vue'
import { useSettingsStore } from '../../stores/settingsStore'
import { useDesktopLyric } from '../../composables/useDesktopLyric'
import { useTaskbarLyric } from '../../composables/useTaskbarLyric'
import { runSnowdropGetMusicUrl } from '../../apis/snowdrop-transform'
import { fetchGMALyric } from '../../apis/gma'
import { AudioPlayerManager } from '../../utils/audioPlayerManager'

const themeVars = useThemeVars()
const message = useMessage()

// 简单混合两个十六进制颜色，用于活跃列表项背景过渡
const mixHexColor = (color1: string, color2: string, weight: number): string => {
  const clamp = (v: number) => Math.max(0, Math.min(255, v))
  const parse = (color: string) => {
    let c = color.replace('#', '')
    if (c.length === 3) {
      c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]
    }
    if (c.length !== 6) return { r: 255, g: 255, b: 255 }
    return {
      r: parseInt(c.slice(0, 2), 16),
      g: parseInt(c.slice(2, 4), 16),
      b: parseInt(c.slice(4, 6), 16)
    }
  }
  const a = parse(color1)
  const b = parse(color2)
  const t = Math.max(0, Math.min(1, weight))
  const r = clamp(a.r * t + b.r * (1 - t))
  const g = clamp(a.g * t + b.g * (1 - t))
  const bVal = clamp(a.b * t + b.b * (1 - t))
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(bVal)}`
}

// 获取全局播放器 store
const player = usePlayerStore()
const playlistStore = usePlaylistStore()
// 获取全局设置 store
const settingsStore = useSettingsStore()

const { isDesktopLyricOpen, toggleDesktopLyric } = useDesktopLyric()
const { isOpen: isTaskbarLyricOpen, toggle: toggleTaskbarLyric, init: initTaskbarLyric } = useTaskbarLyric()

// 初始化任务栏歌词
onMounted(() => {
  initTaskbarLyric()
})

// 歌词重试获取函数
const fetchLyricWithRetry = async (id: string, source: string): Promise<string> => {
  const { fetchNewLyric } = await import('../../apis/netease/lyric')
  
  let attempt = 0
  while (true) {
    // 检查当前播放歌曲是否改变，如果改变则停止重试
    const currentId = player.currentSong?.sourceSongId ?? player.currentSong?.id
    if (String(currentId) !== String(id)) {
      return ''
    }

    try {
      // 如果是网易云，使用 fetchNewLyric (支持 yrc)
      if (source === 'wy' || source === 'netease') {
        const lyricRes = await fetchNewLyric(Number(id))
        if (lyricRes && lyricRes.code === 200) {
          const lrc =
            lyricRes.yrc?.lyric ||
            lyricRes.lrc?.lyric ||
            lyricRes.klyric?.lyric ||
            lyricRes.tlyric?.lyric ||
            lyricRes.romalrc?.lyric ||
            ''
          if (lrc) return lrc
        }
      } else {
        // 其他平台继续使用 fetchGMALyric
        const lrc = await fetchGMALyric(id, source)
        if (lrc) return lrc
      }
    } catch (e) {
      console.warn(`[PlayerBar] 获取歌词失败，第 ${attempt + 1} 次重试:`, e)
    }
    
    attempt++
    // 指数退避策略，最大延迟 5 秒
    const delay = Math.min(500 + attempt * 500, 5000)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}

// 加载并播放歌曲的核心逻辑
const loadAndPlaySong = async (song: PlayerSong, forcePlay: boolean = false) => {
  // 决定是否播放：如果是强制播放，则为 true；否则读取 store 中的 shouldAutoPlay
  // 注意：如果是 watch 触发（forcePlay=false），我们需要消费并重置 shouldAutoPlay
  let shouldPlay = forcePlay
  if (!forcePlay) {
    shouldPlay = player.shouldAutoPlay
    player.shouldAutoPlay = true
  }

  // 优化切歌体验：
  // 1. 立即重置进度条显示，给用户“已切换”的反馈
  // 如果是不自动播放（恢复状态），则保留进度
  if (shouldPlay) {
    player.setPosition(0)
  }

  const currentProcessId = song.id

  if ((song as any).filePath && window.electron && window.electron.ipcRenderer) {
    // 先检查文件是否存在
    const exists = await window.electron.ipcRenderer.invoke('system:fs-exists', (song as any).filePath)
    
    if (player.currentSong?.id !== currentProcessId) return

    if (exists) {
      // 尝试加载本地歌词（如果缺失）
      if (!song.lyrics) {
        window.electron.ipcRenderer.invoke('local-music:get-meta', (song as any).filePath).then((meta: any) => {
          if (meta && meta.lyrics && player.currentSong?.id === song.id) {
            player.setLyrics(meta.lyrics)
          }
        }).catch(err => {
          console.warn('Failed to load local lyrics:', err)
        })
      }

      try {
        if (shouldPlay) {
          await AudioPlayerManager.play({
            filePath: (song as any).filePath,
            volume: player.volume
          })
        } else {
          await AudioPlayerManager.load({
            filePath: (song as any).filePath,
            volume: player.volume
          })
          // 恢复进度
          if (player.positionMs > 0) {
            webAudioEngine.seek(player.positionMs)
          }
        }
        
        if (player.currentSong?.id !== currentProcessId) {
           webAudioEngine.stop() // 如果播放后发现切歌了，立即停止
           return
        }
        if (shouldPlay) {
          player.setPlaying(true)
        }
        return
      } catch (e) {
        console.error('Failed to play song from bar (file)', e)
      }
    } else {
      console.warn('[PlayerBar] Local file not found, falling back to online:', (song as any).filePath);
      // 关键修正：文件不存在时，清除 filePath，以便后续逻辑能进入在线/搜索流程
      (song as any).filePath = undefined;
    }
  }

  if (!((song as any).filePath)) {
    try {
      const songId = song.sourceSongId ?? song.id
      const musicInfo = {
        id: String(songId),
        name: song.title,
        singer: song.artist || '未知歌手',
        albumName: song.album || '未知专辑',
        pic: song.cover || '',
        songmid: String(songId),
        mediaId: String(songId)
      }

      // 确定源平台：
      // 1. 如果歌曲自身带有 source 属性，优先使用它（映射到插件所需的源标识）
      // 2. 否则使用设置中的首选平台
      let source = 'wy' // 默认为网易云 (wy)
      if (song.source) {
         // 映射 source 到插件支持的标识
         // 假设插件支持的标识: wy, tx, kg, kw, mg, bilibili 等
         switch (song.source) {
           case 'netease': source = 'wy'; break;
           case 'qq': source = 'tx'; break;
           case 'kugou': source = 'kg'; break;
           case 'kuwo': source = 'kw'; break;
           case 'migu': source = 'mg'; break;
           default: source = song.source; break;
         }
      } else if (settingsStore.source.preferredPlatform && settingsStore.source.preferredPlatform !== 'all') {
         const pref = settingsStore.source.preferredPlatform
         if (pref === 'netease') source = 'wy'
         else if (pref === 'qq') source = 'tx'
         else if (pref === 'kugou') source = 'kg'
         else if (pref === 'kuwo') source = 'kw'
         else if (pref === 'migu') source = 'mg'
         else source = pref
      }

      const quality = settingsStore.source.preferredQuality || '128k'
      const cacheKey = `${source}:${songId}:${quality}`

      // 尝试在获取在线 URL 之前，先检查本地缓存
      let cacheFilePath: string | null = null
      if (window.electron && window.electron.ipcRenderer) {
        try {
          const cachePath = await window.electron.ipcRenderer.invoke('online-cache:check', {
            dir: settingsStore.local.cacheDir || null,
            key: cacheKey
          })
          
          if (player.currentSong?.id !== currentProcessId) return

          if (cachePath) {
            console.log('[PlayerBar] 主动检测到缓存文件存在，跳过在线获取', cachePath)
            cacheFilePath = cachePath
          }
        } catch (e) {
          console.warn('[PlayerBar] 主动检测缓存失败:', e)
        }
      }

      // 如果检测到缓存，直接播放缓存，跳过 fetchGMALyric 和 runSnowdropGetMusicUrl
      // 但为了保证歌词显示，如果本地没有歌词，还是需要尝试获取歌词
      if (cacheFilePath) {
        // 尝试获取歌词（如果当前歌曲没有歌词）
        if (!song.lyrics) {
           fetchLyricWithRetry(String(songId), source).then(lyric => {
             if (lyric && player.currentSong?.id === song.id) {
               player.setLyrics(lyric)
             }
           }).catch(e => console.error('Failed to fetch lyric in PlayerBar:', e))
        }

        try {
          if (shouldPlay) {
            await AudioPlayerManager.play({
              filePath: cacheFilePath,
              volume: player.volume
            })
          } else {
            await AudioPlayerManager.load({
              filePath: cacheFilePath,
              volume: player.volume
            })
            // 恢复进度
            if (player.positionMs > 0) {
              webAudioEngine.seek(player.positionMs)
            }
          }
          
          if (player.currentSong?.id !== currentProcessId) {
             webAudioEngine.stop()
             return
          }

          // 更新当前歌曲的 filePath，以便后续使用
          const updatedSong: PlayerSong = {
            ...song,
            filePath: cacheFilePath,
            source: song.source,
            sourceSongId: song.sourceSongId
          }
          player.setCurrentSong(updatedSong)
          if (shouldPlay) {
            player.setPlaying(true)
          }
          return // 成功播放缓存，直接返回，不再执行后续在线获取逻辑
        } catch (e) {
          console.error('[PlayerBar] 播放缓存文件失败，回退到在线流程:', e)
          // 播放失败，继续走下面的在线获取流程
          cacheFilePath = null 
        }
      }

      // 尝试获取歌词（如果当前歌曲没有歌词）
      if (!song.lyrics) {
         // 使用重试机制获取歌词
         fetchLyricWithRetry(String(songId), source).then(lyric => {
           console.log('[PlayerBar] Fetched lyric with retry:', lyric ? 'Success' : 'Empty')
           if (lyric && player.currentSong?.id === song.id) {
             player.setLyrics(lyric)
           }
         }).catch(e => console.error('Failed to fetch lyric in PlayerBar:', e))
      }

      const { url } = await runSnowdropGetMusicUrl(source, musicInfo, quality)
      if (player.currentSong?.id !== currentProcessId) return

      if (!url) {
        throw new Error('未获取到播放链接')
      }

      // const cacheKey = ... (上面已定义)
      let finalUrl = url
      // let cacheFilePath = null (上面已定义)

      if (window.electron && window.electron.ipcRenderer) {
        try {
          const cacheResult = (await window.electron.ipcRenderer.invoke(
            'online-cache:prepare',
            {
              dir: settingsStore.local.cacheDir || null,
              key: cacheKey,
              url
            }
          )) as { usedCache: boolean; filePath: string | null; url: string }
          
          if (player.currentSong?.id !== currentProcessId) return

          if (cacheResult.filePath) {
            cacheFilePath = cacheResult.filePath
            finalUrl = cacheResult.url || url
            console.log('[PlayerBar][OnlineCache] 使用缓存文件播放', {
              cacheKey,
              filePath: cacheFilePath,
              usedCache: cacheResult.usedCache,
              url: cacheResult.url
            })
          }
        } catch (e) {
          console.error('[PlayerBar] 准备在线播放缓存失败:', e)
        }
      }

      if (cacheFilePath && window.electron && window.electron.ipcRenderer) {
        try {
          if (shouldPlay) {
            await AudioPlayerManager.play({
              filePath: cacheFilePath,
              volume: player.volume
            })
          } else {
            await AudioPlayerManager.load({
              filePath: cacheFilePath,
              volume: player.volume
            })
            // 恢复进度
            if (player.positionMs > 0) {
              webAudioEngine.seek(player.positionMs)
            }
          }
        } catch (e) {
          console.error('[PlayerBar] 从缓存文件播放失败，回退到在线播放:', e)
          if (player.currentSong?.id !== currentProcessId) {
            webAudioEngine.stop()
            return
          }
          if (shouldPlay) {
            await AudioPlayerManager.play({
              url: finalUrl,
              volume: player.volume
            })
          } else {
            await AudioPlayerManager.load({
              url: finalUrl,
              volume: player.volume
            })
            // 恢复进度
            if (player.positionMs > 0) {
              webAudioEngine.seek(player.positionMs)
            }
          }
        }
      } else {
        if (shouldPlay) {
          await AudioPlayerManager.play({
            url: finalUrl,
            volume: player.volume
          })
        } else {
          await AudioPlayerManager.load({
            url: finalUrl,
            volume: player.volume
          })
          // 恢复进度
          if (player.positionMs > 0) {
            webAudioEngine.seek(player.positionMs)
          }
        }
      }
      
      if (player.currentSong?.id !== currentProcessId) {
         webAudioEngine.stop()
         return
      }

      const updatedSong: PlayerSong = {
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        cover: song.cover,
        durationMs: song.durationMs,
        filePath: cacheFilePath || undefined,
        source: song.source,
        sourceSongId: song.sourceSongId,
        // 保留已有的歌词，防止被覆盖为空
        lyrics: song.lyrics || player.currentSong?.lyrics
      }
      player.setCurrentSong(updatedSong)
      if (shouldPlay) {
        player.setPlaying(true)
      }
    } catch (e) {
      console.error('[PlayerBar] 获取并播放在线歌曲失败:', e)
    }
  }

  if (!((song as any).filePath) && !song.source && !song.sourceSongId) {
    try {
      const platform = settingsStore.source.preferredPlatform
      // 仅当首选平台为网易云或所有平台时，才使用网易云搜索回退
      if (platform !== 'wy' && platform !== 'netease' && platform !== 'all') {
        return
      }

      const name = song.title || ''
      const artist = (song as any).artist || ''
      const keyword = name

      const { cloudSearch } = await import('../../apis/netease/search/cloudsearch')
      const res = await cloudSearch(keyword, 1, 10, 0)
      
      if (player.currentSong?.id !== currentProcessId) return

      const songs = res?.result?.songs || []

      const norm = (s: string) => s.toLowerCase().trim()
      const target = songs.find((s: any) => {
        const sName = norm(s.name || '')
        const sArtist = norm((s.ar || []).map((a: any) => a.name).join(' / ') || '')
        const tName = norm(name)
        const tArtist = norm(artist)
        return sName === tName && (!tArtist || sArtist === tArtist)
      }) || songs[0]

      if (!target) {
        return
      }

      const neteaseId = target.id

      const musicInfo = {
        id: String(neteaseId),
        name: target.name,
        singer: (target.ar || []).map((a: any) => a.name).join(' / ') || '未知歌手',
        albumName: target.al?.name || '未知专辑',
        pic: target.al?.picUrl || '',
        songmid: String(neteaseId),
        mediaId: String(neteaseId)
      }

      // 这里使用的是网易云搜索结果，所以 source 固定为 wy
      const source = 'wy'
      const quality = settingsStore.source.preferredQuality || '128k'

      const { url } = await runSnowdropGetMusicUrl(source, musicInfo, quality)
      if (player.currentSong?.id !== currentProcessId) return
      if (!url) {
        throw new Error('未获取到播放链接')
      }

      const cacheKey = `wy:${neteaseId}:${quality}`
      let finalUrl = url
      let cacheFilePath: string | null = null

      if (window.electron && window.electron.ipcRenderer) {
        try {
          const cacheResult = (await window.electron.ipcRenderer.invoke(
            'online-cache:prepare',
            {
              dir: settingsStore.local.cacheDir || null,
              key: cacheKey,
              url
            }
          )) as { usedCache: boolean; filePath: string | null; url: string }

          if (player.currentSong?.id !== currentProcessId) return

          if (cacheResult.filePath) {
            cacheFilePath = cacheResult.filePath
            finalUrl = cacheResult.url || url
            console.log('[PlayerBar][SearchFallback][OnlineCache] 使用缓存文件播放', {
              cacheKey,
              filePath: cacheFilePath,
              usedCache: cacheResult.usedCache,
              url: cacheResult.url
            })
          }
        } catch (e) {
          console.error('[PlayerBar][SearchFallback] 准备在线播放缓存失败:', e)
        }
      }

      if (cacheFilePath && window.electron && window.electron.ipcRenderer) {
        try {
          const data = (await window.electron.ipcRenderer.invoke(
            'audio:load-file',
            cacheFilePath
          )) as ArrayBuffer
          
          if (player.currentSong?.id !== currentProcessId) return

          webAudioEngine.setVolume(player.volume)
          if (shouldPlay) {
            await webAudioEngine.playFromFileData(data)
          } else {
            await webAudioEngine.loadFromFileData(data)
            if (player.positionMs > 0) webAudioEngine.seek(player.positionMs)
          }
        } catch (e) {
          console.error('[PlayerBar][SearchFallback] 从缓存文件播放失败，回退到在线播放:', e)
          if (player.currentSong?.id !== currentProcessId) {
             webAudioEngine.stop()
             return
          }
          if (shouldPlay) {
            await webAudioEngine.playFromUrl(finalUrl)
          } else {
            await webAudioEngine.loadFromUrl(finalUrl)
            if (player.positionMs > 0) webAudioEngine.seek(player.positionMs)
          }
        }
      } else {
        if (shouldPlay) {
          await webAudioEngine.playFromUrl(finalUrl)
        } else {
          await webAudioEngine.loadFromUrl(finalUrl)
          if (player.positionMs > 0) webAudioEngine.seek(player.positionMs)
        }
      }

      if (player.currentSong?.id !== currentProcessId) {
         webAudioEngine.stop()
         return
      }

      const updatedSong: PlayerSong = {
        id: song.id,
        title: song.title || target.name,
        artist: song.artist || (target.ar || []).map((a: any) => a.name).join(' / ') || '未知歌手',
        album: song.album || target.al?.name || '未知专辑',
        cover: song.cover || target.al?.picUrl || '',
        durationMs: song.durationMs || target.dt || 0,
        filePath: cacheFilePath || undefined,
        source: 'netease',
        sourceSongId: neteaseId,
        // 保留已有的歌词，防止被覆盖为空
        lyrics: song.lyrics || player.currentSong?.lyrics
      }
      player.setCurrentSong(updatedSong)
      if (shouldPlay) {
        player.setPlaying(true)
      }
    } catch (e) {
      console.error('[PlayerBar][SearchFallback] 搜索并播放歌曲失败:', e)
    }
  }
}

// 监听 currentSong 变化，触发播放
// 注意：LocalMusicView 中也有播放逻辑，这里主要是响应上一首/下一首的切换
watch(() => player.currentSong, async (newSong, oldSong) => {
  if (newSong && newSong.id !== oldSong?.id) {
     await loadAndPlaySong(newSong)
  }
})

// 播放 / 暂停切换
const togglePlay = async () => {
  if (player.isPlaying) {
    await webAudioEngine.pause()
    player.setPlaying(false)
    // 主动更新 SMTC 播放状态
    updateMediaPlaybackState()
    updateMediaPositionState()
  } else {
    if (player.currentSong) {
      const success = await webAudioEngine.play()
      if (success) {
        player.setPlaying(true)
        // 主动更新 SMTC 播放状态
        updateMediaPlaybackState()
        updateMediaPositionState()
      } else {
        // 播放失败（如未加载），尝试重新加载并播放
        console.log('[PlayerBar] Play failed, reloading song...')
        await loadAndPlaySong(player.currentSong, true)
      }
    }
  }
}

// 切歌
const handlePrev = () => {
  player.playPrev()
}

const handleNext = () => {
  player.playNext()
}

// 播放模式
const toggleMode = () => {
  player.togglePlayMode()
}

const modeIcon = computed(() => {
  switch (player.playMode) {
    case 'loop': return 'mgc_repeat_one_line'
    case 'shuffle': return 'mgc_shuffle_line'
    case 'list': default: return 'mgc_repeat_line'
  }
})

// 播放列表抽屉
const showPlaylist = ref(false)
const togglePlaylist = () => {
  showPlaylist.value = !showPlaylist.value
}

// 从播放页打开发送播放列表时使用（只负责打开，不切换）
const openPlaylist = () => {
  showPlaylist.value = true
}

const handlePlaylistClick = (song: PlayerSong) => {
  player.setCurrentSong(song)
  // 触发播放逻辑 (依赖 watch)
}

// 进度条拖拽状态
const isDraggingProgress = ref(false)
const dragValue = ref(0)

// 当前进度映射为 0-100 百分比
const progressPercent = computed(() => {
  if (isDraggingProgress.value) return dragValue.value
  if (!player.currentSong || player.currentSong.durationMs <= 0) return 0
  return (player.positionMs / player.currentSong.durationMs) * 100
})

const handleProgressUpdate = (val: number) => {
  // 如果没有在拖拽状态（例如键盘操作），也需要更新 dragValue
  dragValue.value = val

  // 支持键盘操作或未被捕获的交互
  if (!isDraggingProgress.value) {
    if (!player.currentSong || player.currentSong.durationMs <= 0) return
    const ratio = Math.min(Math.max(val, 0), 100) / 100
    const targetMs = player.currentSong.durationMs * ratio
    webAudioEngine.seek(targetMs)
  }
}

const startDrag = () => {
  // 初始化 dragValue 为当前进度，防止跳变
  if (player.currentSong && player.currentSong.durationMs > 0) {
    dragValue.value = (player.positionMs / player.currentSong.durationMs) * 100
  } else {
    dragValue.value = 0
  }
  
  isDraggingProgress.value = true
  window.addEventListener('mouseup', endDrag)
  window.addEventListener('touchend', endDrag)
}

const endDrag = () => {
  if (!isDraggingProgress.value) return
  
  isDraggingProgress.value = false
  window.removeEventListener('mouseup', endDrag)
  window.removeEventListener('touchend', endDrag)
  
  if (!player.currentSong || player.currentSong.durationMs <= 0) return

  const ratio = Math.min(Math.max(dragValue.value, 0), 100) / 100
  const targetMs = player.currentSong.durationMs * ratio
  
  webAudioEngine.seek(targetMs)
}

// 音量使用 0-100 的滑块值
const volumePercent = computed({
  get: () => Math.round(player.volume * 100),
  set: (val: number) => {
    const v = val / 100
    player.setVolume(v)
    webAudioEngine.setVolume(v)
  }
})

const volumeSliderRef = ref<HTMLElement | null>(null)
const isDraggingVolume = ref(false)

const updateVolumeFromClientY = (clientY: number) => {
  const el = volumeSliderRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const ratio = 1 - (clientY - rect.top) / rect.height
  const clamped = Math.min(Math.max(ratio, 0), 1)
  volumePercent.value = Math.round(clamped * 100)
}

const handleVolumeSliderMouseDown = (e: MouseEvent) => {
  isDraggingVolume.value = true
  updateVolumeFromClientY(e.clientY)
  window.addEventListener('mousemove', handleVolumeSliderMouseMove)
  window.addEventListener('mouseup', handleVolumeSliderMouseUp)
}

const handleVolumeSliderMouseMove = (e: MouseEvent) => {
  if (!isDraggingVolume.value) return
  updateVolumeFromClientY(e.clientY)
}

const handleVolumeSliderMouseUp = () => {
  if (!isDraggingVolume.value) return
  isDraggingVolume.value = false
  window.removeEventListener('mousemove', handleVolumeSliderMouseMove)
  window.removeEventListener('mouseup', handleVolumeSliderMouseUp)
}

const handleVolumeSliderClick = (e: MouseEvent) => {
  updateVolumeFromClientY(e.clientY)
}

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', handleVolumeSliderMouseMove)
  window.removeEventListener('mouseup', handleVolumeSliderMouseUp)
})

// 已播放时间（秒），用于显示为分钟:秒
const playedSeconds = computed(() => Math.floor(player.positionMs / 1000))

// 总时长（秒），用于显示为分钟:秒
const totalSeconds = computed(() => {
  if (!player.currentSong || player.currentSong.durationMs <= 0) return 0
  return Math.floor(player.currentSong.durationMs / 1000)
})

// 将秒格式化为 mm:ss
const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  const mm = m.toString().padStart(2, '0')
  const ss = s.toString().padStart(2, '0')
  return `${mm}:${ss}`
}

// 判断当前环境是否支持 Media Session（用于 SMTC）
const supportsMediaSession =
  typeof navigator !== 'undefined' && (navigator as any).mediaSession !== undefined

// 更新 Media Session 的元数据（标题 / 艺术家 / 封面）
const updateMediaMetadata = () => {
  if (!supportsMediaSession) return

  const mediaSession = (navigator as any).mediaSession
  const MediaMetadataCtor = (window as any).MediaMetadata

  if (!MediaMetadataCtor) return

  const song = player.currentSong
  if (!song) {
    // 没有当前歌曲时不主动清空 metadata，避免被系统视为重建 SMTC
    return
  }

  const artworkSrc = song.cover || defaultCover

  // 尝试从 data URL 中解析封面 MIME 类型，保证与实际格式一致
  let artworkType = 'image/png'
  if (typeof artworkSrc === 'string' && artworkSrc.startsWith('data:')) {
    const mimeMatch = artworkSrc.slice(5).split(';', 1)[0]
    if (mimeMatch) {
      artworkType = mimeMatch
    }
  }

  mediaSession.metadata = new MediaMetadataCtor({
    title: song.title || '未选择歌曲',
    artist: song.artist || '',
    album: song.album || '',
    artwork: [
      {
        src: artworkSrc,
        sizes: '512x512',
        type: artworkType
      }
    ]
  })
}

// 更新 Media Session 的播放位置状态（用于系统进度条与拖动）
const updateMediaPositionState = () => {
  if (!supportsMediaSession) return

  const mediaSession = (navigator as any).mediaSession
  if (typeof mediaSession.setPositionState !== 'function') return

  const song = player.currentSong
  if (!song || !song.durationMs || song.durationMs <= 0) return

  mediaSession.setPositionState({
    duration: song.durationMs / 1000,
    position: player.positionMs / 1000,
    playbackRate: 1
  })
}

// 更新 Media Session 的播放状态（playing/paused/none）
const updateMediaPlaybackState = () => {
  if (!supportsMediaSession) return
  const mediaSession = (navigator as any).mediaSession

  if (!player.currentSong) {
    mediaSession.playbackState = 'none'
    return
  }

  mediaSession.playbackState = player.isPlaying ? 'playing' : 'paused'
}

// 确保 Media Session 的操作处理只注册一次
let mediaActionsRegistered = false

const ensureMediaSessionHandlers = () => {
  if (!supportsMediaSession || mediaActionsRegistered) return

  const mediaSession = (navigator as any).mediaSession
  mediaActionsRegistered = true

  // 播放
  mediaSession.setActionHandler('play', async () => {
    if (!player.isPlaying) {
      await webAudioEngine.play()
      player.setPlaying(true)
      updateMediaPlaybackState()
      updateMediaPositionState()
    }
  })

  // 暂停
  mediaSession.setActionHandler('pause', async () => {
    if (player.isPlaying) {
      await webAudioEngine.pause()
      player.setPlaying(false)
      updateMediaPlaybackState()
      updateMediaPositionState()
    }
  })

  // 上一首
  mediaSession.setActionHandler('previoustrack', () => {
    player.playPrev()
  })


  // 下一首
  mediaSession.setActionHandler('nexttrack', () => {
    player.playNext()
  })

  // 快退
  mediaSession.setActionHandler('seekbackward', (details: any) => {
    const offsetSec = details?.seekOffset ?? 10
    const targetMs = Math.max(0, player.positionMs - offsetSec * 1000)
    webAudioEngine.seek(targetMs)
  })

  // 快进
  mediaSession.setActionHandler('seekforward', (details: any) => {
    const offsetSec = details?.seekOffset ?? 10
    const targetMs = player.positionMs + offsetSec * 1000
    webAudioEngine.seek(targetMs)
  })

  // 跳转到指定时间
  mediaSession.setActionHandler('seekto', (details: any) => {
    if (typeof details?.seekTime !== 'number') return
    const targetMs = Math.max(0, details.seekTime * 1000)
    webAudioEngine.seek(targetMs)
  })
}

// 监听当前歌曲及其元数据变化，刷新 Media Session
watch(
  () => ({
    id: player.currentSong?.id,
    title: player.currentSong?.title,
    artist: player.currentSong?.artist,
    album: player.currentSong?.album,
    cover: player.currentSong?.cover
  }),
  () => {
    ensureMediaSessionHandlers()
    updateMediaMetadata()
    updateMediaPositionState()
  },
  { immediate: true }
)

// 监听播放状态，更新 Media Session 播放状态
watch(
  () => player.isPlaying,
  () => {
    if (!supportsMediaSession) return
    // 根据当前播放状态更新 Media Session
    updateMediaPlaybackState()
    updateMediaPositionState()
  },
  { immediate: true }
)

// 监听播放进度，定期更新位置状态
watch(
  () => player.positionMs,
  () => {
    // 这里直接调用，Web Audio 更新频率可接受
    updateMediaPositionState()
  }
)

// 任务栏进度（0-1 之间，小于 0 表示关闭显示）
const taskbarProgress = computed(() => {
  if (!settingsStore.general.taskbarProgress) return -1
  if (!player.currentSong || player.currentSong.durationMs <= 0) return -1
  return player.positionMs / player.currentSong.durationMs
})

let lastTaskbarProgress = -1

// 监听进度变化，同步到主进程以更新任务栏图标进度
watch(
  taskbarProgress,
  (val) => {
    if (!(window as any).electron?.ipcRenderer) return

    // 关闭显示时，发送 -1 重置任务栏进度
    if (val < 0) {
      if (lastTaskbarProgress === -1) return
      lastTaskbarProgress = -1
      window.electron.ipcRenderer.send('player:taskbarProgress', { progress: -1 })
      return
    }

    const clamped = Math.max(0, Math.min(val, 1))
    // 量化到 1% 精度，避免频繁 IPC
    const normalized = Math.round(clamped * 100) / 100
    if (normalized === lastTaskbarProgress) return
    lastTaskbarProgress = normalized

    window.electron.ipcRenderer.send('player:taskbarProgress', { progress: normalized })
  },
  { immediate: true }
)

const playlistContainerRef = ref<HTMLElement | null>(null)

// 播放列表来源下拉配置
const playlistSourceOptions = [
  { label: '搜索结果', key: 'search' },
  { label: '最近播放', key: 'recent' },
  { label: '本地音乐', key: 'local' }
]

const playlistSourceLabel = computed(() => {
  switch (player.playlistSource) {
    case 'local':
      return '本地音乐'
    case 'recent':
      return '最近播放'
    case 'search':
    default:
      return '搜索结果'
  }
})

const handlePlaylistSourceSelect = (key: string | number) => {
  player.playlistSource = key as any
}

const toggleFavorite = () => {
  if (!player.currentSong) return
  const isAdded = playlistStore.toggleFavorite({
    id: player.currentSong.id,
    title: player.currentSong.title,
    artist: player.currentSong.artist,
    album: player.currentSong.album,
    cover: player.currentSong.cover,
    filePath: (player.currentSong as any).filePath,
    durationMs: player.currentSong.durationMs,
    source: player.currentSong.source,
    sourceSongId: player.currentSong.sourceSongId
  })
  if (isAdded) {
    message.success('已添加到我喜爱的音乐')
  } else {
    message.success('已取消收藏')
  }
}

const isCurrentFavorite = computed(() => {
  if (!player.currentSong) return false
  return playlistStore.isFavorite({
    id: player.currentSong.id,
    title: player.currentSong.title,
    artist: player.currentSong.artist,
    source: player.currentSong.source,
    sourceSongId: player.currentSong.sourceSongId
  })
})

const handleRemove = (song: PlayerSong) => {
  if (song.id) {
    player.removeFromPlaylist(song.id)
  }
}

const handleClear = () => {
  player.clearPlaylist()
}

const scrollToCurrent = () => {
  if (!player.currentSong?.id || !playlistContainerRef.value) return
  
  const el = playlistContainerRef.value.querySelector(`#song-${player.currentSong.id}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

watch(showPlaylist, (val) => {
  if (val) {
    setTimeout(scrollToCurrent, 100)
  }
})
</script>

<template>
  <div class="player-bar">
    <PlayerPage @open-playlist="openPlaylist" />
    <!-- Progress Bar (Top) -->
    <div class="progress-wrapper" @mousedown="startDrag" @touchstart="startDrag">
      <n-slider
        :value="progressPercent"
        :tooltip="false"
        class="main-progress"
        @update:value="handleProgressUpdate"
        @update:value-end="endDrag"
      />
    </div>

    <!-- Song Info -->
    <div class="song-info">
      <img
        :src="player.currentSong?.cover || defaultCover"
        class="cover-image"
        style="cursor: pointer"
        @click="player.setPlayerPageShown(true)"
      />
      <Transition name="song-slide" mode="out-in">
        <div :key="player.currentSong?.id || 'empty'" class="song-details">
          <div class="song-title-row">
            <n-text strong class="song-title">
              {{ player.currentSong?.title || '未选择歌曲' }}
            </n-text>
            <n-button text @click="toggleFavorite">
              <n-icon size="18" :color="isCurrentFavorite ? '#d03050' : undefined">
                <i :class="isCurrentFavorite ? 'mgc_heart_fill' : 'mgc_heart_line'"></i>
              </n-icon>
            </n-button>
          </div>
          <n-text depth="3" class="song-artist">
            {{ player.currentSong?.artist || '未知歌手' }}
          </n-text>
        </div>
      </Transition>
    </div>

    <!-- Controls (Center) -->
    <div class="player-controls">
      <div class="control-buttons">
        <n-button strong circle quaternary class="control-btn" @click="toggleMode"
          ><n-icon size="20"><i :class="modeIcon"></i></n-icon
        ></n-button>
        <n-button strong circle quaternary class="control-btn" @click="handlePrev"
          ><n-icon size="22"><i class="mgc_skip_previous_fill"></i></n-icon
        ></n-button>
        <n-button strong circle secondary style="width: 44px; height: 44px" @click="togglePlay">
          <n-icon size="22">
            <i :class="player.isPlaying ? 'mgc_pause_line' : 'mgc_play_fill'"></i>
          </n-icon>
        </n-button>
        <n-button strong circle quaternary class="control-btn" @click="handleNext"
          ><n-icon style="margin: 3px" size="22"><i class="mgc_skip_forward_fill"></i></n-icon
        ></n-button>
        <n-button strong circle quaternary class="control-btn" @click="toggleFavorite">
          <n-icon size="20" :color="isCurrentFavorite ? '#d03050' : undefined">
            <i :class="isCurrentFavorite ? 'mgc_heart_fill' : 'mgc_heart_line'"></i>
          </n-icon>
        </n-button>
      </div>
    </div>

    <!-- Right Actions -->
    <div class="player-actions">
      <span class="time-text">
        {{ formatTime(playedSeconds) }} / {{ formatTime(totalSeconds) }}
      </span>
      <n-button 
        quaternary 
        class="action-btn" 
        :type="isDesktopLyricOpen ? 'primary' : 'default'"
        @click="toggleDesktopLyric"
      >
        <n-icon size="22" style="margin-left: -5px"><i class="mgc_text_line"></i></n-icon>
      </n-button>
      <n-button 
        quaternary 
        class="action-btn"
        style="display: none;"
        :type="isTaskbarLyricOpen ? 'primary' : 'default'"
        @click="toggleTaskbarLyric"
        title="任务栏歌词"
      >
        <n-icon size="22" style="margin-left: -5px"><i class="mgc_text_line"></i></n-icon>
      </n-button>
      <n-button quaternary class="action-btn"
        ><n-icon size="22" style="margin-left: -5px"><i class="mgc_settings_2_line"></i></n-icon
      ></n-button>

      <div class="volume-control">
        <n-popover trigger="hover"> 
          <template #trigger>
            <n-button style="width: 40px; height: 40px" quaternary class="action-btn">
              <n-icon size="22" style="margin-left: -4px"><i class="mgc_volume_line"></i></n-icon
            ></n-button>
          </template>
          <div class="volume-slider-pop">
            <div
              ref="volumeSliderRef"
              class="volume-slider-vertical"
              @mousedown.prevent="handleVolumeSliderMouseDown"
              @click.stop="handleVolumeSliderClick"
            >
              <div class="volume-slider-track">
                <div class="volume-slider-fill" :style="{ height: `${volumePercent}%` }" />
                <div class="volume-slider-thumb" :style="{ bottom: `${volumePercent}%` }" />
              </div>
            </div>
          </div>
        </n-popover>
      </div>
      <n-badge :value="player.playlist.length" :max="999" :bordered="false" :show="player.playlist.length > 0">
        <n-button style="width: 40px; height: 40px" quaternary class="action-btn" @click="togglePlaylist"
          ><n-icon size="22" style="margin-left: -4px"><i class="mgc_playlist_2_fill"></i></n-icon
        ></n-button>
      </n-badge>
    </div>

    <n-drawer v-model:show="showPlaylist" :width="400" placement="right">
      <n-drawer-content :native-scrollbar="false" body-content-style="padding: 0;">
        <template #header>
          <div class="playlist-header">
            <div class="playlist-title">播放队列</div>
            <div class="playlist-header-right">
              <n-dropdown
                trigger="click"
                :options="playlistSourceOptions"
                @select="handlePlaylistSourceSelect"
              >
                <n-button text size="small" class="playlist-source-btn">
                  <n-icon size="16" style="margin-right: 4px">
                    <i class="mgc_list_check_2_line" />
                  </n-icon>
                  <span>{{ playlistSourceLabel }}</span>
                  <n-icon size="14" style="margin-left: 2px">
                    <i class="mgc_down_small_line" />
                  </n-icon>
                </n-button>
              </n-dropdown>
              <div class="playlist-count">{{ player.playlist.length }} 首歌曲</div>
            </div>
          </div>
        </template>
        
        <div ref="playlistContainerRef" style="padding: 12px;">
           <n-empty v-if="player.playlist.length === 0" description="暂无歌曲" style="margin-top: 40px;" />
           <div 
             v-else
             v-for="(song, index) in player.playlist" 
             :key="song.id || index"
             class="playlist-item"
             :class="{ active: player.currentSong?.id === song.id }"
             @click="handlePlaylistClick(song)"
             :id="'song-' + song.id"
           >
             <div class="item-index">
               <n-icon v-if="player.currentSong?.id === song.id" :color="themeVars.primaryColor"><i class="mgc_music_fill"></i></n-icon>
               <span v-else>{{ index + 1 }}</span>
             </div>
             <div class="item-info">
               <div class="item-title" :class="{ 'active-text': player.currentSong?.id === song.id }">{{ song.title }}</div>
               <div class="item-artist">{{ song.artist }}</div>
             </div>
             <div class="item-actions">
               <n-button text class="delete-btn" @click.stop="handleRemove(song)">
                 <n-icon size="18"><i class="mgc_delete_line"></i></n-icon>
               </n-button>
             </div>
           </div>
        </div>

        <template #footer>
          <div class="playlist-footer">
             <n-button class="footer-btn" quaternary @click="handleClear">
               <template #icon><n-icon><i class="mgc_delete_2_line"></i></n-icon></template>
               清空列表
             </n-button>
             <n-button class="footer-btn" secondary type="primary" @click="scrollToCurrent">
               <template #icon><n-icon><i class="mgc_target_line"></i></n-icon></template>
               当前播放
             </n-button>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.player-bar {
  position: relative;
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 100%;
  padding: 12px 13px 13px;
  background-color: #fff;
}

html[data-theme='dark'] .player-bar {
  background-color: #18181c !important;
}

.progress-wrapper {
  position: absolute;
  top: -3px; /* Pull it up to overlap the border */
  left: 0;
  width: 100%;
  height: 4px; /* Interaction area */
  z-index: 10;
  display: flex;
  align-items: center;
  cursor: pointer;
}

.action-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}

:deep(.n-slider .n-slider-rail) {
  height: 2px;
}

:deep(.n-badge .n-badge-sup) {
  font-size: 10px;
  /* 使用主题前景色作为文字颜色，保证深浅色模式下都有良好对比度 */
  color: v-bind('themeVars.baseColor');
  /* 使用主题主色作为徽标背景，增强可读性 */
  background-color: v-bind('themeVars.primaryColor');
}

:deep(.n-slider .n-slider-rail .n-slider-rail__fill) {
  width: 2px;
  height: 2px;
}

:deep(.n-slider .n-slider-handle) {
  width: 0;
  height: 0;
  transition: all 0.2s;
  opacity: 0;
}

:deep(.n-slider:hover .n-slider-handle) {
  width: 10px;
  height: 10px;
  opacity: 1;
}

.song-info {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 300px;
  overflow: hidden;
}

.song-slide-enter-active,
.song-slide-leave-active {
  transition: all 0.3s ease;
}

.song-slide-enter-from {
  opacity: 0;
  transform: translateX(10px);
}

.song-slide-leave-to {
  opacity: 0;
  transform: translateX(-10px);
}

.cover-image {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
}

.song-details {
  display: flex;
  flex-direction: column;
  justify-content: center;
  overflow: hidden;
}

.song-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.song-title {
  font-size: 15px;
  white-space: nowrap;
  transform: translateY(1px);
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
}

.song-artist {
  font-size: 12px;
  transform: translateY(-0.5px);
}

.icon-btn {
  cursor: pointer;
  color: #666;
}

.icon-btn:hover {
  color: #000;
}

.player-controls {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
}

.control-buttons {
  display: flex;
  align-items: center;
  gap: 16px;
}

.play-pause-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background-color: #eee; /* Light gray background */
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 0.2s;
}

.play-pause-btn:hover {
  background-color: #ddd;
}

.player-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 16px;
  width: auto; /* Allow flexible width */
  min-width: 300px;
  justify-content: flex-end;
}

.time-text {
  font-size: 14px;
  color: #666;
  font-variant-numeric: tabular-nums;
  margin-right: 8px;
}

.playlist-count-badge {
  font-size: 10px;
  background-color: #eee;
  padding: 2px 6px;
  border-radius: 10px;
  color: #666;
}

.volume-slider-pop {
  height: 100px;
  padding: 8px 0px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.volume-slider-vertical {
  width: 10px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.volume-slider-track {
  position: relative;
  width: 3.5px;
  height: 100%;
  border-radius: 999px;
  background-color: rgba(0, 0, 0, 0.12);
}

.volume-slider-fill {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  border-radius: inherit;
  background-color: #2c8efd;
}

.volume-slider-thumb {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background-color: #ffffff;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.685);
}

.playlist-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.playlist-title {
  font-size: 18px;
  font-weight: bold;
}

.playlist-count {
  font-size: 12px;
  opacity: 0.6;
}

.playlist-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.playlist-source-btn {
  padding: 0 8px;
  font-size: 12px;
}

.playlist-footer {
  display: flex;
  gap: 12px;
  width: 100%;
}

.footer-btn {
  flex: 1;
  height: 40px;
}

.playlist-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.2s;
  background-color: rgba(0, 0, 0, 0.02);
}

html[data-theme='dark'] .playlist-item {
  background-color: rgba(255, 255, 255, 0.04);
}

.playlist-item:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

html[data-theme='dark'] .playlist-item:hover {
  background-color: rgba(255, 255, 255, 0.08);
}

.playlist-item.active {
  border: 1px solid v-bind('themeVars.primaryColor');
  background-color: v-bind('mixHexColor(themeVars.primaryColor, "#ffffff", 0.05)');
}

html[data-theme='dark'] .playlist-item.active {
  background-color: v-bind('mixHexColor(themeVars.primaryColor, "#000000", 0.15)');
}

.item-index {
  width: 32px;
  text-align: center;
  font-size: 14px;
  color: #999;
  display: flex;
  align-items: center;
  justify-content: center;
}

.item-info {
  flex: 1;
  margin-left: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.item-title {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.active-text {
  color: v-bind('themeVars.primaryColor');
}

.item-artist {
  font-size: 12px;
  color: #888;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-actions {
  opacity: 0;
  transition: opacity 0.2s;
  margin-left: 8px;
}

.playlist-item:hover .item-actions {
  opacity: 1;
}

.delete-btn {
  color: #999;
}

.delete-btn:hover {
  color: #ff4d4f;
}
</style>
