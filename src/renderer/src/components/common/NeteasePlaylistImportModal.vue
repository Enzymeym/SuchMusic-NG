<template>
  <n-modal
    :show="show"
    style="border-radius: 12px; overflow: hidden"
    :mask-closable="!importing"
    @update:show="handleUpdateShow"
  >
    <n-card
      class="netease-import-card"
      :bordered="false"
      role="dialog"
      aria-modal="true"
      :style="{
        backgroundColor: themeVars.modalColor,
        maxWidth: 'calc(100vw - 96px)',
        width: 'min(560px, calc(100vw - 96px))'
      }"
      content-style="padding: 0; display: flex; flex-direction: column; min-height: 0;"
    >
      <!-- 关闭按钮：悬浮在右上角，与设置弹窗一致 -->
      <div class="modal-topbar">
        <div class="close-btn" @click="handleUpdateShow(false)">
          <n-icon size="18"><i class="mgc_close_line"></i></n-icon>
        </div>
      </div>

      <!-- 顶部标题区域 -->
      <div class="import-header">
        <div class="title">导入网易云歌单</div>
        <div class="subtitle">从网易云歌单导入曲目到本地</div>
      </div>

      <!-- 内容区域 -->
      <div class="import-body">
        <n-tabs v-model:value="activeTab" type="segment" animated @update:value="handleTabChange">
          <!-- 粘贴链接 / ID -->
          <n-tab-pane name="link" tab="粘贴链接/ID">
            <div class="link-pane">
              <n-input
                v-model:value="linkInput"
                placeholder="粘贴歌单链接或歌单 ID，例如 3778678"
                clearable
                :disabled="importing"
                @keyup.enter="handleImportByLink"
              />
              <n-button
                type="primary"
                :loading="importing"
                :disabled="!linkInput.trim()"
                @click="handleImportByLink"
              >
                导入
              </n-button>
            </div>
            <p class="hint">支持歌单分享链接（music.163.com）或纯数字歌单 ID，公开歌单无需登录。</p>
          </n-tab-pane>

          <!-- 我的歌单 -->
          <n-tab-pane name="mine" tab="我的歌单">
            <div class="mine-pane">
              <div v-if="checkingLogin || loadingList" class="state-block">
                <n-spin size="small" />
                <span>正在加载…</span>
              </div>

              <div v-else-if="!loggedIn" class="state-block">
                <p>请先在右上角账号处扫码登录网易云账号</p>
              </div>

              <div v-else-if="!playlists.length" class="state-block">
                <p>未获取到歌单</p>
              </div>

              <template v-else>
                <n-scrollbar class="playlist-scroll" content-style="padding-right: 8px;">
                  <div
                    v-for="pl in playlists"
                    :key="pl.id"
                    class="playlist-row"
                    :class="{ selected: selectedIds.includes(pl.id) }"
                    @click="toggleSelect(pl.id)"
                  >
                    <n-checkbox
                      :checked="selectedIds.includes(pl.id)"
                      @update:checked="() => toggleSelect(pl.id)"
                      @click.stop
                    />
                    <img class="row-cover" :src="pl.cover || defaultCover" />
                    <div class="row-info">
                      <div class="row-name">{{ pl.name }}</div>
                      <div class="row-count">{{ pl.trackCount }} 首</div>
                    </div>
                  </div>
                </n-scrollbar>
                <div class="mine-actions">
                  <span class="selected-count">已选 {{ selectedIds.length }} 个</span>
                  <n-button
                    type="primary"
                    :loading="importing"
                    :disabled="!selectedIds.length"
                    @click="handleImportSelected"
                  >
                    导入选中
                  </n-button>
                </div>
              </template>
            </div>
          </n-tab-pane>
        </n-tabs>
      </div>
    </n-card>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  NModal,
  NCard,
  NTabs,
  NTabPane,
  NInput,
  NButton,
  NCheckbox,
  NSpin,
  NScrollbar,
  NIcon,
  useMessage,
  useThemeVars
} from 'naive-ui'
import { usePlaylistStore, type UserPlaylist } from '../../stores/playlistStore'
import {
  parseNeteasePlaylistId,
  fetchNeteasePlaylist,
  type NeteasePlaylistSummary
} from '../../composables/useNeteasePlaylist'
import defaultCover from '@renderer/assets/default-cover.png'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'imported', playlist: UserPlaylist): void
}>()

const playlistStore = usePlaylistStore()
const message = useMessage()
const themeVars = useThemeVars()

const activeTab = ref<'link' | 'mine'>('link')
const linkInput = ref('')
const importing = ref(false)

// 我的歌单状态
const checkingLogin = ref(false)
const loadingList = ref(false)
const loggedIn = ref(false)
const playlists = ref<NeteasePlaylistSummary[]>([])
const selectedIds = ref<number[]>([])

const handleUpdateShow = (value: boolean): void => {
  emit('update:show', value)
}

const handleTabChange = (value: string): void => {
  if (value === 'mine' && !playlists.value.length && !loadingList.value) {
    void loadMyPlaylists()
  }
}

