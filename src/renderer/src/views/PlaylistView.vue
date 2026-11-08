<template>
  <div class="local-music-view">
    <div class="header">
      <div class="title">
        歌单
        <span class="subtitle">
          <i class="mgc_music_2_fill"></i> {{ currentCount }} 个
        </span>
      </div>
      <div class="actions">
        <div style="display: flex; gap: 10px">
          <n-button
            v-if="activeCategory === 'mine'"
            secondary
            style="padding: 0 16px; font-size: 15px"
            size="large"
            round
            type="primary"
            @click="createEmptyPlaylist"
          >
            <template #icon>
              <n-icon size="16">
                <i class="mgc_add_line"></i>
              </n-icon>
            </template>
            新建歌单
          </n-button>
          <n-dropdown v-if="activeCategory !== 'folder'" trigger="click" :options="importOptions" @select="handleImportSelect">
            <n-button secondary style="padding: 0 16px; font-size: 15px" size="large" round>
              <template #icon>
                <n-icon size="16">
                  <i class="mgc_download_3_line"></i>
                </n-icon>
              </template>
              导入歌单
            </n-button>
          </n-dropdown>
          <n-button secondary strong circle size="large" @click="refresh">
            <template #icon>
              <n-icon size="20">
                <i class="mgc_refresh_2_line"></i>
              </n-icon>
            </template>
          </n-button>
        </div>
        <n-input
          v-model:value="searchKeyword"
          placeholder="搜索歌单 / 文件夹"
          clearable
          size="large"
          round
          class="search-input"
          style="width: 220px"
        >
          <template #prefix>
            <n-icon size="18" color="#999">
              <i class="mgc_search_2_line"></i>
            </n-icon>
          </template>
        </n-input>
      </div>

      <!-- 分类：文件夹歌单是曲库派生的，和手动/云端歌单并列展示 -->
      <div class="category-tabs">
        <button
          v-for="tab in categoryTabs"
          :key="tab.key"
          type="button"
          class="category-tab"
          :class="{ active: activeCategory === tab.key }"
          @click="activeCategory = tab.key"
        >
          <i :class="tab.icon"></i>
          {{ tab.label }}
          <span class="tab-count">{{ tab.count }}</span>
        </button>
      </div>
    </div>

    <div class="content">
      <n-scrollbar class="playlist-scroll" content-style="padding: 0 4px 16px;">
        <!-- 文件夹歌单 -->
        <div v-if="activeCategory === 'folder'" class="playlist-grid">
          <div
            v-for="folder in filteredFolders"
            :key="folder.id"
            class="playlist-card"
            @click="openFolder(folder.id)"
            @dblclick="playFolder(folder)"
          >
            <div class="cover-wrapper">
              <img :src="folderCover(folder)" class="playlist-cover" loading="lazy" />
              <div class="play-count">
                <n-icon size="14"><i class="mgc_music_2_line"></i></n-icon>
                <span>{{ folder.totalTrackCount }} 首</span>
              </div>
              <div class="card-actions" @click.stop>
                <n-dropdown
                  trigger="click"
                  :options="folderMenuOptions(folder)"
                  @select="(key: string) => handleFolderMenu(key, folder)"
                >
                  <button type="button" class="card-action-btn">
                    <i class="mgc_more_2_fill"></i>
                  </button>
                </n-dropdown>
              </div>
              <span v-if="folder.pinned" class="pin-badge">
                <i class="mgc_pin_2_fill"></i>
              </span>
            </div>
            <div class="playlist-title">{{ folder.displayName }}</div>
          </div>

          <div v-if="filteredFolders.length === 0" class="empty-tip">
            <p>{{ searchKeyword ? '没有匹配的文件夹' : '还没有扫描到任何音乐文件夹' }}</p>
            <p class="hint">在「设置 → 本地音乐」添加扫描目录，或到「歌曲」页点刷新</p>
          </div>
        </div>

        <!-- 我的歌单 / 云端歌单 -->
        <div v-else class="playlist-grid">
          <div
            v-for="pl in visiblePlaylists"
            :key="pl.id"
            class="playlist-card"
            :class="{ active: pl.id === selectedId }"
            @click="handleSelect(pl.id)"
            @dblclick="() => handlePlayPlaylist(pl.id)"
          >
            <div class="cover-wrapper">
              <img :src="getPlaylistCover(pl)" class="playlist-cover" loading="lazy" />
              <div class="play-count">
                <n-icon size="14"><i class="mgc_music_2_line"></i></n-icon>
                <span>{{ pl.tracks.length }} 首</span>
              </div>
            </div>
            <div class="playlist-title">{{ pl.name }}</div>
          </div>

          <div v-if="visiblePlaylists.length === 0" class="empty-tip">
            <p>{{ searchKeyword ? '没有匹配的歌单' : '这个分类下还没有歌单' }}</p>
          </div>
        </div>
      </n-scrollbar>
    </div>

    <n-modal v-model:show="showCreateModal" preset="dialog" title="新建歌单" style="width: 400px">
      <div style="margin-bottom: 12px">歌单名称</div>
      <n-input v-model:value="newPlaylistName" placeholder="输入歌单名称" />
      <template #action>
        <n-button @click="showCreateModal = false">取消</n-button>
        <n-button type="primary" @click="handleConfirmCreate">确定</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showRenameFolderModal" preset="dialog" title="重命名文件夹歌单" style="width: 420px">
      <div style="margin-bottom: 8px">只改显示名称，不会改动磁盘上的目录名</div>
      <n-input v-model:value="renameFolderName" placeholder="输入显示名称" />
      <template #action>
        <n-button @click="showRenameFolderModal = false">取消</n-button>
        <n-button type="primary" @click="confirmRenameFolder">确定</n-button>
      </template>
    </n-modal>

    <NeteasePlaylistImportModal v-model:show="showImportModal" @imported="handleImported" />
    <SourcePlaylistImportModal v-model:show="showSourceImportModal" @imported="handleImported" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NInput, NScrollbar, NModal, NDropdown, useMessage } from 'naive-ui'
