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
            <span>{{ artist.playCount }} 次播放</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Song List -->
    <div class="song-list-section">
      <SongList
        :songs="songsForList"
        :loading="false"
        :current-playing-song-id="playerStore.currentSong?.id ?? null"
        :transparent-header="true"
        item-variant="plain"
        @song-click="handleSongClick"
      />
    </div>
  </div>

  <div v-else class="not-found">
    <n-empty description="未找到该歌手" />
    <n-button style="margin-top: 16px" @click="router.back()">返回</n-button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NEmpty } from 'naive-ui'
import { usePlayerStore } from '../stores/playerStore'
import { useLocalMusicStore } from '../stores/localMusicStore'
import SongList from '../components/common/SongList.vue'
import defaultCover from '@renderer/assets/default-cover.png'

const route = useRoute()
const router = useRouter()
const playerStore = usePlayerStore()
const localMusicStore = useLocalMusicStore()

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

  // 先处理本地音乐（元数据更完整：封面、时长等）
  localMusicStore.songs.forEach((song) => {
    const songArtist = song.ar?.[0]?.name || '未知歌手'
    if (songArtist !== name) return

    if (!result.cover && song.picUrl) {
      result.cover = song.picUrl
    }
    if (!result.cover && song.al?.picUrl) {
      result.cover = song.al.picUrl
    }
    if (!result.songs.find(s => s.id === song.id)) {
      result.songs.push({
        id: song.id,
        title: song.name,
        artist: name,
        cover: song.picUrl || song.al?.picUrl || '',
        album: song.al?.name,
        filePath: song.filePath,
        durationMs: song.dt
      })
    }
  })

  // 再用播放历史补充（主要是 playCount，以及本地没有的歌曲）
  playerStore.playHistory.forEach((record) => {
    const recordArtist = record.artist || '未知歌手'
    if (recordArtist !== name) return

    result.playCount++
    if (!result.cover && record.cover) {
      result.cover = record.cover
    }
    if (!result.songs.find(s => s.id === record.songId)) {
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

/* Song List */
.song-list-section {
  flex: 1;
  overflow: hidden;
  padding: 0 40px;
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

  .song-list-section {
    padding: 0 16px;
  }
}
</style>
