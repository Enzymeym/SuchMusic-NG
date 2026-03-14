<template>
  <div class="local-music-view">
    <div class="header">
      <div class="title">
        本地音乐
        <span class="subtitle">
          <i class="mgc_music_2_fill"></i> {{ songs.length }} 首</span>
      </div>
      <div class="actions">
        <div style="display: flex; gap: 10px">
          <n-button type="primary" style="padding: 0 16px; font-size: 15px;" size="large" secondary round @click="playAll">
            <template #icon>
              <n-icon size="14">
                <i class="mgc_play_fill"></i>
              </n-icon>
            </template>
            播放
          </n-button>
          <n-button secondary strong circle size="large" @click="scanMusic">
            <template #icon>
              <n-icon size="20">
                <i class="mgc_refresh_2_line"></i>
              </n-icon>
            </template>
          </n-button>
          <n-button secondary circle size="large" @click="openScanDirSettings">
            <template #icon>
              <n-icon size="20">
                <i class="mgc_folders_line"></i>
              </n-icon>
            </template>
          </n-button>
          <n-button secondary circle size="large"  @click="openBatchModal">
            <template #icon>
              <n-icon size="20">
                <i class="mgc_list_check_2_line"></i>
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
        :loading="loading"
        :current-playing-song-id="player.currentSong?.id ?? null"
        :menu-options="contextMenuOptions"
        @song-click="handleSongClick"
        @preload="handlePreload"
        @context-menu-select="handleContextMenuSelect"
      />
      <TagEditDialog
        v-model:show="showTagEditor"
        :file-path="currentEditingSongPath"
        @saved="handleTagSaved"
      />
      <n-modal
        v-model:show="showBatchModal"
        preset="dialog"
        title="批量管理"
        style="width: 800px; max-width: 90vw;"
      >
        <div style="height: 500px; display: flex; flex-direction: column;">
          <n-data-table
            :columns="batchColumns"
            :data="songs"
            :pagination="{ pageSize: 10 }"
            :row-key="(row) => row.id"
            @update:checked-row-keys="handleCheck"
            style="flex: 1; overflow: hidden;"
            flex-height
          />
          <n-space justify="end" style="margin-top: 16px;">
            <n-button @click="showBatchModal = false">取消</n-button>
            <n-button 
              type="primary"
              ghost
              :disabled="checkedRowKeys.length === 0"
              @click="handleCreatePlaylistFromSelection"
            >
              保存为歌单 ({{ checkedRowKeys.length }})
            </n-button>
            <n-button 
              type="error" 
              :disabled="checkedRowKeys.length === 0"
              @click="handleBatchDelete"
            >
              删除选中 ({{ checkedRowKeys.length }})
            </n-button>
          </n-space>
        </div>
      </n-modal>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, h, computed } from 'vue'
import { NButton, NIcon, useMessage, NInput, NModal, NDataTable, NSpace, useDialog, type DataTableColumns } from 'naive-ui'
import SongList from '../components/common/SongList.vue'
import TagEditDialog from '../components/common/TagEditDialog.vue'
import { usePlayerStore } from '../stores/playerStore'
import defaultCover from '@renderer/assets/icon.png'
import { usePlaylistStore } from '../stores/playlistStore'
import { useLocalMusicStore, type LocalSong } from '../stores/localMusicStore'

// 本地音乐歌曲结构，尽量对齐 SongList 组件
// Use LocalSong from store instead of defining locally, but for compatibility with existing code we can alias it or just use it.
type Song = LocalSong

const localMusicStore = useLocalMusicStore()
const songs = computed(() => localMusicStore.songs)
const searchKeyword = ref('')
const loading = computed(() => localMusicStore.loading)
const message = useMessage()
const dialog = useDialog()
// const fillingMeta = ref(false) // Use store fillingMeta
const player = usePlayerStore()
const playlistStore = usePlaylistStore()

const showTagEditor = ref(false)
const currentEditingSongPath = ref<string>()

const showBatchModal = ref(false)
const checkedRowKeys = ref<Array<string | number>>([])

const batchColumns: DataTableColumns<Song> = [
  { type: 'selection' },
  { title: '歌曲标题', key: 'name' },
  { title: '歌手', key: 'ar', render: (row) => getSongArtist(row) },
  { title: '专辑', key: 'al', render: (row) => row.al?.name || '未知专辑' }
]