import { usePlayerStore } from '../stores/playerStore'
import { usePlaylistStore, type UserPlaylist } from '../stores/playlistStore'
import { useLocalMusicStore } from '../stores/localMusicStore'
import NeteasePlaylistImportModal from '../components/common/NeteasePlaylistImportModal.vue'
import SourcePlaylistImportModal from '../components/common/SourcePlaylistImportModal.vue'
import { playlistTrackToPlayerSong, playerSongToPlaylistTrack } from '../utils/playlistTrack'
import { coverUrl } from '../../../shared/library/channels'
import { normalizeSearchText } from '../../../shared/library/normalize'
import type { LibraryFolder } from '../../../shared/library/types'
import defaultCover from '@renderer/assets/default-cover.png'

const router = useRouter()
const player = usePlayerStore()
const playlistStore = usePlaylistStore()
const localMusicStore = useLocalMusicStore()
const message = useMessage()

type Category = 'folder' | 'mine' | 'cloud'

const activeCategory = ref<Category>('folder')
const searchKeyword = ref('')
const loading = ref(false)
const selectedId = ref<string | null>(null)
const showCreateModal = ref(false)
const showImportModal = ref(false)
const showSourceImportModal = ref(false)
const createMode = ref<'empty' | 'queue'>('empty')
const newPlaylistName = ref('')
const showRenameFolderModal = ref(false)
const renameFolderName = ref('')
const renamingFolderId = ref(0)

/** 「导入歌单」下拉：网易云 / 音源插件 */
const importOptions = [
  { label: '从网易云导入歌单', key: 'netease' },
  { label: '从音源插件导入歌单', key: 'source' }
]

