<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NDropdown, useMessage } from 'naive-ui'
import SongList from '../components/common/SongList.vue'
import { usePlayerStore } from '../stores/playerStore'
import type { PlayerSong } from '../stores/playerStore'
import { useLocalMusicStore } from '../stores/localMusicStore'
import { useSourcePluginStore } from '../stores/sourcePluginStore'
import { normalizeSourceKey, resolvePluginUrlDetailed } from '../utils/pluginSource'
import { useLibrarySearch } from '../composables/useLibrarySearch'
import { useSearchHistoryStore } from '../stores/searchHistoryStore'
import { normalizeSearchText } from '../../../shared/library/normalize'
import type { SearchSource } from '../../../shared/plugin/types'

const route = useRoute()
const router = useRouter()
const playerStore = usePlayerStore()
const localMusicStore = useLocalMusicStore()
const searchHistoryStore = useSearchHistoryStore()
const message = useMessage()

const keywords = ref('')

// ===== 平台下拉菜单 =====
type SearchTab = 'local' | 'netease' | 'qq' | 'plugin'
const activeTab = ref<SearchTab>('local')

/**
 * 平台下拉菜单：本地 / 网易云 / QQ音乐 / 各插件（每个插件都是一级父项）。
 *
 * 多平台插件自带 children（全部平台 + 各平台），单平台插件点一下即选中；
 * 没有「插件」这个中间层，来源选择也并入这里，标题右侧不再有独立下拉。
 */
const platformOptions = computed(() => {
  const base = [
    { label: '本地', key: 'local' },
    { label: '网易云', key: 'netease' },
    { label: 'QQ音乐', key: 'qq' },
    { type: 'divider' as const, key: 'plugin-divider' }
  ]
  const plugins = buildPluginEntries()
  if (plugins.length === 0) {
    return [...base, { label: '暂无可用插件来源', key: 'plugin-empty', disabled: true }]
  }
  return [...base, ...plugins]
})

const platformLabel = computed(() => {
  switch (activeTab.value) {
    case 'netease':
      return '网易云'
    case 'qq':
      return 'QQ音乐'
    case 'plugin':
      return activeSourceLabel.value
    default:
      return '本地'
  }
})

const platformIcon = computed(() => {
  switch (activeTab.value) {
    case 'netease':
      return 'mgc_netease_music_line'
    case 'qq':
      return 'mgc_qq_fill'
    case 'plugin':
      return 'mgc_extension_line'
    default:
      return 'mgc_computer_line'
  }
})

/** 展开下拉时顺手拉一次来源列表，避免首次打开「插件」是空的 */
const onPlatformMenuToggle = (show: boolean): void => {
  if (show && pluginSources.value.length === 0) void loadPluginSources()
}

const onPlatformSelect = (key: string | number) => {
  const value = String(key)
  if (value === 'local' || value === 'netease' || value === 'qq') {
    activeTab.value = value
    return
  }
  // 插件或插件下的具体平台：切到插件视图并按新来源重搜
  if (!isPluginScope(value) && !pluginSources.value.some((s) => s.key === value)) return
  activeSource.value = value
  if (activeTab.value !== 'plugin') {
    activeTab.value = 'plugin'
  } else if (keywords.value.trim()) {
    searchPluginFromStart()
  }
}

// ===== 本地搜索 =====
// 从歌曲对象提取歌手名
const getSongArtist = (song: any): string => {
  if (song.ar && song.ar.length > 0) {
    return song.ar.map((a: any) => a.name).join(' / ')
  }
  return '未知歌手'
}

// 本地搜索结果：走统一的曲库搜索（标题 / 歌手 / 专辑 / 文件名，支持字段前缀）。
// 本页没有输入框（关键词来自路由 query），所以用 submit 跳过防抖直接生效。
const localSearch = useLibrarySearch({
  source: () => localMusicStore.songs,
  limit: 200
})

watch(
  keywords,
  (value) => localSearch.submit(value ?? ''),
  { immediate: true }
)

// 记录搜索历史：本页是唯一「真正执行搜索」的入口，
// 头部搜索框跳转、热搜词点击、从外部带 query 进入都会经过这里。
// 统一在此写入，避免各处重复调用；store 内部会去重并置顶。
watch(keywords, (value) => {
  const keyword = (value ?? '').trim()
  if (keyword) searchHistoryStore.add(keyword)
})

const searchResults = computed(() =>
  localSearch.hasQuery.value ? localSearch.results.value : []
)

/** 命中的文件夹歌单（最多 6 个，避免把歌曲列表挤下去） */
const matchedFolders = computed(() => {
  const q = normalizeSearchText(keywords.value)
  if (!q) return []
  return localMusicStore.folderPlaylists
    .filter((folder) => normalizeSearchText(folder.displayName).includes(q))
    .slice(0, 6)
})

