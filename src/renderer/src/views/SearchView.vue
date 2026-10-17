<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { NAlert, NDropdown, useMessage } from 'naive-ui'
import SongList from '../components/common/SongList.vue'
import { usePlayerStore } from '../stores/playerStore'
import type { PlayerSong } from '../stores/playerStore'
import { useLocalMusicStore } from '../stores/localMusicStore'
import { useSourcePluginStore } from '../stores/sourcePluginStore'
import { normalizeSourceKey, resolvePluginUrlDetailed } from '../utils/pluginSource'

const route = useRoute()
const playerStore = usePlayerStore()
const localMusicStore = useLocalMusicStore()
const message = useMessage()

const keywords = ref('')

// ===== 平台下拉菜单 =====
type SearchTab = 'local' | 'netease' | 'qq'
const activeTab = ref<SearchTab>('local')

// 平台选项（作为下拉菜单放入标题中）
const platformOptions = [
  { label: '本地', key: 'local' },
  { label: '网易云', key: 'netease' },
  { label: 'QQ音乐', key: 'qq' }
]

const platformLabel = computed(() => {
  switch (activeTab.value) {
    case 'netease':
      return '网易云'
    case 'qq':
      return 'QQ音乐'
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
    default:
      return 'mgc_computer_line'
  }
})

const onPlatformSelect = (key: string | number) => {
  activeTab.value = String(key) as SearchTab
}

// ===== 本地搜索 =====
// 从歌曲对象提取歌手名
const getSongArtist = (song: any): string => {
  if (song.ar && song.ar.length > 0) {
    return song.ar.map((a: any) => a.name).join(' / ')
  }
  return '未知歌手'
}

// 本地搜索结果：按关键词过滤本地音乐
const searchResults = computed(() => {
  if (!keywords.value.trim()) return []
  const keyword = keywords.value.toLowerCase().trim()
  return localMusicStore.songs.filter((song) => {
    const name = song.name?.toLowerCase() || ''
    const artist = getSongArtist(song).toLowerCase()
    const album = (song.al?.name || '').toLowerCase()
    return name.includes(keyword) || artist.includes(keyword) || album.includes(keyword)
  })
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

// ===== 路由关键词同步 =====
onMounted(() => {
  if (route.query.q) {
    keywords.value = String(route.query.q)
  }
  // 同步音源插件列表，用于「QQ 音乐」标签页的前置可用性提示
  sourcePluginStore.initListeners()
  void sourcePluginStore.refresh()
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
    } else {
      qqSongs.value = []
      qqSearched.value = false
      qqHasMore.value = false
    }
    loadHotSearch()
    return
  }
  if (activeTab.value === 'netease') searchNeteaseFromStart()
  else searchQQFromStart()
})

watch(activeTab, (tab) => {
  if (tab === 'local') return
  if (!keywords.value.trim()) {
    loadHotSearch()
  } else if (tab === 'netease') {
    searchNeteaseFromStart()
  } else {
    searchQQFromStart()
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
            >
              <span class="platform-trigger">
                <i :class="['platform-icon', platformIcon]"></i>
                <span class="platform-label">{{ platformLabel }}</span>
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
        <SongList
          v-if="searchResults.length > 0"
          :songs="searchResults"
          :loading="false"
          @song-click="handleSongClick"
        />

        <div v-else-if="keywords" class="empty-state">
          <p>本地音乐中未找到匹配"{{ keywords }}"的歌曲</p>
          <p class="hint">请确保已添加本地音乐目录，或切换「网易云」标签在线搜索</p>
        </div>

        <div v-else class="empty-state">
          <p>请输入关键词搜索本地音乐</p>
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
      <template v-else>
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
