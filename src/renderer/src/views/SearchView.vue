<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import SongList from '../components/common/SongList.vue'
import { useSettingsStore } from '../stores/settingsStore'
import { cloudSearch } from '../apis/netease/search'
import { fetchNewLyric } from '../apis/netease/lyric'
import { usePlayerStore } from '../stores/playerStore'
import { webAudioEngine } from '../audio/audio-engine'
import { runSnowdropGetMusicUrl } from '../apis/snowdrop-transform'

const route = useRoute()
const router = useRouter()
const settingsStore = useSettingsStore()
const playerStore = usePlayerStore()
const message = useMessage()

const keywords = ref('')
const selectedPlatform = ref('netease') // Default to netease for now
const loading = ref(false)
const searchResults = ref<any[]>([])
const hasMore = ref(false)
const offset = ref(0)
const limit = 30
const loadingMore = ref(false)

// Initialize
onMounted(() => {
  if (route.query.q) {
    keywords.value = String(route.query.q)
  }
  if (route.query.platform) {
    selectedPlatform.value = String(route.query.platform)
  } else if (settingsStore.source.preferredPlatform && settingsStore.source.preferredPlatform !== 'all') {
      // Check if preferred platform is supported
      if (settingsStore.source.preferredPlatform === 'netease') {
          selectedPlatform.value = 'netease'
      }
  }
  
  if (keywords.value) {
      handleSearch()
  }
})

const updateRoute = () => {
  router.replace({ query: { ...route.query, q: keywords.value, platform: selectedPlatform.value } })
}

const handleSearch = async () => {
  if (!keywords.value.trim()) return
  
  loading.value = true
  searchResults.value = []
  offset.value = 0
  hasMore.value = false
  updateRoute()

  try {
    if (selectedPlatform.value === 'netease') {
      const res = await cloudSearch(keywords.value, 1, limit, offset.value)
      if (res && res.result && res.result.songs) {
        searchResults.value = res.result.songs.map(song => ({
          ...song,
          // Map to SongList expected format if needed
          // SongList uses: id, name, ar/artists, al/album, dt, picUrl
          // cloudSearch returns: id, name, ar, al, dt, al.picUrl
        }))
        hasMore.value = (res.result.songCount || 0) > searchResults.value.length
      } else {
        searchResults.value = []
        hasMore.value = false
      }
    } else {
      message.info('该平台搜索暂未实现')
      searchResults.value = []
    }
  } catch (error) {
    console.error(error)
    message.error('搜索失败')
  } finally {
    loading.value = false
  }
}

const handleScroll = (e: Event) => {
    const target = e.target as HTMLElement
    // Check if near bottom
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 100) {
        if (!loadingMore.value && hasMore.value && !loading.value) {
            handleLoadMore()
        }
    }
}

const handleLoadMore = async () => {
  if (loadingMore.value || !hasMore.value) return
  
  loadingMore.value = true
  offset.value += limit
  
  try {
    if (selectedPlatform.value === 'netease') {
      const res = await cloudSearch(keywords.value, 1, limit, offset.value)
      if (res && res.result && res.result.songs) {
        const newSongs = res.result.songs.map(song => ({ ...song }))
        searchResults.value.push(...newSongs)
        hasMore.value = (res.result.songCount || 0) > searchResults.value.length
      }
    }
  } catch (error) {
    message.error('加载更多失败')
  } finally {
    loadingMore.value = false
  }
}