// 处理歌曲点击播放（仅本地文件）
const handleSongClick = async (song: any) => {
  if (!song.filePath) {
    message.error('找不到本地文件路径，无法播放')
    return
  }

  const songInfo = {
    id: song.id,
    title: song.name,
    artist: getSongArtist(song),
    cover: song.picUrl || song.al?.picUrl || '',
    durationMs: song.dt || 0,
    album: song.al?.name,
    filePath: song.filePath,
    // 歌词不再常驻响应式 songs，按需取（未命中由 PlayerBar 兜底异步拉取）
    lyrics: localMusicStore.getLyrics(song) || undefined,
    source: 'local',
    sourceSongId: song.id
  }

  playerStore.setCurrentSong(songInfo)
  playerStore.recordPlay(songInfo)
}

// ===== 网易云搜索 =====
const PAGE_SIZE = 30
const neteaseSongs = ref<any[]>([])
const neteaseLoading = ref(false)
const neteaseLoadMore = ref(false)
const neteaseHasMore = ref(false)
const neteaseTotal = ref(0)
const neteaseSearched = ref(false) // 是否已执行过搜索（区分「请输入关键词」和「无结果」）
const hotSearches = ref<{ searchWord: string; iconUrl?: string }[]>([])

let searchTimer: ReturnType<typeof setTimeout> | null = null
let requestSeq = 0 // 递增序号，用于丢弃过期请求结果

// 加载网易云热搜
const loadHotSearch = async () => {
  try {
    const list = await window.api.netease.hotSearch()
    hotSearches.value = list || []
  } catch (e) {
    console.error('[SearchView] 加载网易云热搜失败:', e)
  }
}

// 执行网易云搜索
const doSearchNetease = async (offset: number, reset: boolean) => {
  const kw = keywords.value.trim()
  if (!kw) return
  const seq = ++requestSeq
  neteaseLoading.value = true
  if (reset) {
    neteaseSongs.value = []
    neteaseLoadMore.value = false
  } else {
    neteaseLoadMore.value = true
  }
  try {
    const res = await window.api.netease.search(kw, offset, PAGE_SIZE)
    if (seq !== requestSeq) return // 过期结果，丢弃
    neteaseSongs.value = reset ? res.songs : [...neteaseSongs.value, ...res.songs]
    neteaseTotal.value = res.total
    neteaseHasMore.value = res.hasMore
    neteaseSearched.value = true
  } catch (e) {
    console.error('[SearchView] 网易云搜索失败:', e)
    if (seq === requestSeq) {
      message.error('搜索失败，请稍后重试')
    }
  } finally {
    if (seq === requestSeq) {
      neteaseLoading.value = false
      neteaseLoadMore.value = false
    }
  }
}

// 300ms 防抖搜索（从第一页开始）
const searchNeteaseFromStart = () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    doSearchNetease(0, true)
  }, 300)
}

// 滚动到底部加载下一页
const handleNeteaseScroll = (e: Event) => {
  const target = e.target as HTMLElement
  if (!target || typeof target.scrollTop !== 'number') return
  const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 150
  if (nearBottom && neteaseHasMore.value && !neteaseLoading.value && !neteaseLoadMore.value) {
    doSearchNetease(neteaseSongs.value.length, false)
  }
}

// 点击热搜词：填入关键词触发搜索
const onHotSearchClick = (word: string) => {
  keywords.value = word
}

// 解析网易云歌曲为可播放对象（供右键播放/下一首播放/下载复用）
const resolveNeteaseSong = async (song: any) => {
  const id = Number(song.id)
  if (!id || id <= 0) return null
  const urlMap = await window.api.netease.songUrl([id])
  const playUrl = urlMap[id]
  if (!playUrl) return null
  return {
    id: `wy-${id}`,
    title: song.name,
    artist: getSongArtist(song),
    cover: song.al?.picUrl || '',
    durationMs: song.dt || 0,
    album: song.al?.name,
    filePath: playUrl,
    source: 'netease',
    sourceSongId: id
  }
}

/** 点击网易云搜索结果的歌手名：进入该歌手的网易云歌手详情页 */
const handleNeteaseArtistClick = (artist: { id?: number | string; name: string }) => {
  if (!artist?.name) return
  const id = Number(artist.id)
  router.push({
    name: 'singer-detail',
    params: { name: artist.name },
    query: id > 0 ? { wy: String(id) } : {}
  })
}

// 处理网易云歌曲点击播放
const handleNeteaseSongClick = async (song: any) => {
  const loadingMsg = message.loading('正在获取播放地址…', { duration: 0 })
  try {
    const songInfo = await resolveNeteaseSong(song)
    loadingMsg.destroy()
    if (!songInfo) {
      message.error('该歌曲无版权或需要 VIP，无法播放')
      return
    }
    playerStore.setCurrentSong(songInfo)
    playerStore.recordPlay(songInfo)
  } catch (e) {
    loadingMsg.destroy()
    console.error('[SearchView] 获取网易云播放地址失败:', e)
    message.error('获取播放地址失败，请稍后重试')
  }
}

// ===== QQ 音乐搜索（vkeys API 搜索 + 音源插件解析播放） =====
const qqSongs = ref<any[]>([])
const qqLoading = ref(false)
const qqLoadMore = ref(false)
const qqHasMore = ref(false)
const qqSearched = ref(false)

