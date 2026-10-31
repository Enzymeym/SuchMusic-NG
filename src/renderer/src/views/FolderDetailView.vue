<template>
  <div class="folder-detail">
    <div class="header-section">
      <div class="header-top">
        <n-button quaternary circle size="large" @click="goBack">
          <template #icon>
            <n-icon size="20"><i class="mgc_left_line"></i></n-icon>
          </template>
        </n-button>
        <div class="title-block">
          <div class="folder-title">
            <i class="mgc_folder_2_fill folder-icon"></i>
            {{ folder?.displayName || '文件夹' }}
          </div>
          <div class="folder-meta">
            <span>{{ songs.length }} 首</span>
            <span v-if="totalDurationText">· {{ totalDurationText }}</span>
            <span v-if="techSummary">· {{ techSummary }}</span>
          </div>
          <div class="folder-path" :title="folder?.path">{{ folder?.path }}</div>
        </div>
      </div>

      <div class="header-actions">
        <n-switch v-model:value="includeSubfolders" size="small">
          <template #checked>含子目录</template>
          <template #unchecked>只看本层</template>
        </n-switch>
        <n-button type="primary" round secondary @click="playAll">
          <template #icon>
            <n-icon size="16"><i class="mgc_play_fill"></i></n-icon>
          </template>
          播放全部
        </n-button>
        <n-button quaternary circle @click="revealFolder">
          <template #icon>
            <n-icon size="18"><i class="mgc_folder_open_line"></i></n-icon>
          </template>
        </n-button>
      </div>
    </div>

    <div class="content">
      <SongList
        :songs="songs"
        :loading="loading"
        :load-more="hasMore"
        loading-text="加载更多…"
        :current-playing-song-id="player.currentSong?.id ?? null"
        :extra-menu-options="contextMenuOptions"
        @song-click="handleSongClick"
        @context-menu-select="handleContextMenuSelect"
        @scroll="handleScroll"
      />

      <div v-if="!loading && songs.length === 0" class="empty-state">
        <p>这个文件夹里没有可播放的音频文件</p>
        <p class="hint">支持 mp3 / flac / wav / m4a / aac / ogg / opus / ape / wv / aiff</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import SongList from '../components/common/SongList.vue'
import { useLocalMusicStore, type LocalSong } from '../stores/localMusicStore'
import { usePlayerStore, type PlayerSong } from '../stores/playerStore'
import { formatTechSpec } from '../utils/quality'

// keep-alive 依赖组件 name，必须显式声明
defineOptions({ name: 'folder-detail' })

const route = useRoute()
const router = useRouter()
const message = useMessage()
const localMusicStore = useLocalMusicStore()
const player = usePlayerStore()

const PAGE_SIZE = 500

const folderId = computed(() => Number(route.params.id) || 0)
const folder = computed(() => localMusicStore.folders.find((f) => f.id === folderId.value) || null)

const songs = ref<LocalSong[]>([])
const loading = ref(false)
const includeSubfolders = ref(true)
/** 到底了就不再请求（否则「刚好整页」会一直请求空页） */
const reachedEnd = ref(false)

const totalDurationText = computed(() => {
  const totalMs = songs.value.reduce((sum, song) => sum + (song.dt || 0), 0)
  if (totalMs <= 0) return ''
  const minutes = Math.round(totalMs / 60000)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
})

/** 目录里出现的主要编码/位深，给用户一个「这个目录是什么规格」的直观印象 */
const techSummary = computed(() => {
  const sample = songs.value.find((song) => song.codec || song.bitrate)
  return sample ? formatTechSpec(sample) : ''
})

const hasMore = computed(() => !reachedEnd.value && songs.value.length > 0)

const contextMenuOptions = [
  { label: '在文件夹中显示', key: 'reveal', icon: renderIcon('mgc_folder_open_line') }
]

function renderIcon(icon: string) {
  return () => h('i', { class: icon })
}

async function loadSongs(reset = false): Promise<void> {
  if (!folderId.value) return
  if (loading.value) return
  loading.value = true
  if (reset) reachedEnd.value = false
  try {
    const offset = reset ? 0 : songs.value.length
    const page = await localMusicStore.getFolderTracks(folderId.value, {
      includeSubfolders: includeSubfolders.value,
      limit: PAGE_SIZE,
      offset
    })
    songs.value = reset ? page : [...songs.value, ...page]
    // 返回不足一页即视为到底，避免「正好整页」时反复请求空页
    if (page.length < PAGE_SIZE) reachedEnd.value = true
  } catch (error) {
    console.error('加载文件夹曲目失败', error)
    message.error('加载文件夹曲目失败')
  } finally {
    loading.value = false
  }
}

function toPlayerSong(song: LocalSong): PlayerSong {
  return {
    id: song.id,
    title: song.name,
    artist: (song.ar ?? []).map((a) => a.name).join(' / ') || '未知歌手',
    cover: song.picUrl || song.al?.picUrl || '',
    durationMs: song.dt || 0,
    album: song.al?.name,
    filePath: song.filePath,
    lyrics: localMusicStore.getLyrics(song) || undefined,
    source: 'local',
    sourceSongId: song.id
  } as PlayerSong
}

function playAll(): void {
  if (songs.value.length === 0) {
    message.info('该文件夹没有可播放的音乐')
    return
  }
  const list = songs.value.map(toPlayerSong)
  player.setPlaylist(list)
  player.setCurrentSong(list[0])
  message.info(`开始播放「${folder.value?.displayName || '文件夹'}」`)
}

function handleSongClick(song: LocalSong): void {
  const list = songs.value.map(toPlayerSong)
  const target = list.find((item) => item.id === song.id)
  if (!target) return
  player.setPlaylist(list)
  player.setCurrentSong(target)
  player.recordPlay(target)
}

function handleContextMenuSelect(key: string, song: LocalSong): void {
  if (key !== 'reveal') return
  if (song.filePath) void localMusicStore.revealInFolder(song.filePath)
}

function handleScroll(): void {
  // SongList 滚到底部时触发；没有更多就什么都不做，避免空请求
  if (!hasMore.value || loading.value) return
  void loadSongs(false)
}

function revealFolder(): void {
  if (!folder.value) return
  const first = songs.value.find((song) => song.filePath)
  if (first?.filePath) void localMusicStore.revealInFolder(first.filePath)
}

function goBack(): void {
  if (window.history.length > 1) router.back()
  else router.push({ name: 'playlist' })
}

watch(includeSubfolders, () => {
  songs.value = []
  void loadSongs(true)
})

watch(folderId, () => {
  songs.value = []
  void loadSongs(true)
})

onMounted(async () => {
  await localMusicStore.bootstrap()
  await loadSongs(true)
})
</script>

<style scoped>
.folder-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 64px 24px 0;
  box-sizing: border-box;
}

.header-section {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 8px 4px 18px;
  flex-wrap: wrap;
}

.header-top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.title-block {
  min-width: 0;
}

.folder-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 30px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--n-text-color, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-icon {
  font-size: 26px;
  opacity: 0.75;
}

.folder-meta {
  margin-top: 8px;
  font-size: 13px;
  color: var(--n-text-color-3, #888);
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.folder-path {
  margin-top: 6px;
  font-size: 12px;
  color: var(--n-text-color-3, #999);
  opacity: 0.8;
  max-width: 56vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.content {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--n-text-color-3, #888);
}

.empty-state .hint {
  font-size: 12px;
  opacity: 0.7;
}
</style>