const handleCheck = (rowKeys: Array<string | number>) => {
  checkedRowKeys.value = rowKeys
}

const openBatchModal = () => {
  checkedRowKeys.value = []
  showBatchModal.value = true
}

const handleBatchDelete = () => {
  if (checkedRowKeys.value.length === 0) return

  dialog.warning({
    title: '确认删除',
    content: `确定要删除选中的 ${checkedRowKeys.value.length} 首歌曲吗？此操作将永久删除本地文件！`,
    positiveText: '确定删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const filePaths = localMusicStore.songs
          .filter(s => checkedRowKeys.value.includes(s.id))
          .map(s => s.filePath)
          .filter(fp => fp) as string[]

        if (filePaths.length === 0) return

        const result = await window.electron.ipcRenderer.invoke('local-music:delete', filePaths)
        
        if (result.success) {
          message.success(`成功删除 ${result.deletedCount} 首歌曲`)
          if (result.failedCount > 0) {
            message.warning(`${result.failedCount} 首歌曲删除失败`)
          }
          // 重新扫描或手动移除
          // Store scanMusic handles update, but here we might want to manually remove for speed
          // But simpler to just rescan or let store handle it.
          // Since we deleted files, rescanning is safer.
          void scanMusic()
          
          checkedRowKeys.value = []
          if (localMusicStore.songs.length === 0) {
            showBatchModal.value = false
          }
        }
      } catch (error) {
        console.error('删除失败', error)
        message.error('删除失败')
      }
    }
  })
}

const handleCreatePlaylistFromSelection = () => {
  if (checkedRowKeys.value.length === 0) {
    message.info('请先选择要加入歌单的歌曲')
    return
  }

  const selectedSongs = localMusicStore.songs.filter((s) => checkedRowKeys.value.includes(s.id))
  if (!selectedSongs.length) {
    message.info('未找到选中的歌曲')
    return
  }

  const defaultName = `本地歌单 (${new Date().toLocaleString()})`
  const name = window.prompt('输入歌单名称', defaultName)
  if (!name || !name.trim()) return

  const tracks = selectedSongs.map((s) => ({
    id: s.id,
    title: s.name,
    artist: getSongArtist(s),
    album: s.al?.name,
    cover: getSongCover(s),
    filePath: s.filePath,
    durationMs: s.dt,
    source: 'local',
    sourceSongId: s.id
  }))

  const cover = tracks[0]?.cover
  playlistStore.createPlaylistFromTracks(name.trim(), tracks, cover)
  message.success('已创建本地歌单')
}

const filteredSongs = computed(() => {
  if (!searchKeyword.value) return localMusicStore.songs
  const keyword = searchKeyword.value.toLowerCase().trim()
  return localMusicStore.songs.filter((song) => {
    const name = song.name?.toLowerCase() || ''
    const artist = getSongArtist(song).toLowerCase()
    const album = (song.al?.name || '').toLowerCase()
    return name.includes(keyword) || artist.includes(keyword) || album.includes(keyword)
  })
})

onMounted((): void => {
  // If store is empty, scan. Otherwise don't scan automatically to save time?
  // Or always scan to keep up to date?
  // Original code scanned on mount.
  if (localMusicStore.songs.length === 0) {
    scanMusic().catch((error) => {
      console.error('初次扫描本地音乐失败', error)
    })
  }
})

// 从歌曲对象提取歌手名
const getSongArtist = (song: Song): string => {
  if (song.ar && song.ar.length > 0) {
    return song.ar.map((a) => a.name).join(' / ')
  }
  return '未知歌手'
}

// 从歌曲对象提取封面
const getSongCover = (song: Song): string => {
  return song.picUrl || song.al?.picUrl || defaultCover
}

// 根据比特率和采样率映射为 LQ/HQ/SQ/Hi-Res 标签
// Removed local helper since store logic handles filling meta, but we might need it if we wanted to display it in table?
// Store fills `quality` field. SongList might use it.
// The SongList component handles display.
// The helper was used in fillMeta.

