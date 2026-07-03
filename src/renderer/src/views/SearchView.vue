<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useMessage } from 'naive-ui'
import SongList from '../components/common/SongList.vue'
import { usePlayerStore } from '../stores/playerStore'
import { useLocalMusicStore } from '../stores/localMusicStore'

const route = useRoute()
const playerStore = usePlayerStore()
const localMusicStore = useLocalMusicStore()
const message = useMessage()

const keywords = ref('')

// 从歌曲对象提取歌手名
const getSongArtist = (song: any): string => {
  if (song.ar && song.ar.length > 0) {
    return song.ar.map((a: any) => a.name).join(' / ')
  }
  return '未知歌手'
}

// 本地搜索结果：按关键词过滤本地音乐
const searchResults = computed(() => {
  if (!keywords.value.trim()) return []
  const keyword = keywords.value.toLowerCase().trim()
  return localMusicStore.songs.filter((song) => {
    const name = song.name?.toLowerCase() || ''
    const artist = getSongArtist(song).toLowerCase()
    const album = (song.al?.name || '').toLowerCase()
    return name.includes(keyword) || artist.includes(keyword) || album.includes(keyword)
  })
})

// 处理歌曲点击播放（仅本地文件）
const handleSongClick = async (song: any) => {
  if (!song.filePath) {
    message.error('找不到本地文件路径，无法播放')
    return
  }

  const songInfo = {
    id: song.id,
    title: song.name,
    artist: getSongArtist(song),
    cover: song.picUrl || song.al?.picUrl || '',
    durationMs: song.dt || 0,
    album: song.al?.name,
    filePath: song.filePath,
    lyrics: song.lyrics,
    source: 'local',
    sourceSongId: song.id
  }

  playerStore.setCurrentSong(songInfo)
  playerStore.setPlaying(true)
  playerStore.recordPlay(songInfo)
}

// Initialize
onMounted(() => {
  if (route.query.q) {
    keywords.value = String(route.query.q)
  }
})

watch(() => route.query, (newQuery) => {
  if (newQuery.q && newQuery.q !== keywords.value) {
    keywords.value = String(newQuery.q)
  }
})
</script>

<template>
  <div class="search-view">
    <div class="search-header">
      <div class="header-top">
        <div class="header-title-row">
          <h1>搜索"{{ keywords }}"</h1>
          <span v-if="keywords && searchResults.length" class="result-count">
            找到 {{ searchResults.length }} 首本地歌曲
          </span>
        </div>
      </div>
    </div>

    <div class="search-content">
      <SongList
        v-if="searchResults.length > 0"
        :songs="searchResults"
        :loading="false"
        @song-click="handleSongClick"
      />

      <div v-else-if="keywords" class="empty-state">
        <p>本地音乐中未找到匹配"{{ keywords }}"的歌曲</p>
        <p class="hint">请确保已添加本地音乐目录，或尝试其他关键词</p>
      </div>

      <div v-else class="empty-state">
        <p>请输入关键词搜索本地音乐</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 24px 0;
  box-sizing: border-box;
}

.search-header {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

.header-top {
  display: flex;
  align-items: center;
}

.header-title-row {
  display: flex;
  align-items: baseline;
  gap: 16px;
}

.header-title-row h1 {
  font-weight: 900;
  margin: 0;
  font-size: 24px;
}

.result-count {
  font-size: 14px;
  color: #888;
}

.search-content {
  flex: 1;
  overflow: auto;
  position: relative;
}

.empty-state {
  text-align: center;
  padding: 80px 40px;
  color: #888;
}

.empty-state p {
  margin: 8px 0;
  font-size: 16px;
}

.empty-state .hint {
  font-size: 13px;
  color: #aaa;
}
</style>
