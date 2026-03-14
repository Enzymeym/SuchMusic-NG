<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { NInput, NIcon, NButton, NDivider, useDialog, NPopover, NScrollbar } from 'naive-ui'
import SettingsModal from '../common/SettingsModal.vue'
import { useSettingsStore } from '../../stores/settingsStore'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useLocalMusicStore } from '../../stores/localMusicStore'
import { searchSuggest } from '../../apis/netease/search/suggest'

const router = useRouter()
const route = useRoute()
const settingsStore = useSettingsStore()
const playerStore = usePlayerStore()
const playlistStore = usePlaylistStore()
const localMusicStore = useLocalMusicStore()
const dialog = useDialog()
const searchText = ref('')
const sizeType = ref<'max' | 'min'>('min')
const showSettings = ref(false)
const settingsSection = ref('general')
const settingsHighlightKey = ref<string | null>(null)

// Search Suggestion State
const showSuggestions = ref(false)
const suggestions = ref<{
  online: { songs: any[]; artists: any[]; playlists: any[] }
  localSongs: any[]
  localPlaylists: any[]
  recent: any[]
}>({
  online: { songs: [], artists: [], playlists: [] },
  localSongs: [],
  localPlaylists: [],
  recent: []
})
const suggestionLoading = ref(false)
let searchTimer: NodeJS.Timeout | null = null

// Watch search text for suggestions
watch(searchText, (newVal) => {
  if (searchTimer) clearTimeout(searchTimer)
  
  if (!newVal.trim()) {
    showSuggestions.value = false
    return
  }

  searchTimer = setTimeout(async () => {
    suggestionLoading.value = true
    try {
      const keyword = newVal.toLowerCase().trim()
      
      // 1. Local Songs
      const localSongs = localMusicStore.songs.filter(s => 
        s.name?.toLowerCase().includes(keyword) || 
        s.ar?.some(a => a.name.toLowerCase().includes(keyword)) ||
        s.al?.name?.toLowerCase().includes(keyword)
      ).slice(0, 5)

      // 2. Local Playlists
      const localPlaylists = playlistStore.playlists.filter(p => 
        p.name.toLowerCase().includes(keyword)
      ).slice(0, 3)

      // 3. Recent Play
      const recent = playerStore.playHistory.filter(p => 
        p.title.toLowerCase().includes(keyword) ||
        p.artist.toLowerCase().includes(keyword)
      ).slice(0, 5)

      // 4. Online Suggestions
      const res = await searchSuggest(newVal)
      const online = {
        songs: res.result.songs || [],
        artists: res.result.artists || [],
        playlists: res.result.playlists || []
      }

      suggestions.value = {
        localSongs,
        localPlaylists,
        recent,
        online
      }
      showSuggestions.value = true
    } catch (e) {
      console.error('Fetch suggestions failed', e)
    } finally {
      suggestionLoading.value = false
    }
  }, 300)
})

const handleSearch = () => {
  if (searchText.value.trim()) {
    showSuggestions.value = false
    router.push({ name: 'search', query: { q: searchText.value } })
  }
}

const handleSuggestionClick = (type: string, item: any) => {
  showSuggestions.value = false
  
  if (type === 'local-song') {
    // Construct PlayerSong from LocalSong
    const song = {
      id: item.id,
      title: item.name,
      artist: item.ar?.map((a: any) => a.name).join('/') || '未知歌手',
      cover: item.picUrl,
      durationMs: item.dt || 0,
      album: item.al?.name,
      filePath: item.filePath,
      source: 'local',
      sourceSongId: item.id
    }
    playerStore.setPlaylistForSource('local', [song])
    playerStore.setCurrentSong(song)
    playerStore.setPlaying(true)
    playerStore.recordPlay(song)
  } else if (type === 'local-playlist') {
    // Navigate to playlist detail? Or play?
    // Assuming we have a route for local playlist or just playlist detail
    // For now, maybe just do nothing or implement if playlist detail supports it
    // The current PlaylistDetailView seems to support 'id' param.
    // Let's assume we can navigate to it.
    // But wait, playlistStore playlists are user created.
    // We need to check routes.
    router.push({ name: 'playlist-detail', params: { id: item.id } })
  } else if (type === 'recent') {
    const song = {
      id: item.songId,
      title: item.title,
      artist: item.artist,
      cover: item.cover,
      filePath: item.filePath,
      durationMs: 0, // Recent record might not have duration
      source: item.source,
      sourceSongId: item.songId // Simplified
    }
    // Just play it
    playerStore.setPlaylistForSource('recent', [song]) // Or append?
    playerStore.setCurrentSong(song)
    playerStore.setPlaying(true)
  } else if (type === 'online-song') {
    // Play online song
    // We need to fetch details or just play if we have enough info
    // suggest api returns minimal info.
    // Usually we navigate to search page or try to play.
    // Let's navigate to search page with the song name for now, OR play it if we can.
    // The online song item usually has id, name, artists.
    // Let's just fill search text and search
    searchText.value = item.name + ' ' + (item.artists?.[0]?.name || '')
    handleSearch()
  } else if (type === 'online-artist') {
    searchText.value = item.name
    handleSearch()
  } else if (type === 'online-playlist') {
    searchText.value = item.name
    handleSearch()
  }
}