const handleImportSelect = (key: string | number): void => {
  if (String(key) === 'netease') showImportModal.value = true
  else showSourceImportModal.value = true
}

const playlists = computed(() => playlistStore.playlists)

/** 手动歌单（自建 + 本地导入）与云端歌单分开，避免混在一格里 */
const minePlaylists = computed(() => playlists.value.filter((pl) => !pl.source))
const cloudPlaylists = computed(() => playlists.value.filter((pl) => !!pl.source))

const keyword = computed(() => normalizeSearchText(searchKeyword.value))

const filteredFolders = computed<LibraryFolder[]>(() => {
  const list = localMusicStore.folderPlaylists
  if (!keyword.value) return list
  return list.filter((folder) => normalizeSearchText(folder.displayName).includes(keyword.value))
})

const visiblePlaylists = computed<UserPlaylist[]>(() => {
  const list = activeCategory.value === 'cloud' ? cloudPlaylists.value : minePlaylists.value
  if (!keyword.value) return list
  return list.filter((pl) => normalizeSearchText(pl.name).includes(keyword.value))
})

const currentCount = computed(() => {
  if (activeCategory.value === 'folder') return filteredFolders.value.length
  return visiblePlaylists.value.length
})

const categoryTabs = computed(() => [
  { key: 'folder' as Category, label: '文件夹', icon: 'mgc_folder_2_line', count: filteredFolders.value.length },
  { key: 'mine' as Category, label: '我的歌单', icon: 'mgc_playlist_line', count: minePlaylists.value.length },
  { key: 'cloud' as Category, label: '云端歌单', icon: 'mgc_cloud_line', count: cloudPlaylists.value.length }
])

function folderCover(folder: LibraryFolder): string {
  return coverUrl(folder.coverHash, folder.coverExt, 'thumb') || defaultCover
}

function folderMenuOptions(folder: LibraryFolder) {
  return [
    { label: folder.pinned ? '取消固定' : '固定到顶部', key: 'pin' },
    { label: '重命名显示名', key: 'rename' },
    { label: '播放这个文件夹', key: 'play' },
    { type: 'divider', key: 'd1' },
    { label: '在资源管理器中显示', key: 'reveal' },
    { label: '隐藏这个文件夹歌单', key: 'hide' }
  ]
}

async function handleFolderMenu(key: string, folder: LibraryFolder): Promise<void> {
  switch (key) {
    case 'pin':
      await localMusicStore.updateFolder(folder.id, { pinned: !folder.pinned })
      break
    case 'rename':
      renamingFolderId.value = folder.id
      renameFolderName.value = folder.displayName
      showRenameFolderModal.value = true
      break
    case 'play':
      await playFolder(folder)
      break
    case 'reveal':
      await revealFolder(folder)
      break
    case 'hide':
      await localMusicStore.updateFolder(folder.id, { hidden: true })
      message.success('已隐藏，可在设置中恢复')
      break
    default:
      break
  }
}

async function confirmRenameFolder(): Promise<void> {
  const name = renameFolderName.value.trim()
  if (!name || !renamingFolderId.value) {
    showRenameFolderModal.value = false
    return
  }
  await localMusicStore.updateFolder(renamingFolderId.value, { alias: name })
  showRenameFolderModal.value = false
  message.success('已重命名')
}

function openFolder(id: number): void {
  router.push({ name: 'folder-detail', params: { id: String(id) } })
}

async function playFolder(folder: LibraryFolder): Promise<void> {
  const songs = await localMusicStore.getFolderTracks(folder.id, {
    includeSubfolders: true,
    limit: 2000
  })
  if (songs.length === 0) {
    message.info('这个文件夹里没有可播放的音乐')
    return
  }
  const list = songs.map(
    (song) =>
      ({
        id: song.id,
        title: song.name,
        artist: (song.ar ?? []).map((a) => a.name).join(' / ') || '未知歌手',
        cover: song.picUrl || song.al?.picUrl || '',
        durationMs: song.dt || 0,
        album: song.al?.name,
        filePath: song.filePath,
        lyrics: localMusicStore.getLyrics(song) || undefined,
        source: 'local',
        sourceSongId: song.id
      }) as any
  )
  player.setPlaylist(list)
  player.setCurrentSong(list[0])
  message.success(`开始播放「${folder.displayName}」`)
}

