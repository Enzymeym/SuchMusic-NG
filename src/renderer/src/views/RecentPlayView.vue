<template>
  <div class="local-music-view">
    <div class="header">
      <div class="title">
        最近播放
        <span class="subtitle">
          <i class="mgc_music_2_fill"></i> {{ songs.length }} 首</span>
      </div>
      <div class="actions">
        <div style="display: flex; gap: 10px">
          <n-button
            type="primary"
            style="padding: 0 16px; font-size: 15px;"
            size="large"
            secondary
            round
            @click="playAll"
          >
            <template #icon>
              <n-icon size="14">
                <i class="mgc_play_fill"></i>
              </n-icon>
            </template>
            播放
          </n-button>
          <n-button secondary strong circle size="large" @click="refreshHistory">
            <template #icon>
              <n-icon size="20">
                <i class="mgc_refresh_2_line"></i>
              </n-icon>
            </template>
          </n-button>
        </div>
        <n-input
          v-model:value="searchKeyword"
          placeholder="模糊搜索"
          clearable
          size="large"
          round
          class="search-input"
          style="width: 200px"
        >
          <template #prefix>
            <n-icon size="18" color="#999">
              <i class="mgc_search_2_line"></i>
            </n-icon>
          </template>
        </n-input>
      </div>
    </div>

    <div class="content">
      <SongList
        :songs="filteredSongs"
        :loading="false"
        :current-playing-song-id="player.currentSong?.id ?? null"
        :menu-options="contextMenuOptions"
        @song-click="handleSongClick"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, h } from 'vue'
import { NButton, NIcon, useMessage, NInput } from 'naive-ui'
import SongList from '../components/common/SongList.vue'
import { usePlayerStore } from '../stores/playerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { fetchGMALyric } from '../apis/gma'
import { runSnowdropGetMusicUrl } from '../apis/snowdrop-transform'
import { AudioPlayerManager } from '../utils/audioPlayerManager'
import { fetchNewLyric } from '../apis/netease/lyric'

interface RecentSong {
  id: string | number
  name: string
  al?: { name: string; picUrl?: string }
  ar?: { name: string }[]
  dt?: number
  picUrl?: string
  filePath?: string
  source?: string
  sourceSongId?: string | number
}

const player = usePlayerStore()
const settingsStore = useSettingsStore()
const songs = ref<RecentSong[]>([])
const searchKeyword = ref('')
const message = useMessage()

const buildSongsFromHistory = () => {
  // 使用 Map 按 songId 去重，保留最新一次播放记录
  const seen = new Set<string | number>()
  const uniqueSongs: RecentSong[] = []

  for (const r of player.playHistory) {
    if (seen.has(r.songId)) continue
    seen.add(r.songId)

    uniqueSongs.push({
      id: r.songId,
      name: r.title,
      al: r.album ? { name: r.album } : undefined,
      ar: r.artist
        ? r.artist.split(/[/,]/).map((n) => ({ name: n.trim() })).filter((a) => a.name)
        : [{ name: '未知歌手' }],
      // 优先使用历史记录中的封面；如果为空则留空，后续尝试从本地文件补充
      picUrl: r.cover || undefined,
      filePath: r.filePath,
      // 补充来源信息：
      // 1. 如果 PlayRecord 中有 source，直接使用
      // 2. 如果没有，但有 filePath，则视为 local
      // 3. 否则默认假设为 netease
      source: (r as any).source || (r.filePath ? 'local' : 'netease'),
      sourceSongId: r.songId
    })
  }

  songs.value = uniqueSongs
}

// 尝试为缺失封面的最近播放记录补充本地封面
const fillMissingCoversFromMeta = async () => {
  const hasIpc = (window as any).electron?.ipcRenderer
  if (!hasIpc) return

  const targets = songs.value.filter((song) => !song.picUrl && song.filePath)
  if (!targets.length) return

  await Promise.all(
    targets.map(async (song) => {
      try {
        const result = (await window.electron.ipcRenderer.invoke(
          'local-music:get-meta',
          song.filePath
        )) as {
          cover?: { mimeType: string; base64: string }
        }

        if (result.cover?.mimeType && result.cover.base64) {
          // 通过本地 meta 生成封面 data URL
          song.picUrl = `data:${result.cover.mimeType};base64,${result.cover.base64}`
        }
      } catch (error) {
        console.error('加载最近播放封面失败:', error)
      }
    })
  )
}

const filteredSongs = computed(() => {
  if (!searchKeyword.value) return songs.value
  const keyword = searchKeyword.value.toLowerCase().trim()
  return songs.value.filter((song) => {
    const name = song.name?.toLowerCase() || ''
    const artist =
      (song.ar && song.ar.map((a) => a.name).join(' / ').toLowerCase()) || '未知歌手'
    const album = (song.al?.name || '').toLowerCase()
    return name.includes(keyword) || artist.includes(keyword) || album.includes(keyword)
  })
})

