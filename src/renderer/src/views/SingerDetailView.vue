<template>
  <div v-if="artist" class="singer-detail">
    <!-- Header -->
    <div class="detail-header">
      <div class="header-content">
        <div class="artist-cover">
          <img :src="artist.cover || defaultCover" loading="lazy" decoding="async" />
        </div>
        <div class="artist-info">
          <h1 class="artist-name">{{ artist.name }}</h1>
          <div class="artist-meta">
            <span>{{ artist.songCount }} 首歌曲</span>
            <span class="meta-sep">·</span>
            <span>{{ albumCount }} 张专辑</span>
            <span class="meta-sep">·</span>
            <span>{{ artist.playCount }} 次播放</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs-section">
      <n-tabs v-model:value="activeTab" type="segment" animated>
        <n-tab-pane name="songs" tab="歌曲">
          <SongList
            :songs="songsForList"
            :loading="false"
            :current-playing-song-id="playerStore.currentSong?.id ?? null"
            :transparent-header="true"
            item-variant="plain"
            @song-click="handleSongClick"
          />
        </n-tab-pane>
        <n-tab-pane name="albums" tab="专辑">
          <div class="albums-grid" v-if="albums.length > 0">
            <div
              v-for="album in albums"
              :key="album.name"
              class="album-card"
              @click="openAlbumDetail(album)"
            >
              <div class="album-cover-wrapper">
                <img
                  :src="album.cover || defaultCover"
                  class="album-cover"
                  loading="lazy"
                  decoding="async"
                />
                <div class="album-play-overlay">
                  <n-icon size="28" color="white"><i class="mgc_play_fill"></i></n-icon>
                </div>
              </div>
              <div class="album-info">
                <div class="album-name" :title="album.name">{{ album.name }}</div>
                <div class="album-song-count">{{ album.songs.length }} 首</div>
              </div>
            </div>
          </div>
          <n-empty v-else description="暂无专辑" style="margin-top: 40px" />
        </n-tab-pane>
      </n-tabs>
    </div>
  </div>

  <div v-else class="not-found">
    <n-empty description="未找到该歌手" />
    <n-button style="margin-top: 16px" @click="router.back()">返回</n-button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NEmpty, NIcon, NTabs, NTabPane } from 'naive-ui'
import { usePlayerStore } from '../stores/playerStore'
import { useLocalMusicStore } from '../stores/localMusicStore'
import { albumCache } from '../stores/albumCache'
import SongList from '../components/common/SongList.vue'
import defaultCover from '@renderer/assets/default-cover.png'

const route = useRoute()
const router = useRouter()
const playerStore = usePlayerStore()
const localMusicStore = useLocalMusicStore()

const activeTab = ref('songs')

onMounted(() => {
  playerStore.loadHistory()
})

const artistName = computed(() => route.params.name as string)

interface ArtistInfo {
  name: string
  cover: string
  playCount: number
  songCount: number
  songs: {
    id: string | number
    title: string
    artist: string
    cover: string
    album?: string
    filePath?: string
    durationMs?: number
  }[]
}

const artist = computed<ArtistInfo | null>(() => {
  const name = artistName.value
  if (!name) return null

  const result: ArtistInfo = {
    name,
    cover: '',
    playCount: 0,
    songCount: 0,
    songs: []
  }

  // 已收录歌曲 ID 集合：将 Array.find 去重（O(n²)）降为 Set 查询（O(1)），
  // 避免大曲库 + 播放历史下每次播放触发全库重算时退化
  const seenSongIds = new Set<string>()

  // 先处理本地音乐（元数据更完整：封面、时长等）
  localMusicStore.songs.forEach((song) => {
    const songArtist = song.ar?.[0]?.name || '未知歌手'
    if (songArtist !== name) return
    if (seenSongIds.has(String(song.id))) return
    seenSongIds.add(String(song.id))

    if (!result.cover && song.picUrl) {
      result.cover = song.picUrl
    }
    if (!result.cover && song.al?.picUrl) {
      result.cover = song.al.picUrl
    }
    result.songs.push({
      id: song.id,
      title: song.name,
      artist: name,
      cover: song.picUrl || song.al?.picUrl || '',
      album: song.al?.name,
      filePath: song.filePath,
      durationMs: song.dt
    })
  })

  // 再用播放历史补充（主要是 playCount，以及本地没有的歌曲）
  playerStore.playHistory.forEach((record) => {
    const recordArtist = record.artist || '未知歌手'
    if (recordArtist !== name) return

    result.playCount++
    if (!result.cover && record.cover) {
      result.cover = record.cover
    }
    if (!seenSongIds.has(String(record.songId))) {
      seenSongIds.add(String(record.songId))
      result.songs.push({
        id: record.songId,
        title: record.title,
        artist: record.artist,
        cover: record.cover,
        album: record.album,
        filePath: record.filePath
      })
    }
  })

  result.songCount = result.songs.length
  // 使用第一首歌的封面作为歌手头像
  if (result.songs.length > 0) {
    result.cover = result.songs[0].cover || result.cover
  }
  return result.songCount > 0 ? result : null
})

