<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMessage, NTabs, NTabPane, NPopselect, NIcon, NButton, NScrollbar } from 'naive-ui'
import SongList from '../components/common/SongList.vue'
import { useSettingsStore } from '../stores/settingsStore'
import { searchMusic, fetchGMALyric, type GMASong } from '../apis/gma'
import { usePlayerStore } from '../stores/playerStore'
import { webAudioEngine } from '../audio/audio-engine'
import { AudioPlayerManager } from '../utils/audioPlayerManager'
import { runSnowdropGetMusicUrl } from '../apis/snowdrop-transform'
import { formatQuality, calculateBitrate } from '../utils/quality'

const route = useRoute()
const router = useRouter()
const settingsStore = useSettingsStore()
const playerStore = usePlayerStore()
const message = useMessage()

const keywords = ref('')
const selectedPlatform = ref<string | string[]>('all') // Default to 'all' for aggregated search
const searchType = ref<'song' | 'playlist'>('song')
const loading = ref(false)
const searchResults = ref<any[]>([])
const playlistResults = ref<any[]>([])
const hasMore = ref(false)
const offset = ref(0)
const limit = 30
const loadingMore = ref(false)

const platformOptions = [
  { label: '所有平台', value: 'all' },
  { label: '网易云音乐', value: 'wy' },
  { label: 'QQ音乐', value: 'tx' },
  { label: '酷狗音乐', value: 'kg' },
  { label: '酷我音乐', value: 'kw' }
]

const sortSongs = (songs: any[]) => {
  const order = settingsStore.general.searchResultOrder || ['tx', 'kg', 'wy', 'kw']
  const getScore = (source: string) => {
    const index = order.indexOf(source)
    return index === -1 ? 999 : index
  }
  return songs.sort((a, b) => {
    return getScore(a.source) - getScore(b.source)
  })
}

const selectedPlatformLabel = computed(() => {
  if (selectedPlatform.value === 'all' || (Array.isArray(selectedPlatform.value) && selectedPlatform.value.includes('all'))) {
    return '所有平台'
  }
  if (Array.isArray(selectedPlatform.value)) {
    // If 'all' is in the array, it takes precedence
    if (selectedPlatform.value.includes('all')) {
        return '所有平台'
    }
    if (selectedPlatform.value.length === 0) return '所有平台'
    if (selectedPlatform.value.length === 1) {
      const option = platformOptions.find(o => o.value === selectedPlatform.value[0])
      return option ? option.label : '未知平台'
    }
    if (selectedPlatform.value.length === 4) return '所有平台'
    return `已选 ${selectedPlatform.value.length} 个平台`
  }
  
  if (selectedPlatform.value === 'all') return '所有平台'

  const option = platformOptions.find(o => o.value === selectedPlatform.value)
  return option ? option.label : '未知平台'
})

const handleUpdatePlatform = (value: string | string[]) => {
    // Determine the new value
    let newValue: string[] = []
    if (Array.isArray(value)) {
        newValue = value
    } else {
        newValue = [value]
    }
    
    const hasAll = newValue.includes('all')
    const oldHasAll = Array.isArray(selectedPlatform.value) ? selectedPlatform.value.includes('all') : selectedPlatform.value === 'all'
    
    // Logic:
    // 1. If 'all' was just added (it wasn't there before), clear everything else and keep only 'all'.
    // 2. If 'all' was already there and user added something else, remove 'all'.
    // 3. If 'all' is removed (user deselected it), and list is empty, select 'all' back (default).
    // 4. If list becomes empty, select 'all'.
    
    if (hasAll && !oldHasAll) {
         // Case 1: 'all' selected newly
         selectedPlatform.value = ['all']
    } else if (hasAll && newValue.length > 1) {
         // Case 2: 'all' + others -> remove 'all'
         selectedPlatform.value = newValue.filter(v => v !== 'all')
    } else if (newValue.length === 0) {
         // Case 4: empty -> 'all'
         selectedPlatform.value = ['all']
    } else {
         selectedPlatform.value = newValue
    }
    
    handleSearch()
}

