<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NIcon, NScrollbar, NInput } from 'naive-ui'
import defaultCover from '@renderer/assets/default-cover.png'
import { usePlayerStore } from '../stores/playerStore'
import { useLocalMusicStore } from '../stores/localMusicStore'
import { albumCache, type AlbumInfo } from '../stores/albumCache'

const playerStore = usePlayerStore()
const localMusicStore = useLocalMusicStore()
const router = useRouter()

onMounted(() => {
  playerStore.loadHistory()
})

const searchQuery = ref('')

const albums = computed(() => {
  return localMusicStore.albumList
})

const filteredAlbums = computed(() => {
  if (!searchQuery.value.trim()) return albums.value
  const q = searchQuery.value.trim().toLowerCase()
  return albums.value.filter(a =>
    a.name.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q)
  )
})

const openAlbumDetail = (album: AlbumInfo) => {
  router.push('/album/' + encodeURIComponent(album.name))
}

// 同步到缓存，供 AlbumDetailView 使用
watch(albums, (list) => {
  albumCache.clear()
  for (const a of list) {
    albumCache.set(a.name, a)
  }
}, { immediate: true })
</script>

<template>
  <div style="height: 100%">
    <n-scrollbar style="height: 100%" content-style="padding: 16px 24px;">
      <div class="album-view">
        <!-- Header -->
        <div class="header">
          <div class="title">
            专辑
            <span class="subtitle">
              <i class="mgc_album_2_line"></i> {{ albums.length }} 张</span>
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

        <!-- Album Grid -->
        <div class="albums-grid" v-if="filteredAlbums.length > 0">
          <div
            v-for="album in filteredAlbums"
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
              <div class="album-artist" :title="album.artist">{{ album.artist }}</div>
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
.header {
  display: flex;
  background-color: #F6F6F6;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  margin-bottom: 14px;
  padding: 8px 0px 4px;
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
  background: var(--n-primary-color-suppl);
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
  border-radius: 16px;
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
  padding: 12px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
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
  color: #999;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  .albums-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 14px;
  }
}
</style>
