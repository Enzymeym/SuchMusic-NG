<template>
  <!-- 加载中：网易云歌手首屏拉取 -->
  <div v-if="loading" class="sd-status">
    <n-spin size="large" />
    <p class="sd-status-text">正在加载歌手…</p>
  </div>

  <!-- 未找到 -->
  <div v-else-if="!hasContent" class="sd-status">
    <n-empty :description="loadFailed ? '歌手信息获取失败' : '未找到该歌手'" />
    <div class="sd-status-actions">
      <n-button v-if="isNetease" secondary round @click="reload">重试</n-button>
      <n-button round @click="router.back()">返回</n-button>
    </div>
  </div>

  <!-- 歌手详情 -->
  <div v-else class="singer-detail">
    <!-- 顶部主视觉：大图 + 手写体歌手名 + 操作按钮 -->
    <header class="hero">
      <div
        v-if="heroImage"
        class="hero-media"
        :style="{ '--hero-image': `url('${heroImage}')` }"
      ></div>
      <div class="hero-inner">
        <h1 class="hero-name" :class="{ 'hero-name--script': useScriptFont }" :title="displayName">
          {{ displayName }}
        </h1>
        <p class="hero-meta">{{ metaLine }}</p>

        <div class="hero-actions">
          <button class="hero-btn" title="随机播放" @click="shuffleAll">
            <i class="mgc_shuffle_line"></i>
          </button>

          <button class="hero-btn hero-btn--play" title="播放全部" @click="playAll">
            <i class="mgc_play_fill"></i>
            <span>播放</span>
          </button>

          <n-dropdown
            trigger="click"
            placement="bottom-start"
            :options="moreOptions"
            @select="handleMoreSelect"
          >
            <button class="hero-btn" title="更多操作">
              <i class="mgc_plus_line"></i>
            </button>
          </n-dropdown>
        </div>
      </div>
    </header>

    <!-- 歌曲 / 专辑 -->
    <div class="sd-body">
      <div class="sd-tabbar">
        <button class="sd-tab" :class="{ active: activeTab === 'songs' }" @click="activeTab = 'songs'">
          歌曲
          <span class="sd-tab-count">{{ songCount }}</span>
        </button>
        <button
          class="sd-tab"
          :class="{ active: activeTab === 'albums' }"
          @click="activeTab = 'albums'"
        >
          专辑
          <span class="sd-tab-count">{{ albums.length }}</span>
        </button>
        <div class="sd-tabbar-spacer"></div>
        <span v-if="isNetease" class="sd-source-tag">
          <i class="mgc_netease_music_line"></i>
          网易云
        </span>
      </div>

      <div class="sd-pane">
        <SongList
          v-if="activeTab === 'songs'"
          :songs="songs"
          :loading="songsLoadingMore"
          :load-more="songsLoadingMore"
          :current-playing-song-id="currentPlayingId"
          :transparent-header="true"
          item-variant="plain"
          @song-click="handleSongClick"
          @scroll="handleSongsScroll"
        />

        <template v-else>
          <n-scrollbar v-if="albums.length > 0" class="sd-albums-scroll">
            <div class="sd-albums-grid">
              <div
                v-for="album in albums"
                :key="album.id || album.name"
                class="sd-album-card"
                @click="openAlbum(album)"
              >
                <div class="sd-album-cover">
                  <img :src="album.cover || defaultCover" loading="lazy" decoding="async" />
                  <div class="sd-album-play">
                    <i class="mgc_play_fill"></i>
                  </div>
                </div>
                <div class="sd-album-name" :title="album.name">{{ album.name }}</div>
                <div class="sd-album-sub">{{ albumSubtitle(album) }}</div>
              </div>
            </div>
          </n-scrollbar>
          <n-empty v-else description="暂无专辑" class="sd-empty" />
        </template>
      </div>
    </div>

    <!-- 网易云专辑曲目（本地专辑直接跳转专辑详情页） -->
    <n-modal
      v-model:show="albumModal.show"
      preset="card"
      class="sd-album-modal"
      :title="albumModal.title"
      :bordered="false"
      style="width: 680px; max-width: 92vw"
    >
      <template #header-extra>
        <span class="sd-album-modal-count">
          {{ albumModal.songs.length }} 首 · {{ formatTotalDuration(albumModal.durationMs) }}
        </span>
      </template>
      <n-spin :show="albumModal.loading">
        <div class="sd-album-tracks">
          <div
            v-for="(track, index) in albumModal.songs"
            :key="track.id"
            class="sd-album-track"
            @click="playAlbumTrack(index)"
          >
            <span class="sd-album-track-index">{{ index + 1 }}</span>
            <span class="sd-album-track-name" :title="track.name">{{ track.name }}</span>
            <span class="sd-album-track-duration">{{ formatDuration(track.dt) }}</span>
          </div>
        </div>
      </n-spin>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NDropdown, NEmpty, NModal, NScrollbar, NSpin, NButton, useMessage } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import { usePlayerStore, type PlayerSong } from '../stores/playerStore'