// Initialize
onMounted(() => {
  if (route.query.q) {
    keywords.value = String(route.query.q)
  }
  
  // Default to 'all' first
  selectedPlatform.value = ['all']
  
  if (route.query.platform) {
    // Check if platform is array or comma separated string or single string
    const platform = route.query.platform
    if (typeof platform === 'string') {
        if (platform.includes(',')) {
            selectedPlatform.value = platform.split(',')
        } else if (platform === 'all') {
            selectedPlatform.value = ['all']
        } else {
            selectedPlatform.value = [platform]
        }
    } else if (Array.isArray(platform)) {
         selectedPlatform.value = platform.map(p => String(p))
    }
  } else if (settingsStore.source.preferredPlatform) {
    // If settings have a preferred platform, use it (could be 'all' or specific)
    const pref = settingsStore.source.preferredPlatform
    if (pref === 'all') {
        selectedPlatform.value = ['all']
    } else {
        selectedPlatform.value = [pref]
    }
  }
  
  // Ensure it's always an array for NPopselect multiple mode to work correctly? 
  // NPopselect with multiple=true expects an array.
  if (!Array.isArray(selectedPlatform.value)) {
      if (selectedPlatform.value === 'all') {
          selectedPlatform.value = ['all']
      } else {
          selectedPlatform.value = [selectedPlatform.value]
      }
  }
  
  if (route.query.type) {
    // @ts-ignore
    searchType.value = String(route.query.type)
  }
  
  if (keywords.value) {
      handleSearch()
  }
})

const updateRoute = () => {
  const platform = Array.isArray(selectedPlatform.value) ? selectedPlatform.value.join(',') : selectedPlatform.value
  router.replace({ query: { ...route.query, q: keywords.value, platform, type: searchType.value } })
}

