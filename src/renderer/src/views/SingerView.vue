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

        <!-- Artist List -->
        <div class="artists-list" v-if="filteredArtists.length > 0">
          <div
            v-for="(artist, index) in filteredArtists"
            :key="artist.name"
            class="artist-row"
            @click="goToArtistDetail(artist)"
          >
            <div class="artist-col-index">
              <span class="index-num">{{ index + 1 }}</span>
            </div>
            <div class="artist-col-main">
              <div class="artist-row-cover">
                <img
                  :src="artist.cover || defaultCover"
                  loading="lazy"
                  decoding="async"
                />
              </div>
              <div class="artist-row-info">
                <span class="artist-row-name" :title="artist.name">{{ artist.name }}</span>
              </div>
            </div>
            <div class="artist-col-songs">
              <span>{{ artist.songCount }} 首歌曲</span>
            </div>
            <div class="artist-col-plays">
              <span>{{ artist.playCount }} 次播放</span>
            </div>
            <div class="artist-col-arrow">
              <n-icon size="20"><i class="mgc_right_line"></i></n-icon>
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

/* Artist List */
.artists-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.artist-row {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  background: var(--n-color-card);
  border-radius: 12px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.2s ease;
  gap: 12px;
}

.artist-row:hover {
  background: var(--n-color-hover);
  border-color: var(--n-border-color);
}

.artist-col-index {
  width: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.index-num {
  font-size: 14px;
  color: var(--n-text-color-3);
  font-variant-numeric: tabular-nums;
}

.artist-col-main {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.artist-row-cover {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.artist-row-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.artist-row-info {
  min-width: 0;
  display: flex;
  align-items: center;
}

.artist-row-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--n-text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artist-col-songs {
  width: 120px;
  flex-shrink: 0;
  text-align: left;
  font-size: 13px;
  color: var(--n-text-color-3);
}

.artist-col-plays {
  width: 100px;
  flex-shrink: 0;
  text-align: left;
  font-size: 13px;
  color: var(--n-text-color-3);
}

.artist-col-arrow {
  width: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--n-text-color-3);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.artist-row:hover .artist-col-arrow {
  opacity: 1;
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
  .artist-row {
    padding: 8px 12px;
  }

  .artist-col-songs,
  .artist-col-plays {
    display: none;
  }

  .artist-col-arrow {
    opacity: 1;
  }
}
</style>
