<script setup lang="ts">
/**
 * 首页
 *
 * 版式参考：问候区 + 本周统计 → 「随机翻到了」主卡片 → 快捷入口 →
 * 反复聆听（本地播放次数榜）→ 专属歌单（网易云推荐歌单）。
 * 数据来源：每日推荐 / 推荐歌单走网易云 API，
 * 未登录或接口失败时回落到本地曲库与本地历史，保证首页永远有内容。
 */
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import {
  NButton,
  NCard,
  NEmpty,
  NGrid,
  NGridItem,
  NIcon,
  NScrollbar,
  NSkeleton,
  NSpin,
  NTag,
  useMessage
} from 'naive-ui'
import { useRouter } from 'vue-router'
import defaultCover from '@renderer/assets/default-cover.png'
import { usePlayerStore, type PlayerSong, type PlayRecord } from '../stores/playerStore'
import { useLocalMusicStore, type LocalSong } from '../stores/localMusicStore'
import { useSettingsStore } from '../stores/settingsStore'
import { usePlaylistStore } from '../stores/playlistStore'

/** 网易云归一化歌曲（由 preload 桥推导，避免重复声明结构） */
type NeteaseSong = Awaited<ReturnType<typeof window.api.netease.dailySongs>>[number]
/** 网易云歌单摘要 */
type NeteasePlaylist = Awaited<ReturnType<typeof window.api.netease.recommendPlaylists>>[number]

const message = useMessage()
const router = useRouter()
const playerStore = usePlayerStore()
const localMusicStore = useLocalMusicStore()
const settingsStore = useSettingsStore()
const playlistStore = usePlaylistStore()

const UNKNOWN_ARTIST = '未知歌手'

// ==================== 问候语 ====================

const greetingNow = ref(new Date())
let greetingTimer: ReturnType<typeof setInterval> | null = null

const startGreetingTimer = (): void => {
  if (greetingTimer) return
  greetingTimer = setInterval(() => {
    greetingNow.value = new Date()
  }, 30_000)
}
const stopGreetingTimer = (): void => {
  if (greetingTimer) {
    clearInterval(greetingTimer)
    greetingTimer = null
  }
}

/** 根据当前时段返回问候语 */
const greetingText = computed(() => {
  const hour = greetingNow.value.getHours()
  if (hour >= 5 && hour < 8) return '清晨好'
  if (hour >= 8 && hour < 11) return '上午好'
  if (hour >= 11 && hour < 13) return '中午好'
  if (hour >= 13 && hour < 17) return '下午好'
  if (hour >= 17 && hour < 19) return '傍晚好'
  if (hour >= 19 && hour < 23) return '晚上好'
  return '夜深了'
})

/** 网易云账号资料（仅用于取昵称） */
const neteaseProfile = ref<
  Awaited<ReturnType<typeof window.api.netease.loginStatus>>['profile'] | null
>(null)
const nickname = computed(() => neteaseProfile.value?.nickname?.trim() || '朋友')

/** 最近播放的去重歌曲数 */
const recentCount = computed(
  () => new Set(playerStore.playHistory.map((record) => String(record.songId))).size
)

/** 副标语：有历史就引导续听，没有就引导每日推荐 */
const subline = computed(() =>
  recentCount.value > 0
    ? `今天想听点什么？继续上次的 ${recentCount.value} 首最近播放吧`
    : '今天想听点什么？先从每日推荐里挑一首吧'
)

// ==================== 数据加载 ====================

/** 网易云每日推荐（已转成播放器歌曲） */
const dailyPool = ref<PlayerSong[]>([])
/** 本地曲库随机抽样（已转成播放器歌曲，数量受采样上限控制） */
const localPool = ref<PlayerSong[]>([])
/** 首页专属歌单 */
const homePlaylists = ref<
  {
    key: string
    name: string
    cover: string
    count: number
    neteaseId?: number
    localId?: string
  }[]