const handleSearch = async () => {
  if (!keywords.value.trim()) return
  
  loading.value = true
  searchResults.value = []
  playlistResults.value = []
  offset.value = 0
  hasMore.value = false
  updateRoute()

  try {
    // 使用聚合搜索 API
    // 如果选择了特定平台，传给 API；否则只传允许的平台列表，排除 B站/咪咕
    let sources: string[] = []
    if (selectedPlatform.value === 'all' || (Array.isArray(selectedPlatform.value) && selectedPlatform.value.includes('all'))) {
        sources = ['wy', 'tx', 'kg', 'kw']
    } else if (Array.isArray(selectedPlatform.value)) {
        sources = selectedPlatform.value
    } else {
        sources = [selectedPlatform.value]
    }
    
    // 注意：聚合 API 文档中暂未明确分页参数，这里暂时只请求第一页
    // 如果将来支持分页，可以传入 offset / limit
    let { songs, playlists } = await searchMusic(keywords.value, 1, limit, sources, searchType.value)
    
    // 再次过滤，确保不包含 B站/咪咕
    if (songs) {
      songs = songs.filter(s => s.source !== 'bilibili' && s.source !== 'mg' && s.source !== 'migu')
    }
    if (playlists) {
      playlists = playlists.filter(s => s.source !== 'bilibili' && s.source !== 'mg' && s.source !== 'migu')
    }
    
    if (searchType.value === 'song' && songs && songs.length > 0) {
      const mappedSongs = songs.map((s: GMASong) => ({
        id: s.id,
        name: s.name,
        // 聚合 API 返回的 artist 是字符串，SongList 需要数组结构
        ar: [{ name: s.artist || '未知歌手' }],
        al: {
          name: s.album || '未知专辑',
          picUrl: s.cover
        },
        // 聚合 API 返回的是秒，SongList 需要毫秒
        dt: (s.duration || 0) * 1000,
        picUrl: s.cover,
        quality: s.size && s.duration ? formatQuality(calculateBitrate(s.size, s.duration)) : undefined,
        // 保留原始信息
        source: s.source,
        url: s.url,
        is_invalid: s.is_invalid,
        link: s.link
      }))
      
      sortSongs(mappedSongs)
      searchResults.value = mappedSongs
      
      // 由于无法准确得知总数，暂时假设没有更多数据，或者根据返回数量判断
      // 如果返回数量等于 limit，可能还有下一页？但 API 不支持分页的话...
      hasMore.value = false 
    } else if (searchType.value === 'playlist' && playlists && playlists.length > 0) {
      playlistResults.value = playlists
      hasMore.value = false
    } else {
      searchResults.value = []
      playlistResults.value = []
      hasMore.value = false
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
    // 使用聚合搜索 API 加载更多
    let sources: string[] = []
    if (selectedPlatform.value === 'all' || (Array.isArray(selectedPlatform.value) && selectedPlatform.value.includes('all'))) {
        sources = ['wy', 'tx', 'kg', 'kw']
    } else if (Array.isArray(selectedPlatform.value)) {
        sources = selectedPlatform.value
    } else {
        sources = [selectedPlatform.value]
    }
    let { songs, playlists } = await searchMusic(keywords.value, offset.value / limit + 1, limit, sources, searchType.value)
    
    // 再次过滤，确保不包含 B站/咪咕
    if (songs) {
      songs = songs.filter(s => s.source !== 'bilibili' && s.source !== 'mg' && s.source !== 'migu')
    }
    if (playlists) {
      playlists = playlists.filter(s => s.source !== 'bilibili' && s.source !== 'mg' && s.source !== 'migu')
    }

    if (searchType.value === 'song' && songs && songs.length > 0) {
      const newSongs = songs.map((s: GMASong) => ({
        id: s.id,
        name: s.name,
        ar: [{ name: s.artist || '未知歌手' }],
        al: {
          name: s.album || '未知专辑',
          picUrl: s.cover
        },
        dt: (s.duration || 0) * 1000,
        picUrl: s.cover,
        quality: s.size && s.duration ? formatQuality(calculateBitrate(s.size, s.duration)) : undefined,
        source: s.source,
        url: s.url,
        is_invalid: s.is_invalid,
        link: s.link
      }))
      
      sortSongs(newSongs)
      searchResults.value.push(...newSongs)
      // 由于无法准确得知总数，根据本次返回数量是否达到 limit 来判断
      // (虽然 API 可能不支持分页，这里做个尽力而为的尝试)
      hasMore.value = songs.length >= limit
    } else if (searchType.value === 'playlist' && playlists && playlists.length > 0) {
      playlistResults.value.push(...playlists)
      hasMore.value = playlists.length >= limit
    } else {
      hasMore.value = false
    }
  } catch (error) {
    message.error('加载更多失败')
  } finally {
    loadingMore.value = false
  }
}

// 处理歌曲点击播放
const handleSongClick = async (song: any) => {
  try {
    message.loading('正在获取播放链接...')

    // 构造插件需要的 musicInfo
    const musicInfo = {
      id: String(song.id),
      name: song.name,
      singer: song.ar?.map((a) => a.name).join(' / ') || '未知歌手',
      albumName: song.al?.name || '未知专辑',
      pic: song.al?.picUrl || '',
      // 网易云特有字段，其他平台可能需要适配或忽略
      songmid: String(song.id),
      mediaId: String(song.id)
    }

    // 确定音源平台标识
    let source = 'wy'
    if (song.source) {
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

    // 并行请求播放链接和歌词，提升响应速度
    // 使用聚合 API 获取歌词 (支持多平台)
    const lyricPromise = fetchGMALyric(String(song.id), source).catch((err) => {
      console.error('获取歌词失败:', err)
      return ''
    })

    // 生成缓存键：平台 + 歌曲 ID + 音质
    const cacheKey = `${source}:${song.id}:${quality}`
    let finalUrl = ''
    let cacheFilePath: string | null = null

    // 1. 优先检查本地缓存
    if (window.electron && window.electron.ipcRenderer) {
      try {
        const cachePath = await window.electron.ipcRenderer.invoke('online-cache:check', {
          dir: settingsStore.local.cacheDir || null,
          key: cacheKey
        })
        if (cachePath) {
          console.log('[SearchView] 主动检测到缓存文件存在', cachePath)
          cacheFilePath = cachePath
        }
      } catch (e) {
        console.warn('主动检测缓存失败:', e)
      }
    }

    // 2. 如果没有缓存，才调用插件获取 URL
    if (!cacheFilePath) {
      const { url } = await runSnowdropGetMusicUrl(source, musicInfo, quality)
      if (!url) {
        throw new Error('未获取到播放链接')
      }
      finalUrl = url

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
    }

    // 等待歌词结果（失败则回退为空字符串）
    // GMA API 直接返回字符串格式歌词
    const lyrics = (await lyricPromise) || ''

    // 构造播放器需要的 Song 对象
    const playerSong = {
      id: song.id,
      title: song.name,
      artist: song.ar?.map((a) => a.name).join(' / ') || '未知歌手',
      album: song.al?.name || '未知专辑',
      cover: song.al?.picUrl || '',
      durationMs: song.dt || 0,
      // 记录来源平台与平台内原始 ID，供评论等功能使用
      source: song.source || 'netease',
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
      source: s.source || 'netease',
      sourceSongId: s.id,
      url: s.id === song.id ? finalUrl : '',
      lyrics: s.id === song.id ? lyrics : '',
      filePath: s.id === song.id ? cacheFilePath || undefined : undefined
    }))

    // 更新播放器列表与当前歌曲
    playerStore.setPlaylistForSource('search', newPlaylist, true)

    // 播放：优先使用本地缓存文件，其次使用远程 URL
    try {
      await AudioPlayerManager.play({
        filePath: cacheFilePath || undefined,
        url: finalUrl,
        volume: playerStore.volume
      })
    } catch (e) {
      console.error('播放失败，尝试回退纯URL播放:', e)
      // 如果 playWithProxy 是必须的，可以在 AudioPlayerManager 中集成，或者这里暂时保留
      // 鉴于 AudioPlayerManager 暂未实现 playWithProxy，这里先保留回退到 playWithProxy
      await playWithProxy(finalUrl)
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

// 辅助函数：使用主进程代理下载音频数据并播放（绕过 CORS）
const playWithProxy = async (url: string) => {
  if (window.electron && window.electron.ipcRenderer) {
    try {
      const res = await window.electron.ipcRenderer.invoke('proxy:request', {
        url,
        method: 'GET',
        responseType: 'arraybuffer'
      })
      
      if (res.success && res.data) {
        // res.data 在 IPC 传输后通常是 Uint8Array 或 Buffer
        // playFromFileData 接受 ArrayBuffer
        const buffer = res.data.buffer ? res.data.buffer : res.data
        webAudioEngine.setVolume(playerStore.volume)
        await webAudioEngine.playFromFileData(buffer)
        return
      } else {
        console.error('Proxy fetch audio failed:', res.error)
      }
    } catch (e) {
      console.error('Play with proxy failed:', e)
    }
  }
  
  // 如果代理失败，尝试直接播放（最后手段）
  await webAudioEngine.playFromUrl(url)
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
      <div class="header-top">
        <div class="header-title-row">
          <h1>{{ keywords }} 的搜索结果</h1>
          <n-popselect
            :value="selectedPlatform"
            multiple
            :options="platformOptions"
            class="platform-select"
            @update:value="handleUpdatePlatform"
          >
            <n-button size="small" secondary round>
                <template #icon>
                    <n-icon><i class="mgc_filter_line"></i></n-icon>
                </template>
                {{ selectedPlatformLabel }}
            </n-button>
          </n-popselect>
        </div>
      </div>
      <div class="search-type-tabs">
        <n-tabs
          v-model:value="searchType"
          type="segment"
          animated
          size="small"
          @update:value="handleSearch"
        >
          <n-tab-pane name="song" tab="单曲" />
          <n-tab-pane name="playlist" tab="歌单" />
        </n-tabs>
      </div>
    </div>
    
    <div class="search-content">
      <SongList 
        v-if="searchType === 'song'"
        :songs="searchResults" 
        :loading="loading || loadingMore"
        :load-more="loadingMore"
        @scroll="handleScroll"
        @song-click="handleSongClick"
      />
      
      <div v-else-if="searchType === 'playlist'" class="playlist-grid-container">
         <n-scrollbar @scroll="handleScroll">
            <div class="playlist-grid">
                <div v-for="pl in playlistResults" :key="pl.id" class="playlist-item">
                <div class="playlist-cover-wrapper">
                    <img :src="pl.cover" class="playlist-cover" loading="lazy" />
                    <div class="playlist-play-count" v-if="pl.playCount">
                        <n-icon size="12"><i class="mgc_play_arrow_fill"></i></n-icon>
                        {{ (pl.playCount / 10000).toFixed(1) }}万
                    </div>
                </div>
                <div class="playlist-info">
                    <div class="playlist-name" :title="pl.name">{{ pl.name }}</div>
                    <div class="playlist-author" v-if="pl.author">{{ pl.author.name }}</div>
                </div>
                </div>
            </div>
            <div v-if="loading || loadingMore" class="loading-state">
                Loading...
            </div>
            <div v-if="!loading && !loadingMore && playlistResults.length === 0" class="empty-state">
                暂无搜索结果
            </div>
         </n-scrollbar>
      </div>
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
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

.header-top {
  display: flex;
  align-items: center;
}

.header-title-row {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-title-row h1 {
  font-weight: 900;
  margin: 0;
  font-size: 24px;
}

.platform-select {
  width: auto;
  min-width: 100px;
}

.search-content {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.playlist-grid-container {
  height: 100%;
}

.playlist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 20px;
  padding-bottom: 20px;
}

.playlist-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  cursor: pointer;
  transition: transform 0.2s;
}

.playlist-item:hover {
  transform: translateY(-4px);
}

.playlist-cover-wrapper {
  position: relative;
  aspect-ratio: 1;
  border-radius: 8px;
  overflow: hidden;
  background: #f0f0f0;
}

.playlist-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.playlist-play-count {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(0, 0, 0, 0.5);
  color: white;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 2px;
}

.playlist-name {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.playlist-author {
  font-size: 12px;
  color: #888;
}

.loading-state, .empty-state {
   text-align: center;
   padding: 40px;
   color: #888;
}
</style>