const handleBlur = () => {
  // Delay hiding to allow click event to propagate
  setTimeout(() => {
    showSuggestions.value = false
  }, 200)
}

const handleFocus = () => {
  if (searchText.value.trim()) {
    showSuggestions.value = true
  }
}

onMounted(() => {
  if (window.electron && window.electron.ipcRenderer) {
    window.electron.ipcRenderer.on('winSizeChange', (_, type) => {
      sizeType.value = type.size
    })
  }

  const handleOpenSettings = (event: Event) => {
    const detail = (event as CustomEvent<{ section?: string; settingKey?: string }>).detail || {}
    settingsSection.value = detail.section || 'general'
    settingsHighlightKey.value = detail.settingKey ?? null
    showSettings.value = true
  }

  window.addEventListener('open-settings', handleOpenSettings as EventListener)

  onBeforeUnmount(() => {
    window.removeEventListener('open-settings', handleOpenSettings as EventListener)
  })
})

const handleWindowAction = (type: 'hide' | 'min' | 'max' | 'close') => {
  if (window.electron && window.electron.ipcRenderer) {
    if (type === 'close') {
      const { closeAction, remindOnClose } = settingsStore.general

      const performClose = () => {
        if (closeAction === 'minimize') {
          window.electron.ipcRenderer.send('winAction', { type: 'hide' })
        } else {
          window.electron.ipcRenderer.send('winAction', { type: 'close' })
        }
      }

      if (remindOnClose) {
        dialog.warning({
          title: '关闭提示',
          content: '确定要关闭应用吗？',
          positiveText: closeAction === 'minimize' ? '最小化到托盘' : '退出应用',
          negativeText: '取消',
          onPositiveClick: () => {
            performClose()
          }
        })
        return
      }

      performClose()
      return
    }
    window.electron.ipcRenderer.send('winAction', { type })
  }
}

const goBack = () => {
  // Implement router back
  history.back()
}

const goForward = () => {
  // Implement router forward
  history.forward()
}

// 检查是否需要透明背景
const isTransparent = computed(() => {
  // 歌单详情页使用透明背景
  return route.name === 'playlist-detail'
})
</script>