const songsForList = computed(() => {
  if (!artist.value) return []
  return artist.value.songs.map(s => ({
    id: s.id,
    name: s.title,
    ar: [{ name: s.artist }],
    al: s.album ? { name: s.album } : undefined,
    dt: s.durationMs,
    picUrl: s.cover || defaultCover,
    filePath: s.filePath
  }))
})

// 该歌手的专辑列表
const albums = computed(() => {
  const name = artistName.value
  if (!name) return []
  return localMusicStore.albumList.filter(a => a.artist === name)
})

const albumCount = computed(() => albums.value.length)

// 同步专辑到缓存，供 AlbumDetailView 使用
watch(albums, (list) => {
  for (const a of list) {
    albumCache.set(a.name, a)
  }
}, { immediate: true })

const openAlbumDetail = (album: { name: string }) => {
  router.push('/album/' + encodeURIComponent(album.name))
}

const handleSongClick = (song: any) => {
  if (!artist.value) return

  const playlist = artist.value.songs.map(s => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    cover: s.cover || '',
    durationMs: s.durationMs || 0,
    album: s.album,
    filePath: s.filePath
  }))

  const clickedIndex = playlist.findIndex(s => s.id === song.id)
  playerStore.setPlaylist(playlist)
  playerStore.playSongAtIndex(clickedIndex >= 0 ? clickedIndex : 0)
}
</script>

<style scoped>
.singer-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding-top: 64px;
}

/* Header */
.detail-header {
  position: relative;
  padding: 24px 32px 32px;
}

.header-content {
  position: relative;
  display: flex;
  align-items: center;
  gap: 20px;
  z-index: 1;
}

.artist-cover {
  width: 140px;
  height: 140px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.artist-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.artist-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 4px;
}

.artist-name {
  font-size: 28px;
  font-weight: 700;
  color: var(--n-text-color);
  margin: 0;
}

.artist-meta {
  font-size: 14px;
  color: #999;
  display: flex;
  align-items: center;
  gap: 6px;
}

.meta-sep {
  color: #999;
}

/* Tabs */
.tabs-section {
  flex: 1;
  overflow: hidden;
  padding: 0 40px;
}

.albums-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 16px;
}

.album-card {
  display: flex;
  flex-direction: column;
  background: var(--n-color-card);
  border-radius: 12px;
  border: 1px solid var(--n-border-color);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.album-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
  border-color: var(--n-primary-color);
}

.album-cover-wrapper {
  position: relative;
  width: 100%;
  padding-bottom: 100%;
  overflow: hidden;
}

.album-cover {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.album-play-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.25s;
}

.album-card:hover .album-play-overlay {
  opacity: 1;
}

.album-info {
  padding: 10px 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.album-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--n-text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.album-song-count {
  font-size: 11px;
  color: #999;
}

/* Not Found */
.not-found {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

/* Responsive */
@media (max-width: 768px) {
  .detail-header {
    padding: 16px 16px 24px;
  }

  .header-content {
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .artist-cover {
    width: 120px;
    height: 120px;
  }

  .artist-name {
    font-size: 22px;
  }

  .tabs-section {
    padding: 0 16px;
  }

  .albums-grid {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 12px;
  }
}
</style>