import { useLocalMusicStore } from '../stores/localMusicStore'
import { usePlaylistStore } from '../stores/playlistStore'
import { albumCache } from '../stores/albumCache'
import SongList from '../components/common/SongList.vue'
import defaultCover from '@renderer/assets/default-cover.png'
import { formatDuration } from '../utils/format'

/** 预加载桥推导出的网易云类型 */
type NeteaseSong = Awaited<ReturnType<typeof window.api.netease.artistSongs>>['songs'][number]
type NeteaseArtistDetail = NonNullable<Awaited<ReturnType<typeof window.api.netease.artistDetail>>>
type NeteaseArtistAlbum = Awaited<ReturnType<typeof window.api.netease.artistAlbums>>['albums'][number]

/** 统一后的歌曲行（SongList 兼容结构 + 播放所需字段） */
interface ArtistSongRow {
  id: string | number
  name: string
  ar: { id?: number; name: string }[]
  al?: { name: string; picUrl?: string }
  dt?: number
  picUrl?: string
  filePath?: string
  source?: string
  sourceSongId?: number | string
}

/** 统一后的专辑卡 */
interface ArtistAlbumRow {
  id: number
  name: string
  cover: string
  size: number
  publishTime: number
  /** 本地专辑保留原始分组，供专辑详情页读取 */
  local?: boolean
}

const route = useRoute()
const router = useRouter()
const playerStore = usePlayerStore()
const localMusicStore = useLocalMusicStore()
const playlistStore = usePlaylistStore()
const message = useMessage()

/** 路由里的歌手名（网易云返回正式名后会覆盖） */
const routeArtistName = computed(() => String(route.params.name || ''))

/** 网易云歌手 ID（搜索页点歌手名时通过 ?wy= 传入） */
const neteaseId = computed(() => {
  const raw = Array.isArray(route.query.wy) ? route.query.wy[0] : route.query.wy
  const id = Number(raw)
  return Number.isFinite(id) && id > 0 ? id : 0
})
const isNetease = computed(() => neteaseId.value > 0)

const wyDetail = ref<NeteaseArtistDetail | null>(null)
const wySongs = ref<NeteaseSong[]>([])
const wyAlbums = ref<NeteaseArtistAlbum[]>([])
const wyHasMoreSongs = ref(false)
const loading = ref(false)
const loadFailed = ref(false)
const songsLoadingMore = ref(false)
const activeTab = ref<'songs' | 'albums'>('songs')

/* ================== 本地歌手聚合（无 ?wy= 时使用） ================== */

/**
 * 从本地曲库 + 播放历史聚合该歌手的歌曲
 * 用 Set 去重，避免大曲库下 Array.find 的 O(n²) 退化
 */