<template>
  <div class="app-header" :class="{ 'is-transparent': isTransparent }">
    <div class="left-controls">
      <div style="display: flex; align-items: center; gap: 6px">
        <n-button circle strong secondary size="large" @click="goBack" class="nav-btn">
          <template #icon
            ><n-icon style="transform: scale(1.25)"><i class="mgc_left_line"></i></n-icon
          ></template>
        </n-button>
        <n-button circle strong secondary size="large" @click="goForward" class="nav-btn">
          <template #icon
            ><n-icon style="transform: scale(1.25)"><i class="mgc_right_line"></i></n-icon
          ></template>
        </n-button>
      </div>

      <n-popover
        trigger="manual"
        :show="showSuggestions"
        placement="bottom-start"
        style="padding: 0; width: 350px; border-radius: 10px; overflow: hidden; border: 1px solid rgba(0,0,0,0.15);"
        :show-arrow="false"
      >
        <template #trigger>
          <n-input
            v-model:value="searchText"
            placeholder="搜索音乐..."
            class="search-bar"
            @keydown.enter="handleSearch"
            @focus="handleFocus"
            @blur="handleBlur"
          >
            <template #prefix>
              <n-icon><i class="mgc_search_line"></i></n-icon>
            </template>
          </n-input>
        </template>
        <div class="search-suggestions">
          <n-scrollbar style="max-height: 400px">
             <!-- Online Songs -->
            <template v-if="suggestions.online.songs.length">
              <div class="suggestion-header">在线歌曲</div>
              <div 
                v-for="item in suggestions.online.songs" 
                :key="'online-s-'+item.id" 
                class="suggestion-item"
                @click="handleSuggestionClick('online-song', item)"
              >
                 <!-- Use first artist pic if available or online playlist cover logic, but online songs usually don't have direct cover in suggest result. 
                      Actually search/suggest result for songs usually has artists. 
                      If we want cover, we might need album.picUrl if available.
                      Let's check API response structure. Usually suggest API returns `songs` with `album`.
                      If not, we use icon or placeholder.
                      Figma shows cover. Let's assume we can get it or use placeholder.
                 -->
                <div class="suggestion-icon-wrapper" v-if="!item.album?.picId && !item.album?.artist?.img1v1Url">
                   <n-icon><i class="mgc_music_fill"></i></n-icon>
                </div>
                 <!-- Try to use album pic if available (netease api usually provides al or album) -->
                <img v-else :src="item.album?.picUrl || item.album?.artist?.img1v1Url" class="suggestion-cover" />
                
                <div class="suggestion-info">
                  <div class="suggestion-title">
                    {{ item.name }}
                  </div>
                  <div class="suggestion-desc">{{ item.artists?.[0]?.name }}</div>
                </div>
              </div>
            </template>

            <!-- Local & Recent (Merged) -->
            <template v-if="suggestions.recent.length || suggestions.localSongs.length">
              <div class="suggestion-header">本地&最近</div>
              
              <!-- Local Songs -->
              <div 
                v-for="item in suggestions.localSongs" 
                :key="'local-'+item.id" 
                class="suggestion-item"
                @click="handleSuggestionClick('local-song', item)"
              >
                <div class="suggestion-icon-wrapper">
                  <n-icon><i class="mgc_music_fill"></i></n-icon>
                </div>
                <div class="suggestion-info">
                  <div class="suggestion-title">{{ item.name }}</div>
                  <div class="suggestion-desc">{{ item.ar?.[0]?.name }}</div>
                </div>
              </div>

              <!-- Recent Play -->
              <div 
                v-for="item in suggestions.recent" 
                :key="'recent-'+item.songId" 
                class="suggestion-item"
                @click="handleSuggestionClick('recent', item)"
              >
                <img :src="item.cover" class="suggestion-cover" />
                <div class="suggestion-info">
                  <div class="suggestion-title">{{ item.title }}</div>
                  <div class="suggestion-desc">{{ item.artist }}</div>
                </div>
              </div>
            </template>

            <!-- Playlists (Local & Online) -->
            <template v-if="suggestions.localPlaylists.length || suggestions.online.playlists.length">
              <div class="suggestion-header">歌单</div>
              <div class="playlist-grid">
                <!-- Local Playlists -->
                <div 
                  v-for="item in suggestions.localPlaylists" 
                  :key="'lp-'+item.id" 
                  class="playlist-item"
                  @click="handleSuggestionClick('local-playlist', item)"
                >
                  <div class="playlist-cover-wrapper">
                    <n-icon size="40"><i class="mgc_playlist_fill"></i></n-icon>
                  </div>
                  <div class="playlist-title">{{ item.name }}</div>
                </div>

                <!-- Online Playlists -->
                <div 
                  v-for="item in suggestions.online.playlists" 
                  :key="'online-p-'+item.id" 
                  class="playlist-item"
                  @click="handleSuggestionClick('online-playlist', item)"
                >
                  <img :src="item.coverImgUrl" class="playlist-cover" />
                  <div class="playlist-title">{{ item.name }}</div>
                </div>
              </div>
            </template>

            <!-- Online Artists (Keep them but maybe at bottom or merged? Design didn't show them. Let's keep at bottom for now) -->
            <template v-if="suggestions.online.artists.length">
                <div class="suggestion-header">相关歌手</div>
                <div 
                  v-for="item in suggestions.online.artists" 
                  :key="'online-a-'+item.id" 
                  class="suggestion-item"
                  @click="handleSuggestionClick('online-artist', item)"
                >
                  <img :src="item.picUrl || item.img1v1Url" class="suggestion-cover round" />
                  <div class="suggestion-info">
                    <div class="suggestion-title">{{ item.name }}</div>
                  </div>
                </div>
            </template>
            
            <div v-if="!suggestions.recent.length && !suggestions.localSongs.length && !suggestions.localPlaylists.length && !suggestions.online.songs.length && !suggestions.online.artists.length && !suggestions.online.playlists.length" class="no-suggestions">
                未找到相关结果
            </div>
          </n-scrollbar>
        </div>
      </n-popover>
    </div>

    <div class="right-controls">
      <n-button
        circle
        strong
        secondary
        size="large"
        class="action-btn"
        @click="showSettings = true"
      >
        <template #icon
          ><n-icon><i class="mgc_settings_3_line"></i></n-icon
        ></template>
      </n-button>
      <n-divider vertical />
      <div class="window-controls">
        <n-button
          circle
          strong
          secondary
          size="large"
          @click="handleWindowAction('hide')"
          class="nav-btn"
        >
          <template #icon
            ><n-icon><i class="mgc_minimize_line"></i></n-icon
          ></template>
        </n-button>
        <n-button
          circle
          strong
          secondary
          size="large"
          @click="handleWindowAction(sizeType === 'max' ? 'min' : 'max')"
          class="nav-btn"
        >
          <template #icon
            ><n-icon
              ><i :class="sizeType === 'max' ? 'mgc_restore_line' : 'mgc_square_line'"></i></n-icon
          ></template>
        </n-button>
        <n-button
          circle
          strong
          secondary
          size="large"
          @click="handleWindowAction('close')"
          class="nav-btn"
        >
          <template #icon
            ><n-icon><i class="mgc_close_line"></i></n-icon
          ></template>
        </n-button>
      </div>
    </div>
    <SettingsModal
      v-model:show="showSettings"
      :initial-section="settingsSection"
      :initial-highlight-key="settingsHighlightKey"
    />
  </div>
