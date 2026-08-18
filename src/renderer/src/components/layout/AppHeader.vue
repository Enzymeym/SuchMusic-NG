<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { NInput, NIcon, NButton, NDivider, useDialog, NPopover, NScrollbar, useThemeVars, NImage, NSpin, useMessage, NAvatar, NText, NTag } from 'naive-ui'

const props = defineProps<{
  collapsed?: boolean
}>()

const themeVars = useThemeVars()
import SettingsModal from '../common/SettingsModal.vue'
import { useSettingsStore } from '../../stores/settingsStore'
import { usePlayerStore } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useLocalMusicStore } from '../../stores/localMusicStore'
const router = useRouter()
const route = useRoute()
const settingsStore = useSettingsStore()
const playerStore = usePlayerStore()
const playlistStore = usePlaylistStore()
const localMusicStore = useLocalMusicStore()
const dialog = useDialog()
const message = useMessage()
const searchText = ref('')
const sizeType = ref<'max' | 'min'>('min')
const showSettings = ref(false)
const settingsSection = ref('general')
const settingsHighlightKey = ref<string | null>(null)

// ===== 网易云账号登录 =====
interface NeteaseProfile {
  nickname: string
  userId: string
  avatarUrl?: string
  vipType?: number
  vipLevel?: number
  level?: number
  signature?: string
}

const neteaseUser = ref<NeteaseProfile | null>(null)
const neteaseAccounts = ref<NeteaseProfile[]>([])
const showUserPanel = ref(false)
const qrImg = ref('')
const qrUnikey = ref('')
const qrStatusText = ref('')
const qrLoading = ref(false)
let qrPollTimer: ReturnType<typeof setInterval> | null = null

/** 当前账号是否为黑胶 VIP */
const isVip = computed(() => {
  const u = neteaseUser.value
  return !!u && typeof u.vipType === 'number' && u.vipType > 0
})

/** VIP 文案（黑胶VIP Lv.X） */
const vipLabel = computed(() => {
  if (!isVip.value) return ''
  const u = neteaseUser.value
  return u?.vipLevel ? `黑胶VIP Lv.${u.vipLevel}` : '黑胶VIP'
})

const stopQrPolling = () => {
  if (qrPollTimer) {
    clearInterval(qrPollTimer)
    qrPollTimer = null
  }
}

const loadLoginStatus = async () => {
  try {
    const status = await window.api.netease.loginStatus()
    neteaseUser.value = status.loggedIn ? status.profile || null : null
    neteaseAccounts.value = status.accounts || []
  } catch (e) {
    console.error('[AppHeader] 获取网易云登录状态失败:', e)
  }
}

const loadLoginQr = async () => {
  stopQrPolling()
  qrLoading.value = true
  qrStatusText.value = '正在生成二维码...'
  try {
    const { unikey, qrimg } = await window.api.netease.loginQr()
    qrUnikey.value = unikey
    qrImg.value = qrimg
    qrStatusText.value = '请使用网易云音乐 APP 扫码'
    startQrPolling()
  } catch (e: any) {
    qrStatusText.value = '二维码生成失败: ' + (e?.message || '未知错误')
    console.error('[AppHeader] 生成网易云登录二维码失败:', e)
  } finally {
    qrLoading.value = false
  }
}

const startQrPolling = () => {
  stopQrPolling()
  qrPollTimer = setInterval(async () => {
    try {
      const res = await window.api.netease.loginQrCheck(qrUnikey.value)
      if (res.code === 801) {
        qrStatusText.value = '等待扫码...'
      } else if (res.code === 802) {
        qrStatusText.value = '已扫码，请在手机上确认登录'
      } else if (res.code === 800) {
        stopQrPolling()
        qrStatusText.value = '二维码已过期，请点击刷新'
      } else if (res.code === 803) {
        stopQrPolling()
        if (res.profile) {
          neteaseUser.value = res.profile
          await loadLoginStatus()
          message.success(`登录成功，欢迎 ${res.profile.nickname}`)
        } else {
          neteaseUser.value = { nickname: '网易云用户', userId: '' }
          message.success('登录成功')
        }
        showUserPanel.value = false
      }
    } catch (e) {
      console.error('[AppHeader] 检测网易云扫码状态失败:', e)
    }
  }, 3000)
}

const handleUserButtonClick = () => {
  showUserPanel.value = !showUserPanel.value
  if (showUserPanel.value) {
    if (neteaseUser.value) {
      // 打开面板时刷新账号状态（VIP / 等级等）
      loadLoginStatus()
    } else if (!qrImg.value) {
      loadLoginQr()
    }
  }
}

