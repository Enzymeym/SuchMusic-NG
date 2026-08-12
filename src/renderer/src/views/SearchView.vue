<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useMessage } from 'naive-ui'
import SongList from '../components/common/SongList.vue'
import { usePlayerStore } from '../stores/playerStore'
import { useLocalMusicStore } from '../stores/localMusicStore'

const route = useRoute()
const playerStore = usePlayerStore()
const localMusicStore = useLocalMusicStore()
const message = useMessage()

const keywords = ref('')

// ===== 标签页 =====
type SearchTab = 'local' | 'netease'
const activeTab = ref<SearchTab>('local')

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
    lyrics: song.lyrics,
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

// ===== 路由关键词同步 =====
onMounted(() => {
  if (route.query.q) {
    keywords.value = String(route.query.q)
  }
})

watch(() => route.query, (newQuery) => {
  if (newQuery.q && newQuery.q !== keywords.value) {
    keywords.value = String(newQuery.q)
  }
})

// ===== 标签/关键词变化 =====
watch(keywords, () => {
  if (activeTab.value !== 'netease') return
  if (!keywords.value.trim()) {
    // 清空关键词：回到热搜状态
    neteaseSongs.value = []
    neteaseSearched.value = false
    neteaseHasMore.value = false
    neteaseTotal.value = 0
    loadHotSearch()
    return
  }
  searchNeteaseFromStart()
})

watch(activeTab, (tab) => {
  if (tab === 'netease') {
    if (!keywords.value.trim()) {
      loadHotSearch()
    } else {
      searchNeteaseFromStart()
    }
  }
})
</script>

<template>
  <div class="search-view">
    <div class="search-header">
      <div class="header-top">
        <div class="header-title-row">
          <h1>搜索"{{ keywords }}"</h1>
          <span v-if="activeTab === 'local' && keywords && searchResults.length" class="result-count">
            找到 {{ searchResults.length }} 首本地歌曲
          </span>
          <span v-else-if="activeTab === 'netease' && neteaseSearched" class="result-count">
            找到 {{ neteaseTotal }} 首网易云歌曲
          </span>
        </div>
      </div>

      <!-- 标签切换 -->
      <div class="tab-switch">
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'local' }"
          @click="activeTab = 'local'"
        >本地</button>
        <button
          class="tab-btn"
          :class="{ active: activeTab === 'netease' }"
          @click="activeTab = 'netease'"
        >网易云</button>
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
      <template v-else>
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
  align-items: baseline;
  gap: 16px;
}

.header-title-row h1 {
  font-weight: 900;
  margin: 0;
  font-size: 24px;
}

.result-count {
  font-size: 14px;
  color: #888;
}

/* 标签切换 */
.tab-switch {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background-color: rgba(128, 128, 128, 0.12);
  align-self: flex-start;
}

.tab-btn {
  border: none;
  background: transparent;
  padding: 5px 18px;
  border-radius: 6px;
  font-size: 14px;
  color: #888;
  cursor: pointer;
  transition: all 0.2s ease;
}

.tab-btn:hover {
  color: #555;
}

.tab-btn.active {
  background-color: #fff;
  color: #333;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

:root[data-theme='dark'] .tab-btn.active {
  background-color: rgba(255, 255, 255, 0.14);
  color: #fff;
  box-shadow: none;
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
