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
import { useSettingsStore } from '../stores/settingsStore'
import { usePlaylistStore } from '../stores/playlistStore'

// 本地音乐歌曲结构，尽量对齐 SongList 组件
interface Song {
  id: number | string
  name: string
  al?: { name: string; picUrl?: string }
  ar?: { name: string }[]
  filePath?: string
  dt?: number
  picUrl?: string
  lyrics?: string
  [key: string]: any
}

const songs = ref<Song[]>([])
const searchKeyword = ref('')
const loading = ref(false)
const message = useMessage()
const dialog = useDialog()
const fillingMeta = ref(false)
const player = usePlayerStore()
const settingsStore = useSettingsStore()
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
        const filePaths = songs.value
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
          // 为了即时反馈，我们手动从列表中移除
          songs.value = songs.value.filter(s => !checkedRowKeys.value.includes(s.id))
          checkedRowKeys.value = []
          if (songs.value.length === 0) {
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

  const selectedSongs = songs.value.filter((s) => checkedRowKeys.value.includes(s.id))
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
  if (!searchKeyword.value) return songs.value
  const keyword = searchKeyword.value.toLowerCase().trim()
  return songs.value.filter((song) => {
    const name = song.name?.toLowerCase() || ''
    const artist = getSongArtist(song).toLowerCase()
    const album = (song.al?.name || '').toLowerCase()
    return name.includes(keyword) || artist.includes(keyword) || album.includes(keyword)
  })
})

onMounted((): void => {
  scanMusic().catch((error) => {
    console.error('初次扫描本地音乐失败', error)
  })
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
const formatQualityFromMeta = (bitrate?: number, sampleRate?: number): string => {
  if (!bitrate && !sampleRate) return 'LQ'
  const kbps = bitrate ? bitrate / 1000 : 0
  const khz = sampleRate ? sampleRate / 1000 : 0

  // 采样率或码率足够高时判定为 Hi-Res
  if (khz >= 88.2 || kbps >= 2500) {
    return 'Hi-Res'
  }

  // 近似无损（如 CD FLAC）判定为 SQ
  if (kbps >= 800) {
    return 'SQ'
  }

  // 中高码率判定为 HQ
  if (kbps >= 192) {
    return 'HQ'
  }

  // 其余归为 LQ
  return 'LQ'
}

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
  if (!songs.value.length) {
    message.info('当前没有可播放的本地音乐')
    return
  }
  void playSong(songs.value[0])
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
  loading.value = true
  try {
    const rawDirs = settingsStore.local.scanDirs
    const plainDirs = Array.isArray(rawDirs) ? [...rawDirs] : []
    const result = (await window.electron.ipcRenderer.invoke(
      'local-music:scan',
      plainDirs.length ? plainDirs : undefined
    )) as {
      rootDir: string
      rootDirs?: string[]
      tracks: Array<{
        id: string
        name: string
        filePath: string
        ar: { name: string }[]
        al: { name: string }
        dt?: number
        quality?: string
      }>
    }

    const list = result.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      ar: t.ar,
      // al: t.al, // 暂时不使用扫描返回的专辑信息（通常是文件夹名），等待元数据填充
      filePath: t.filePath,
      dt: t.dt,
      quality: t.quality ?? 'Standard'
    }))

    songs.value = list
    void fillMeta()

    message.success(`扫描完成，找到 ${songs.value.length} 首本地音乐`)
  } catch (error) {
    console.error('扫描本地音乐失败', error)
    message.error('扫描本地音乐失败')
  } finally {
    loading.value = false
  }
}

const fillMeta = async (): Promise<void> => {
  if (fillingMeta.value) return
  fillingMeta.value = true
  try {
    const targets = songs.value.filter((song) => {
      if (!song.filePath) return false
      const missingBasic =
        !song.dt || !song.picUrl || !song.name || !song.ar || song.ar.length === 0
      const isPlaceholderArtist =
        song.ar && song.ar.length > 0 && song.ar[0].name === '本地音乐'
      return missingBasic || isPlaceholderArtist
    })
    console.log('fillMeta start', songs.value.length, 'targets', targets.length)
    if (!targets.length) return

    // 对所有目标歌曲并发请求 meta
    await Promise.all(
      targets.map(async (song, index) => {
        if (!song.filePath) return
        try {
          const result = (await window.electron.ipcRenderer.invoke(
            'local-music:get-meta',
            song.filePath
          )) as {
            durationMs?: number
            bitrate?: number
            sampleRate?: number
            cover?: { mimeType: string; base64: string }
            title?: string
            artists?: string[]
            album?: string
            lyrics?: string
          }

          console.log('meta result', index, song.filePath, result)

          if (result.lyrics) {
            song.lyrics = result.lyrics
            // 如果当前正在播放这首歌，且没有歌词，尝试更新 store 中的歌词
            if (player.currentSong?.id === song.id && !player.currentSong.lyrics) {
              player.currentSong.lyrics = result.lyrics
            }
          }

          if (typeof result.durationMs === 'number' && result.durationMs > 0 && !song.dt) {
            song.dt = result.durationMs
          }

          if (result.cover && result.cover.base64 && !song.picUrl) {
            // 生成新的封面 data URL
            const coverUrl = `data:${result.cover.mimeType};base64,${result.cover.base64}`
            song.picUrl = coverUrl

            // 如果当前正在播放这首歌，同步更新播放器当前歌曲封面
            if (player.currentSong?.id === song.id) {
              if (player.currentSong) {
                player.currentSong.cover = coverUrl
              }
            }
          }

          if (result.title) {
            song.name = result.title
          }

          if (result.artists && result.artists.length > 0) {
            if (!song.ar || song.ar.length === 0 || song.ar[0].name === '本地音乐') {
              song.ar = result.artists.map((n) => ({ name: n }))
            }
          }

          if (result.album) {
            if (!song.al) {
              song.al = { name: result.album }
            } else {
              song.al.name = result.album
            }
          }

          if (typeof result.bitrate === 'number' && result.bitrate > 0) {
            song.bitrate = result.bitrate
          }

          if (typeof result.sampleRate === 'number' && result.sampleRate > 0) {
            song.sampleRate = result.sampleRate
          }

          if (
            (typeof result.bitrate === 'number' && result.bitrate > 0) ||
            (typeof result.sampleRate === 'number' && result.sampleRate > 0)
          ) {
            song.quality = formatQualityFromMeta(
              result.bitrate,
              result.sampleRate
            )
          }
        } catch (error) {
          console.error('读取歌曲 meta 失败', song.filePath, error)
        }
      })
    )
  } finally {
    fillingMeta.value = false
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