// 播放指定歌曲并同步播放器状态
const playSong = async (song: Song): Promise<void> => {
  if (!song.filePath) {
    message.error('找不到本地文件路径，无法播放')
    return
  }

  const songInfo = {
    id: song.id,
    title: song.name,
    artist: getSongArtist(song),
    cover: getSongCover(song),
    durationMs: song.dt || 0,
    album: song.al?.name,
    filePath: song.filePath,
    lyrics: song.lyrics,
    // 标记为本地来源，避免误用为在线平台资源
    source: 'local',
    sourceSongId: song.id
  }

  // 移除本地播放逻辑，统一交由 PlayerBar 的 watch 监听 currentSong 变化来处理播放
  // 这样可以避免重复触发播放
  // 只需要设置 playlist, currentSong 和 isPlaying 状态
  
  // 更新播放列表：如果当前播放列表为空或者不包含当前歌曲，或者用户希望重置列表（这里简化处理：如果是点击播放，我们确保歌曲在列表中）
  // 为了简单起见，如果从本地音乐列表播放，我们将当前显示的列表作为播放列表
  // 但这样可能会覆盖之前的播放列表。通常用户的期望是：点击播放，这首歌加入播放列表（或替换播放列表），并开始播放。
  // 我们采用：替换整个播放列表为当前筛选后的列表，并定位到该歌曲。
  const newPlaylist = filteredSongs.value.map(s => ({
    id: s.id,
    title: s.name,
    artist: getSongArtist(s),
    cover: getSongCover(s),
    durationMs: s.dt || 0,
    album: s.al?.name,
    filePath: s.filePath,
    lyrics: s.lyrics,
    source: 'local',
    sourceSongId: s.id
  }))
  player.setPlaylistForSource('local', newPlaylist, true)
  
  // 设置 currentSong 会触发 PlayerBar 的 watch 逻辑进行播放
  player.setCurrentSong(songInfo)
  player.setPlaying(true)
  player.recordPlay(songInfo)
  
  message.info(`正在播放: ${song.name}`)
}

const handleSongClick = (song: Song): void => {
  void playSong(song)
}

const handlePreload = (song: Song): void => {
  message.info(`预加载: ${song.name}`)
}

const renderIcon = (iconClass: string) => {
  return () => h(NIcon, null, { default: () => h('i', { class: iconClass }) })
}

const contextMenuOptions = [
  { label: '播放', key: 'play', icon: renderIcon('mgc_play_circle_line') },
  { label: '下一首播放', key: 'playNext', icon: renderIcon('mgc_playlist_add_line') },
  { type: 'divider', key: 'd1' },
  { label: '音乐标签编辑', key: 'editTags', icon: renderIcon('mgc_edit_2_line') },
  { type: 'divider', key: 'd2' },
  { label: '打开文件位置', key: 'openFileLocation', icon: renderIcon('mgc_folder_open_line') },
  { type: 'divider', key: 'd3' },
  { label: '查看专辑', key: 'viewAlbum', icon: renderIcon('mgc_album_2_line') }
]

const handleContextMenuSelect = async (key: string, song: Song) => {
  switch (key) {
    case 'play':
      await playSong(song)
      break
    case 'playNext':
      message.info('下一首播放功能待实现')
      break
    case 'editTags':
      if (song.filePath) {
        currentEditingSongPath.value = song.filePath
        showTagEditor.value = true
      } else {
        message.warning('无法编辑：文件路径不存在')
      }
      break
    case 'openFileLocation':
      if (song.filePath) {
        // window.electron.ipcRenderer.send('show-item-in-folder', song.filePath)
        message.info(`文件路径: ${song.filePath}`)
      }
      break
    case 'viewAlbum':
      message.info(`查看专辑: ${song.al?.name}`)
      break
    default:
      console.warn('Unknown context menu key:', key)
  }
}

const handleTagSaved = () => {
  // 重新扫描以更新列表信息
  void scanMusic()
}

const playAll = (): void => {
  if (!localMusicStore.songs.length) {
    message.info('当前没有可播放的本地音乐')
    return
  }
  void playSong(localMusicStore.songs[0])
}

const openScanDirSettings = (): void => {
  window.dispatchEvent(
    new CustomEvent('open-settings', {
      detail: {
        section: 'local',
        settingKey: 'local.scanDirs'
      }
    })
  )
}

const scanMusic = async (): Promise<void> => {
  try {
    await localMusicStore.scanMusic()
    message.success(`扫描完成，找到 ${localMusicStore.songs.length} 首本地音乐`)
  } catch (error) {
    console.error('扫描本地音乐失败', error)
    message.error('扫描本地音乐失败')
  }
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
  padding: 8px 1px 4px ;
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
  overflow: hidden; /* Ensure SongList scroll works */
  border-radius: 8px;
}
</style>