>([])
/** 收藏歌单数量（登录取网易云，未登录取本地） */
const favoritedPlaylistCount = ref(0)

const homeLoading = ref(true)
/** 正在执行中的快捷入口（避免重复点击） */
const actionLoading = ref<string | null>(null)
/** 正在拉取曲目的歌单卡片 */
const playlistLoadingKey = ref<string | null>(null)

/** 本地曲库采样上限：只取随机 N 首参与首页展示，避免为整库构建播放对象 */
const LOCAL_SAMPLE_SIZE = 50
/** 首页数据缓存时长，切页回来不必重新请求 */
const CACHE_TTL = 10 * 60 * 1000
let lastLoadedAt = 0
let requesting = false

/** 统一封面地址：网易云封面强制 https 并追加缩略参数，减少解码开销 */
function coverOf(url?: string, size = 300): string {
  if (!url) return defaultCover
  let value = url
  if (value.startsWith('http://')) value = `https://${value.slice('http://'.length)}`
  if (/^https?:/.test(value) && !value.includes('?')) value += `?param=${size}y${size}`
  return value
}

function artistText(names?: { name: string }[]): string {
  const text = (names || [])
    .map((item) => item?.name)
    .filter(Boolean)
    .join(' / ')
  return text || UNKNOWN_ARTIST
}

function neteaseToPlayerSong(song: NeteaseSong): PlayerSong {
  return {
    id: song.id,
    title: song.name || UNKNOWN_ARTIST,
    artist: artistText(song.ar),
    album: song.al?.name || '',
    cover: coverOf(song.al?.picUrl),
    durationMs: song.dt || 0,
    source: 'netease',
    sourceSongId: song.id
  }
}

function localToPlayerSong(song: LocalSong): PlayerSong {
  return {
    id: song.id,
    title: song.name,
    artist: artistText(song.ar),
    album: song.al?.name,
    cover: song.thumbUrl || song.al?.picUrl || song.picUrl || defaultCover,
    durationMs: song.dt || 0,
    filePath: song.filePath,
    source: 'local',
    sourceSongId: song.id
  }
}

/** 从历史记录还原成可播放对象：优先命中本地文件，否则按在线来源重放 */
function recordToPlayerSong(record: PlayRecord, fallbackCover?: string): PlayerSong {
  const localSong = localMusicStore.songs.find((song) => song.id === record.songId)
  if (localSong) return localToPlayerSong(localSong)
  const isNetease = record.source === 'netease'
  return {
    id: record.songId,
    title: record.title,
    artist: record.artist || UNKNOWN_ARTIST,
    album: record.album,
    cover: coverOf(record.cover || fallbackCover),
    durationMs: record.durationMs || 0,
    filePath: record.filePath,
    source: record.source || 'local',
    sourceSongId: isNetease ? record.songId : undefined
  }
}

/** 部分 Fisher-Yates 抽样：只洗前 need 个，避免整库复制 + 全量洗牌 */
function sampleLocalSongs(size: number): LocalSong[] {
  const songs = localMusicStore.songs
  if (songs.length <= size) return [...songs]
  const pool = [...songs]
  for (let i = 0; i < size; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i))
    const tmp = pool[i]
    pool[i] = pool[j]
    pool[j] = tmp
  }
  return pool.slice(0, size)
}

