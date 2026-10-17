<template>
  <n-modal
    :show="show"
    style="border-radius: 12px; overflow: hidden"
    :mask-closable="!importing"
    @update:show="handleUpdateShow"
  >
    <n-card
      class="source-import-card"
      :bordered="false"
      role="dialog"
      aria-modal="true"
      :style="{
        backgroundColor: themeVars.modalColor,
        maxWidth: 'calc(100vw - 96px)',
        width: 'min(600px, calc(100vw - 96px))'
      }"
      content-style="padding: 0; display: flex; flex-direction: column; min-height: 0;"
    >
      <!-- 关闭按钮 -->
      <div class="modal-topbar">
        <div class="close-btn" @click="handleUpdateShow(false)">
          <n-icon size="18"><i class="mgc_close_line"></i></n-icon>
        </div>
      </div>

      <div class="import-header">
        <div class="title">从音源插件导入歌单</div>
        <div class="subtitle">浏览澜音（Ceru）插件提供的歌单，导入后可在本地歌单中播放</div>
      </div>

      <div class="import-body">
        <!-- 无可用插件 -->
        <div v-if="!playlistPlugins.length" class="state-block">
          <p>未加载支持歌单的音源插件</p>
          <p class="hint">请在「设置 → 音源插件」中加载支持歌单能力的澜音 v2 插件</p>
        </div>

        <template v-else>
          <!-- 插件选择 -->
          <div class="plugin-row">
            <span class="label">音源插件</span>
            <n-select
              v-model:value="activePluginId"
              :options="pluginOptions"
              size="small"
              style="width: 220px"
              @update:value="handlePluginChange"
            />
          </div>

          <!-- 搜索 -->
          <div class="search-row">
            <n-input
              v-model:value="keyword"
              placeholder="搜索歌单名称"
              clearable
              :disabled="importing"
              @keyup.enter="handleSearch"
            />
            <n-button type="primary" :loading="searching" @click="handleSearch">搜索</n-button>
          </div>

          <!-- 歌单列表 -->
          <div class="list-area">
            <div v-if="loadingList || searching" class="state-block">
              <n-spin size="small" />
              <span>正在加载…</span>
            </div>

            <div v-else-if="loadError" class="state-block">
              <p>{{ loadError }}</p>
            </div>

            <div v-else-if="!playlists.length" class="state-block">
              <p>{{ keyword ? '未找到匹配的歌单' : '该插件未返回可浏览的歌单' }}</p>
            </div>

            <template v-else>
              <n-scrollbar class="playlist-scroll" content-style="padding-right: 8px;">
                <div
                  v-for="pl in playlists"
                  :key="pl.key"
                  class="playlist-row"
                  :class="{ selected: selectedKey === pl.key }"
                  @click="selectPlaylist(pl)"
                >
                  <img class="row-cover" :src="pl.cover || defaultCover" @error="onCoverError" />
                  <div class="row-info">
                    <div class="row-name">{{ pl.name }}</div>
                    <div class="row-sub">{{ pl.subtitle || '歌单' }}</div>
                  </div>
                  <n-icon v-if="selectedKey === pl.key" size="18" class="row-check">
                    <i class="mgc_check_line"></i>
                  </n-icon>
                </div>
              </n-scrollbar>
            </template>
          </div>

          <div class="import-actions">
            <span class="selected-count">
              {{ selectedKey ? '已选择 1 个歌单' : '请选择要导入的歌单' }}
            </span>
            <n-button
              type="primary"
              :loading="importing"
              :disabled="!selectedKey"
              @click="handleImport"
            >
              导入到本地歌单
            </n-button>
          </div>
        </template>
      </div>
    </n-card>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NModal,
  NCard,
  NInput,
  NButton,
  NSelect,
  NSpin,
  NScrollbar,
  NIcon,
  useMessage,
  useThemeVars
} from 'naive-ui'
import { usePlaylistStore, type UserPlaylist, type PlaylistTrack } from '../../stores/playlistStore'
import { useSourcePluginStore } from '../../stores/sourcePluginStore'
import { sourceTrackToPlaylistTrack, toCloneable } from '../../utils/pluginSource'
import defaultCover from '@renderer/assets/default-cover.png'

/** 弹窗中展示的歌单条目 */
interface SourcePlaylistItem {
  key: string
  name: string
  subtitle?: string
  cover?: string
  /** 不透明引用，导入时回传主进程 */
  ref?: unknown
  trackCount?: number
}

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'imported', playlist: UserPlaylist): void
}>()

const playlistStore = usePlaylistStore()
const sourceStore = useSourcePluginStore()
const message = useMessage()
const themeVars = useThemeVars()

const activePluginId = ref<string>('')
const keyword = ref('')
const loadingList = ref(false)
const searching = ref(false)
const importing = ref(false)
const loadError = ref('')
const playlists = ref<SourcePlaylistItem[]>([])
const selectedKey = ref('')

/** 具备歌单能力的已启用插件 */
const playlistPlugins = computed(() =>
  sourceStore.plugins.filter(
    (p) => p.enabled && p.state === 'running' && p.capabilities?.canBrowsePlaylist
  )
)

const pluginOptions = computed(() =>
  playlistPlugins.value.map((p) => ({ label: `${p.name} (${p.version})`, value: p.id }))
)

const handleUpdateShow = (value: boolean): void => {
  emit('update:show', value)
}

const onCoverError = (e: Event): void => {
  const img = e.target as HTMLImageElement
  if (img && img.src !== defaultCover) img.src = defaultCover
}