// 加载登录状态与用户歌单
const loadMyPlaylists = async (): Promise<void> => {
  checkingLogin.value = true
  try {
    const status = await window.api.netease.loginStatus()
    loggedIn.value = !!status.loggedIn
    if (!loggedIn.value) {
      playlists.value = []
      return
    }
    loadingList.value = true
    playlists.value = await window.api.netease.userPlaylists()
    selectedIds.value = []
  } catch (e) {
    console.error('[NeteaseImportModal] 加载我的歌单失败:', e)
    message.error('获取歌单列表失败，请稍后重试')
  } finally {
    checkingLogin.value = false
    loadingList.value = false
  }
}

const toggleSelect = (id: number): void => {
  const index = selectedIds.value.indexOf(id)
  if (index === -1) {
    selectedIds.value.push(id)
  } else {
    selectedIds.value.splice(index, 1)
  }
}

// 导入单个歌单，返回是否成功
const importOne = async (id: number): Promise<UserPlaylist | null> => {
  const payload = await fetchNeteasePlaylist(id)
  if (!payload) return null
  try {
    const playlist = playlistStore.importPlaylistFromNetease(payload)
    emit('imported', playlist)
    return playlist
  } catch (e) {
    // 例如名称与系统保留歌单「我喜爱的音乐」冲突
    console.warn('[NeteaseImportModal] 创建本地歌单失败:', e)
    return null
  }
}

const handleImportByLink = async (): Promise<void> => {
  if (importing.value) return
  const id = parseNeteasePlaylistId(linkInput.value)
  if (!id) {
    message.error('无法识别的歌单链接或 ID')
    return
  }
  importing.value = true
  const loadingMsg = message.loading('正在获取歌单曲目…', { duration: 0 })
  try {
    const created = await importOne(id)
    loadingMsg.destroy()
    if (!created) {
      message.error('歌单不存在或获取失败')
      return
    }
    message.success(`已导入「${created.name}」，共 ${created.tracks.length} 首`)
    linkInput.value = ''
    emit('update:show', false)
  } catch (e) {
    loadingMsg.destroy()
    console.error('[NeteaseImportModal] 导入歌单失败:', e)
    message.error('导入失败，请稍后重试')
  } finally {
    importing.value = false
  }
}

const handleImportSelected = async (): Promise<void> => {
  if (importing.value || !selectedIds.value.length) return
  importing.value = true
  const loadingMsg = message.loading('正在导入歌单…', { duration: 0 })
  let success = 0
  let failed = 0
  try {
    for (const id of [...selectedIds.value]) {
      const created = await importOne(id)
      if (created) {
        success++
      } else {
        failed++
      }
    }
    loadingMsg.destroy()
    if (success > 0) {
      message.success(`成功导入 ${success} 个歌单${failed ? `，${failed} 个失败` : ''}`)
      selectedIds.value = []
      emit('update:show', false)
    } else {
      message.error('导入失败，请稍后重试')
    }
  } catch (e) {
    loadingMsg.destroy()
    console.error('[NeteaseImportModal] 批量导入失败:', e)
    message.error('导入失败，请稍后重试')
  } finally {
    importing.value = false
  }
}

// 打开弹窗时重置为默认状态
watch(
  () => props.show,
  (value) => {
    if (value) {
      activeTab.value = 'link'
      linkInput.value = ''
    }
  }
)
</script>

<style scoped>
/* 顶部标题区域（与设置弹窗标题风格保持一致） */
.import-header {
  padding: 24px 24px 12px;
}

.title {
  font-size: 18px;
  font-weight: 600;
}

.subtitle {
  font-size: 12px;
  color: #999;
  margin-top: 4px;
}

/* 内容区域 */
.import-body {
  padding: 0 24px 24px;
}

.link-pane {
  display: flex;
  gap: 10px;
  align-items: center;
}

.hint {
  margin: 12px 0 0;
  font-size: 12px;
  color: #999;
}

.mine-pane {
  min-height: 220px;
  display: flex;
  flex-direction: column;
}

.state-block {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #999;
  font-size: 14px;
  padding: 40px 0;
}

.playlist-scroll {
  max-height: min(320px, 40vh);
}

.playlist-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.2s ease;
}

.playlist-row:hover {
  background-color: rgba(128, 128, 128, 0.1);
}

.playlist-row.selected {
  background-color: rgba(61, 136, 155, 0.14);
}

.row-cover {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  object-fit: cover;
  flex: 0 0 auto;
}

.row-info {
  min-width: 0;
  flex: 1;
}

.row-name {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-count {
  font-size: 12px;
  color: #999;
  margin-top: 2px;
}

.mine-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
}

.selected-count {
  font-size: 13px;
  color: #999;
}

html[data-theme='dark'] .hint,
html[data-theme='dark'] .state-block,
html[data-theme='dark'] .row-count,
html[data-theme='dark'] .selected-count {
  color: #aaa;
}

html[data-theme='dark'] .playlist-row:hover {
  background-color: rgba(255, 255, 255, 0.08);
}
</style>