async function loadHomeData(force = false): Promise<void> {
  if (requesting) return
  if (!force && Date.now() - lastLoadedAt < CACHE_TTL) return
  requesting = true
  if (!dailyPool.value.length && !localPool.value.length) homeLoading.value = true

  // 本地兜底始终可用，先渲染出来，网络结果到达后再覆盖
  if (!localPool.value.length) {
    localPool.value = sampleLocalSongs(LOCAL_SAMPLE_SIZE).map(localToPlayerSong)
  }

  const statusTask = window.api.netease.loginStatus().catch(() => null)
  const dailyTask = window.api.netease.dailySongs().catch(() => [] as NeteaseSong[])
  const playlistsTask = window.api.netease
    .recommendPlaylists(6)
    .catch(() => [] as NeteasePlaylist[])

  const [status, daily, playlists] = await Promise.all([statusTask, dailyTask, playlistsTask])

  if (status) {
    neteaseProfile.value = status.loggedIn ? status.profile || null : null
  }
  if (daily.length) dailyPool.value = daily.map(neteaseToPlayerSong)

  if (playlists.length) {
    homePlaylists.value = playlists.map((item) => ({
      key: `wy-${item.id}`,
      name: item.name,
      cover: coverOf(item.cover),
      count: item.trackCount,
      neteaseId: item.id
    }))
  } else {
    homePlaylists.value = playlistStore.playlists.slice(0, 6).map((item) => ({
      key: `local-${item.id}`,
      name: item.name,
      cover: item.cover || item.tracks[0]?.cover || defaultCover,
      count: item.tracks.length,
      localId: item.id
    }))
  }

  // 收藏歌单数：登录后取账号歌单，未登录回落到本地歌单
  const userPlaylists = status?.loggedIn
    ? await window.api.netease.userPlaylists().catch(() => [])
    : []
  favoritedPlaylistCount.value = userPlaylists.length || playlistStore.playlists.length

  lastLoadedAt = Date.now()
  homeLoading.value = false
  requesting = false
}

// ==================== 主卡片「随机翻到了」 ====================

/** 主卡片候选池：优先每日推荐，其次本地曲库 */
const heroPool = computed<PlayerSong[]>(() =>
  dailyPool.value.length ? dailyPool.value : localPool.value
)
const heroIndex = ref(0)
/** 候选池变短（如每日推荐覆盖本地抽样）时回落到第一首，避免索引越界 */
const heroPosition = computed(() => (heroIndex.value < heroPool.value.length ? heroIndex.value : 0))
const hero = computed<PlayerSong | null>(() => heroPool.value[heroPosition.value] || null)
const heroPreview = computed(() => heroPool.value.slice(0, 4))
const heroSource = computed(() =>
  dailyPool.value.length
    ? { label: '每日推荐', icon: 'mgc_calendar_day_line' }
    : { label: '本地曲库', icon: 'mgc_album_line' }
)
const heroMeta = computed(() =>
  dailyPool.value.length
    ? `来自网易云每日推荐 · ${dailyPool.value.length} 首`
    : `从本地曲库随机精选 · ${localPool.value.length} 首`
)

/** 换一首：换个随机位置，本地池顺带重新抽样 */
function rollHero(): void {
  if (!dailyPool.value.length) {
    localPool.value = sampleLocalSongs(LOCAL_SAMPLE_SIZE).map(localToPlayerSong)
  }
  const total = heroPool.value.length
  if (total <= 1) {
    heroIndex.value = 0
    return
  }
  let next = Math.floor(Math.random() * total)
  // 避免「换一首」抽到同一首，看起来像没反应
  if (next === heroPosition.value) next = (next + 1) % total
  heroIndex.value = next
}

/** 用指定队列播放，并从 startIndex 开始 */
function playPool(list: PlayerSong[], startIndex = 0): void {
  if (!list.length) return
  playerStore.setPlaylist([...list])
  playerStore.playSongAtIndex(Math.min(Math.max(startIndex, 0), list.length - 1))
}

function playHero(): void {
  playPool(heroPool.value, heroPosition.value)
}

/** 添加到队列：队列空时直接入列，否则插到当前歌曲之后 */
function queueHero(): void {
  const song = hero.value
  if (!song) return
  if (!playerStore.currentSong) {
    playerStore.addToPlaylist(song)
    message.success('已加入播放队列')
    return
  }
  playerStore.insertNextToPlaylist(song)
  message.success('已加入下一首播放')
}

function playPreviewAt(index: number): void {
  playPool(heroPool.value, index)
}

// ==================== 快捷入口 ====================