/** 主进程返回的 SourceTrack → 弹窗条目 */
const mapItem = (item: any): SourcePlaylistItem => ({
  key: String(item.id ?? Math.random().toString(36).slice(2)),
  name: item.title || '未命名歌单',
  subtitle: item.artist || undefined,
  cover: item.coverUrl || undefined,
  ref: item.ref,
  trackCount: item.durationMs
})

/** 拉取歌单列表（无关键词时尝试类目，有则搜索） */
const loadPlaylists = async (): Promise<void> => {
  const pluginId = activePluginId.value
  if (!pluginId) return
  loadError.value = ''
  playlists.value = []
  selectedKey.value = ''

  const kw = keyword.value.trim()
  if (kw) {
    searching.value = true
    try {
      const res = await window.api.sources.playlistSearch({ pluginId, query: kw })
      if (!res?.success) throw new Error(res?.error || '搜索失败')
      playlists.value = (res.items || []).map(mapItem)
    } catch (e: any) {
      console.error('[SourcePlaylistImport] 歌单搜索失败:', e)
      loadError.value = e?.message || '搜索歌单失败'
    } finally {
      searching.value = false
    }
    return
  }

  loadingList.value = true
  try {
    // 先尝试「类目」列表；插件未实现类目时回退为「列表」
    const catRes = await window.api.sources.playlistCategories(pluginId)
    if (catRes?.success && catRes.items?.length) {
      playlists.value = catRes.items.map(mapItem)
      return
    }
    const listRes = await window.api.sources.playlistList({ pluginId })
    if (!listRes?.success) throw new Error(listRes?.error || '获取歌单失败')
    playlists.value = (listRes.items || []).map(mapItem)
  } catch (e: any) {
    console.error('[SourcePlaylistImport] 获取歌单列表失败:', e)
    loadError.value = e?.message || '获取歌单列表失败'
  } finally {
    loadingList.value = false
  }
}

const handleSearch = (): void => {
  void loadPlaylists()
}

const handlePluginChange = (): void => {
  keyword.value = ''
  void loadPlaylists()
}

const selectPlaylist = (pl: SourcePlaylistItem): void => {
  selectedKey.value = selectedKey.value === pl.key ? '' : pl.key
}

/** 拉取选中歌单的曲目并写入本地歌单 */
const handleImport = async (): Promise<void> => {
  const pluginId = activePluginId.value
  const item = playlists.value.find((p) => p.key === selectedKey.value)
  if (!pluginId || !item) return

  importing.value = true
  const loadingMsg = message.loading('正在获取歌单曲目…', { duration: 0 })
  try {
    const tracks: PlaylistTrack[] = []
    let cursor: string | undefined
    let meta: { name?: string; coverUrl?: string; description?: string } | undefined
    for (let page = 0; page < 20; page++) {
      const res = await window.api.sources.playlistGet({
        pluginId,
        ref: toCloneable(item.ref),
        cursor
      })
      if (!res?.success) throw new Error(res?.error || '获取歌单曲目失败')
      if (res.meta && !meta) meta = res.meta
      for (const t of res.items || []) {
        tracks.push(sourceTrackToPlaylistTrack(t, pluginId))
      }
      if (!res.nextCursor) break
      cursor = res.nextCursor
    }

    loadingMsg.destroy()
    if (!tracks.length) {
      message.warning('该歌单没有可用曲目')
      return
    }

    const created = playlistStore.importPlaylistFromSource({
      name: meta?.name || item.name,
      cover: meta?.coverUrl || item.cover,
      description: meta?.description || '由音源插件导入',
      sourcePluginId: pluginId,
      sourceProviderId: sourceStore.plugins.find((p) => p.id === pluginId)?.capabilities
        ?.providers?.[0]?.id,
      sourcePlaylistRef: item.ref,
      tracks
    })

    emit('imported', created)
    message.success(`已导入「${created.name}」，共 ${created.tracks.length} 首`)
    emit('update:show', false)
  } catch (e: any) {
    loadingMsg.destroy()
    console.error('[SourcePlaylistImport] 导入歌单失败:', e)
    message.error(e?.message || '导入失败，请稍后重试')
  } finally {
    importing.value = false
  }
}

// 打开时刷新插件列表并默认选中第一个支持歌单的插件
watch(
  () => props.show,
  async (value) => {
    if (!value) return
    keyword.value = ''
    selectedKey.value = ''
    loadError.value = ''
    playlists.value = []
    await sourceStore.refresh()
    const first = playlistPlugins.value[0]
    activePluginId.value = first?.id ?? ''
    if (activePluginId.value) void loadPlaylists()
  }
)
</script>

<style scoped>
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

.import-body {
  padding: 0 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.plugin-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.plugin-row .label {
  font-size: 13px;
  color: #888;
}

.search-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.list-area {
  min-height: 240px;
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
  flex-direction: column;
  text-align: center;
}

.state-block .hint {
  font-size: 12px;
  color: #aaa;
  margin: 0;
}

.playlist-scroll {
  max-height: min(360px, 44vh);
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
  background-color: rgba(140, 61, 155, 0.14);
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

.row-sub {
  font-size: 12px;
  color: #999;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-check {
  color: var(--n-primary-color, #8c3d9b);
}

.import-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.selected-count {
  font-size: 13px;
  color: #999;
}

html[data-theme='dark'] .subtitle,
html[data-theme='dark'] .hint,
html[data-theme='dark'] .state-block,
html[data-theme='dark'] .row-sub,
html[data-theme='dark'] .selected-count,
html[data-theme='dark'] .plugin-row .label {
  color: #aaa;
}

html[data-theme='dark'] .playlist-row:hover {
  background-color: rgba(255, 255, 255, 0.08);
}
</style>