// 处理歌曲点击播放
const handleSongClick = async (song: any) => {
  // 如果当前选中的平台不是网易云，暂不支持
  if (selectedPlatform.value !== 'netease') {
    message.warning('当前仅支持网易云音乐播放')
    return
  }

  try {
    message.loading('正在获取播放链接...')

    // 构造插件需要的 musicInfo
    const musicInfo = {
      id: String(song.id),
      name: song.name,
      singer: song.ar?.map((a) => a.name).join(' / ') || '未知歌手',
      albumName: song.al?.name || '未知专辑',
      pic: song.al?.picUrl || '',
      // 网易云特有字段
      songmid: String(song.id),
      mediaId: String(song.id)
    }

    // 获取首选音源平台和音质
    const source =
      settingsStore.source.preferredPlatform === 'all'
        ? 'wy'
        : settingsStore.source.preferredPlatform
    const quality = settingsStore.source.preferredQuality || '128k'

    // 并行请求播放链接和歌词，提升响应速度
    const lyricPromise = fetchNewLyric(song.id).catch((err) => {
      console.error('获取歌词失败:', err)
      return null
    })

    // 调用插件获取 URL，并通过主进程缓存
    const { url } = await runSnowdropGetMusicUrl(source, musicInfo, quality)

    if (!url) {
      throw new Error('未获取到播放链接')
    }

    // 生成缓存键：平台 + 歌曲 ID + 音质
    const cacheKey = `netease:${song.id}:${quality}`
    let finalUrl = url
    let cacheFilePath: string | null = null

    if (window.electron && window.electron.ipcRenderer) {
      try {
        const cacheResult = (await window.electron.ipcRenderer.invoke('online-cache:prepare', {
          dir: settingsStore.local.cacheDir || null,
          key: cacheKey,
          url
        })) as { usedCache: boolean; filePath: string | null; url: string }

        if (cacheResult.filePath) {
          // 记录本地缓存文件路径，用于走本地文件播放链路
          cacheFilePath = cacheResult.filePath
          // finalUrl 保留为可展示/记录的在线地址（或重定向后的地址）
          finalUrl = cacheResult.url || url
          console.log('[OnlineCache] 使用缓存文件播放', {
            cacheKey,
            filePath: cacheFilePath,
            usedCache: cacheResult.usedCache,
            url: cacheResult.url
          })
        }
      } catch (e) {
        console.error('准备在线播放缓存失败:', e)
        // 出错时回退为直接使用远程 URL
      }
    }

    // 等待歌词结果（失败则回退为空字符串）
    const lyricRes = await lyricPromise
    let lyrics = ''
    if (lyricRes && lyricRes.code === 200) {
      // 优先使用逐字歌词，其次回退到普通 LRC 等
      lyrics =
        lyricRes.yrc?.lyric ||
        lyricRes.lrc?.lyric ||
        lyricRes.klyric?.lyric ||
        lyricRes.tlyric?.lyric ||
        lyricRes.romalrc?.lyric ||
        ''
    }

    // 构造播放器需要的 Song 对象
    const playerSong = {
      id: song.id,
      title: song.name,
      artist: song.ar?.map((a) => a.name).join(' / ') || '未知歌手',
      album: song.al?.name || '未知专辑',
      cover: song.al?.picUrl || '',
      durationMs: song.dt || 0,
      // 记录来源平台与平台内原始 ID，供评论等功能使用
      source: 'netease',
      sourceSongId: song.id,
      // 如果有本地缓存文件，则记录 filePath，后续从歌单等位置播放时可直接走本地缓存
      filePath: cacheFilePath || undefined,
      url: finalUrl, // 播放链接（可能为本地缓存文件对应的在线地址）
      lyrics // 歌词内容
    }

    // 设置搜索来源播放列表：当前点击的歌曲填充 URL / 歌词 / 本地缓存路径
    const newPlaylist = searchResults.value.map((s) => ({
      id: s.id,
      title: s.name,
      artist: s.ar?.map((a) => a.name).join(' / ') || '未知歌手',
      album: s.al?.name || '未知专辑',
      cover: s.al?.picUrl || '',
      durationMs: s.dt || 0,
      source: 'netease',
      sourceSongId: s.id,
      url: s.id === song.id ? finalUrl : '',
      lyrics: s.id === song.id ? lyrics : '',
      filePath: s.id === song.id ? cacheFilePath || undefined : undefined
    }))

    // 更新播放器列表与当前歌曲
    playerStore.setPlaylistForSource('search', newPlaylist, true)

    // 播放：优先使用本地缓存文件，其次使用远程 URL
    if (cacheFilePath && window.electron && window.electron.ipcRenderer) {
      try {
        const data = (await window.electron.ipcRenderer.invoke(
          'audio:load-file',
          cacheFilePath
        )) as ArrayBuffer
        webAudioEngine.setVolume(playerStore.volume)
        await webAudioEngine.playFromFileData(data)
      } catch (e) {
        console.error('从缓存文件播放失败，回退到在线播放:', e)
        await webAudioEngine.playFromUrl(finalUrl)
      }
    } else {
      await webAudioEngine.playFromUrl(finalUrl)
    }

    // 同步 store 状态
    playerStore.setCurrentSong(playerSong)
    playerStore.setPlaying(true)

    message.success('开始播放')

  } catch (error: any) {
    console.error('播放失败:', error)
    message.error(`播放失败: ${error.message || '未知错误'}`)
  }
}

watch(() => route.query, (newQuery) => {
  if (newQuery.q && newQuery.q !== keywords.value) {
    keywords.value = String(newQuery.q)
    handleSearch()
  }
})
</script>

<template>
  <div class="search-view">
    <div class="search-header">
      <h1>{{ keywords }} 的搜索结果</h1>
    </div>
    
    <div class="search-content">
      <SongList 
        :songs="searchResults" 
        :loading="loading || loadingMore"
        :load-more="loadingMore"
        @scroll="handleScroll"
        @song-click="handleSongClick"
      />
    </div>
  </div>
</template>

<style scoped>
.search-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 24px 0;
  box-sizing: border-box;
}

.search-header {
  display: flex;
  font-weight: 900;
  gap: 12px;
  margin-bottom: 6px;
  align-items: center;
}

.search-input-wrapper {
  flex: 1;
}

.platform-select {
  width: 160px;
}

.search-content {
  flex: 1;
  overflow: hidden;
  position: relative;
  /* SongList takes full height */
}
</style>