/** 随机播一首：本地曲库重新抽样后随机挑一首 */
function actionLucky(): void {
  const localSongs = sampleLocalSongs(LOCAL_SAMPLE_SIZE)
  const pool = [...dailyPool.value, ...localSongs.map(localToPlayerSong)]
  if (!pool.length) {
    message.warning('本地曲库还是空的，先扫描一下本地音乐吧')
    return
  }
  const index = Math.floor(Math.random() * pool.length)
  playPool(pool, index)
  message.success(`手气不错，来听「${pool[index].title}」`)
}

/** 每日推荐：拉一次网易云每日推荐并整队播放 */
async function actionDaily(): Promise<void> {
  if (actionLoading.value) return
  actionLoading.value = 'daily'
  try {
    let pool = dailyPool.value
    if (!pool.length) {
      const songs = await window.api.netease.dailySongs()
      pool = songs.map(neteaseToPlayerSong)
      dailyPool.value = pool
    }
    if (!pool.length) {
      message.warning('暂时拿不到每日推荐，请稍后再试')
      return
    }
    playPool(pool, 0)
    message.success(`已开始播放每日推荐 · ${pool.length} 首`)
  } catch (e) {
    console.error('[HomeView] 加载每日推荐失败:', e)
    message.error('加载每日推荐失败')
  } finally {
    actionLoading.value = null
  }
}

const quickActions = [
  {
    key: 'lucky',
    icon: 'mgc_magic_1_fill',
    title: '试试手气',
    desc: '随机播放一首',
    run: actionLucky
  },
  {
    key: 'daily',
    icon: 'mgc_calendar_day_fill',
    title: '每日推荐',
    desc: '每天为你精选',
    run: actionDaily
  }
]

// ==================== 反复聆听 ====================

const TOP_LIMIT = 6

const topSongs = computed(() => {
  const map = new Map<string, { song: PlayerSong; count: number; last: number }>()
  for (const record of playerStore.playHistory) {
    const key = String(record.songId)
    const exist = map.get(key)
    if (exist) {
      exist.count += 1
      exist.last = Math.max(exist.last, record.timestamp)
      continue
    }
    map.set(key, { song: recordToPlayerSong(record), count: 1, last: record.timestamp })
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, TOP_LIMIT)
})

function playTopAt(index: number): void {
  playPool(
    topSongs.value.map((item) => item.song),
    index
  )
}

// ==================== 本周统计 ====================

/** 本周起始时间（周一 00:00） */
function startOfWeek(now: Date): number {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const day = date.getDay() || 7
  date.setDate(date.getDate() - (day - 1))
  return date.getTime()
}

const DAY_MS = 24 * 60 * 60 * 1000

