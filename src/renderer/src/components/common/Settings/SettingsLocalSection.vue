<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NCard, NButton, NIcon, NTag, useMessage } from 'naive-ui'
import { useSettingsStore } from '../../../stores/settingsStore'

const props = defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  highlightKey?: string | null
}>()

const settingsStore = useSettingsStore()
const message = useMessage()

const scanDirs = computed({
  get: () => settingsStore.local.scanDirs,
  set: (val: string[]) => {
    settingsStore.local.scanDirs = val
  }
})

const addDirs = async () => {
  if (!window.electron || !window.electron.ipcRenderer) return
  const result = (await window.electron.ipcRenderer.invoke('local-music:choose-scan-dirs')) as {
    canceled: boolean
    dirs: string[]
  }
  if (result.canceled || !Array.isArray(result.dirs) || !result.dirs.length) return
  const merged = new Set<string>(scanDirs.value)
  for (const dir of result.dirs) {
    if (dir) {
      merged.add(dir)
    }
  }
  scanDirs.value = Array.from(merged)
}

const removeDir = (dir: string) => {
  scanDirs.value = scanDirs.value.filter((d) => d !== dir)
}

const resetToDefault = async () => {
  if (!window.electron || !window.electron.ipcRenderer) return
  try {
    const musicDir = (await window.electron.ipcRenderer.invoke('system:get-music-dir')) as string
    if (musicDir) {
      scanDirs.value = [musicDir]
    }
  } catch (error) {
    console.error('获取系统音乐目录失败', error)
  }
}

// 在线缓存设置
const cacheDir = computed({
  get: () => settingsStore.local.cacheDir || '',
  set: (val: string) => {
    settingsStore.local.cacheDir = val
  }
})

const cacheInfo = ref<{
  dir: string
  sizeBytes: number
  fileCount: number
} | null>(null)