const localSongs = computed<ArtistSongRow[]>(() => {
  if (isNetease.value) return []
  const name = routeArtistName.value
  if (!name) return []

  const rows: ArtistSongRow[] = []
  const seen = new Set<string>()

  localMusicStore.songs.forEach((song) => {
    const songArtist = song.ar?.[0]?.name || '未知歌手'
    if (songArtist !== name) return
    const id = String(song.id)
    if (seen.has(id)) return
    seen.add(id)
    rows.push({
      id: song.id,
      name: song.name,
      ar: [{ name: songArtist }],
      al: { name: song.al?.name || '未知专辑', picUrl: song.picUrl || song.al?.picUrl },
      dt: song.dt,
      picUrl: song.picUrl || song.al?.picUrl,
      filePath: song.filePath,
      source: 'local',
      sourceSongId: song.id
    })
  })

  playerStore.playHistory.forEach((record) => {
    if ((record.artist || '未知歌手') !== name) return
    const id = String(record.songId)
    if (seen.has(id)) return
    seen.add(id)
    rows.push({
      id: record.songId,
      name: record.title,
      ar: [{ name: record.artist || name }],
      al: { name: record.album || '未知专辑', picUrl: record.cover },
      picUrl: record.cover,
      filePath: record.filePath,
      source: 'local',
      sourceSongId: record.songId
    })
  })

  return rows
})

/** 本地该歌手的专辑 */
const localAlbums = computed<ArtistAlbumRow[]>(() => {
  if (isNetease.value) return []
  const name = routeArtistName.value
  if (!name) return []
  return localMusicStore.albumList
    .filter((album) => album.artist === name)
    .map((album) => ({
      id: 0,
      name: album.name,
      cover: album.cover,
      size: album.songs.length,
      publishTime: 0,
      local: true
    }))
})

/* ================== 统一视图数据 ================== */

const songs = computed<any[]>(() => (isNetease.value ? wySongs.value : localSongs.value))
const albums = computed<ArtistAlbumRow[]>(() => (isNetease.value ? wyAlbums.value : localAlbums.value))

const displayName = computed(() => wyDetail.value?.name || routeArtistName.value || '未知歌手')

const songCount = computed(() => {
  if (!isNetease.value) return songs.value.length
  return wyDetail.value?.musicSize || songs.value.length
})

const totalDurationMs = computed(() =>
  songs.value.reduce((sum, song) => sum + (song.dt || 0), 0)
)

/**
 * 名字里含拉丁字母就用手写体。
 * 字体只覆盖拉丁字形，中文（含「周杰伦 Jay Chou」这类混排）会自动逐字回退到系统字体，
 * 所以这里不用把纯中文名排除掉，也不需要判断是否整串都是英文。
 */
const useScriptFont = computed(() => /[A-Za-z]/.test(displayName.value))

const heroImage = computed(() => {
  const fromDetail = wyDetail.value?.cover || ''
  if (fromDetail) return fromDetail
  return songs.value.find((song) => song.picUrl || song.al?.picUrl)?.picUrl
    || songs.value.find((song) => song.al?.picUrl)?.al?.picUrl
    || ''
})

/**
 * 副标题：`N 首歌曲 · 约 X 分钟`（对齐参考图的「1 首歌曲 · 4 分钟」）
 * 网易云歌手只加载了前若干首时，用「专辑数」代替时长，避免用部分曲目算出误导性的总时长
 */
const metaLine = computed(() => {
  const parts: string[] = [`${songCount.value} 首歌曲`]
  const allLoaded = songCount.value <= songs.value.length
  if (allLoaded && totalDurationMs.value > 0) {
    parts.push(formatTotalDuration(totalDurationMs.value))
  } else if (albums.value.length > 0) {
    parts.push(`${albums.value.length} 张专辑`)
  }
  return parts.join(' · ')
})

const hasContent = computed(() => {
  if (isNetease.value) return !!wyDetail.value || wySongs.value.length > 0
  return localSongs.value.length > 0
})

/**
 * 当前正在播放的曲目 ID（SongList 用 song.id 直接比对）
 * 网易云曲目在播放器里的 id 是 `wy-<id>`，需要还原为原始 id 才能高亮
 */