// 已加载插件里是否存在可解析 QQ 音源（tx / qq / tencent）的插件
const sourcePluginStore = useSourcePluginStore()
const hasQQSourcePlugin = computed(() =>
  sourcePluginStore.plugins.some(
    (plugin) =>
      plugin.enabled &&
      plugin.state === 'running' &&
      (plugin.capabilities?.sources ?? []).some((source) => {
        if (normalizeSourceKey(source.key) !== 'tx') return false
        // actions 为空视为「按插件类型默认支持播放地址」
        return source.actions.length === 0 || source.actions.includes('musicUrl')
      })
  )
)

/** 主进程 SourceTrack → SongList 兼容结构 */
const mapQQItem = (t: any) => ({
  id: `tx-${t.id}`,
  name: t.title,
  ar: [{ name: t.artist || '未知歌手' }],
  al: { name: t.album || '未知专辑', picUrl: t.coverUrl || '' },
  dt: t.durationMs || 0,
  picUrl: t.coverUrl || '',
  source: 'tx',
  sourceSongId: t.id,
  sourceKey: 'tx',
  pluginId: t.pluginId || '',
  trackRef: t.ref
})

// 执行 QQ 音乐搜索
const doSearchQQ = async (offset: number, reset: boolean) => {
  const kw = keywords.value.trim()
  if (!kw) return
  const seq = ++requestSeq
  qqLoading.value = true
  if (reset) {
    qqSongs.value = []
    qqLoadMore.value = false
  } else {
    qqLoadMore.value = true
  }
  try {
    const res = await window.api.sources.qqSearch(kw, PAGE_SIZE, offset)
    if (seq !== requestSeq) return // 过期结果，丢弃
    if (!res?.success) throw new Error(res?.error || '搜索失败')
    const items = (res.items || []).map(mapQQItem)
    qqSongs.value = reset ? items : [...qqSongs.value, ...items]
    qqHasMore.value = !!res.hasMore
    qqSearched.value = true
  } catch (e: any) {
    console.error('[SearchView] QQ 音乐搜索失败:', e)
    if (seq === requestSeq) {
      message.error(e?.message || '搜索失败，请稍后重试')
    }
  } finally {
    if (seq === requestSeq) {
      qqLoading.value = false
      qqLoadMore.value = false
    }
  }
}

const searchQQFromStart = () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    doSearchQQ(0, true)
  }, 300)
}

const handleQQScroll = (e: Event) => {
  const target = e.target as HTMLElement
  if (!target || typeof target.scrollTop !== 'number') return
  const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 150
  if (nearBottom && qqHasMore.value && !qqLoading.value && !qqLoadMore.value) {
    doSearchQQ(qqSongs.value.length, false)
  }
}

// 解析 QQ 曲目为可播放对象：播放地址来自音源插件（未加载插件时返回 null）
const buildQQPlayerBase = (song: any): PlayerSong => ({
  id: song.id,
  title: song.name,
  artist: getSongArtist(song),
  cover: song.picUrl || song.al?.picUrl || '',
  durationMs: song.dt || 0,
  album: typeof song.al?.name === 'string' ? song.al.name : undefined,
  source: 'tx',
  sourceKey: 'tx',
  sourceSongId: song.sourceSongId,
  trackRef: song.trackRef
})

/** 解析结果：成功返回曲目，失败保留主进程给出的真实原因 */
const resolveQQSongDetail = async (
  song: any
): Promise<{ song: PlayerSong | null; error?: string; code?: string }> => {
  const base = buildQQPlayerBase(song)
  const detail = await resolvePluginUrlDetailed(base)
  if (!detail.url) return { song: null, error: detail.error, code: detail.code }
  return {
    song: { ...base, filePath: detail.url, requestHeaders: detail.requestHeaders }
  }
}

const resolveQQSong = async (song: any): Promise<PlayerSong | null> => {
  const { song: resolved } = await resolveQQSongDetail(song)
  return resolved
}

// 处理 QQ 音乐歌曲点击播放
const handleQQSongClick = async (song: any) => {
  const loadingMsg = message.loading('正在获取播放地址…', { duration: 0 })
  try {
    const detail = await resolveQQSongDetail(song)
    loadingMsg.destroy()
    if (!detail.song) {
      // 不再把所有失败都说成「未找到音源插件」：
      // 主进程会区分「没有插件 / 插件停用 / 插件加载失败 / 插件解析失败」并给出原因
      const hint = detail.code === 'NO_PLUGIN' ? '（请在「设置 → 音源插件」中导入并启用）' : ''
      message.error(`${detail.error || '音源插件未能解析出播放地址'}${hint}`, { duration: 8000 })
      return
    }
    playerStore.setCurrentSong(detail.song)
    playerStore.recordPlay(detail.song)
  } catch (e) {
    loadingMsg.destroy()
    console.error('[SearchView] 获取 QQ 音乐播放地址失败:', e)
    message.error('获取播放地址失败，请稍后重试')
  }
}