onMounted(() => {
  // 确保历史已加载
  player.loadHistory()
  buildSongsFromHistory()
  void fillMissingCoversFromMeta()
})

const renderIcon = (iconClass: string) => {
  return () => h(NIcon, null, { default: () => h('i', { class: iconClass }) })
}

const contextMenuOptions = [
  { label: '播放', key: 'play', icon: renderIcon('mgc_play_circle_line') }
]

const handleSongClick = async (song: RecentSong) => {
  // 1. 本地歌曲播放逻辑
  if (typeof song.id === 'string' && (song.id.includes(':\\') || song.id.includes(':/'))) {
    
    // 检查文件是否存在
    let exists = false
    if ((window as any).electron?.ipcRenderer) {
      exists = await (window as any).electron.ipcRenderer.invoke('system:fs-exists', song.id)
    }

    // 构造本地歌曲对象
    const playerSong = {
      id: song.id,
      title: song.name,
      artist: (song.ar || []).map((a) => a.name).join(' / ') || '未知歌手',
      album: song.al?.name || '未知专辑',
      cover: song.picUrl || '',
      durationMs: song.dt || 0,
      filePath: exists ? (song.id as string) : undefined // 如果文件不存在，清除 filePath
    }
    
    // 构造播放列表（过滤出所有本地歌曲）
    const localSongs = songs.value
      .filter(s => typeof s.id === 'string' && (s.id.includes(':\\') || s.id.includes(':/')))
      .map(s => ({
        id: s.id,
        title: s.name,
        artist: (s.ar || []).map((a) => a.name).join(' / ') || '未知歌手',
        album: s.al?.name || '未知专辑',
        cover: s.picUrl || '',
        durationMs: s.dt || 0,
        filePath: s.id as string
      }))

    player.setPlaylistForSource('recent', localSongs)
    player.currentSong = playerSong
    player.currentIndex = localSongs.findIndex(s => s.id === song.id)
    player.isPlaying = true
    
    // 调用播放引擎
    if (exists && playerSong.filePath) {
      try {
        await AudioPlayerManager.play({
          filePath: playerSong.filePath,
          volume: player.volume
        })
      } catch (e) {
        console.error('Failed to play local file from recent view:', e)
      }
    } else {
       console.warn('[RecentPlayView] Local file missing, delegating to PlayerBar fallback:', song.id)
       // 文件不存在，不显式调用 AudioPlayerManager.play
       // 由于 setPlaying(true) 且 currentSong 改变，PlayerBar 的 watch 会触发
       // PlayerBar 发现 filePath 为 undefined，会自动进入 Search Fallback 流程
    }
    return
  }

  // 2. 在线歌曲播放逻辑
  try {
    let source = song.source || 'wy' // 默认网易云(wy)，后续可扩展
    // 映射旧版 source 代码到新版
    switch (source) {
      case 'netease': source = 'wy'; break;
      case 'qq': source = 'tx'; break;
      case 'kugou': source = 'kg'; break;
      case 'kuwo': source = 'kw'; break;
      case 'migu': source = 'mg'; break;
    }
    const quality = settingsStore.source.preferredQuality || '128k'
    
    // 获取歌曲 ID
    const neteaseId = song.id

    // 歌词重试获取函数
    const fetchLyricWithRetry = async (id: string, source: string): Promise<string> => {
      let attempt = 0
      while (true) {
        // 检查当前播放歌曲是否改变，如果改变则停止重试
        const currentId = player.currentSong?.sourceSongId ?? player.currentSong?.id
        if (String(currentId) !== String(id)) {
          return ''
        }

        try {
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
             const lrc = await fetchGMALyric(id, source)
             if (lrc) return lrc
          }
        } catch (e) {
          console.warn(`获取歌词失败，第 ${attempt + 1} 次重试:`, e)
        }
        
        attempt++
        // 指数退避策略，最大延迟 5 秒
        const delay = Math.min(500 + attempt * 500, 5000)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    // 构造 MusicInfo 供插件使用
    const musicInfo = {
      id: String(neteaseId),
      name: song.name,
      singer: (song.ar || []).map((a) => a.name).join(' / ') || '未知歌手',
      albumName: song.al?.name || '未知专辑',
      pic: song.picUrl || '',
      songmid: String(neteaseId),
      mediaId: String(neteaseId)
    }

    // 启动获取歌词（异步）
    const lyricPromise = fetchLyricWithRetry(String(neteaseId), source).catch(() => '')

    // 缓存处理：先检查是否存在缓存
    let cacheFilePath: string | null = null
    const cacheKey = `${source}:${neteaseId}:${quality}`
    
    if (window.electron && window.electron.ipcRenderer) {
      try {
        const cachePath = await window.electron.ipcRenderer.invoke('online-cache:check', {
           dir: settingsStore.local.cacheDir || null,
           key: cacheKey
        })
        if (cachePath) {
           console.log('[RecentPlayView] 主动检测到缓存文件存在', cachePath)
           cacheFilePath = cachePath
        }
      } catch (e) {
         console.warn('主动检测缓存失败:', e)
      }
    }

    let finalUrl = ''
    
    // 如果没有缓存，则获取在线 URL
    if (!cacheFilePath) {
       const { url } = await runSnowdropGetMusicUrl(source, musicInfo, quality)
       if (!url) {
         throw new Error('未获取到播放链接')
       }
       finalUrl = url

       // 准备缓存（下载/记录）
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

            if (cacheResult.filePath) {
              cacheFilePath = cacheResult.filePath
              finalUrl = cacheResult.url || url
            }
          } catch (e) {
            console.error('准备在线播放缓存失败:', e)
          }
       }
    } else {
       // 如果有缓存，finalUrl 可以为空，或者设置为 filePath (虽然 AudioPlayerManager 优先用 filePath)
       // 为了兼容性，保持为空
    }

    // 解析歌词
    const lyrics = await lyricPromise

    // 构造播放器歌曲对象
    const playerSong = {
      id: song.id,
      title: song.name,
      artist: (song.ar || []).map((a) => a.name).join(' / ') || '未知歌手',
      album: song.al?.name || '未知专辑',
      cover: song.picUrl || '',
      durationMs: song.dt || 0,
      source: source,
      sourceSongId: song.id,
      filePath: cacheFilePath || undefined,
      url: finalUrl,
      lyrics
    }

    // 构造播放列表（当前仅包含点击的这一首，或者可以包含整个最近播放列表的在线歌曲）
    // 为了体验一致性，这里我们将整个最近播放列表中的在线歌曲都加入播放列表
    const recentOnlineSongs = songs.value
      .filter(s => !(typeof s.id === 'string' && (s.id.includes(':\\') || s.id.includes(':/'))))
      .map(s => ({
        id: s.id,
        title: s.name,
        artist: (s.ar || []).map((a) => a.name).join(' / ') || '未知歌手',
        album: s.al?.name || '未知专辑',
        cover: s.picUrl || '',
        durationMs: s.dt || 0,
        source: s.source || 'netease',
        sourceSongId: s.id,
        // 仅当前歌曲填充 url 和 lyrics
        url: s.id === song.id ? finalUrl : '',
        lyrics: s.id === song.id ? lyrics : '',
        filePath: s.id === song.id ? (cacheFilePath || undefined) : undefined
      }))

    player.setPlaylistForSource('recent', recentOnlineSongs)
    player.currentSong = playerSong
    player.currentIndex = recentOnlineSongs.findIndex(s => s.id === song.id)
    player.isPlaying = true

    // 播放
    try {
      await AudioPlayerManager.play({
        filePath: cacheFilePath || undefined,
        url: finalUrl,
        volume: player.volume
      })
      message.success(cacheFilePath ? '从缓存播放' : '开始播放')
    } catch (e) {
      console.error('播放失败，尝试回退纯URL播放:', e)
      // 如果本地播放失败，且有 URL，则回退到 URL 播放
      if (finalUrl) {
         await AudioPlayerManager.play({
           url: finalUrl,
           volume: player.volume
         })
      } else {
         // 如果本来就是缓存播放且没有 URL (即 skipped fetch)，则此时可能需要重新 fetch URL
         // 但为了简化，这里假设 cacheFilePath 存在时文件通常可用。
         // 如果真的不可用，AudioPlayerManager 会报错。
         // 可以在这里补充 fetch URL 逻辑，但比较复杂。
         throw e
      }
    }

  } catch (error: any) {
    console.error('播放失败:', error)
    message.error(error.message || '播放失败')
  }
}