</template>

<style scoped>
.app-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  height: 60px;
  padding: 0 24px 0 20px;
  -webkit-app-region: drag;
  /* Draggable */
  transition: background-color 0.3s;
  background-color: transparent; /* 容器默认背景透明 */
  position: relative;
  z-index: 1;
}

/* 仅在沉浸式模式下（透明背景），子元素应用毛玻璃样式 */
.is-transparent .left-controls .nav-btn,
.is-transparent .search-bar,
.is-transparent .right-controls .action-btn,
.is-transparent .window-controls .nav-btn {
  background-color: rgba(255, 255, 255, 0.4) !important;
  backdrop-filter: blur(12px) !important;
  -webkit-backdrop-filter: blur(12px) !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1) !important;
  transition: all 0.3s ease;
  border: 1px solid rgba(255, 255, 255, 0.2) !important;
}

/* 深色模式下的沉浸式样式 */
html[data-theme='dark'] .is-transparent .left-controls .nav-btn,
html[data-theme='dark'] .is-transparent .search-bar,
html[data-theme='dark'] .is-transparent .right-controls .action-btn,
html[data-theme='dark'] .is-transparent .window-controls .nav-btn {
  background-color: rgba(0, 0, 0, 0.3);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

/* 非沉浸式（普通模式）下，AppHeader 应该有背景，子元素恢复默认 */
/* 这里我们为普通模式添加一个背景色，通常跟随主题 */
:not(.is-transparent) .app-header {
  background-color: transparent; /* 或者 var(--n-color-modal) 如果需要不透明 */
}

/* 普通模式下，搜索框 */
:not(.is-transparent) .search-bar {
  /* 移除强制背景，让 naive-ui 默认样式或主题变量生效 */
  width: 240px;
  height: 38px;
  background-color: rgb(231, 230, 230); /* 确保外层容器透明，不干扰内部 n-input */
  backdrop-filter: none;
  box-shadow: none;
  border: none;
}

.left-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  -webkit-app-region: no-drag;
}

.nav-btn {
  border: none;
}

.search-bar {
  width: 240px;
  border: none;
  border-radius: 20000px;
  height: 38px;
  /* 默认情况（非沉浸式）下，不应该强制 transparent，除非我们确实想让它透明 */
  /* background-color: transparent !important; */
}

/* 强制覆盖 naive-ui 默认背景 */
/* 仅在沉浸式模式下生效 */
.is-transparent .search-bar :deep(.n-input),
.is-transparent .search-bar :deep(.n-input .n-input-wrapper),
.is-transparent .search-bar :deep(.n-input__border),
.is-transparent .search-bar :deep(.n-input__state-border),
.is-transparent .search-bar :deep(.n-input--state-focused),
.is-transparent .search-bar :deep(.n-input:hover),
.is-transparent .search-bar :deep(.n-input:focus) {
  background-color: transparent !important;
  box-shadow: none !important; /* 移除 naive-ui 默认阴影 */
  border: none !important;
  --n-color: transparent !important;
  --n-color-focus: transparent !important;
  --n-border: none !important;
  --n-border-hover: none !important;
  --n-border-focus: none !important;
  --n-box-shadow-focus: none !important;
}

