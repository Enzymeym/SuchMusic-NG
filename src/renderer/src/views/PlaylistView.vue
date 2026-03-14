<template>
  <div class="local-music-view">
    <div class="header">
      <div class="title">
        歌单
        <span class="subtitle">
          <i class="mgc_music_2_fill"></i> {{ playlists.length }} 个</span
        >
      </div>
      <div class="actions">
        <div style="display: flex; gap: 10px">
          <n-button
            secondary
            style="padding: 0 16px; font-size: 15px;"
            size="large"
            round
            type="primary"
            @click="createEmptyPlaylist"
          >
            <template #icon>
              <n-icon size="16">
                <i class="mgc_add_circle_line"></i>
              </n-icon>
            </template>
            新建歌单
          </n-button>
          <n-button secondary strong circle size="large" @click="refreshPlaylist">
            <template #icon>
              <n-icon size="20">
                <i class="mgc_refresh_2_line"></i>
              </n-icon>
            </template>
          </n-button>
        </div>
        <n-input
          v-model:value="searchKeyword"
          placeholder="模糊搜索"
          clearable
          size="large"
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

    <div class="content">
      <n-scrollbar class="playlist-scroll" content-style="padding: 0 4px 16px;">
        <div class="playlist-grid">
          <div
            v-for="pl in filteredPlaylists"
            :key="pl.id"
            class="playlist-card"
            :class="{ active: pl.id === selectedId }"
            @click="handleSelect(pl.id)"
            @dblclick="() => handlePlayPlaylist(pl.id)"
          >
            <div class="cover-wrapper">
              <img :src="pl.cover || pl.tracks[0]?.cover || defaultCover" class="playlist-cover" />
              <div class="play-count">
                <n-icon size="14"><i class="mgc_music_2_line"></i></n-icon>
                <span>{{ pl.tracks.length }} 首</span>
              </div>
            </div>
            <div class="playlist-title">{{ pl.name }}</div>
          </div>
        </div>
      </n-scrollbar>
    </div>

    <n-modal
      v-model:show="showCreateModal"
      preset="dialog"
      title="新建歌单"
      style="width: 400px"
    >
      <div style="margin-bottom: 12px;">歌单名称</div>
      <n-input v-model:value="newPlaylistName" placeholder="输入歌单名称" />
      <template #action>
        <n-button @click="showCreateModal = false">取消</n-button>
        <n-button type="primary" @click="handleConfirmCreate">确定</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NInput, NScrollbar, NModal, useMessage } from 'naive-ui'
import { usePlayerStore } from '../stores/playerStore'
import { usePlaylistStore, type UserPlaylist } from '../stores/playlistStore'
import defaultCover from '@renderer/assets/icon.png'

const router = useRouter()
const player = usePlayerStore()
const playlistStore = usePlaylistStore()
const message = useMessage()

const searchKeyword = ref('')
const loading = ref(false)
const selectedId = ref<string | null>(null)
const showCreateModal = ref(false)
const createMode = ref<'empty' | 'queue'>('empty')
const newPlaylistName = ref('')

const playlists = computed(() => playlistStore.playlists)

const filteredPlaylists = computed<UserPlaylist[]>(() => {
  if (!searchKeyword.value) return playlists.value
  const keyword = searchKeyword.value.toLowerCase().trim()
  return playlists.value.filter((pl) => {
    const name = pl.name?.toLowerCase() || ''
    return name.includes(keyword)
  })
})

onMounted(() => {
  loading.value = true
  try {
    playlistStore.loadFromStorage()
  } finally {
    loading.value = false
  }
})

const handleSelect = (id: string) => {
  selectedId.value = id
  router.push(`/playlist/${id}`)
}

const handlePlayPlaylist = (id: string) => {
  const pl = playlists.value.find((p) => p.id === id)
  if (!pl || !pl.tracks.length) {
    message.info('该歌单中没有歌曲')
    return
  }
  const list = pl.tracks.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    cover: t.cover || defaultCover,
    filePath: t.filePath,
    durationMs: t.durationMs || 0,
    source: t.source,
    sourceSongId: t.sourceSongId,
    lyrics: ''
  }))
  player.setPlaylist(list)
  if (list.length > 0) {
    player.setCurrentSong(list[0])
    player.setPlaying(true)
  }
}

const refreshPlaylist = (): void => {
  playlistStore.loadFromStorage()
  message.success('歌单已从本地存储重新加载')
}

const createEmptyPlaylist = (): void => {
  const base = '新建歌单'
  createMode.value = 'empty'
  newPlaylistName.value = `${base} (${new Date().toLocaleString()})`
  showCreateModal.value = true
}

const handleConfirmCreate = (): void => {
  const name = newPlaylistName.value.trim()
  if (!name) {
    message.error('歌单名称不能为空')
    return
  }

  if (createMode.value === 'empty') {
    const playlist = playlistStore.createPlaylistFromTracks(name, [], undefined)
    selectedId.value = playlist.id
    message.success('已创建空歌单')
  } else {
    if (!player.playlist.length) {
      message.info('当前播放队列为空')
      return
    }
    const tracks = player.playlist.map((s) => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      cover: s.cover || defaultCover,
      filePath: s.filePath,
      durationMs: s.durationMs,
      source: s.source,
      sourceSongId: s.sourceSongId
    }))
    const cover = tracks[0]?.cover
    const playlist = playlistStore.createPlaylistFromTracks(name, tracks, cover)
    selectedId.value = playlist.id
    message.success('已从当前播放队列创建歌单')
  }

  showCreateModal.value = false
}
</script>

<style scoped>
.local-music-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 24px 0px;
  box-sizing: border-box;
}

.header {
  display: flex;
  background-color: #F6F6F6;
  justify-content: space-between;
  align-items: start;
  gap: 4px;
  flex-direction: column;
  margin-bottom: 14px;
  padding: 8px 1px 4px;
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
  width: 100%;
  justify-content: space-between;
  align-items: center;
}

.content {
  flex: 1;
  overflow: hidden;
  border-radius: 8px;
}

.playlist-scroll {
  height: 100%;
}

.playlist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 18px;
  padding: 4px 4px 12px;
}

.playlist-card {
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease, background-color 0.2s ease;
  border-radius: 12px;
  padding: 6px 6px 10px;
}

.playlist-card.active {
  background-color: rgba(0, 0, 0, 0.04);
}

.cover-wrapper {
  position: relative;
  width: 100%;
  padding-bottom: 100%;
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 8px;
}

.playlist-cover {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s;
}

.playlist-card:hover .playlist-cover {
  transform: scale(1.05);
}

.play-count {
  position: absolute;
  top: 8px;
  right: 8px;
  background-color: rgba(0, 0, 0, 0.5);
  color: white;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.playlist-title {
  font-size: 14px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
</style>