const playAll = (): void => {
  if (!songs.value.length) {
    message.info('当前没有最近播放记录')
    return
  }
  message.info('当前版本暂不支持从“最近播放”批量播放，请在其他页面播放')
}

const refreshHistory = (): void => {
  player.loadHistory()
  buildSongsFromHistory()
  void fillMissingCoversFromMeta()
  message.success('最近播放已刷新')
}
</script>

<style scoped>
.local-music-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 24px 0px;
  box-sizing: border-box;
}

.header {
  display: flex;
  background-color: #F6F6F6;
  justify-content: space-between;
  align-items: start;
  gap: 4px;
  flex-direction: column;
  margin-bottom: 14px;
  padding: 8px 1px 4px;
  z-index: 10;
  border-radius: 8px;
}

html[data-theme='dark'] .header {
  background-color: rgba(255, 255, 255, 0);
}

html[data-theme='dark'] .search-input {
  --n-color: rgba(255, 255, 255, 0.1) !important;
  --n-color-focus: rgba(255, 255, 255, 0.15) !important;
  --n-border: 1px solid rgba(255, 255, 255, 0.1) !important;
}

.title {
  font-size: 27px;
  font-weight: bold;
}

.subtitle {
  font-size: 14px;
  color: #999;
  margin-left: 8px;
}

.actions {
  display: flex;
  width: 100%;
  justify-content: space-between;
  align-items: center;
}

.content {
  flex: 1;
  overflow: hidden;
  border-radius: 8px;
}
</style>
