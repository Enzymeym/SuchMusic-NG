<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMessage, NTabs, NTabPane, NPopselect, NIcon, NButton, NScrollbar } from 'naive-ui'
import SongList from '../components/common/SongList.vue'
import { useSettingsStore } from '../stores/settingsStore'
import { usePlayerStore } from '../stores/playerStore'
import { usePluginStore } from '../stores/pluginStore'
import { webAudioEngine } from '../audio/audio-engine'
import { AudioPlayerManager } from '../utils/audioPlayerManager'
import { runSnowdropGetMusicUrl } from '../apis/snowdrop-transform'
import { throttle } from '../utils/performance'
import { formatQuality, calculateBitrate } from '../utils/quality'
import { searchMusic, fetchGMALyric } from '../apis/gma'
import { fetchQQMusicLyric } from '../apis/vkeys'

const route = useRoute()
const router = useRouter()
const settingsStore = useSettingsStore()
const pluginStore = usePluginStore()
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

// 获取歌曲主标题（去除括号内容），用于合并匹配
const getSongMainTitle = (name: string): string => {
  if (!name) return ''
  return name.replace(/[（(].*?[)）]/g, '').trim()
}

// 获取歌曲首位歌手名，用于合并匹配
const getSongFirstArtist = (song: any): string => {
  if (song.ar && Array.isArray(song.ar) && song.ar.length > 0) {
    return song.ar[0].name || ''
  }
  return ''
}

// 生成歌曲合并键：主标题 + 首位歌手
const getSongMergeKey = (song: any): string => {
  const title = getSongMainTitle(song.name)
  const artist = getSongFirstArtist(song)
  return `${title}|||${artist}`.toLowerCase()
}

// 将单平台歌曲转换为平台信息对象（含显示用字段，供 QQ 音乐优先使用）
const songToPlatformInfo = (song: any) => ({
  id: song.id,
  source: song.source,
  quality: song.quality,
  pluginId: song.pluginId,
  url: song.url || '',
  is_invalid: song.is_invalid || false,
  link: song.link || '',
  // 显示用信息：当此平台被优先显示时，用于覆盖合并后的歌曲展示字段
  _ar: song.ar,
  _al: song.al,
  _dt: song.dt,
  _picUrl: song.picUrl
})

// 判断是否为 QQ 音乐平台
const isQQSource = (source: string): boolean => {
  return source === 'tx' || source === 'qq'
}

// 不支持的平台列表
const blockedSources = ['soda', '5sing', 'bilibili', 'mg', 'migu']

// 合并歌曲列表：将同歌名+同歌手的多平台结果合并为一条
const mergeSongs = (songs: any[]): any[] => {
  const map = new Map<string, any>()
  const order: string[] = []

  // 先过滤掉不支持平台的歌曲
  const filteredSongs = songs.filter(song => !blockedSources.includes(song.source))

  for (const song of filteredSongs) {
    const key = getSongMergeKey(song)

    if (map.has(key)) {
      const existing = map.get(key)
      // 将已有的首平台也加入 platforms
      if (!existing.platforms || existing.platforms.length === 0) {
        existing.platforms = [songToPlatformInfo(existing)]
      }
      // 去重：避免同一平台重复添加
      // 使用标准化的内部标识符进行比较（处理 'tx' 和 'qq' 等相同平台不同标识符的情况）
      const songSourceInternal = mapSourceToInternal(song.source)
      const alreadyHas = existing.platforms.some((p: any) =>
        mapSourceToInternal(p.source) === songSourceInternal
      )
      if (!alreadyHas) {
        existing.platforms.push(songToPlatformInfo(song))
      }
      // QQ 音乐信息优先：如果是 QQ 音乐，直接覆盖显示字段
      if (isQQSource(song.source)) {
        if (song.ar) existing.ar = song.ar
        if (song.al) existing.al = song.al
        if (song.picUrl) existing.picUrl = song.picUrl
        if (song.dt) existing.dt = song.dt
      } else if (!isQQSource(existing.source)) {
        // 非 QQ 音乐之间回退逻辑
        if (!existing.picUrl && song.picUrl) {
          existing.picUrl = song.picUrl
          if (existing.al) existing.al.picUrl = song.picUrl
        }
        if (song.dt && (!existing.dt || song.dt > existing.dt)) {
          existing.dt = song.dt
        }
      }
    } else {
      map.set(key, { ...song })
      order.push(key)
    }
  }

  // 按原始顺序返回合并结果
  return order.map(key => map.get(key)!)
}