const currentPlayingId = computed<string | number | null>(() => {
  const song = playerStore.currentSong
  if (!song) return null
  if (isNetease.value) {
    return song.source === 'netease' ? song.sourceSongId ?? null : null
  }
  return song.source === 'netease' ? null : song.id
})

/** 将毫秒总时长格式化为「x 分钟 / x 小时 y 分钟」 */
function formatTotalDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 1) return '不到 1 分钟'
  if (totalMinutes < 60) return `${totalMinutes} 分钟`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
}

/* ================== 数据加载 ================== */

const loadNeteaseArtist = async () => {
  const id = neteaseId.value
  if (!id) return
  loading.value = true
  loadFailed.value = false
  try {
    const [detail, songPage, albumPage] = await Promise.all([
      window.api.netease.artistDetail(id),
      window.api.netease.artistSongs(id, 0),
      window.api.netease.artistAlbums(id, 0)
    ])
    wyDetail.value = detail
    wySongs.value = songPage.songs
    wyHasMoreSongs.value = songPage.hasMore
    wyAlbums.value = albumPage.albums
    if (!detail && songPage.songs.length === 0) loadFailed.value = true
  } catch (e) {
    console.error('[SingerDetail] 加载网易云歌手失败:', e)
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

const reload = () => {
  if (isNetease.value) void loadNeteaseArtist()
}

/** 滚动到底部时继续拉取歌手歌曲（接口单页上限 200） */
const handleSongsScroll = (e: Event) => {
  const target = e.target as HTMLElement
  if (!target || typeof target.scrollTop !== 'number') return
  const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 200
  if (!isNetease.value || !nearBottom) return
  if (!wyHasMoreSongs.value || songsLoadingMore.value) return
  void loadMoreSongs()
}

const loadMoreSongs = async () => {
  if (songsLoadingMore.value) return
  songsLoadingMore.value = true
  try {
    const page = await window.api.netease.artistSongs(neteaseId.value, wySongs.value.length)
    const seen = new Set(wySongs.value.map((song) => String(song.id)))
    wySongs.value = [...wySongs.value, ...page.songs.filter((song) => !seen.has(String(song.id)))]
    wyHasMoreSongs.value = page.hasMore && page.songs.length > 0
  } catch (e) {
    console.error('[SingerDetail] 加载更多歌手歌曲失败:', e)
  } finally {
    songsLoadingMore.value = false
  }
}

/* ================== 播放 ================== */

/** SongList 行 → 播放器歌曲；网易云曲目不带 filePath，由 PlayerBar 按 sourceSongId 解析 */
const toPlayerSong = (song: any): PlayerSong => {
  const isWy = song.source === 'netease'
  return {
    id: isWy ? `wy-${song.id}` : song.id,
    title: song.name,
    artist: (song.ar || []).map((artist: { name: string }) => artist.name).join(' / ') || displayName.value,
    album: song.al?.name,
    cover: song.picUrl || song.al?.picUrl || '',
    durationMs: song.dt || 0,
    filePath: song.filePath || '',
    source: isWy ? 'netease' : 'local',
    sourceSongId: isWy ? song.id : song.sourceSongId ?? song.id
  }
}

const playAll = () => {
  const list = songs.value.map(toPlayerSong)
  if (list.length === 0) {
    message.warning('该歌手暂无可播放歌曲')
    return
  }
  playerStore.setPlaylist(list)
  playerStore.playSongAtIndex(0)
}

const shuffleAll = () => {
  const list = songs.value.map(toPlayerSong)
  if (list.length === 0) {
    message.warning('该歌手暂无可播放歌曲')
    return
  }
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  playerStore.setPlaylist(list)
  playerStore.playSongAtIndex(0)
}

const handleSongClick = (song: any) => {
  const list = songs.value.map(toPlayerSong)
  const index = list.findIndex((item) => String(item.id) === String(song.id))
  if (index < 0) return
  playerStore.setPlaylist(list)
  playerStore.playSongAtIndex(index)
}

const playAlbumTrack = (index: number) => {
  const list = albumModal.songs.map((song) => toPlayerSong({ ...song, source: 'netease' }))
  if (list.length === 0) return
  albumModal.show = false
  playerStore.setPlaylist(list)
  playerStore.playSongAtIndex(index)
}

/* ================== 专辑 ================== */

const albumModal = reactive({
  show: false,
  loading: false,
  title: '',
  songs: [] as NeteaseSong[],
  durationMs: 0
})

const albumSubtitle = (album: ArtistAlbumRow) => {
  const parts: string[] = []
  if (album.publishTime) parts.push(String(new Date(album.publishTime).getFullYear()))
  if (album.size > 0) parts.push(`${album.size} 首`)
  return parts.join(' · ') || '专辑'
}

const openAlbum = async (album: ArtistAlbumRow) => {
  // 本地专辑走原有的专辑详情页
  if (album.local || !isNetease.value) {
    router.push('/album/' + encodeURIComponent(album.name))
    return
  }
  albumModal.show = true
  albumModal.title = album.name
  albumModal.songs = []
  albumModal.durationMs = 0
  albumModal.loading = true
  try {
    const tracks = await window.api.netease.albumTracks(album.id)
    albumModal.songs = tracks
    albumModal.durationMs = tracks.reduce((sum, track) => sum + (track.dt || 0), 0)
  } catch (e) {
    console.error('[SingerDetail] 加载专辑曲目失败:', e)
    message.error('专辑曲目加载失败')
  } finally {
    albumModal.loading = false
  }
}

// 同步本地专辑到缓存，供 AlbumDetailView 使用
watch(
  localAlbums,
  (list) => {
    for (const album of list) {
      const origin = localMusicStore.albumList.find((item) => item.name === album.name)
      if (origin) albumCache.set(origin.name, origin)
    }
  },
  { immediate: true, deep: false }
)

/* ================== 更多操作 ================== */

const moreOptions = computed<DropdownOption[]>(() => {
  const playlists = playlistStore.playlists
  const addOptions: DropdownOption[] =
    playlists.length > 0
      ? playlists.map((playlist) => ({ label: playlist.name, key: `add:${playlist.id}` }))
      : [{ label: '暂无歌单', key: 'no-playlist', disabled: true }]

  return [
    { label: '全部加入歌单', key: 'add', children: addOptions },
    { label: '复制歌手名', key: 'copy-name' }
  ]
})

const handleMoreSelect = async (key: string | number) => {
  const keyStr = String(key)
  if (keyStr.startsWith('add:')) {
    const playlistId = keyStr.slice('add:'.length)
    const playlist = playlistStore.playlists.find((item) => item.id === playlistId)
    if (!playlist) {
      message.error('歌单不存在，请刷新后重试')
      return
    }
    const list = songs.value.map(toPlayerSong)
    if (list.length === 0) {
      message.warning('该歌手暂无可加入的歌曲')
      return
    }
    const existing = new Set(playlist.tracks.map((track) => String(track.id)))
    const added = list.filter((track) => !existing.has(String(track.id)))
    if (added.length === 0) {
      message.info('歌单中已包含该歌手的全部歌曲')
      return
    }
    playlistStore.updatePlaylist({ ...playlist, tracks: [...playlist.tracks, ...added] })
    message.success(`已将 ${added.length} 首歌曲加入「${playlist.name}」`)
    return
  }

  if (keyStr === 'copy-name') {
    try {
      await navigator.clipboard.writeText(displayName.value)
      message.success('歌手名已复制')
    } catch (e) {
      console.error('[SingerDetail] 复制歌手名失败:', e)
      message.error('复制失败')
    }
  }
}

/* ================== 初始化 ================== */

onMounted(() => {
  playerStore.loadHistory()
  if (!playlistStore.playlists.length) playlistStore.loadFromStorage()
  if (isNetease.value) {
    void loadNeteaseArtist()
  }
})
</script>

<style scoped>
.singer-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* ===== 顶部主视觉 ===== */
.hero {
  position: relative;
  flex: 0 0 auto;
  height: clamp(320px, 46vh, 480px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  overflow: hidden;
}

/*
 * 背景大图 + 压暗层 + 底部渐隐：
 * 渐隐用 mask 实现，使图片自然过渡到当前主题的页面底色（深浅色都不用改）
 */
.hero-media {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(
      180deg,
      rgba(0, 0, 0, 0.44) 0%,
      rgba(0, 0, 0, 0.1) 26%,
      rgba(0, 0, 0, 0.45) 58%,
      rgba(0, 0, 0, 0.84) 100%
    ),
    var(--hero-image);
  background-size: cover, cover;
  background-position: center center, center 22%;
  background-repeat: no-repeat, no-repeat;
  transform: scale(1.02);
  -webkit-mask-image: linear-gradient(
    to bottom,
    #000 0%,
    #000 42%,
    rgba(0, 0, 0, 0.72) 66%,
    rgba(0, 0, 0, 0.3) 86%,
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    #000 0%,
    #000 42%,
    rgba(0, 0, 0, 0.72) 66%,
    rgba(0, 0, 0, 0.3) 86%,
    transparent 100%
  );
}

.hero-inner {
  position: relative;
  z-index: 1;
  width: 100%;
  padding: 0 32px 34px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
}

.hero-name {
  margin: 0;
  max-width: 92%;
  font-size: clamp(40px, 5vw, 68px);
  font-weight: 800;
  letter-spacing: -0.01em;
  line-height: 1.12;
  color: rgba(255, 255, 255, 0.86);
  text-shadow: 0 2px 28px rgba(0, 0, 0, 0.42);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 英文手写体：字重与行高按字体特性单独放宽 */
/* 注意：兜底值必须是有字体名的列表，写 inherit 会让整条声明作废、回退到系统字体 */
.hero-name--script {
  font-family: 'Florida Vibes', var(--app-font-family, system-ui, sans-serif);
  font-weight: 400;
  font-size: clamp(54px, 7vw, 96px);
  line-height: 1.24;
  letter-spacing: 0.005em;
  color: rgba(255, 255, 255, 0.74);
  padding-bottom: 2px;
}

.hero-meta {
  margin: 0;
  font-size: 13.5px;
  letter-spacing: 0.02em;
  color: rgba(255, 255, 255, 0.64);
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.4);
}

.hero-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 16px;
}

/* 半透明玻璃按钮，透出背后图片的颜色（与参考图观感一致） */
.hero-btn {
  height: 46px;
  min-width: 46px;
  padding: 0 13px;
  border-radius: 23px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background-color: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.92);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  font-size: 15px;
  cursor: pointer;
  backdrop-filter: blur(18px) saturate(150%);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  transition:
    background-color 0.2s ease,
    transform 0.2s ease;
}

.hero-btn i {
  font-size: 18px;
  font-style: normal;
  line-height: 1;
}

.hero-btn:hover {
  background-color: rgba(255, 255, 255, 0.22);
  transform: translateY(-1px);
}

.hero-btn:active {
  transform: translateY(0) scale(0.98);
}

.hero-btn--play {
  padding: 0 26px;
  font-weight: 600;
  background-color: rgba(255, 255, 255, 0.17);
}

.hero-btn--play i {
  font-size: 15px;
}

/* ===== 内容区 ===== */
.sd-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 4px 32px 0;
}