function dayKey(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

const weekHours = computed(() => {
  const weekStart = startOfWeek(greetingNow.value)
  const totalMs = playerStore.playHistory
    .filter((record) => record.timestamp >= weekStart)
    .reduce((sum, record) => sum + (record.durationMs || 0), 0)
  return (totalMs / 3_600_000).toFixed(1)
})

/** 连续收听天数：从今天（或昨天）往前推，遇到空档即停 */
const streakDays = computed(() => {
  const days = new Set(playerStore.playHistory.map((record) => dayKey(record.timestamp)))
  if (days.size === 0) return 0
  let cursor = Date.now()
  // 今天还没听时允许从昨天起算，避免刚过零点就清零
  if (!days.has(dayKey(cursor))) cursor -= DAY_MS
  let count = 0
  while (days.has(dayKey(cursor))) {
    count += 1
    cursor -= DAY_MS
  }
  return count
})

const stats = computed(() => [
  { key: 'hours', value: weekHours.value, unit: 'h', label: '本周时长' },
  {
    key: 'playlists',
    value: String(favoritedPlaylistCount.value),
    unit: '个',
    label: '收藏歌单'
  },
  { key: 'streak', value: String(streakDays.value), unit: '天', label: '连续收听' }
])

// ==================== 专属歌单 ====================

async function playHomePlaylist(item: (typeof homePlaylists.value)[number]): Promise<void> {
  if (item.localId) {
    router.push({ name: 'playlist-detail', params: { id: item.localId } })
    return
  }
  if (!item.neteaseId || playlistLoadingKey.value) return
  playlistLoadingKey.value = item.key
  try {
    const songs = await window.api.netease.playlistTracks(item.neteaseId)
    const pool = songs.map(neteaseToPlayerSong)
    if (!pool.length) {
      message.warning('这个歌单暂时拉不到曲目')
      return
    }
    playPool(pool, 0)
    message.success(`已开始播放「${item.name}」· ${pool.length} 首`)
  } catch (e) {
    console.error('[HomeView] 加载歌单失败:', e)
    message.error('加载歌单失败')
  } finally {
    playlistLoadingKey.value = null
  }
}

// ==================== 生命周期 ====================

onMounted(() => {
  playerStore.loadHistory()
  startGreetingTimer()
  rollHero()
  void loadHomeData()
})

onActivated(() => {
  startGreetingTimer()
  void loadHomeData()
})

onDeactivated(() => {
  stopGreetingTimer()
})

onUnmounted(() => {
  stopGreetingTimer()
})
</script>

<template>
  <div class="home-view">
    <!--
      顶部留白放在滚动内容里（而不是根容器）：
      根容器必须占满内容区，内容才能在滚动时滑到浮动头部下方，被头部的渐进模糊糊到。
    -->
    <n-scrollbar style="height: 100%" content-style="padding: 80px 28px 40px;">
      <!-- 问候区 + 本周统计 -->
      <header class="home-header">
        <div class="header-main">
          <h1 class="greeting">{{ greetingText }}，{{ nickname }}</h1>
          <p class="greeting-sub">{{ subline }}</p>
        </div>
        <div class="header-stats">
          <div v-for="item in stats" :key="item.key" class="stat-item">
            <div class="stat-value">
              {{ item.value }}<span class="stat-unit">{{ item.unit }}</span>
            </div>
            <div class="stat-label">{{ item.label }}</div>
          </div>
        </div>
      </header>

      <!-- 主卡片：随机翻到了 xxx -->
      <n-card
        v-if="settingsStore.appearance.homeShowInfoCards"
        class="hero-card"
        :bordered="false"
        content-style="padding: 22px 24px;"
      >
        <n-skeleton v-if="homeLoading && !hero" height="180px" :sharp="false" />
        <div v-else-if="hero" class="hero-body">
          <div class="hero-left">
            <div class="hero-cover" @click="playHero">
              <img :src="hero.cover" alt="" />
              <div class="hero-cover-play">
                <n-icon size="26"><i class="mgc_play_fill"></i></n-icon>
              </div>
            </div>
            <div class="hero-info">
              <div class="hero-tag-row">
                <n-tag size="small" round :bordered="false" class="hero-tag">
                  <template #icon>
                    <n-icon size="13"><i :class="heroSource.icon"></i></n-icon>
                  </template>
                  {{ heroSource.label }}
                </n-tag>
                <n-button text size="tiny" class="hero-reroll" @click="rollHero">
                  <template #icon>
                    <n-icon size="14"><i class="mgc_refresh_2_line"></i></n-icon>
                  </template>
                  换一首
                </n-button>
              </div>
              <h2 class="hero-title">随机翻到了「{{ hero.title }}」</h2>
              <p class="hero-meta">{{ heroMeta }}</p>
              <div class="hero-actions">
                <n-button type="primary" round strong @click="playHero">
                  <template #icon>
                    <n-icon size="16"><i class="mgc_play_fill"></i></n-icon>
                  </template>
                  立即播放
                </n-button>
                <n-button round tertiary @click="queueHero">
                  <template #icon>
                    <n-icon size="16"><i class="mgc_add_line"></i></n-icon>
                  </template>
                  添加到队列
                </n-button>
              </div>
            </div>
          </div>

          <ul class="hero-list">
            <li
              v-for="(track, index) in heroPreview"
              :key="`${track.id}-${index}`"
              class="hero-row"
              @click="playPreviewAt(index)"
            >
              <span class="hero-row-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="hero-row-title">{{ track.title }}</span>
              <span class="hero-row-artist">{{ track.artist }}</span>
            </li>
          </ul>
        </div>
        <n-empty v-else size="small" description="曲库还没有歌，先扫描本地音乐吧" />
      </n-card>
      <div v-else class="greeting-only">
        <p class="greeting-sub">愿旋律与你不期而遇</p>
      </div>

      <!-- 快捷入口 -->
      <n-grid class="quick-grid" cols="1 m:2" responsive="screen" :x-gap="12" :y-gap="12">
        <n-grid-item v-for="action in quickActions" :key="action.key">
          <n-card
            class="action-card"
            :bordered="false"
            hoverable
            content-style="padding: 16px 18px;"
            @click="action.run"
          >
            <div class="action-inner">
              <span class="action-icon">
                <n-icon size="20"><i :class="action.icon"></i></n-icon>
              </span>
              <span class="action-text">
                <span class="action-title">{{ action.title }}</span>
                <span class="action-desc">{{ action.desc }}</span>
              </span>
              <n-spin v-if="actionLoading === action.key" :size="14" />
              <n-icon v-else size="15" class="action-arrow">
                <i class="mgc_right_line"></i>
              </n-icon>
            </div>
          </n-card>
        </n-grid-item>
      </n-grid>

      <!-- 反复聆听 -->
      <section v-if="topSongs.length" class="section">
        <div class="section-header">
          <h3 class="section-title">反复聆听</h3>
          <p class="section-desc">你最常听的 {{ topSongs.length }} 首歌</p>
        </div>
        <n-grid cols="1 m:2 l:3" responsive="screen" :x-gap="12" :y-gap="10">
          <n-grid-item v-for="(item, index) in topSongs" :key="String(item.song.id)">
            <n-card
              class="track-card"
              :bordered="false"
              hoverable
              content-style="padding: 10px 14px;"
              @click="playTopAt(index)"
            >
              <div class="track-inner">
                <span class="track-index">{{ String(index + 1).padStart(2, '0') }}</span>
                <img class="track-cover" :src="item.song.cover" alt="" loading="lazy" />
                <span class="track-text">
                  <span class="track-title">{{ item.song.title }}</span>
                  <span class="track-artist">{{ item.song.artist }}</span>
                </span>
                <span class="track-count">播放 {{ item.count }} 次</span>
              </div>
            </n-card>
          </n-grid-item>
        </n-grid>
      </section>

      <!-- 专属歌单 -->
      <section class="section">
        <div class="section-header">
          <h3 class="section-title">专属歌单</h3>
          <p class="section-desc">为你量身定制的歌单精选</p>
        </div>
        <n-grid cols="2 m:3 l:6" responsive="screen" :x-gap="12" :y-gap="12">
          <n-grid-item v-for="item in homePlaylists" :key="item.key">
            <n-card
              class="playlist-card"
              :bordered="false"
              hoverable
              content-style="padding: 10px;"
              @click="playHomePlaylist(item)"
            >
              <div class="playlist-cover">
                <img :src="item.cover" alt="" loading="lazy" />
                <div class="playlist-cover-mask">
                  <n-spin v-if="playlistLoadingKey === item.key" :size="20" />
                  <n-icon v-else size="24"><i class="mgc_play_fill"></i></n-icon>
                </div>
              </div>
              <div class="playlist-title">{{ item.name }}</div>
              <div class="playlist-count">{{ item.count }} 首</div>
            </n-card>
          </n-grid-item>
        </n-grid>
        <n-empty
          v-if="!homePlaylists.length && !homeLoading"
          size="small"
          description="暂无推荐歌单"
        />
      </section>
    </n-scrollbar>
  </div>
</template>

<style scoped>
/*
 * 统一表面色：深色下用极轻的白色叠加，浅色下用极轻的黑色叠加，
 * 与全局「近黑底色 + 半透明柔光」的观感保持一致，不引入新的视觉体系。
 */
.home-view {
  --home-surface: rgba(255, 255, 255, 0.045);
  --home-surface-hover: rgba(255, 255, 255, 0.075);
  --home-border: rgba(255, 255, 255, 0.075);
  --home-text: rgba(255, 255, 255, 0.92);
  --home-text-weak: rgba(255, 255, 255, 0.5);
  height: 100%;
}

html[data-theme='light'] .home-view {
  --home-surface: rgba(0, 0, 0, 0.028);
  --home-surface-hover: rgba(0, 0, 0, 0.05);
  --home-border: rgba(0, 0, 0, 0.08);
  --home-text: rgba(0, 0, 0, 0.86);
  --home-text-weak: rgba(0, 0, 0, 0.45);
}

/* ===== 问候区 ===== */
.home-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 8px 4px 24px;
}