// ===== 插件搜索（v2 插件 musicSearch 源 + 澜音 provider 统一目录） =====

/** 可用的插件搜索源（只保留已启用且加载成功的） */
const pluginSources = ref<SearchSource[]>([])
const pluginSourcesLoading = ref(false)

/**
 * 选中的来源。一级选项永远是「插件」，多平台插件再级联到具体平台。
 *
 * 三种取值，统一用字符串表达，减少一层状态对象：
 * - `plugin:<pluginId>`     该插件（多平台即「全部平台」）
 * - 其他                    具体某个来源的 key（即 `source:list-sources` 返回的 key）
 * - `''`                    尚未选择；读取来源后会自动落到第一个插件
 */
const activeSource = ref('')
const PLUGIN_SCOPE_PREFIX = 'plugin:'

const isPluginScope = (value: string): boolean => value.startsWith(PLUGIN_SCOPE_PREFIX)

/** 按插件聚合：搜索页的一级选项是插件，平台只在插件有多个时级联展开 */
interface PluginGroup {
  pluginId: string
  pluginName: string
  sources: SearchSource[]
}

const pluginGroups = computed<PluginGroup[]>(() => {
  const map = new Map<string, PluginGroup>()
  for (const source of pluginSources.value) {
    let group = map.get(source.pluginId)
    if (!group) {
      group = { pluginId: source.pluginId, pluginName: source.pluginName, sources: [] }
      map.set(source.pluginId, group)
    }
    group.sources.push(source)
  }
  return [...map.values()]
})

async function loadPluginSources(force = false): Promise<void> {
  if (!force && pluginSources.value.length > 0) return
  pluginSourcesLoading.value = true
  try {
    const res = await window.api.sources.listSources()
    const list = res?.success ? (res.sources ?? []) : []
    pluginSources.value = list.filter((s) => s.enabled && s.state === 'running')
    // 首次进入或选中的插件已被停用 / 移除：落到第一个可用插件
    if (!activeSource.value || resolveTargets().length === 0) {
      const first = pluginGroups.value[0]
      activeSource.value = first ? `${PLUGIN_SCOPE_PREFIX}${first.pluginId}` : ''
    }
  } catch (e) {
    console.error('[SearchView] 读取插件搜索源失败:', e)
    pluginSources.value = []
  } finally {
    pluginSourcesLoading.value = false
  }
}

/** 当前选择对应的来源集合（顺序稳定，用于并发搜索与计数） */
function resolveTargets(): SearchSource[] {
  const value = activeSource.value
  if (isPluginScope(value)) {
    const pluginId = value.slice(PLUGIN_SCOPE_PREFIX.length)
    const grouped = pluginSources.value.filter((s) => s.pluginId === pluginId)
    if (grouped.length > 0) return grouped
  } else if (value) {
    const exact = pluginSources.value.filter((s) => s.key === value)
    if (exact.length > 0) return exact
  }
  // 未选择 / 选择已失效：回落到第一个插件
  return pluginGroups.value[0]?.sources ?? []
}

/**
 * 平台下拉里的插件项：每个插件都是一级父项，没有跨插件的聚合项。
 *
 * - 只有一个平台 → 直接选中该插件
 * - 多个平台     → 级联子菜单，子项首条是「全部平台」，其后是各平台
 *
 * 父项 key 用 `group:` 前缀，避免与子项（`plugin:<id>`）重复。
 */
function buildPluginEntries(): {
  label: string
  key: string
  children?: { label: string; key: string }[]
}[] {
  return pluginGroups.value.map((group) => {
    const pluginKey = `${PLUGIN_SCOPE_PREFIX}${group.pluginId}`
    if (group.sources.length === 1) {
      const only = group.sources[0]
      return {
        label:
          only.label && only.label !== group.pluginName
            ? `${group.pluginName} · ${only.label}`
            : group.pluginName,
        key: pluginKey
      }
    }
    return {
      label: group.pluginName,
      key: `group:${group.pluginId}`,
      children: [
        { label: '全部平台', key: pluginKey },
        ...group.sources.map((s) => ({ label: s.label, key: s.key }))
      ]
    }
  })
}

const activeSourceLabel = computed(() => {
  const value = activeSource.value
  if (!value) return '插件'

  const group = pluginGroups.value.find((g) => g.pluginId === groupPluginId(value))
  if (isPluginScope(value)) {
    if (!group) return '插件'
    return group.sources.length > 1 ? `${group.pluginName}（全部平台）` : group.pluginName
  }

  const found = pluginSources.value.find((s) => s.key === value)
  if (!found) return '插件'
  return group && group.sources.length > 1 ? `${found.pluginName} · ${found.label}` : found.pluginName
})

/** 从 key 里取出 pluginId（插件级或具体来源两种形态都适用） */
function groupPluginId(key: string): string {
  if (isPluginScope(key)) return key.slice(PLUGIN_SCOPE_PREFIX.length)
  return pluginSources.value.find((s) => s.key === key)?.pluginId ?? ''
}

