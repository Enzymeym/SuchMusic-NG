<template>
  <div class="local-music-view">
    <div class="header">
      <div class="title">
        最近播放
        <span class="subtitle">
          <i class="mgc_music_2_fill"></i> {{ songs.length }} 首</span>
      </div>
      <div class="actions">
        <div style="display: flex; gap: 10px">
          <n-button
            type="primary"
            style="padding: 0 16px; font-size: 15px;"
            size="large"
            secondary
            round
            @click="playAll"
          >
            <template #icon>
              <n-icon size="14">
                <i class="mgc_play_fill"></i>
              </n-icon>
            </template>
            播放
          </n-button>
          <n-button secondary strong circle size="large" @click="refreshHistory">
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
      <SongList
        :songs="filteredSongs"
        :loading="false"
        :current-playing-song-id="player.currentSong?.id ?? null"
        @song-click="handleSongClick"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { NButton, NIcon, useMessage, NInput } from 'naive-ui'
import SongList from '../components/common/SongList.vue'
import { usePlayerStore } from '../stores/playerStore'

interface RecentSong {
  id: string | number
  name: string
  al?: { name: string; picUrl?: string }
  ar?: { name: string }[]
  dt?: number
  picUrl?: string
  filePath?: string
  source?: string
  sourceSongId?: string | number
  lyrics?: string
  translatedLyrics?: string
}

const player = usePlayerStore()
const songs = ref<RecentSong[]>([])
const searchKeyword = ref('')
const message = useMessage()

const buildSongsFromHistory = () => {
  // 使用 Map 按 songId 去重，保留最新一次播放记录
  const seen = new Set<string | number>()
  const uniqueSongs: RecentSong[] = []

  for (const r of player.playHistory) {
    if (seen.has(r.songId)) continue
    seen.add(r.songId)

    uniqueSongs.push({
      id: r.songId,
      name: r.title,
      al: r.album ? { name: r.album } : undefined,
      ar: r.artist
        ? r.artist.split(/[/,]/).map((n) => ({ name: n.trim() })).filter((a) => a.name)
        : [{ name: '未知歌手' }],
      dt: r.durationMs || 0,
      // 优先使用历史记录中的封面；如果为空则留空，后续尝试从本地文件补充
      picUrl: r.cover || undefined,
      filePath: r.filePath,
      // 补充来源信息：
      // 1. 如果 PlayRecord 中有 source，直接使用
      // 2. 如果没有，但有 filePath，则视为 local
      // 3. 否则默认标记为 local
      source: (r as any).source || (r.filePath ? 'local' : 'local'),
      sourceSongId: r.songId,
      lyrics: r.lyrics,
      translatedLyrics: r.translatedLyrics
    })
  }

  songs.value = uniqueSongs
}

// 尝试为缺失封面的最近播放记录补充本地封面
const fillMissingCoversFromMeta = async () => {
  const hasIpc = (window as any).electron?.ipcRenderer
  if (!hasIpc) return

  const targets = songs.value.filter((song) => !song.picUrl && song.filePath)
  if (!targets.length) return

  // 限制并发数量，避免一次性发起上百个 IPC 请求造成主进程/磁盘 I/O 拥塞
  const CONCURRENCY = 5
  let cursor = 0
  const worker = async () => {
    while (cursor < targets.length) {
      const song = targets[cursor++]
      try {
        const result = (await window.electron.ipcRenderer.invoke(
          'local-music:get-meta',
          song.filePath
        )) as {
          cover?: { mimeType: string; base64: string }
        }

        if (result.cover?.mimeType && result.cover.base64) {
          // 通过本地 meta 生成封面 data URL
          song.picUrl = `data:${result.cover.mimeType};base64,${result.cover.base64}`
        }
      } catch (error) {
        console.error('加载最近播放封面失败:', error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker))
}

const filteredSongs = computed(() => {
  if (!searchKeyword.value) return songs.value
  const keyword = searchKeyword.value.toLowerCase().trim()
  return songs.value.filter((song) => {
    const name = song.name?.toLowerCase() || ''
    const artist =
      (song.ar && song.ar.map((a) => a.name).join(' / ').toLowerCase()) || '未知歌手'
    const album = (song.al?.name || '').toLowerCase()
    return name.includes(keyword) || artist.includes(keyword) || album.includes(keyword)
  })
})

onMounted(() => {
  // 确保历史已加载
  player.loadHistory()
  buildSongsFromHistory()
  void fillMissingCoversFromMeta()
})

const handleSongClick = async (song: RecentSong) => {
  // 1. 本地歌曲播放逻辑
  if (typeof song.id === 'string' && (song.id.includes(':\\') || song.id.includes(':/'))) {
    
    // 检查文件是否存在
    let exists = false
    if ((window as any).electron?.ipcRenderer) {
      exists = await (window as any).electron.ipcRenderer.invoke('system:fs-exists', song.id)
    }

    // 构造本地歌曲对象
    const playerSong = {
      id: song.id,
      title: song.name,
      artist: (song.ar || []).map((a) => a.name).join(' / ') || '未知歌手',
      album: song.al?.name || '未知专辑',
      cover: song.picUrl || '',
      durationMs: song.dt || 0,
      filePath: exists ? (song.id as string) : undefined, // 如果文件不存在，清除 filePath
      lyrics: song.lyrics || '',
      translatedLyrics: song.translatedLyrics || ''
    }
    
    // 统一交由 PlayerBar 的 watch 监听 currentSong 变化来处理实际播放
    // isPlaying 状态由 doLoadAndPlaySong 在音频引擎成功启动后设置
    player.setCurrentSong(playerSong)
    
    if (!exists) {
      message.error(`本地文件不存在，无法播放 (${song.id})`)
    }
    return
  }

  // 2. 非本地歌曲（在线服务已移除）
  message.warning('在线服务已移除，无法播放在线歌曲')
}

const playAll = (): void => {
  if (!songs.value.length) {
    message.info('当前没有最近播放记录')
    return
  }
  message.info('当前版本暂不支持从“最近播放”批量播放，请在其他页面播放')
}

const refreshHistory = (): void => {
  player.loadHistory()
  buildSongsFromHistory()
  void fillMissingCoversFromMeta()
  message.success('最近播放已刷新')
}
</script>

<style scoped>
.local-music-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 64px 24px 0px;
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
</style>