async function revealFolder(folder: LibraryFolder): Promise<void> {
  const songs = await localMusicStore.getFolderTracks(folder.id, {
    includeSubfolders: true,
    limit: 1
  })
  const filePath = songs[0]?.filePath
  if (filePath) await localMusicStore.revealInFolder(filePath)
}

/**
 * 获取歌单封面：根据 coverFollowsFirstTrack 决定封面来源
 */
const getPlaylistCover = (pl: UserPlaylist): string => {
  if (pl.coverFollowsFirstTrack) {
    return pl.tracks[0]?.cover || pl.cover || defaultCover
  }
  return pl.cover || pl.tracks[0]?.cover || defaultCover
}

onMounted(async () => {
  loading.value = false
  // 文件夹歌单来自曲库，先确保已从库里加载
  await localMusicStore.bootstrap()
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
  const list = pl.tracks.map((t) => playlistTrackToPlayerSong(t))
  player.setPlaylist(list)
  if (list.length > 0) {
    player.setCurrentSong(list[0])
  }
}

const refresh = (): void => {
  playlistStore.loadFromStorage()
  void localMusicStore.loadFromLibrary()
  message.success('已刷新歌单')
}

// 导入成功后定位到新歌单（不自动跳转，避免批量导入时连续跳转）
const handleImported = (pl: UserPlaylist): void => {
  selectedId.value = pl.id
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
    const tracks = player.playlist.map((s) => playerSongToPlaylistTrack(s))
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
  padding: 64px 24px 0px;
  box-sizing: border-box;
}

.header {
  display: flex;
  background-color: #f6f6f6;
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
  font-size: clamp(20px, 2.5vw, 27px);
  font-weight: bold;
}

.subtitle {
  font-size: clamp(12px, 1.2vw, 14px);
  color: #999;
  margin-left: 8px;
}

.actions {
  display: flex;
  width: 100%;
  justify-content: space-between;
  align-items: center;
}

/* 分类 tabs */
.category-tabs {
  display: flex;
  gap: 6px;
  margin: 10px 0 2px;
  flex-wrap: wrap;
}

.category-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 14px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--n-text-color-3, #777);
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
}

.category-tab:hover {
  background: var(--n-color-hover, rgba(0, 0, 0, 0.04));
}

.category-tab.active {
  background: var(--n-color, rgba(0, 0, 0, 0.06));
  color: var(--n-text-color, inherit);
  font-weight: 600;
}

html[data-theme='dark'] .category-tab.active {
  background: rgba(255, 255, 255, 0.1);
}

.tab-count {
  font-size: 11px;
  opacity: 0.65;
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
  position: relative;
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
  background: var(--n-color, rgba(0, 0, 0, 0.04));
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
  font-size: clamp(8px, 0.9vw, 10px);
  padding: 2px 6px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.card-actions {
  position: absolute;
  left: 6px;
  bottom: 6px;
  opacity: 0;
  transition: opacity 0.16s ease;
}

.playlist-card:hover .card-actions {
  opacity: 1;
}

.card-action-btn {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 14px;
}

.pin-badge {
  position: absolute;
  left: 8px;
  top: 8px;
  color: #fff;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 50%;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}

.playlist-title {
  font-size: clamp(14px, 1.3vw, 16px);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.empty-tip {
  grid-column: 1 / -1;
  text-align: center;
  padding: 60px 20px;
  color: var(--n-text-color-3, #888);
}

.empty-tip .hint {
  font-size: 12px;
  opacity: 0.7;
}
</style>