const pluginSongs = ref<any[]>([])
const pluginLoading = ref(false)
const pluginLoadMore = ref(false)
const pluginHasMore = ref(false)
const pluginSearched = ref(false)
const pluginCursor = ref<string | undefined>(undefined)

/** 主进程 SourceTrack → SongList 兼容结构（保留插件解析所需的全部字段） */
const mapPluginItem = (t: any) => {
  const sourceKey = normalizeSourceKey(t.sourceKey)
  return {
    id: `plg-${t.pluginId || 'x'}-${t.sourceKey || ''}-${t.id}`,
    name: t.title,
    ar: [{ name: t.artist || '未知歌手' }],
    al: { name: t.album || '未知专辑', picUrl: t.coverUrl || '' },
    dt: t.durationMs || 0,
    picUrl: t.coverUrl || '',
    source: sourceKey || 'plugin',
    sourceKey: sourceKey || undefined,
    sourceSongId: t.id,
    pluginId: t.pluginId || '',
    providerId: t.providerId || undefined,
    // ref 必须是纯数据：这里在请求返回后立即脱离响应式包装前先做一次浅拷贝
    trackRef: t.ref
  }
}

const doSearchPlugin = async (cursor: string | undefined, reset: boolean): Promise<void> => {
  const kw = keywords.value.trim()
  if (!kw) return
  const seq = ++requestSeq
  pluginLoading.value = true
  if (reset) {
    pluginSongs.value = []
    pluginLoadMore.value = false
    pluginCursor.value = undefined
  } else {
    pluginLoadMore.value = true
  }
  try {
    let raw: any[] = []
    let nextCursor: string | undefined
    let hasMore = false

    const targets = resolveTargets()
    if (targets.length === 0) throw new Error('没有可用的插件搜索源')

    if (targets.length === 1) {
      // 单来源：直接用插件自己的游标分页
      const res = await window.api.sources.search({
        key: targets[0].key,
        query: kw,
        limit: PAGE_SIZE,
        cursor
      })
      if (!res?.success) throw new Error(res?.error || '搜索失败')
      raw = res.items ?? []
      nextCursor = res.nextCursor
      hasMore = !!res.hasMore
    } else {
      // 多来源（某插件的全部平台）：并发取各源首页后合并，
      // 跨源游标不通用，因此这一档不提供「加载更多」
      const batches = await Promise.all(
        targets.map(async (source) => {
          try {
            const res = await window.api.sources.search({
              key: source.key,
              query: kw,
              limit: 20
            })
            return res?.success ? (res.items ?? []) : []
          } catch {
            return []
          }
        })
      )
      raw = batches.flat()
      hasMore = false
    }

    if (seq !== requestSeq) return // 过期结果，丢弃

    const mapped = raw.map(mapPluginItem)
    // 同一首歌可能被多个插件返回，按 (插件, 平台, 曲目 id) 去重
    const seen = new Set<string>()
    const items = mapped.filter((item) => {
      const dedupeKey = `${item.pluginId}|${item.sourceKey}|${item.sourceSongId}`
      if (seen.has(dedupeKey)) return false
      seen.add(dedupeKey)
      return true
    })

    pluginSongs.value = reset ? items : [...pluginSongs.value, ...items]
    pluginCursor.value = nextCursor
    pluginHasMore.value = hasMore
    pluginSearched.value = true
  } catch (e: any) {
    console.error('[SearchView] 插件搜索失败:', e)
    if (seq === requestSeq) message.error(e?.message || '搜索失败，请稍后重试')
  } finally {
    if (seq === requestSeq) {
      pluginLoading.value = false
      pluginLoadMore.value = false
    }
  }
}

const searchPluginFromStart = () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    doSearchPlugin(undefined, true)
  }, 300)
}

const handlePluginScroll = (e: Event) => {
  const target = e.target as HTMLElement
  if (!target || typeof target.scrollTop !== 'number') return
  const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 150
  if (nearBottom && pluginHasMore.value && !pluginLoading.value && !pluginLoadMore.value) {
    doSearchPlugin(pluginCursor.value, false)
  }
}

/** 插件曲目 → 可播放对象 */
const buildPluginPlayerBase = (song: any): PlayerSong => ({
  id: song.id,
  title: song.name,
  artist: getSongArtist(song),
  cover: song.picUrl || song.al?.picUrl || '',
  durationMs: song.dt || 0,
  album: typeof song.al?.name === 'string' ? song.al.name : undefined,
  source: song.source,
  sourceKey: song.sourceKey,
  sourceSongId: song.sourceSongId,
  pluginId: song.pluginId,
  providerId: song.providerId,
  trackRef: song.trackRef
})

const resolvePluginSongDetail = async (
  song: any
): Promise<{ song: PlayerSong | null; error?: string; code?: string }> => {
  const base = buildPluginPlayerBase(song)
  const detail = await resolvePluginUrlDetailed(base)
  if (!detail.url) return { song: null, error: detail.error, code: detail.code }
  return { song: { ...base, filePath: detail.url, requestHeaders: detail.requestHeaders } }
}