.greeting {
  margin: 0;
  font-family: 'SHSC', serif;
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 0.01em;
  line-height: 1.35;
  color: var(--home-text);
}

.greeting-sub {
  margin: 6px 0 0;
  font-size: 13px;
  letter-spacing: 0.03em;
  color: var(--home-text-weak);
}

.header-stats {
  display: flex;
  gap: 34px;
  flex-shrink: 0;
}

.stat-item {
  text-align: right;
}

.stat-value {
  font-family: 'SHSC', serif;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  color: var(--home-text);
}

.stat-unit {
  font-size: 12px;
  font-weight: 600;
  margin-left: 2px;
  color: var(--home-text-weak);
}

.stat-label {
  margin-top: 2px;
  font-size: 12px;
  color: var(--home-text-weak);
}

.greeting-only {
  padding: 0 4px 8px;
}

/* ===== 主卡片 ===== */
.hero-card {
  --n-color: var(--home-surface);
  --n-border-color: var(--home-border);
  border-radius: 16px;
  border: 1px solid var(--home-border);
  overflow: hidden;
  position: relative;
}

/* 卡片右上角一团极淡的柔光，避免大片纯色显得平板 */
.hero-card::after {
  content: '';
  position: absolute;
  top: -80px;
  right: -40px;
  width: 280px;
  height: 180px;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.09), transparent 70%);
  pointer-events: none;
}

