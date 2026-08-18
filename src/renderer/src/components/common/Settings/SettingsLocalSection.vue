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

// 下载目录设置
const downloadDir = computed({
  get: () => settingsStore.local.downloadDir || '',
  set: (val: string) => {
    settingsStore.local.downloadDir = val
  }
})

const chooseDownloadDir = async () => {
  if (!window.electron || !window.electron.ipcRenderer) return
  try {
    const dir = await window.electron.ipcRenderer.invoke('system:choose-dir')
    if (dir) {
      downloadDir.value = dir
    }
  } catch (error) {
    console.error('选择下载目录失败', error)
    message.error('选择下载目录失败')
  }
}

const resetDownloadDir = () => {
  downloadDir.value = ''
}

// ====== 在线音频缓存设置 ======
const cacheInfo = ref<{
  dir: string
  isDefault: boolean
  fileCount: number
  totalSize: number
  maxSize: number
} | null>(null)

const cacheLoading = ref(false)

/** 格式化字节为可读大小 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let val = bytes
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i += 1
  }
  return `${val.toFixed(val >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** 刷新缓存目录与统计信息 */
async function refreshCacheInfo() {
  if (!window.electron || !window.electron.ipcRenderer) return
  cacheLoading.value = true
  try {
    cacheInfo.value = await window.api.cache.getInfo()
  } catch (error) {
    console.error('获取缓存信息失败', error)
  } finally {
    cacheLoading.value = false
  }
}

/** 更改缓存目录 */
async function chooseCacheDir() {
  if (!window.electron || !window.electron.ipcRenderer) return
  try {
    const dir = (await window.electron.ipcRenderer.invoke('system:choose-dir')) as string
    if (!dir) return
    const result = await window.api.cache.setDir(dir)
    if (result && result.success) {
      message.success('缓存目录已更改')
      await refreshCacheInfo()
    }
  } catch (error) {
    console.error('更改缓存目录失败', error)
    message.error('更改缓存目录失败')
  }
}

/** 恢复默认缓存目录 */
async function resetCacheDir() {
  if (!window.electron || !window.electron.ipcRenderer) return
  try {
    const result = await window.api.cache.setDir('')
    if (result && result.success) {
      message.success('已恢复默认缓存目录')
      await refreshCacheInfo()
    }
  } catch (error) {
    console.error('恢复默认缓存目录失败', error)
    message.error('恢复默认缓存目录失败')
  }
}

/** 清空缓存 */
async function clearCache() {
  if (!window.electron || !window.electron.ipcRenderer) return
  try {
    const result = await window.api.cache.clear()
    if (result && result.success) {
      message.success(
        `已清空 ${result.removedCount} 个缓存文件，释放 ${formatBytes(result.removedSize)}`
      )
      await refreshCacheInfo()
    }
  } catch (error) {
    console.error('清空缓存失败', error)
    message.error('清空缓存失败')
  }
}

onMounted(async () => {
  refreshCacheInfo()
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

    <div class="section-group-title" style="margin-top: 24px">下载</div>
    <n-card
      class="setting-item cache-card"
      data-setting-key="local.downloadDir"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="cache-row">
        <div class="cache-info-main">
          <div class="cache-title">歌曲保存位置</div>
          <div class="cache-desc">
            下载的歌曲将会保存在此目录下。如果不指定，则使用系统的音乐目录。
          </div>
          <div class="cache-meta">
            <div class="cache-path">
              <span class="label">保存目录：</span>
              <span class="value">{{ downloadDir || '系统音乐目录' }}</span>
              <n-tag v-if="!settingsStore.local.downloadDir" size="small" type="default" round>
                默认
              </n-tag>
            </div>
          </div>
        </div>
        <div class="cache-actions">
          <n-button size="small" @click="chooseDownloadDir">
            <template #icon>
              <n-icon size="16">
                <i class="mgc_folder_open_line" />
              </n-icon>
            </template>
            更改目录
          </n-button>
          <n-button size="small" tertiary @click="resetDownloadDir" v-if="downloadDir">
            恢复默认
          </n-button>
        </div>
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
          <div class="cache-title">在线音乐缓存</div>
          <div class="cache-desc">
            在线播放的歌曲会缓存到本地，二次播放时秒开、避免重复下载。可自定义缓存位置或清空缓存。
          </div>
          <div class="cache-meta">
            <div class="cache-path">
              <span class="label">缓存目录：</span>
              <span class="value">{{ cacheInfo?.dir || '加载中...' }}</span>
              <n-tag v-if="cacheInfo?.isDefault" size="small" type="default" round>
                默认
              </n-tag>
            </div>
            <div class="cache-stats" v-if="cacheInfo">
              <span>{{ cacheInfo.fileCount }} 首歌曲</span>
              <span class="dot">·</span>
              <span>{{ formatBytes(cacheInfo.totalSize) }}</span>
              <span class="dot">·</span>
              <span>上限 {{ formatBytes(cacheInfo.maxSize) }}</span>
            </div>
          </div>
        </div>
        <div class="cache-actions">
          <n-button size="small" :loading="cacheLoading" @click="chooseCacheDir">
            <template #icon>
              <n-icon size="16">
                <i class="mgc_folder_open_line" />
              </n-icon>
            </template>
            更改目录
          </n-button>
          <n-button
            size="small"
            tertiary
            @click="resetCacheDir"
            v-if="cacheInfo && !cacheInfo.isDefault"
          >
            恢复默认
          </n-button>
          <n-button size="small" tertiary type="error" @click="clearCache">
            <template #icon>
              <n-icon size="16">
                <i class="mgc_delete_2_line" />
              </n-icon>
            </template>
            清空缓存
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
  flex-direction: row;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.dir-reset-btn {}
</style>