const resolvePluginSong = async (song: any): Promise<PlayerSong | null> => {
  const { song: resolved } = await resolvePluginSongDetail(song)
  return resolved
}

const handlePluginSongClick = async (song: any) => {
  const loadingMsg = message.loading('正在获取播放地址…', { duration: 0 })
  try {
    const detail = await resolvePluginSongDetail(song)
    loadingMsg.destroy()
    if (!detail.song) {
      const hint = detail.code === 'NO_PLUGIN' ? '（请到「设置 → 插件」导入音源插件）' : ''
      message.error(`${detail.error || '插件未能解析出播放地址'}${hint}`, { duration: 8000 })
      return
    }
    playerStore.setCurrentSong(detail.song)
    playerStore.recordPlay(detail.song)
  } catch (e) {
    loadingMsg.destroy()
    console.error('[SearchView] 插件播放地址解析失败:', e)
    message.error('获取播放地址失败，请稍后重试')
  }
}

// ===== 路由关键词同步 =====
onMounted(() => {
  if (route.query.q) {
    keywords.value = String(route.query.q)
  }
  // 同步音源插件列表，用于「QQ 音乐」标签页的前置可用性提示
  sourcePluginStore.initListeners()
  void sourcePluginStore.refresh()
  // 插件搜索源目录（v2 musicSearch + 澜音 provider）
  void loadPluginSources()
})

watch(() => route.query, (newQuery) => {
  if (newQuery.q && newQuery.q !== keywords.value) {
    keywords.value = String(newQuery.q)
  }
})

// ===== 标签/关键词变化 =====
watch(keywords, () => {
  if (activeTab.value === 'local') return
  if (!keywords.value.trim()) {
    // 清空关键词：回到热搜状态
    if (activeTab.value === 'netease') {
      neteaseSongs.value = []
      neteaseSearched.value = false
      neteaseHasMore.value = false
      neteaseTotal.value = 0
    } else if (activeTab.value === 'qq') {
      qqSongs.value = []
      qqSearched.value = false
      qqHasMore.value = false
    } else {
      pluginSongs.value = []
      pluginSearched.value = false
      pluginHasMore.value = false
      pluginCursor.value = undefined
    }
    loadHotSearch()
    return
  }
  if (activeTab.value === 'netease') searchNeteaseFromStart()
  else if (activeTab.value === 'qq') searchQQFromStart()
  else searchPluginFromStart()
})

watch(activeTab, (tab) => {
  if (tab === 'local') return
  if (tab === 'plugin') void loadPluginSources()
  if (!keywords.value.trim()) {
    loadHotSearch()
  } else if (tab === 'netease') {
    searchNeteaseFromStart()
  } else if (tab === 'qq') {
    searchQQFromStart()
  } else {
    searchPluginFromStart()
  }
})

// 简化后的搜索结果数量文案（本地/网易云统一为「共 X 首」，QQ 无总数接口故显示已加载数量）
const resultCountText = computed(() => {
  if (activeTab.value === 'local') {
    if (!keywords.value.trim() || searchResults.value.length === 0) return ''
    return `共 ${searchResults.value.length} 首`
  }
  if (activeTab.value === 'netease' && neteaseSearched.value) {
    return `共 ${neteaseTotal.value} 首`
  }
  if (activeTab.value === 'qq' && qqSearched.value) {
    return `已加载 ${qqSongs.value.length} 首`
  }
  if (activeTab.value === 'plugin' && pluginSearched.value) {
    return `已加载 ${pluginSongs.value.length} 首`
  }
  return ''
})
</script>