.sd-tabbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
}

.sd-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border-radius: 16px;
  border: none;
  background: transparent;
  color: #8a8a8a;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.sd-tab:hover {
  color: var(--n-text-color, #1a1a1a);
  background-color: rgba(128, 128, 128, 0.12);
}

.sd-tab.active {
  color: var(--n-text-color, #1a1a1a);
  background-color: rgba(128, 128, 128, 0.18);
}

.sd-tab-count {
  font-size: 12px;
  font-weight: 500;
  opacity: 0.7;
}

.sd-tabbar-spacer {
  flex: 1;
}

.sd-source-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #a06666;
  opacity: 0.85;
}

.sd-source-tag i {
  font-size: 14px;
  font-style: normal;
}

.sd-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sd-albums-scroll {
  flex: 1;
  min-height: 0;
}

.sd-albums-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 18px 16px;
  padding: 6px 2px 28px;
}

.sd-album-card {
  cursor: pointer;
  min-width: 0;
}

.sd-album-cover {
  position: relative;
  width: 100%;
  padding-bottom: 100%;
  border-radius: 12px;
  overflow: hidden;
  background-color: rgba(128, 128, 128, 0.12);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  transition:
    transform 0.28s cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow 0.28s ease;
}

.sd-album-cover img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sd-album-card:hover .sd-album-cover {
  transform: translateY(-3px);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.2);
}