const formatSize = (bytes: number): string => {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

const refreshCacheInfo = async () => {
  if (!window.electron || !window.electron.ipcRenderer) return
  try {
    const info = (await window.electron.ipcRenderer.invoke(
      'online-cache:get-info',
      cacheDir.value || null
    )) as { dir: string; sizeBytes: number; fileCount: number }
    cacheInfo.value = info
    if (!cacheDir.value) {
      cacheDir.value = info.dir
    }
  } catch (error) {
    console.error('获取缓存信息失败', error)
    message.error('获取缓存信息失败')
  }
}

const chooseCacheDir = async () => {
  if (!window.electron || !window.electron.ipcRenderer) return
  try {
    const result = (await window.electron.ipcRenderer.invoke(
      'online-cache:choose-dir'
    )) as { canceled: boolean; dir: string | null }
    if (!result.canceled && result.dir) {
      cacheDir.value = result.dir
      await refreshCacheInfo()
    }
  } catch (error) {
    console.error('选择缓存目录失败', error)
    message.error('选择缓存目录失败')
  }
}

const clearCache = async () => {
  if (!window.electron || !window.electron.ipcRenderer) return
  try {
    await window.electron.ipcRenderer.invoke('online-cache:clear', cacheDir.value || null)
    await refreshCacheInfo()
    message.success('缓存已清空')
  } catch (error) {
    console.error('清除缓存失败', error)
    message.error('清除缓存失败')
  }
}

onMounted(async () => {
  if (scanDirs.value.length === 0 && window.electron && window.electron.ipcRenderer) {
    try {
      const musicDir = (await window.electron.ipcRenderer.invoke('system:get-music-dir')) as string
      if (musicDir) {
        scanDirs.value = [musicDir]
      }
    } catch (error) {
      console.error('自动初始化系统音乐目录失败', error)
    }
  }
  await refreshCacheInfo()
})
</script>

<template>
  <div class="settings-content">
    <div class="section-group-title">本地音乐</div>

    <n-card
      class="setting-item dir-manager-card"
      :class="{ 'setting-item--highlight': props.highlightKey === 'local.scanDirs' }"
      data-setting-key="local.scanDirs"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="dir-manager-header">
        <div class="dir-manager-title">目录管理</div>
        <div class="dir-manager-desc">
          请选择本地音乐文件夹，将自动扫描您添加的目录，歌曲增删实时同步。
        </div>
      </div>

      <div v-if="!scanDirs.length" class="dir-empty">
        当前未配置扫描目录，将默认使用系统音乐目录。
      </div>

      <div v-else class="dir-list">
        <div v-for="dir in scanDirs" :key="dir" class="dir-item">
          <div class="dir-main">
            <n-icon size="18" class="dir-icon">
              <i class="mgc_folder_2_line" />
            </n-icon>
            <span class="dir-path">
              {{ dir }}
            </span>
          </div>
          <n-button
            quaternary
            size="small"
            type="error"
            class="dir-remove-btn"
            @click="removeDir(dir)"
          >
            <template #icon>
              <n-icon size="18">
                <i class="mgc_delete_2_line" />
              </n-icon>
            </template>
          </n-button>
        </div>
      </div>

      <div class="dir-footer">
        <n-button tertiary @click="addDirs">
          <template #icon>
            <n-icon size="18">
              <i class="mgc_folder_upload_line" />
            </n-icon>
          </template>
          添加文件夹
        </n-button>
        <n-button v-if="scanDirs.length" secondary class="dir-reset-btn" @click="resetToDefault">
          重置为系统音乐目录
        </n-button>
      </div>
    </n-card>

    <div class="section-group-title" style="margin-top: 24px">缓存</div>
    <n-card
      class="setting-item cache-card"
      data-setting-key="local.cacheDir"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="cache-row">
        <div class="cache-info-main">
          <div class="cache-title">在线播放缓存</div>
          <div class="cache-desc">
            当前播放的在线歌曲会自动缓存到本地，下次播放优先使用本地缓存以减少网络请求。
          </div>
          <div v-if="cacheInfo" class="cache-meta">
            <div class="cache-path">
              <span class="label">缓存目录：</span>
              <span class="value">{{ cacheInfo.dir }}</span>
              <n-tag v-if="!settingsStore.local.cacheDir" size="small" type="default" round>
                默认
              </n-tag>
            </div>
            <div class="cache-stats">
              <span>缓存大小：{{ formatSize(cacheInfo.sizeBytes) }}</span>
              <span class="dot">·</span>
              <span>文件数量：{{ cacheInfo.fileCount }}</span>
            </div>
          </div>
        </div>
        <div class="cache-actions">
          <n-button size="small" @click="chooseCacheDir">选择缓存目录</n-button>
          <n-button size="small" tertiary type="error" @click="clearCache">
            清除所有缓存
          </n-button>
        </div>
      </div>
    </n-card>
  </div>
</template>

<style scoped>
/* 目录管理整体布局，贴近示例弹窗样式 */
.dir-manager-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dir-manager-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dir-manager-title {
  font-size: 14px;
  font-weight: 600;
}

.dir-manager-desc {
  font-size: 12px;
  opacity: 0.85;
}

.dir-empty {
  margin-top: 10px;
  font-size: 12px;
  opacity: 0.8;
}

.dir-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dir-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

html[data-theme='light'] .dir-item {
  border-color: rgba(0, 0, 0, 0.06);
}

.dir-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.dir-icon {
  flex-shrink: 0;
}

.dir-path {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dir-remove-btn {
  flex-shrink: 0;
}

.dir-footer {
  margin-top: 14px;
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 12px;
}

.cache-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}

.cache-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.cache-info-main {
  flex: 1;
}

.cache-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.cache-desc {
  font-size: 12px;
  opacity: 0.85;
}

.cache-meta {
  margin-top: 8px;
  font-size: 12px;
}

.cache-path {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.cache-path .label {
  opacity: 0.8;
}

.cache-path .value {
  word-break: break-all;
}

.cache-stats {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0.85;
}

.cache-stats .dot {
  opacity: 0.6;
}

.cache-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

.dir-reset-btn {}
</style>