<template>
  <div class="search-view">
    <div class="search-header">
      <div class="header-top">
        <div class="header-title-row">
          <h1 class="title-with-platform">
            <n-dropdown
              trigger="click"
              placement="bottom-start"
              :options="platformOptions"
              @select="onPlatformSelect"
              @update:show="onPlatformMenuToggle"
            >
              <span class="platform-trigger">
                <i :class="['platform-icon', platformIcon]"></i>
                <span class="platform-label" :title="platformLabel">{{ platformLabel }}</span>
                <i class="mgc_selector_vertical_line platform-arrow"></i>
              </span>
            </n-dropdown>
            <span class="title-suffix">搜索"{{ keywords }}"的结果</span>
          </h1>
          <span v-if="resultCountText" class="result-count">{{ resultCountText }}</span>
        </div>
      </div>
    </div>

    <div class="search-content">
      <!-- 本地搜索 -->
      <template v-if="activeTab === 'local'">
        <!-- 命中的文件夹歌单：先给「整张专辑/某个目录」的入口，再列单曲 -->
        <div v-if="matchedFolders.length > 0" class="folder-hits">
          <div class="folder-hits-title">文件夹</div>
          <div class="folder-hits-list">
            <button
              v-for="folder in matchedFolders"
              :key="folder.id"
              type="button"
              class="folder-hit"
              @click="router.push(`/folder/${folder.id}`)"
            >
              <i class="mgc_folder_2_line"></i>
              <span class="folder-hit-name">{{ folder.displayName }}</span>
              <span class="folder-hit-count">{{ folder.totalTrackCount }}</span>
            </button>
          </div>
        </div>

        <SongList
          v-if="searchResults.length > 0"
          :songs="searchResults"
          :loading="false"
          @song-click="handleSongClick"
        />

        <div v-else-if="keywords && matchedFolders.length === 0" class="empty-state">
          <p>本地音乐中未找到匹配"{{ keywords }}"的歌曲</p>
          <p class="hint">请确保已添加本地音乐目录，或切换「网易云」标签在线搜索</p>
        </div>

        <div v-else-if="!keywords" class="empty-state">
          <p>请输入关键词搜索本地音乐</p>
          <p class="hint">支持按标题、歌手、专辑、文件名匹配，也可用 artist:xxx 限定字段</p>
        </div>
      </template>

      <!-- 网易云搜索 -->
      <template v-else-if="activeTab === 'netease'">
        <!-- 热搜推荐 -->
        <div v-if="!keywords" class="netease-hot">
          <p class="hot-title">热搜推荐</p>
          <div class="hot-list">
            <span
              v-for="(item, i) in hotSearches"
              :key="item.searchWord"
              class="hot-item"
              @click="onHotSearchClick(item.searchWord)"
            >{{ i + 1 }}. {{ item.searchWord }}</span>
          </div>
          <p class="hint">点击热搜词即可搜索，或在顶部输入关键词后回车</p>
        </div>

        <!-- 搜索结果 -->
        <SongList
          v-else-if="neteaseSongs.length > 0"
          :songs="neteaseSongs"
          :loading="neteaseLoading"
          :load-more="neteaseLoadMore"
          :get-playable-song="resolveNeteaseSong"
          artist-clickable
          @artist-click="handleNeteaseArtistClick"
          @song-click="handleNeteaseSongClick"
          @scroll="handleNeteaseScroll"
        />

        <div v-else-if="neteaseLoading" class="empty-state">
          <p>正在搜索「{{ keywords }}」…</p>
        </div>

        <div v-else-if="neteaseSearched" class="empty-state">
          <p>未找到与"{{ keywords }}"相关的网易云歌曲</p>
        </div>

        <div v-else class="empty-state">
          <p>请输入关键词搜索网易云音乐</p>
        </div>
      </template>

      <!-- QQ 音乐搜索（vkeys API 搜索，播放地址由音源插件提供） -->
      <template v-else-if="activeTab === 'qq'">
        <!-- 插件缺失前置提示：避免点了歌才发现「未找到音源插件」 -->
        <n-alert
          v-if="!hasQQSourcePlugin && (qqSongs.length > 0 || keywords)"
          class="plugin-missing-alert"
          type="warning"
          :bordered="false"
        >
          未检测到可解析 QQ 音乐的音源插件，点击播放会失败。请到「设置 → 音源插件」导入并启用洛雪 / 澜音音源。
        </n-alert>
        <!-- 热搜推荐 -->
        <div v-if="!keywords" class="netease-hot">
          <p class="hot-title">热搜推荐</p>
          <div class="hot-list">
            <span
              v-for="(item, i) in hotSearches"
              :key="item.searchWord"
              class="hot-item"
              @click="onHotSearchClick(item.searchWord)"
            >{{ i + 1 }}. {{ item.searchWord }}</span>
          </div>
          <p class="hint">搜索 QQ 音乐曲库，播放地址由已加载的洛雪 / 澜音音源插件提供</p>
        </div>

        <!-- 搜索结果 -->
        <SongList
          v-else-if="qqSongs.length > 0"
          :songs="qqSongs"
          :loading="qqLoading"
          :load-more="qqLoadMore"
          :get-playable-song="resolveQQSong"
          @song-click="handleQQSongClick"
          @scroll="handleQQScroll"
        />

        <div v-else-if="qqLoading" class="empty-state">
          <p>正在搜索「{{ keywords }}」…</p>
        </div>

        <div v-else-if="qqSearched" class="empty-state">
          <p>未找到与"{{ keywords }}"相关的 QQ 音乐歌曲</p>
        </div>

        <div v-else class="empty-state">
          <p>请输入关键词搜索 QQ 音乐</p>
        </div>
      </template>

      <!-- 插件搜索（v2 插件声明的 musicSearch 源 + 澜音 provider） -->
      <template v-else>
        <!-- 没有任何可用搜索源 -->
        <div v-if="pluginSources.length === 0" class="empty-state">
          <p>{{ pluginSourcesLoading ? '正在读取插件来源…' : '暂无可用插件来源' }}</p>
          <p class="hint">
            请到「设置 → 插件」导入支持搜索的插件并启用（v2 插件需声明 musicSearch，澜音插件自带 provider）
          </p>
        </div>

        <template v-else>
          <!-- 热搜推荐（与网易云 / QQ 共用同一份数据） -->
          <div v-if="!keywords" class="netease-hot">
            <p class="hot-title">热搜推荐</p>
            <div class="hot-list">
              <span
                v-for="(item, i) in hotSearches"
                :key="item.searchWord"
                class="hot-item"
                @click="onHotSearchClick(item.searchWord)"
              >{{ i + 1 }}. {{ item.searchWord }}</span>
            </div>
            <p class="hint">
              当前来源：{{ activeSourceLabel }}（共 {{ pluginGroups.length }} 个插件 ·
              {{ pluginSources.length }} 个平台）
            </p>          </div>

          <SongList
            v-else-if="pluginSongs.length > 0"
            :songs="pluginSongs"
            :loading="pluginLoading"
            :load-more="pluginLoadMore"
            :get-playable-song="resolvePluginSong"
            @song-click="handlePluginSongClick"
            @scroll="handlePluginScroll"
          />

          <div v-else-if="pluginLoading" class="empty-state">
            <p>正在搜索「{{ keywords }}」…</p>
          </div>

          <div v-else-if="pluginSearched" class="empty-state">
            <p>未找到与"{{ keywords }}"相关的歌曲</p>
            <p class="hint">可切换到其他来源，或确认插件是否支持该平台搜索</p>
          </div>

          <div v-else class="empty-state">
            <p>请输入关键词搜索插件音源</p>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.search-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 64px 24px 0;
  box-sizing: border-box;
}

