<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NIcon, NScrollbar, NInput } from 'naive-ui'
import defaultCover from '@renderer/assets/default-cover.png'
import { usePlayerStore } from '../stores/playerStore'
import { useLocalMusicStore } from '../stores/localMusicStore'

const router = useRouter()
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
  return localMusicStore.artistList
})

const filteredArtists = computed(() => {
  if (!searchQuery.value.trim()) return artists.value
  const q = searchQuery.value.trim().toLowerCase()
  return artists.value.filter(a => a.name.toLowerCase().includes(q))
})

const goToArtistDetail = (artist: ArtistInfo) => {
  router.push({ name: 'singer-detail', params: { name: artist.name } })
}
</script>

<template>
  <div style="height: 100%">
    <n-scrollbar style="height: 100%" content-style="padding: 16px 24px;">
      <div class="singer-view">
        <!-- Header -->
        <div class="header">
          <div class="title">
            歌手
            <span class="subtitle">
              <i class="mgc_user_3_line"></i> {{ artists.length }} 位</span>
          </div>
          <div class="actions">
            <n-input
              v-model:value="searchQuery"
              placeholder="模糊搜索"
              clearable
              round
              class="search-input"
              style="width: 200px"
            >
              <template #prefix>
                <n-icon size="18" color="#999">
                  <i class="mgc_search_2_line"></i>
                </n-icon>
              </template>
            </n-input>
          </div>
        </div>

        <!-- Artist Grid -->
        <div class="artists-grid" v-if="filteredArtists.length > 0">
          <div
            v-for="artist in filteredArtists"
            :key="artist.name"
            class="artist-card"
            @click="goToArtistDetail(artist)"
          >
            <div class="artist-avatar">
              <img
                :src="artist.cover || defaultCover"
                loading="lazy"
                decoding="async"
              />
            </div>
            <span class="artist-name" :title="artist.name">{{ artist.name }}</span>
            <span class="artist-meta">{{ artist.songCount }} 首 · {{ artist.playCount }} 次播放</span>
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
  padding-top: 56px;
}

/* Header */
.header {
  display: flex;
  background-color: #F6F6F6;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  margin-bottom: 14px;
  padding: 8px 14px 4px;
  z-index: 10;
  border-radius: 8px;
}

html[data-theme='dark'] .header {
  background-color: rgba(255, 255, 255, 0);
}

html[data-theme='dark'] .search-input {
  --n-color: rgba(255, 255, 255, 0.1) !important;
  --n-color-focus: rgba(255, 255, 255, 0.15) !important;
  --n-border: 1px solid rgba(255, 255, 255, 0.1) !important;
}

.title {
  font-size: 27px;
  font-weight: bold;
}

.subtitle {
  font-size: 14px;
  color: #999;
  margin-left: 8px;
}

.actions {
  display: flex;
  align-items: center;
}

/* Artist Grid */
.artists-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 20px 16px;
}

.artist-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  cursor: pointer;
  padding: 12px 8px;
  border-radius: 12px;
  transition: background 0.2s ease;
  min-width: 0;
}

.artist-card:hover {
  background: var(--n-color-hover);
}

.artist-avatar {
  width: 80%;
  aspect-ratio: 1 / 1;
  border-radius: 50%;
  overflow: hidden;
  margin-bottom: 10px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.artist-card:hover .artist-avatar {
  transform: scale(1.04);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.artist-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.artist-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--n-text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  line-height: 1.4;
}

.artist-meta {
  font-size: 12px;
  color: var(--n-text-color-3);
  margin-top: 2px;
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
@media (max-width: 1400px) {
  .artists-grid {
    grid-template-columns: repeat(5, 1fr);
  }
}

@media (max-width: 1100px) {
  .artists-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}

@media (max-width: 768px) {
  .artists-grid {
    grid-template-columns: repeat(3, 1fr);
    gap: 16px 10px;
  }

  .artist-card {
    padding: 8px 4px;
  }

  .artist-name {
    font-size: 13px;
  }

  .artist-meta {
    font-size: 11px;
  }
}

@media (max-width: 480px) {
  .artists-grid {
    grid-template-columns: repeat(3, 1fr);
    gap: 12px 8px;
  }
}
</style>