// 关闭账号面板时停止 QR 轮询：避免面板收起后仍每 3 秒请求一次检测接口，
// 造成接口限流（429）而无法重新登录
watch(showUserPanel, (visible) => {
  if (!visible) {
    stopQrPolling()
  }
})

const handleRefreshQr = () => {
  loadLoginQr()
}

const handleLogout = async (userId?: string) => {
  try {
    await window.api.netease.logout(userId)
  } catch (e) {
    console.error('[AppHeader] 退出网易云登录失败:', e)
  }
  await loadLoginStatus()
  qrImg.value = ''
  qrUnikey.value = ''
  qrStatusText.value = ''
  stopQrPolling()
  message.success('已退出登录')
}

const handleSwitchAccount = async (userId: string) => {
  if (userId === neteaseUser.value?.userId) return
  try {
    const status = await window.api.netease.switchAccount(userId)
    neteaseUser.value = status.loggedIn ? status.profile || null : null
    neteaseAccounts.value = status.accounts || []
    showUserPanel.value = false
    message.success('已切换账号')
  } catch (e) {
    console.error('[AppHeader] 切换网易云账号失败:', e)
  }
}

// Search Suggestion State
const showSuggestions = ref(false)
const suggestions = ref<{
  localSongs: any[]
  localPlaylists: any[]
  recent: any[]
}>({
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

      suggestions.value = {
        localSongs,
        localPlaylists,
        recent
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
    playerStore.setCurrentSong(song)
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
    playerStore.setCurrentSong(song)
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

  const handleCloseSettings = () => {
    showSettings.value = false
  }

  window.addEventListener('close-settings', handleCloseSettings)

  loadLoginStatus()

  onBeforeUnmount(() => {
    window.removeEventListener('open-settings', handleOpenSettings as EventListener)
    window.removeEventListener('close-settings', handleCloseSettings)
    stopQrPolling()
  })
})

const handleWindowAction = (type: 'hide' | 'min' | 'max' | 'close') => {
  if (window.electron && window.electron.ipcRenderer) {
    if (type === 'close') {
      const { closeAction, remindOnClose } = settingsStore.general

      const performClose = () => {
        if (closeAction === 'minimize') {
          window.electron.ipcRenderer.send('winAction', { type: 'hide-to-tray' })
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
  // 全尺寸歌单页和首页使用透明背景
  return route.name === 'playlist-detail' || route.name === 'home'
})

// 背景磨砂效果：单层模糊从上到下渐进消失
const headerGradientStyle = computed(() => {
  if (route.name === 'playlist-detail' || route.name === 'home') return { display: 'none' }
  return {
    background: 'transparent',
    backdropFilter: 'blur(40px) saturate(160%)',
    WebkitBackdropFilter: 'blur(40px) saturate(160%)',
    WebkitMask: 'linear-gradient(to bottom, black 0%, black 40%, transparent 100%)',
    mask: 'linear-gradient(to bottom, black 0%, black 40%, transparent 100%)'
  }
})

// 侧栏折叠时增加左侧内边距，避免 header 内容被折叠图标遮挡
const headerPaddingStyle = computed(() => {
  if (props.collapsed) {
    return { paddingLeft: '72px' } // 52px 侧栏图标 + 20px 原有间距
  }
  return {}
})

</script>

<template>
  <div
    ref="headerRef"
    class="app-header"
    :class="{ 'is-transparent': isTransparent }"
    :style="headerPaddingStyle"
  >
    <div
      class="header-gradient-bg"
      :style="headerGradientStyle"
    ></div>
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
            placeholder="搜索音乐"
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

            <!-- Playlists (Local) -->
            <template v-if="suggestions.localPlaylists.length">
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
              </div>
            </template>

            <div v-if="!suggestions.recent.length && !suggestions.localSongs.length && !suggestions.localPlaylists.length" class="no-suggestions">
                未找到相关结果
            </div>
          </n-scrollbar>
        </div>
      </n-popover>
    </div>

    <div class="right-controls">
      <n-popover
        trigger="manual"
        :show="showUserPanel"
        placement="bottom-end"
        :show-arrow="false"
        style="width: 280px; border-radius: 12px;"
      >
        <template #trigger>
          <n-button
            circle
            strong
            secondary
            size="large"
            class="action-btn"
            style="margin-right: 8px;"
            title="网易云账号"
            @click="handleUserButtonClick"
          >
            <template #icon>
              <img
                v-if="neteaseUser?.avatarUrl"
                :src="neteaseUser.avatarUrl"
                alt=""
                referrerpolicy="no-referrer"
                class="user-avatar-img"
              />
              <n-icon v-else><i class="mgc_user_fill"></i></n-icon>
            </template>
          </n-button>
        </template>

        <div v-if="neteaseUser" class="user-panel-logged">
          <!-- 当前账号信息：竖向布局 -->
          <div class="user-panel-profile">
            <n-avatar
              :src="neteaseUser.avatarUrl || undefined"
              round
              :size="52"
              class="user-panel-avatar"
            >
              <n-icon v-if="!neteaseUser.avatarUrl" size="24"><i class="mgc_user_fill"></i></n-icon>
            </n-avatar>
            <n-text strong :depth="1" class="user-panel-name">{{ neteaseUser.nickname }}</n-text>
            <div class="user-panel-tags">
              <n-tag v-if="isVip" type="warning" size="small" :bordered="false">VIP</n-tag>
              <n-tag v-if="neteaseUser.level" size="small" :bordered="false">
                Lv.{{ neteaseUser.level }}
              </n-tag>
            </div>
            <n-text v-if="vipLabel" depth="3" class="user-panel-vip">{{ vipLabel }}</n-text>
            <n-text depth="3" class="user-panel-id">用户ID: {{ neteaseUser.userId || '-' }}</n-text>
          </div>

          <template v-if="neteaseAccounts.length > 1">
            <n-divider style="margin: 8px 0" />
            <div class="user-panel-section-title">已登录账号</div>
            <div class="user-panel-menu">
              <button
                v-for="acc in neteaseAccounts"
                :key="acc.userId"
                type="button"
                class="menu-item"
                :class="{ 'menu-item-active': acc.userId === neteaseUser.userId }"
                @click="handleSwitchAccount(acc.userId)"
              >
                <n-avatar
                  :src="acc.avatarUrl || undefined"
                  round
                  :size="28"
                  class="menu-item-icon"
                >
                  <n-icon v-if="!acc.avatarUrl" size="16"><i class="mgc_user_fill"></i></n-icon>
                </n-avatar>
                <span class="menu-item-label">
                  <span class="menu-item-text">{{ acc.nickname }}</span>
                  <span v-if="acc.vipType && acc.vipType > 0" class="menu-item-badge vip">VIP</span>
                  <span v-if="acc.level" class="menu-item-badge">Lv.{{ acc.level }}</span>
                </span>
                <n-icon v-if="acc.userId === neteaseUser.userId" size="16" class="menu-item-check">
                  <i class="mgc_check_line"></i>
                </n-icon>
              </button>
            </div>
          </template>

          <!-- 操作选项：下拉菜单项样式 -->
          <n-divider style="margin: 8px 0" />
          <div class="user-panel-menu">
            <button type="button" class="menu-item menu-item-danger" @click="handleLogout()">
              <n-icon size="16" class="menu-item-icon"><i class="mgc_exit_line"></i></n-icon>
              <span class="menu-item-label menu-item-text">退出登录</span>
            </button>
          </div>
        </div>

        <div v-else class="user-panel-login">
          <n-text depth="3" class="user-panel-qr-status">
            {{ qrStatusText || '正在准备二维码...' }}
          </n-text>
          <n-image v-if="qrImg" :src="qrImg" width="200" style="border-radius: 8px;" />
          <div v-else-if="qrLoading" class="user-panel-qr-loading">
            <n-spin size="medium" />
          </div>
          <n-divider style="margin: 6px 0 0" />
          <!-- 操作选项：下拉菜单项样式 -->
          <div class="user-panel-menu">
            <button
              type="button"
              class="menu-item"
              :disabled="qrLoading"
              @click="handleRefreshQr"
            >
              <n-icon size="16" class="menu-item-icon"><i class="mgc_refresh_4_line"></i></n-icon>
              <span class="menu-item-label menu-item-text">刷新二维码</span>
            </button>
          </div>
        </div>
      </n-popover>

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
  height: 72px;
  padding: 0px 24px 12px 20px;
  -webkit-app-region: drag;
  /* Draggable */
  position: relative;
  z-index: 100;
}

.header-gradient-bg {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  z-index: -1;
}

/* 沉浸式模式下，子元素应用毛玻璃样式 */
.app-header.is-transparent {
  background: transparent !important;
}
.app-header.is-transparent .left-controls .nav-btn,
.app-header.is-transparent .search-bar,
.app-header.is-transparent .right-controls .action-btn,
.app-header.is-transparent .window-controls .nav-btn {
  background-color: rgba(255, 255, 255, 0.4) !important;
  backdrop-filter: blur(12px) !important;
  -webkit-backdrop-filter: blur(12px) !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1) !important;
  transition: all 0.3s ease;
  border: 1px solid rgba(255, 255, 255, 0.2) !important;
}

/* 深色模式下的沉浸式样式 */
html[data-theme='dark'] .app-header.is-transparent .left-controls .nav-btn,
html[data-theme='dark'] .app-header.is-transparent .search-bar,
html[data-theme='dark'] .app-header.is-transparent .right-controls .action-btn,
html[data-theme='dark'] .app-header.is-transparent .window-controls .nav-btn {
  background-color: rgba(0, 0, 0, 0.3) !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3) !important;
  border: 1px solid rgba(255, 255, 255, 0.05) !important;
}

/* 普通模式下，搜索框 */
.app-header:not(.is-transparent) .search-bar {
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
.app-header.is-transparent .search-bar :deep(.n-input),
.app-header.is-transparent .search-bar :deep(.n-input .n-input-wrapper),
.app-header.is-transparent .search-bar :deep(.n-input__border),
.app-header.is-transparent .search-bar :deep(.n-input__state-border),
.app-header.is-transparent .search-bar :deep(.n-input--state-focused),
.app-header.is-transparent .search-bar :deep(.n-input:hover),
.app-header.is-transparent .search-bar :deep(.n-input:focus) {
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
.app-header:not(.is-transparent) .search-bar :deep(.n-input),
.app-header:not(.is-transparent) .search-bar :deep(.n-input .n-input-wrapper) {
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
html[data-theme='dark'] .app-header:not(.is-transparent) .search-bar {
  background-color: v-bind('themeVars.inputColor') !important; /* 加深一点，确保可见 */
  backdrop-filter: blur(10px);
  box-shadow: none;
  border: 1px solid transparent;
}

/* html[data-theme='dark'] .app-header:not(.is-transparent) .search-bar { */
/* background-color: rgba(0, 0, 0, 0.3) !important; */
/* box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); */
/* border: 1px solid rgba(255, 255, 255, 0.05); */
/* } */

html[data-theme='dark'] .app-header:not(.is-transparent) .search-bar :deep(.n-input),
html[data-theme='dark'] .app-header:not(.is-transparent) .search-bar :deep(.n-input .n-input-wrapper) {
  /* 同样不需要做太多，只要文字颜色对就行 */
}

.app-header:not(.is-transparent) .search-bar :deep(.n-input__border),
.app-header:not(.is-transparent) .search-bar :deep(.n-input__state-border) {
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

/* ===== 网易云账号登录 ===== */

.user-avatar-img {
  width: 36px;
  height: 36px;
  border-radius: 50%;

  object-fit: cover;
  flex-shrink: 0;
}

.user-panel-logged {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 0;
}

/* 当前账号信息：竖向布局 */
.user-panel-profile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 4px 0 8px;
  text-align: center;
}

.user-panel-avatar {
  flex-shrink: 0;
  margin-bottom: 4px;
}

.user-panel-name {
  max-width: 100%;
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-panel-tags {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.user-panel-vip {
  font-size: 11px;
  font-weight: 500;
  color: #c9962e;
}

.user-panel-id {
  font-size: 12px;
  line-height: 1.4;
}

.user-panel-section-title {
  font-size: 12px;
  color: var(--n-text-color-3);
  padding: 0 10px 4px;
}

.user-panel-login {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

/* 下拉菜单项样式 */
.user-panel-menu {
  display: flex;
  flex-direction: column;
  padding: 4px;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--n-text-color);
  font-size: 13px;
  font-family: inherit;
  text-align: left;
  line-height: 1.3;
  cursor: pointer;
  transition: background-color 0.18s ease, color 0.18s ease;
}

.menu-item:hover {
  background-color: rgba(128, 128, 128, 0.14);
}

html[data-theme='dark'] .menu-item:hover {
  background-color: rgba(255, 255, 255, 0.09);
}

.menu-item-active {
  background-color: rgba(128, 128, 128, 0.16);
}

html[data-theme='dark'] .menu-item-active {
  background-color: rgba(255, 255, 255, 0.12);
}

.menu-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.menu-item-danger {
  color: #d03050;
}

html[data-theme='dark'] .menu-item-danger:hover {
  background-color: rgba(208, 48, 80, 0.14);
}

.menu-item-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: inherit;
}

.menu-item-label {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
}

.menu-item-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-item-check {
  flex-shrink: 0;
  color: var(--n-primary-color);
}

.menu-item-badge {
  flex-shrink: 0;
  font-size: 9px;
  line-height: 1.4;
  padding: 0 4px;
  border-radius: 4px;
  border: 1px solid var(--n-border-color);
  color: var(--n-text-color);
}

.menu-item-badge.vip {
  border: none;
  background: linear-gradient(135deg, #f6c945, #d9911f);
  color: #fff;
}

.user-panel-qr-status {
  font-size: 13px;
  color: var(--n-text-color-3);
  text-align: center;
  min-height: 18px;
}

.user-panel-qr-loading {
  width: 200px;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