.search-header {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

/* 音源插件缺失提示：常驻在结果列表上方，不参与滚动 */
.plugin-missing-alert {
  flex: 0 0 auto;
  margin-bottom: 12px;
}

.header-top {
  display: flex;
  align-items: center;
}

.header-title-row {
  display: flex;
  align-items: baseline;
  gap: 16px;
  min-width: 0;
}

.title-with-platform {
  display: flex;
  align-items: center;
  gap: 0;
  font-weight: 900;
  margin: 0;
  font-size: 24px;
  min-width: 0;
  flex: 1 1 auto;
}

/* 平台下拉触发器：默认纯文字无背景，悬停时呈现背景效果 */
.platform-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 7px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transform: translateZ(0);
  transition: background-color 0.2s ease, color 0.2s ease;
}

.platform-icon {
  font-size: 17px;
  font-style: normal;
  line-height: 1;
}

.platform-label {
  font-weight: 900;
  /* 插件名可能较长（如「洛雪音乐音源（全部平台）」），超出就省略，避免挤压标题 */
  max-width: 320px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.platform-arrow {
  font-size: 28px;
  font-style: normal;
  line-height: 0.6;
  transition: transform 0.2s ease;
}

.platform-trigger:hover {
  color: #3d889b;
  background-color: rgba(61, 136, 155, 0.12);
}

:root[data-theme='dark'] .platform-trigger:hover {
  color: #7fc4d0;
  background-color: rgba(61, 136, 155, 0.22);
}

/* 触发下拉展开时箭头反转 */
.n-dropdown:focus-visible .platform-arrow {
  transform: translateY(1px) rotate(180deg);
}

.title-suffix {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.result-count {
  font-size: 14px;
  color: #888;
  white-space: nowrap;
}

.search-content {
  flex: 1;
  overflow: auto;
  position: relative;
}

.empty-state {
  text-align: center;
  padding: 80px 40px;
  color: #888;
}

.empty-state p {
  margin: 8px 0;
  font-size: 16px;
}

.empty-state .hint {
  font-size: 13px;
  color: #aaa;
}

/* 本地搜索：命中的文件夹歌单 */
.folder-hits {
  padding: 4px 4px 12px;
}

.folder-hits-title {
  font-size: 13px;
  color: var(--n-text-color-3, #888);
  margin: 4px 0 10px;
}

.folder-hits-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.folder-hit {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid var(--n-border-color, rgba(0, 0, 0, 0.08));
  background: transparent;
  color: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.16s ease, border-color 0.16s ease;
}

.folder-hit:hover {
  background: var(--n-color-hover, rgba(0, 0, 0, 0.04));
  border-color: var(--n-border-color-hover, rgba(0, 0, 0, 0.16));
}

.folder-hit-count {
  font-size: 12px;
  color: var(--n-text-color-3, #999);
}

/* 网易云热搜 */
.netease-hot {
  padding: 8px 4px;
}

.hot-title {
  font-size: 16px;
  font-weight: 700;
  margin: 0 0 16px;
  color: #555;
}

.hot-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.hot-item {
  display: inline-flex;
  align-items: center;
  padding: 6px 14px;
  border-radius: 16px;
  font-size: 14px;
  color: #555;
  background-color: rgba(128, 128, 128, 0.1);
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
}

.hot-item:hover {
  background-color: rgba(61, 136, 155, 0.16);
  color: #3d889b;
}

.netease-hot .hint {
  margin-top: 24px;
  font-size: 13px;
  color: #aaa;
}

:root[data-theme='dark'] .hot-title {
  color: #ccc;
}

:root[data-theme='dark'] .hot-item {
  color: #ccc;
  background-color: rgba(255, 255, 255, 0.08);
}

:root[data-theme='dark'] .hot-item:hover {
  background-color: rgba(61, 136, 155, 0.28);
  color: #fff;
}
</style>