// 获取歌曲用于排序的源平台标识
const getSortSource = (song: any): string => {
  if (song.platforms && song.platforms.length > 0) {
    return song.platforms[0].source
  }
  return song.source || ''
}

// 按平台偏好排序
const sortSongs = (songs: any[]) => {
  const order = settingsStore.general.searchResultOrder || ['tx', 'kg', 'wy', 'kw']
  const getScore = (source: string) => {
    const index = order.indexOf(source)
    return index === -1 ? 999 : index
  }
  return songs.sort((a, b) => {
    return getScore(getSortSource(a)) - getScore(getSortSource(b))
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

  // 默认使用 QQ 音乐平台
  selectedPlatform.value = ['tx']

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
  } else if (settingsStore.source.preferredPlatform && settingsStore.source.preferredPlatform !== 'all') {
    // If settings have a preferred platform (not 'all'), use it
    selectedPlatform.value = [settingsStore.source.preferredPlatform]
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
    // 使用 musicSDK 搜索
    let sources: string[] = []
    if (selectedPlatform.value === 'all' || (Array.isArray(selectedPlatform.value) && selectedPlatform.value.includes('all'))) {
        sources = ['wy', 'tx', 'kg', 'kw']
    } else if (Array.isArray(selectedPlatform.value)) {
        sources = selectedPlatform.value
    } else {
        sources = [selectedPlatform.value]
    }

    // 1. musicSDK 搜索
    const result = await searchMusic(keywords.value, 1, limit, sources, searchType.value === 'playlist' ? 'playlist' : 'song')

    // 2. 插件搜索
    const pluginPromises = pluginStore.activePlugins.map(async (plugin) => {
        // 筛选该插件支持的且用户选中的源，同时排除不支持的平台
        const targetSources = plugin.sources.filter(s => {
            // 排除不支持的平台
            if (blockedSources.includes(s.id)) return false
            if (selectedPlatform.value === 'all' || (Array.isArray(selectedPlatform.value) && selectedPlatform.value.includes('all'))) {
                return true
            }
            const selected = Array.isArray(selectedPlatform.value) ? selectedPlatform.value : [selectedPlatform.value]
            return selected.includes(s.id)
        })

        if (targetSources.length === 0) return null

        // 对每个匹配的源发起搜索
        const sourcePromises = targetSources.map(s =>
            pluginStore.searchMusic(plugin.id, s.id, keywords.value, 1, limit)
                .then(res => ({ ...res, pluginId: plugin.id, sourceId: s.id }))
                .catch(e => {
                    console.error(`Plugin ${plugin.id} source ${s.id} search failed:`, e)
                    return null
                })
        )
        return Promise.all(sourcePromises)
    })

    const pluginResultsNested = await Promise.all(pluginPromises)

    // 处理 GMA 搜索结果
    const songs = (result.songs || []).map((song: any) => ({
      id: song.id,
      name: song.name,
      ar: [{ name: song.artist || '未知歌手' }],
      al: {
        name: song.album || '未知专辑',
        picUrl: song.cover || ''
      },
      dt: (song.duration || 0) * 1000,
      picUrl: song.cover || '',
      quality: undefined,
      source: song.source,
      url: song.url || '',
      is_invalid: song.is_invalid || false,
      link: song.link || ''
    }))

    // 处理插件结果
    const pluginSongs: any[] = []

    pluginResultsNested.forEach(results => {
        if (!results) return
        results.forEach((res: any) => {
            if (!res) return
            if (res.list && res.list.length > 0) {
                 res.list.forEach((item: any) => {
                     const mapped = {
                        id: item.id,
                        name: item.name,
                        ar: [{ name: item.singer || '未知歌手' }],
                        al: {
                          name: item.albumName || item.album || '未知专辑',
                          picUrl: item.pic || item.cover || ''
                        },
                        dt: (typeof item.interval === 'string' && item.interval.includes(':')
                              ? (() => {
                                  const parts = item.interval.split(':').map(Number);
                                  return (parts[0] * 60 + parts[1]) * 1000;
                                })()
                              : (parseFloat(item.interval) || item.duration || 0) * 1000),
                        picUrl: item.pic || item.cover || '',
                        quality: item.quality,
                        source: item.source || res.sourceId,
                        pluginId: res.pluginId,
                        url: '',
                        is_invalid: false,
                        link: ''
                     }
                     pluginSongs.push(mapped)
                 })
            }
        })
    })

    if (searchType.value === 'song') {
      const allSongs = [...songs, ...pluginSongs]
      const merged = mergeSongs(allSongs)
      sortSongs(merged)
      searchResults.value = merged

      // hasMore 判定
      hasMore.value = (result.songs || []).length >= limit
    } else if (searchType.value === 'playlist') {
      playlistResults.value = (result.playlists || []).map((pl: any) => ({
        id: pl.id, name: pl.name, cover: pl.cover, link: pl.link,
        source: pl.source, author: pl.author, playCount: pl.playCount,
        trackCount: pl.trackCount
      }))
      hasMore.value = (result.playlists || []).length >= limit
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

const handleScroll = throttle((e: Event) => {
  const target = e.target as HTMLElement
  // Check if near bottom
  console.log('Scroll event triggered:', {
    scrollTop: target.scrollTop,
    clientHeight: target.clientHeight,
    scrollHeight: target.scrollHeight,
    nearBottom: target.scrollTop + target.clientHeight >= target.scrollHeight - 100,
    loadingMore: loadingMore.value,
    hasMore: hasMore.value,
    loading: loading.value
  })
  if (target.scrollTop + target.clientHeight >= target.scrollHeight - 100) {
    if (!loadingMore.value && hasMore.value && !loading.value) {
      console.log('Loading more...')
      handleLoadMore()
    }
  }
}, 100)

const handleLoadMore = async () => {
  if (loadingMore.value || !hasMore.value) return

  loadingMore.value = true
  offset.value += limit
  const page = Math.floor(offset.value / limit) + 1

  try {
    // 使用 musicSDK 加载更多
    let sources: string[] = []
    if (selectedPlatform.value === 'all' || (Array.isArray(selectedPlatform.value) && selectedPlatform.value.includes('all'))) {
        sources = ['wy', 'tx', 'kg', 'kw']
    } else if (Array.isArray(selectedPlatform.value)) {
        sources = selectedPlatform.value
    } else {
        sources = [selectedPlatform.value]
    }

    // 1. GMA Load More
    const result = await searchMusic(keywords.value, page, limit, sources, searchType.value === 'playlist' ? 'playlist' : 'song')

    // 2. Plugin Load More
    const pluginPromises = pluginStore.activePlugins.map(async (plugin) => {
        // 排除不支持的平台
        const targetSources = plugin.sources.filter(s => {
            if (blockedSources.includes(s.id)) return false
            if (selectedPlatform.value === 'all' || (Array.isArray(selectedPlatform.value) && selectedPlatform.value.includes('all'))) {
                return true
            }
            const selected = Array.isArray(selectedPlatform.value) ? selectedPlatform.value : [selectedPlatform.value]
            return selected.includes(s.id)
        })

        if (targetSources.length === 0) return null

        const sourcePromises = targetSources.map(s =>
            pluginStore.searchMusic(plugin.id, s.id, keywords.value, page, limit)
                .then(res => ({ ...res, pluginId: plugin.id, sourceId: s.id }))
                .catch(e => {
                    console.error(`Plugin ${plugin.id} source ${s.id} load more failed:`, e)
                    return null
                })
        )
        return Promise.all(sourcePromises)
    })

    const pluginResultsNested = await Promise.all(pluginPromises)

    // 处理 GMA 结果
    const songs = (result.songs || []).map((song: any) => ({
      id: song.id,
      name: song.name,
      ar: [{ name: song.artist || '未知歌手' }],
      al: {
        name: song.album || '未知专辑',
        picUrl: song.cover || ''
      },
      dt: (song.duration || 0) * 1000,
      picUrl: song.cover || '',
      quality: undefined,
      source: song.source,
      url: song.url || '',
      is_invalid: song.is_invalid || false,
      link: song.link || ''
    }))

    const pluginSongs: any[] = []

    pluginResultsNested.forEach(results => {
        if (!results) return
        results.forEach((res: any) => {
            if (!res) return
            if (res.list && res.list.length > 0) {
                 res.list.forEach((item: any) => {
                     const mapped = {
                        id: item.id,
                        name: item.name,
                        ar: [{ name: item.singer || '未知歌手' }],
                        al: {
                          name: item.albumName || item.album || '未知专辑',
                          picUrl: item.pic || item.cover || ''
                        },
                        dt: (typeof item.interval === 'string' && item.interval.includes(':')
                              ? (() => {
                                  const parts = item.interval.split(':').map(Number);
                                  return (parts[0] * 60 + parts[1]) * 1000;
                                })()
                              : (parseFloat(item.interval) || item.duration || 0) * 1000),
                        picUrl: item.pic || item.cover || '',
                        quality: item.quality,
                        source: item.source || res.sourceId,
                        pluginId: res.pluginId,
                        url: '',
                        is_invalid: false,
                        link: ''
                     }
                     pluginSongs.push(mapped)
                 })
            }
        })
    })

    if (searchType.value === 'song') {
      const allNewSongs = [...songs, ...pluginSongs]

      if (allNewSongs.length > 0) {
        // 增量更新已有歌曲的 platforms，追加新歌曲，避免全量替换数组导致序号错乱
        const existingKeyIndex = new Map<string, number>()
        searchResults.value.forEach((s, i) => {
          existingKeyIndex.set(getSongMergeKey(s), i)
        })

        const addedKeys = new Set<string>()
        const newSongsToAppend: any[] = []

        for (const song of allNewSongs) {
          // 跳过不支持的平台
          if (blockedSources.includes(song.source)) continue

          const key = getSongMergeKey(song)

          if (existingKeyIndex.has(key)) {
            // 已有歌曲：原地更新 platforms
            const idx = existingKeyIndex.get(key)!
            const target = searchResults.value[idx]
            if (!target.platforms || target.platforms.length === 0) {
              target.platforms = [songToPlatformInfo(target)]
            }
            // 使用标准化的内部标识符进行比较（处理 'tx' 和 'qq' 等相同平台不同标识符的情况）
            const songSourceInternal = mapSourceToInternal(song.source)
            const alreadyHas = target.platforms.some((p: any) =>
              mapSourceToInternal(p.source) === songSourceInternal
            )
            if (!alreadyHas) {
              target.platforms.push(songToPlatformInfo(song))
            }
            // QQ 音乐信息优先覆盖显示字段
            if (isQQSource(song.source)) {
              if (song.ar) target.ar = song.ar
              if (song.al) target.al = song.al
              if (song.picUrl) target.picUrl = song.picUrl
              if (song.dt) target.dt = song.dt
            } else if (!isQQSource(target.source)) {
              // 非 QQ 音乐之间回退逻辑
              if (!target.picUrl && song.picUrl) {
                target.picUrl = song.picUrl
                if (target.al) target.al.picUrl = song.picUrl
              }
              if (song.dt && (!target.dt || song.dt > target.dt)) {
                target.dt = song.dt
              }
            }
          } else if (!addedKeys.has(key)) {
            // 新歌曲：加入待追加列表
            addedKeys.add(key)
            newSongsToAppend.push(song)
          }
        }

        if (newSongsToAppend.length > 0) {
          sortSongs(newSongsToAppend)
          searchResults.value.push(...newSongsToAppend)
        }
        hasMore.value = (result.songs || []).length >= limit
      }
    } else if (searchType.value === 'playlist') {
      const newPlaylists = (result.playlists || []).map((pl: any) => ({
        id: pl.id, name: pl.name, cover: pl.cover, link: pl.link,
        source: pl.source, author: pl.author, playCount: pl.playCount,
        trackCount: pl.trackCount
      }))
      const existingPlIds = new Set(playlistResults.value.map(p => p.id))
      const uniquePl = newPlaylists.filter(pl => !existingPlIds.has(pl.id))
      playlistResults.value.push(...uniquePl)
      hasMore.value = (result.playlists || []).length >= limit
    } else {
      hasMore.value = false
    }
  } catch (error) {
    message.error('加载更多失败')
  } finally {
    loadingMore.value = false
  }
}

// 将 source 映射为内部平台标识
const mapSourceToInternal = (source: string): string => {
  switch (source) {
    case 'netease': return 'wy'
    case 'qq': return 'tx'
    case 'kugou': return 'kg'
    case 'kuwo': return 'kw'
    case 'migu': return 'mg'
    default: return source
  }
}

// 获取单个平台的播放 URL
const getPlatformUrl = async (
  platform: { id: string | number; source: string; pluginId?: string; quality?: string },
  musicInfoTemplate: any,
  quality: string
): Promise<{ url: string; cacheFilePath: string | null; cacheKey: string } | null> => {
  const source = mapSourceToInternal(platform.source)
  const cacheKey = `${source}:${platform.id}:${quality}`

  // 1. 检查本地缓存
  let cacheFilePath: string | null = null
  if (window.electron && window.electron.ipcRenderer) {
    try {
      const cachePath = await window.electron.ipcRenderer.invoke('online-cache:check', {
        dir: settingsStore.local.cacheDir || null,
        key: cacheKey
      })
      if (cachePath) {
        cacheFilePath = cachePath
        return { url: '', cacheFilePath, cacheKey }
      }
    } catch (e) {
      console.warn('缓存检测失败:', e)
    }
  }

  // 2. 获取远程 URL
  try {
    const musicInfo = { ...musicInfoTemplate, id: String(platform.id), source, songmid: String(platform.id), mediaId: String(platform.id), pluginId: platform.pluginId }
    let url = ''
    if (platform.pluginId) {
      url = await pluginStore.getMusicUrl(source, musicInfo, quality)
    } else {
      const res = await runSnowdropGetMusicUrl(source, musicInfo, quality)
      url = res.url
    }
    if (url) {
      return { url, cacheFilePath: null, cacheKey }
    }
  } catch (e) {
    console.warn(`平台 ${platform.source} 获取播放链接失败:`, e)
  }

  return null
}

// 处理歌曲点击播放
const handleSongClick = async (song: any) => {
  try {
    message.loading('正在获取播放链接...')

    // 获取音质：优先使用该歌曲原始音源的独立音质设置，其次使用全局设置
    const mappedSource = mapSourceToInternal(song.source || '')
    const quality = (mappedSource ? settingsStore.getEffectiveQuality(mappedSource) : undefined)
      || settingsStore.source.preferredQuality
      || '128k'

    // 获取所有待请求的平台列表
    const platforms: Array<{ id: string | number; source: string; pluginId?: string; quality?: string }> = []

    // 确定首选平台：优先使用歌曲原始音源的独立设置，否则使用全局设置
    const effectivePreferredSource = mappedSource
      ? settingsStore.getEffectivePlatform(mappedSource)
      : settingsStore.source.preferredPlatform
    const preferredSource = (effectivePreferredSource && effectivePreferredSource !== 'all')
      ? effectivePreferredSource
      : 'wy'
    const defaultSource = preferredSource

    // 将主歌曲本身也作为一个平台选项加入
    const mainPlatform = {
      id: song.id,
      source: song.source || defaultSource,
      pluginId: song.pluginId,
      quality: song.quality
    }

    if (song.platforms && song.platforms.length > 0) {
      // 多平台合并的歌曲：只使用歌曲实际支持的平台（song.platforms）
      // 主歌曲 platform 已经包含在 song.platforms 中，不需要额外添加
      // 过滤掉不支持的平台
      const filteredPlatforms = song.platforms.filter((p: any) => !blockedSources.includes(p.source))
      platforms.push(...filteredPlatforms)
      console.log('[播放] 多平台歌曲:', song.name, 'platforms:', platforms.map(p => p.source))
    } else {
      // 单平台歌曲：使用主歌曲 platform（如果不是不支持的平台）
      if (!blockedSources.includes(mainPlatform.source)) {
        platforms.push(mainPlatform)
      }
      console.log('[播放] 单平台歌曲:', song.name, 'source:', mainPlatform.source)
    }

    // 根据音源设置中的首选播放平台对 platforms 进行排序
    const searchOrder = settingsStore.general.searchResultOrder || ['tx', 'kg', 'wy', 'kw']

    /**
     * 构建平台优先级顺序
     * 如果设置了首选平台（非 'all'），则首选平台排在第一位，其余平台按 searchResultOrder 排序
     * @returns 平台优先级数组
     */
    const buildPlatformOrder = (): string[] => {
      if (preferredSource && preferredSource !== 'all') {
        const otherPlatforms = searchOrder.filter(s => s !== preferredSource)
        return [preferredSource, ...otherPlatforms]
      }
      return searchOrder
    }

    const platformOrder = buildPlatformOrder()

    // 去重：确保同一平台只出现一次（基于标准化后的 source）
    const seenSources = new Set<string>()
    const uniquePlatforms: typeof platforms = []
    for (const platform of platforms) {
      const internalSource = mapSourceToInternal(platform.source)
      if (!seenSources.has(internalSource)) {
        seenSources.add(internalSource)
        uniquePlatforms.push(platform)
      }
    }
    platforms.length = 0
    platforms.push(...uniquePlatforms)

    // 对 platforms 按首选平台优先级排序（稳定排序）
    platforms.sort((a, b) => {
      const scoreA = platformOrder.indexOf(mapSourceToInternal(a.source))
      const scoreB = platformOrder.indexOf(mapSourceToInternal(b.source))
      const sA = scoreA === -1 ? 999 : scoreA
      const sB = scoreB === -1 ? 999 : scoreB
      if (sA !== sB) {
        return sA - sB
      }
      // 分数相同时，保持原始顺序（稳定排序）
      return 0
    })

    console.log('[播放] 最终请求平台顺序:', platforms.map(p => ({ source: p.source, id: p.id })))

    // 构造 musicInfo 模板
    const musicInfoTemplate = {
      name: song.name,
      singer: song.ar?.map((a: any) => a.name).join(' / ') || '未知歌手',
      albumName: song.al?.name || '未知专辑',
      pic: song.al?.picUrl || '',
      songmid: String(song.id),
      mediaId: String(song.id),
      pluginId: song.pluginId
    }

    // 使用首选平台（排序后的第一个）获取歌词
    const firstSource = mapSourceToInternal(platforms[0].source)
    const lyricPromise = (async () => {
      try {
        // QQ音乐优先使用 VKeys API
        if (firstSource === 'tx') {
          console.log(`[SearchView] 检测到 QQ 音乐，使用 VKeys API 获取歌词...`)
          const result = await fetchQQMusicLyric(String(platforms[0].id))
          const mainLyric = result.yrc || result.lrc
          if (mainLyric) {
            console.log(`[SearchView] VKeys 歌词获取成功 | 主歌词: ${result.yrc ? 'YRC(逐字)' : 'LRC(标准)'} (${mainLyric.length} 字符) | 翻译: ${result.trans ? '✓' : '✗'}`)
            if (result.trans) {
              playerStore.setTranslatedLyrics(result.trans)
            }
            return mainLyric
          }
          console.warn(`[SearchView] VKeys 返回空歌词，回退到 GMA API`)
        }
        const lyricText = await fetchGMALyric(String(platforms[0].id), firstSource)
        return lyricText || ''
      } catch (err) {
        console.error('获取歌词失败:', err)
        return ''
      }
    })()

    // 并行请求所有平台的播放链接
    const urlResults = await Promise.all(
      platforms.map(p => getPlatformUrl(p, musicInfoTemplate, quality))
    )

    // 按平台优先级排列结果
    // platforms 已按首选平台排序，只需过滤掉获取失败的结果，保持原有顺序
    const scored = urlResults
      .map((result, i) => ({ result, platform: platforms[i], index: i }))
      .filter(item => item.result !== null)

    if (scored.length === 0) {
      throw new Error('所有平台均未获取到播放链接')
    }

    // 选择优先级最高的平台
    const selected = scored[0]
    const { url: finalUrl, cacheFilePath } = selected.result!
    const selectedPlatform = selected.platform

    // 对选中的 URL 准备缓存（如果有）
    let effectiveFilePath = cacheFilePath
    let effectiveUrl = finalUrl

    if (!effectiveFilePath && finalUrl && window.electron && window.electron.ipcRenderer) {
      try {
        const cacheResult = (await window.electron.ipcRenderer.invoke('online-cache:prepare', {
          dir: settingsStore.local.cacheDir || null,
          key: selected.result!.cacheKey,
          url: finalUrl
        })) as { usedCache: boolean; filePath: string | null; url: string }

        if (cacheResult.filePath) {
          effectiveFilePath = cacheResult.filePath
          effectiveUrl = cacheResult.url || finalUrl
        }
      } catch (e) {
        console.error('准备在线播放缓存失败:', e)
      }
    }

    // 等待歌词
    const lyrics = (await lyricPromise) || ''

    // 构造播放器需要的 Song 对象
    const playerSong = {
      id: selectedPlatform.id,
      title: song.name,
      artist: song.ar?.map((a: any) => a.name).join(' / ') || '未知歌手',
      album: song.al?.name || '未知专辑',
      cover: song.al?.picUrl || '',
      durationMs: song.dt || 0,
      source: mapSourceToInternal(selectedPlatform.source),
      sourceSongId: selectedPlatform.id,
      filePath: effectiveFilePath || undefined,
      url: effectiveUrl,
      lyrics
    }

    // 播放
    try {
      await AudioPlayerManager.play({
        filePath: effectiveFilePath || undefined,
        url: effectiveUrl,
        volume: playerStore.volume
      })
    } catch (e) {
      console.error('播放失败，尝试回退纯URL播放:', e)
      await playWithProxy(effectiveUrl)
    }

    // 同步 store 状态
    playerStore.setCurrentSong(playerSong)
    playerStore.setPlaying(true)

    // 显示播放平台提示
    const platformCount = song.platforms ? song.platforms.length : 1
    if (platformCount > 1) {
      const sourceLabel = mapSourceToInternal(selectedPlatform.source)
      const labelMap: Record<string, string> = { wy: '网易云', tx: 'QQ', kg: '酷狗', kw: '酷我', mg: '咪咕' }
      const label = labelMap[sourceLabel] || selectedPlatform.source
      message.success(`开始播放 (${label}) - 已同步请求 ${platformCount} 个平台`)
    } else {
      message.success('开始播放')
    }
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

    <div class="search-content" @scroll="handleScroll">
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
                    <img :src="pl.cover" class="playlist-cover" loading="lazy" decoding="async" />
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
  overflow: auto;
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