.hero-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 0.92fr);
  gap: 26px;
  position: relative;
  z-index: 1;
}

.hero-left {
  display: flex;
  align-items: center;
  gap: 20px;
  min-width: 0;
}

.hero-cover {
  position: relative;
  width: 136px;
  height: 136px;
  flex-shrink: 0;
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.32);
}

.hero-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.4s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.hero-cover-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: rgba(0, 0, 0, 0.34);
  opacity: 0;
  transition: opacity 0.25s;
}

.hero-cover:hover .hero-cover-play {
  opacity: 1;
}

.hero-cover:hover img {
  transform: scale(1.06);
}

.hero-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hero-tag-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.hero-tag {
  --n-color: rgba(255, 255, 255, 0.1);
  --n-text-color: var(--home-text);
  backdrop-filter: blur(6px);
}

html[data-theme='light'] .hero-tag {
  --n-color: rgba(0, 0, 0, 0.06);
}

.hero-reroll {
  font-size: 12px;
  color: var(--home-text-weak);
}

.hero-title {
  margin: 0;
  font-family: 'SHSC', serif;
  font-size: 25px;
  font-weight: 700;
  line-height: 1.35;
  color: var(--home-text);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.hero-meta {
  margin: 0;
  font-size: 12.5px;
  color: var(--home-text-weak);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}

.hero-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
}

.hero-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 9px 8px;
  border-bottom: 1px solid var(--home-border);
  cursor: pointer;
  border-radius: 8px;
  transition: background-color 0.2s;
}

