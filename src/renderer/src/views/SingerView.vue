<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NIcon, NScrollbar, NInput, NTag } from 'naive-ui'
import defaultCover from '@renderer/assets/icon.png'
import { usePlayerStore } from '../stores/playerStore'
import { useLocalMusicStore } from '../stores/localMusicStore'

const playerStore = usePlayerStore()
const localMusicStore = useLocalMusicStore()

onMounted(() => {
  playerStore.loadHistory()
})

const searchQuery = ref('')

interface ArtistInfo {
  name: string
  cover: string
  playCount: number
  songCount: number
  songs: { id: string | number; title: string; artist: string; cover: string; album?: string; filePath?: string; durationMs?: number }[]
}

const artists = computed<ArtistInfo[]>(() => {
  const artistMap = new Map<string, ArtistInfo>()

  // 从播放历史聚合
  playerStore.playHistory.forEach((record) => {
    const artistName = record.artist || '未知歌手'
    if (!artistMap.has(artistName)) {
      artistMap.set(artistName, {
        name: artistName,
        cover: '',
        playCount: 0,
        songCount: 0,
        songs: []
      })
    }
    const info = artistMap.get(artistName)!
    info.playCount++
    if (!info.cover && record.cover) {
      info.cover = record.cover
    }
    // 去重添加歌曲
    if (!info.songs.find(s => s.id === record.songId)) {
      info.songs.push({
        id: record.songId,
        title: record.title,
        artist: record.artist,
        cover: record.cover,
        album: record.album,
        filePath: record.filePath
      })
    }
  })

  // 从本地音乐补充
  localMusicStore.songs.forEach((song) => {
    const artistName = song.ar?.[0]?.name || '未知歌手'
    if (!artistMap.has(artistName)) {
      artistMap.set(artistName, {
        name: artistName,
        cover: '',
        playCount: 0,
        songCount: 0,
        songs: []
      })
    }
    const info = artistMap.get(artistName)!
    if (!info.cover && song.picUrl) {
      info.cover = song.picUrl
    }
    if (!info.cover && song.al?.picUrl) {
      info.cover = song.al.picUrl
    }
    if (!info.songs.find(s => s.id === song.id)) {
      info.songs.push({
        id: song.id,
        title: song.name,
        artist: artistName,
        cover: song.picUrl || song.al?.picUrl || '',
        album: song.al?.name,
        filePath: song.filePath,
        durationMs: song.dt
      })
    }
  })

  info.songCount = info.songs.length
  return Array.from(artistMap.values())
})

const filteredArtists = computed(() => {
  if (!searchQuery.value.trim()) return artists.value
  const q = searchQuery.value.trim().toLowerCase()
  return artists.value.filter(a => a.name.toLowerCase().includes(q))
})

const playArtistSongs = (artist: ArtistInfo) => {
  if (artist.songs.length === 0) return
  const playlist = artist.songs.map(s => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    cover: s.cover || defaultCover,
    durationMs: s.durationMs || 0,
    album: s.album,
    filePath: s.filePath
  }))
  playerStore.setPlaylist(playlist)
  playerStore.playSongAtIndex(0)
}
</script>

<template>
  <div style="height: 100%">
    <n-scrollbar style="height: 100%" content-style="padding: 16px 24px;">
      <div class="singer-view">
        <!-- Header -->
        <div class="header-section">
          <div class="header-content">
            <div class="header-left">
              <h1 class="page-title">歌手</h1>
              <p class="page-subtitle">{{ artists.length }} 位歌手</p>
            </div>
            <div class="header-right">
              <n-input
                v-model:value="searchQuery"
                placeholder="搜索歌手..."
                clearable
                round
                :style="{ width: '220px' }"
              >
                <template #prefix>
                  <n-icon><i class="mgc_search_line"></i></n-icon>
                </template>
              </n-input>
            </div>
          </div>
        </div>

        <!-- Artist Grid -->
        <div class="artists-grid" v-if="filteredArtists.length > 0">
          <div
            v-for="artist in filteredArtists"
            :key="artist.name"
            class="artist-card"
            @click="playArtistSongs(artist)"
          >
            <div class="artist-img-wrapper">
              <img
                :src="artist.cover || defaultCover"
                class="artist-img"
                loading="lazy"
                decoding="async"
              />
              <div class="artist-play-overlay">
                <n-icon size="28" color="white"><i class="mgc_play_fill"></i></n-icon>
              </div>
            </div>
            <div class="artist-name" :title="artist.name">{{ artist.name }}</div>
            <div class="artist-stats">
              <n-tag size="small" :bordered="false" type="info">
                {{ artist.songCount }} 首
              </n-tag>
              <span class="stat-sep">·</span>
              <span class="stat-plays">{{ artist.playCount }} 次播放</span>
            </div>
          </div>
        </div>

        <!-- Empty State -->
        <div class="empty-state" v-else>
          <n-icon size="64" color="var(--n-text-color-3)"><i class="mgc_user_3_line"></i></n-icon>
          <span v-if="searchQuery">未找到匹配的歌手</span>
          <span v-else>暂无歌手数据，请先播放一些歌曲</span>
        </div>
      </div>
    </n-scrollbar>
  </div>
</template>

<style scoped>
.singer-view {
  min-height: 100%;
}

/* Header */
.header-section {
  margin: 8px 0 24px 0;
}

.header-content {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
}

.page-title {
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 4px 0;
  color: var(--n-text-color);
}

.page-subtitle {
  font-size: 14px;
  color: var(--n-text-color-3);
  margin: 0;
}

/* Artist Grid */
.artists-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 20px;
}

.artist-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px 14px 16px;
  background: var(--n-color-card);
  border-radius: 16px;
  border: 1px solid var(--n-border-color);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.artist-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  border-color: var(--n-primary-color);
}

.artist-img-wrapper {
  position: relative;
  width: 110px;
  height: 110px;
  border-radius: 50%;
  overflow: hidden;
  margin-bottom: 14px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.1);
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.artist-card:hover .artist-img-wrapper {
  transform: scale(1.06);
}

.artist-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.artist-play-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.25s;
  border-radius: 50%;
}

.artist-card:hover .artist-play-overlay {
  opacity: 1;
}

.artist-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--n-text-color);
  text-align: center;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 8px;
}

.artist-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.stat-sep {
  color: var(--n-text-color-3);
}

.stat-plays {
  color: var(--n-text-color-3);
}

/* Empty */
.empty-state {
  padding: 80px 24px;
  background: var(--n-color-card);
  border-radius: 14px;
  border: 1px dashed var(--n-border-color);
  text-align: center;
  color: var(--n-text-color-3);
  font-size: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

/* Responsive */
@media (max-width: 768px) {
  .header-content {
    flex-direction: column;
    align-items: flex-start;
  }

  .artists-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 14px;
  }

  .artist-img-wrapper {
    width: 90px;
    height: 90px;
  }
}
</style>