/* 普通模式下，搜索框恢复默认样式 */
/* 注意：我们在 .search-bar 外层加了背景色，所以这里其实不需要做什么，只要不强制 transparent 即可 */
/* 但是因为上面的 CSS 规则优先级很高，我们需要显式重置 */

/* 重置普通模式下的输入框样式 */
:not(.is-transparent) .search-bar :deep(.n-input),
:not(.is-transparent) .search-bar :deep(.n-input .n-input-wrapper) {
  /* background-color: transparent !important; */
  /* 移除强制透明，让 Naive UI 默认背景生效，或者我们自己指定一个背景 */
  /* 如果 search-bar 容器背景没显示出来，可能是 z-index 或者被覆盖 */

  /* 恢复文字颜色为 Naive UI 默认变量（或者不设置，让它自然继承） */
  /* 这里为了保险，还是设置一下 */
  --n-text-color: var(--n-text-color);
  --n-placeholder-color: var(--n-placeholder-color);
  --n-icon-color: var(--n-icon-color);
  --n-caret-color: var(--n-caret-color);
}

/* 确保在普通模式下，.search-bar 容器本身有背景 */
html[data-theme='dark'] :not(.is-transparent) .search-bar {
  background-color: #232326 !important; /* 加深一点，确保可见 */
  backdrop-filter: blur(10px);
  box-shadow: none;
  border: 1px solid transparent;
}

/* html[data-theme='dark'] :not(.is-transparent) .search-bar { */
/* background-color: rgba(0, 0, 0, 0.3) !important; */
/* box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); */
/* border: 1px solid rgba(255, 255, 255, 0.05); */
/* } */

html[data-theme='dark'] :not(.is-transparent) .search-bar :deep(.n-input),
html[data-theme='dark'] :not(.is-transparent) .search-bar :deep(.n-input .n-input-wrapper) {
  /* 同样不需要做太多，只要文字颜色对就行 */
}

:not(.is-transparent) .search-bar :deep(.n-input__border),
:not(.is-transparent) .search-bar :deep(.n-input__state-border) {
  border: none !important;
  box-shadow: none !important;
}

/* 确保输入文字和图标颜色正确 */
.search-bar :deep(.n-input__input-el),
.search-bar :deep(.n-icon),
.search-bar :deep(.n-input__placeholder) {
  color: inherit !important;
  /* 不要强制 inherit，让 Naive UI 的变量生效，或者我们上面覆盖的变量生效 */
}

.right-controls {
  display: flex;
  align-items: center;

  -webkit-app-region: no-drag;
}

.user-profile {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.username {
  font-size: 14px;
  font-weight: 500;
}

.vip-badge {
  font-size: 10px;
  background-color: #333;
  color: #fff;
  padding: 1px 4px;
  border-radius: 4px;
}

.window-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.win-btn {
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.win-btn:hover {
  background-color: rgba(0, 0, 0, 0.1);
}

.win-btn.close:hover {
  background-color: #e81123;
  color: white;
}

.playlist-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  padding: 8px 12px;
}

.playlist-item {
  display: flex;
  flex-direction: column;
  cursor: pointer;
  transition: opacity 0.2s;
}

.playlist-item:hover {
  opacity: 0.8;
}

.playlist-cover-wrapper {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 8px;
  background-color: rgba(128, 128, 128, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--n-text-color-3);
  margin-bottom: 8px;
}

.playlist-cover {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 8px;
  object-fit: cover;
  background-color: var(--n-color-modal);
  margin-bottom: 8px;
}

.playlist-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--n-text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.3;
}

.suggestion-header {
  font-size: 12px;
  color: var(--n-text-color-3);
  padding: 12px 12px 4px;
  background-color: var(--n-color-modal);
  position: sticky;
  top: 0;
  z-index: 1;
}

.search-suggestions {
  max-height: 400px;
  overflow-y: auto;
}

.no-suggestions {
  padding: 20px;
  text-align: center;
  color: var(--n-text-color-3);
}

.suggestion-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  transition: background-color 0.2s;
  cursor: pointer;
  border-radius: 6px;
  margin: 0 4px;
}

.suggestion-item:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

html[data-theme='dark'] .suggestion-item:hover {
  background-color: rgba(255, 255, 255, 0.08);
}

.suggestion-cover {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
  background-color: var(--n-color-modal);
}

.suggestion-cover.round {
  border-radius: 50%;
}

.suggestion-icon-wrapper {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  background-color: rgba(128, 128, 128, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  color: var(--n-text-color-3);
  flex-shrink: 0;
}

.suggestion-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.suggestion-title {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
}

.suggestion-desc {
  font-size: 12px;
  color: var(--n-text-color-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
</style>