.hero-row:last-child {
  border-bottom: none;
}

.hero-row:hover {
  background: var(--home-surface-hover);
}

.hero-row-index {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--home-text-weak);
  flex-shrink: 0;
}

.hero-row-title {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  color: var(--home-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hero-row-artist {
  font-size: 12px;
  color: var(--home-text-weak);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== 快捷入口 ===== */
.quick-grid {
  margin-top: 14px;
}

.action-card {
  --n-color: var(--home-surface);
  border-radius: 12px;
  border: 1px solid var(--home-border);
  cursor: pointer;
  transition:
    background-color 0.2s,
    transform 0.2s;
}

.action-card:hover {
  background: var(--home-surface-hover);
  transform: translateY(-2px);
}

.action-inner {
  display: flex;
  align-items: center;
  gap: 12px;
}

.action-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 10px;
  border: 1px solid var(--home-border);
  color: var(--home-text);
  background: var(--home-surface-hover);
}

.action-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.action-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--home-text);
}

.action-desc {
  font-size: 11.5px;
  color: var(--home-text-weak);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-arrow {
  color: var(--home-text-weak);
  opacity: 0;
  transition:
    opacity 0.2s,
    transform 0.2s;
}

.action-card:hover .action-arrow {
  opacity: 1;
  transform: translateX(2px);
}

/* ===== 区块 ===== */
.section {
  margin-top: 34px;
}

.section-header {
  padding: 0 4px 12px;
}

.section-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--home-text);
}

.section-desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--home-text-weak);
}

/* ===== 反复聆听 ===== */
.track-card {
  --n-color: var(--home-surface);
  border-radius: 10px;
  border: 1px solid var(--home-border);
  cursor: pointer;
  transition: background-color 0.2s;
}

.track-card:hover {
  background: var(--home-surface-hover);
}

.track-inner {
  display: flex;
  align-items: center;
  gap: 12px;
}

.track-index {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--home-text-weak);
  flex-shrink: 0;
}

.track-cover {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
  background: var(--home-surface-hover);
}

.track-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.track-title {
  font-size: 13.5px;
  color: var(--home-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-artist {
  font-size: 11.5px;
  color: var(--home-text-weak);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-count {
  font-size: 11.5px;
  color: var(--home-text-weak);
  flex-shrink: 0;
}

/* ===== 专属歌单 ===== */
.playlist-card {
  --n-color: transparent;
  border-radius: 12px;
  border: 1px solid transparent;
  cursor: pointer;
  transition:
    background-color 0.2s,
    border-color 0.2s;
}

.playlist-card:hover {
  background: var(--home-surface);
  border-color: var(--home-border);
}

.playlist-cover {
  position: relative;
  width: 100%;
  padding-bottom: 100%;
  border-radius: 10px;
  overflow: hidden;
  background: var(--home-surface-hover);
}

.playlist-cover img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.35s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.playlist-card:hover .playlist-cover img {
  transform: scale(1.05);
}

.playlist-cover-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: rgba(0, 0, 0, 0.32);
  opacity: 0;
  transition: opacity 0.25s;
}

.playlist-card:hover .playlist-cover-mask {
  opacity: 1;
}

.playlist-title {
  margin-top: 8px;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--home-text);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.playlist-count {
  margin-top: 3px;
  font-size: 11px;
  color: var(--home-text-weak);
}

/* ===== 响应式 ===== */
@media (max-width: 900px) {
  .hero-body {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }

  .hero-list {
    border-top: 1px solid var(--home-border);
    padding-top: 6px;
  }
}

@media (max-width: 860px) {
  .home-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
  }

  .header-stats {
    gap: 24px;
    width: 100%;
  }

  .stat-item {
    text-align: left;
  }

  .greeting {
    font-size: 24px;
  }

  .hero-cover {
    width: 96px;
    height: 96px;
  }

  .hero-title {
    font-size: 20px;
  }
}
</style>