.sd-album-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.35);
  color: #fff;
  font-size: 26px;
  opacity: 0;
  transition: opacity 0.24s ease;
}

.sd-album-play i {
  font-style: normal;
}

.sd-album-card:hover .sd-album-play {
  opacity: 1;
}

.sd-album-name {
  margin-top: 9px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--n-text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sd-album-sub {
  margin-top: 2px;
  font-size: 11.5px;
  color: #8a8a8a;
}

.sd-empty {
  padding: 60px 0;
}

/* ===== 专辑曲目弹窗 ===== */
.sd-album-modal-count {
  font-size: 12.5px;
  color: #8a8a8a;
}

.sd-album-tracks {
  max-height: 56vh;
  overflow-y: auto;
  margin: -6px -4px;
}

.sd-album-track {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.18s ease;
}

.sd-album-track:hover {
  background-color: rgba(128, 128, 128, 0.14);
}

.sd-album-track-index {
  width: 22px;
  text-align: right;
  font-size: 12.5px;
  color: #8a8a8a;
  font-variant-numeric: tabular-nums;
}

.sd-album-track-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: var(--n-text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sd-album-track-duration {
  font-size: 12.5px;
  color: #8a8a8a;
  font-variant-numeric: tabular-nums;
}

/* ===== 加载 / 空态 ===== */
.sd-status {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding-top: 64px;
  box-sizing: border-box;
}

.sd-status-text {
  margin: 0;
  font-size: 13px;
  color: #8a8a8a;
}

.sd-status-actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}

/*
 * 浅色主题：图片区保持更长时间的暗底，保证白色文字可读；
 * 仅在最后一段渐隐到浅色页面底色（否则顶部会糊成一片灰白）
 */
:root[data-theme='light'] .hero-media {
  background-image:
    linear-gradient(
      180deg,
      rgba(0, 0, 0, 0.54) 0%,
      rgba(0, 0, 0, 0.22) 28%,
      rgba(0, 0, 0, 0.55) 60%,
      rgba(0, 0, 0, 0.86) 100%
    ),
    var(--hero-image);
  -webkit-mask-image: linear-gradient(
    to bottom,
    #000 0%,
    #000 64%,
    rgba(0, 0, 0, 0.62) 84%,
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    #000 0%,
    #000 64%,
    rgba(0, 0, 0, 0.62) 84%,
    transparent 100%
  );
}

/* ===== 深色适配 ===== */
:root[data-theme='dark'] .sd-tab {
  color: #9b9b9b;
}

:root[data-theme='dark'] .sd-tab:hover {
  color: #fff;
  background-color: rgba(255, 255, 255, 0.1);
}

:root[data-theme='dark'] .sd-tab.active {
  color: #fff;
  background-color: rgba(255, 255, 255, 0.16);
}

:root[data-theme='dark'] .sd-album-cover {
  background-color: rgba(255, 255, 255, 0.06);
}

/* ===== 窄窗口 ===== */
@media (max-width: 860px) {
  .hero {
    height: clamp(260px, 40vh, 380px);
  }

  .hero-inner {
    padding: 0 16px 22px;
  }

  .hero-name {
    font-size: clamp(30px, 6vw, 42px);
  }

  .hero-name--script {
    font-size: clamp(38px, 8vw, 56px);
  }

  .sd-body {
    padding: 4px 12px 0;
  }

  .sd-albums-grid {
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: 14px 12px;
  }
}
</style>
