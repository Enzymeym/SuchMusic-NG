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

interface AlbumInfo {
  name: string
  artist: string
  cover: string
  playCount: number
  songCount: number
  songs: { id: string | number; title: string; artist: string; cover: string; album?: string; filePath?: string; durationMs?: number }[]
}

const albums = computed<AlbumInfo[]>(() => {
  const albumMap = new Map<string, AlbumInfo>()

  // 从播放历史聚合
  playerStore.playHistory.forEach((record) => {
    const albumName = record.album || '未知专辑'
    if (!albumMap.has(albumName)) {
      albumMap.set(albumName, {
        name: albumName,
        artist: record.artist || '未知歌手',
        cover: '',
        playCount: 0,
        songCount: 0,
        songs: []
      })
    }
    const info = albumMap.get(albumName)!
    info.playCount++
    if (!info.cover && record.cover) {
      info.cover = record.cover
    }
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
    const albumName = song.al?.name || '未知专辑'
    if (!albumMap.has(albumName)) {
      albumMap.set(albumName, {
        name: albumName,
        artist: song.ar?.[0]?.name || '未知歌手',
        cover: '',
        playCount: 0,
        songCount: 0,
        songs: []
      })
    }
    const info = albumMap.get(albumName)!
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
        artist: song.ar?.[0]?.name || '未知歌手',
        cover: song.picUrl || song.al?.picUrl || '',
        album: albumName,
        filePath: song.filePath,
        durationMs: song.dt
      })
    }
  })

  return Array.from(albumMap.values())
})

const filteredAlbums = computed(() => {
  if (!searchQuery.value.trim()) return albums.value
  const q = searchQuery.value.trim().toLowerCase()
  return albums.value.filter(a =>
    a.name.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q)
  )
})

const playAlbumSongs = (album: AlbumInfo) => {
  if (album.songs.length === 0) return
  const playlist = album.songs.map(s => ({
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
      <div class="album-view">
        <!-- Header -->
        <div class="header-section">
          <div class="header-content">
            <div class="header-left">
              <h1 class="page-title">专辑</h1>
              <p class="page-subtitle">{{ albums.length }} 张专辑</p>
            </div>
            <div class="header-right">
              <n-input
                v-model:value="searchQuery"
                placeholder="搜索专辑或歌手..."
                clearable
                round
                :style="{ width: '240px' }"
              >
                <template #prefix>
                  <n-icon><i class="mgc_search_line"></i></n-icon>
                </template>
              </n-input>
            </div>
          </div>
        </div>

        <!-- Album Grid -->
        <div class="albums-grid" v-if="filteredAlbums.length > 0">
          <div
            v-for="album in filteredAlbums"
            :key="album.name"
            class="album-card"
            @click="playAlbumSongs(album)"
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
              <div class="album-artist" :title="album.artist">{{ album.artist }}</div>
              <div class="album-stats">
                <n-tag size="small" :bordered="false" type="info">
                  {{ album.songCount }} 首
                </n-tag>
                <span class="stat-sep">·</span>
                <span class="stat-plays">{{ album.playCount }} 次播放</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Empty State -->
        <div class="empty-state" v-else>
          <n-icon size="64" color="var(--n-text-color-3)"><i class="mgc_album_line"></i></n-icon>
          <span v-if="searchQuery">未找到匹配的专辑</span>
          <span v-else>暂无专辑数据，请先播放一些歌曲</span>
        </div>
      </div>
    </n-scrollbar>
  </div>
</template>

<style scoped>
.album-view {
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

/* Album Grid */
.albums-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 20px;
}

.album-card {
  display: flex;
  flex-direction: column;
  background: var(--n-color-card);
  border-radius: 16px;
  border: 1px solid var(--n-border-color);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.album-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
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
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.album-card:hover .album-cover {
  transform: scale(1.06);
}

.album-play-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
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
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.album-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--n-text-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.album-artist {
  font-size: 12px;
  color: var(--n-text-color-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.album-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin-top: 4px;
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

  .albums-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 14px;
  }
}
</style>
