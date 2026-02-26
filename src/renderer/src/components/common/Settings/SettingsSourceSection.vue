<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { NButton, NDivider, NTag, NSpin, NModal, NCode, NDropdown, NInput, NCard, NSelect } from 'naive-ui'
import { useSettingsStore } from '../../../stores/settingsStore'
import {
  runSnowdropTransformFromFile,
  runSnowdropLoadAllPlugins,
  runSnowdropRemovePlugin,
  runSnowdropTransformFromUrl,
  runSnowdropSetActivePlugin,
  type SnowdropTransformTestResult
} from '@renderer/apis/snowdrop-transform'

// 设置项卡片样式由父组件传入，保持与其他设置页一致
const props = defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  highlightKey?: string | null
}>()

// 当前是否在解析或加载音源插件
const loading = ref(false)
// 已加载的音源插件列表
const plugins = ref<SnowdropTransformTestResult[]>([])
// 当前被选中的插件文件路径（一次只能选一个）
const activeFilePath = ref<string | null>(null)
// 导入方式下拉选项
const importOptions = [
  { key: 'file', label: '从本地文件导入' },
  { key: 'url', label: '从在线 URL 导入' }
]
// URL 导入对话框状态
const showImportUrlModal = ref(false)
const importUrl = ref('')
// 最近一次操作的错误信息
const errorMessage = ref<string | null>(null)
// 日志对话框显示状态
const showLogsModal = ref(false)
// 当前查看日志的插件结果
const currentLogResult = ref<SnowdropTransformTestResult | null>(null)

const settingsStore = useSettingsStore()

const qualityLabelMap: Record<string, string> = {
  '128k': '标准音质 (128k)',
  '320k': '高音质 (320k)',
  'flac': '无损音质 (FLAC)',
  'flac24bit': 'Hi-Res 无损 (24bit)',
  'hires': 'Hi-Res',
  'master': '母带级 (Master)',
  'atmos': '杜比全景声 (Dolby)',
}

const getQualityLabel = (q: string) => qualityLabelMap[q] || q

const qualityOptions = computed(() => {
  const currentPlatform = settingsStore.source.preferredPlatform
  const availableQualities = new Set<string>()

  // 如果选了特定平台，只查找该平台的音质
  if (currentPlatform !== 'all') {
    for (const plugin of plugins.value) {
      if (plugin.sources && Array.isArray(plugin.sources)) {
        const targetSource = plugin.sources.find(s => s.id === currentPlatform)
        if (targetSource && targetSource.qualities) {
          targetSource.qualities.forEach(q => availableQualities.add(q))
        }
      }
    }
  } else {
    // 如果是所有平台，则收集所有平台支持的音质
    for (const plugin of plugins.value) {
      if (plugin.sources && Array.isArray(plugin.sources)) {
        plugin.sources.forEach(src => {
          if (src.qualities) {
            src.qualities.forEach(q => availableQualities.add(q))
          }
        })
      }
    }
  }

  // 默认至少要有 128k
  if (availableQualities.size === 0) {
    availableQualities.add('128k')
  }

  // 排序优先级
  const priority = ['128k', '320k', 'flac', 'flac24bit', 'hires', 'master', 'atmos']
  
  return Array.from(availableQualities)
    .sort((a, b) => {
      const idxA = priority.indexOf(a)
      const idxB = priority.indexOf(b)
      if (idxA !== -1 && idxB !== -1) return idxA - idxB
      if (idxA !== -1) return -1
      if (idxB !== -1) return 1
      return a.localeCompare(b)
    })
    .map(q => ({
      label: getQualityLabel(q),
      value: q
    }))
})

// 当可用音质列表变化时，如果当前选中的音质不再可用，重置为第一个可用音质
watch(qualityOptions, (newOptions) => {
  if (newOptions.length > 0) {
    const currentQuality = settingsStore.source.preferredQuality
    const isAvailable = newOptions.some(opt => opt.value === currentQuality)
    if (!isAvailable) {
      // 优先尝试保留原有选择的意图（例如都是无损，只是名字变了？暂不处理复杂映射）
      // 简单回退到 128k 或者列表第一项
      const fallback = newOptions.find(o => o.value === '128k') || newOptions[0]
      settingsStore.source.preferredQuality = fallback.value
    }
  }
}, { deep: true })

const platformOptions = computed(() => {
  const options = [
    { label: '所有平台 (默认)', value: 'all' }
  ]
  
  // 遍历所有已加载的插件，提取 sources
  plugins.value.forEach(plugin => {
    if (plugin.sources && Array.isArray(plugin.sources)) {
      plugin.sources.forEach(src => {
        options.push({
          label: src.name || src.id,
          value: src.id
        })
      })
    }
  })
  
  // 去重
  const uniqueOptions: {label: string, value: string}[] = []
  const map = new Map()
  for (const item of options) {
    if(!map.has(item.value)){
        map.set(item.value, true);
        uniqueOptions.push(item);
    }
  }
  return uniqueOptions
})

// 初始化时从主进程加载已保存的音源插件
onMounted(async () => {
  await loadAllPlugins()
})

// 从主进程加载所有音源插件，并同步当前激活的插件
const loadAllPlugins = async (): Promise<void> => {
  loading.value = true
  errorMessage.value = null
  try {
    const { canceled, results, errors, activeFilePath: remoteActive } =
      await runSnowdropLoadAllPlugins()
    if (!canceled && results && results.length) {
      plugins.value = results
      // 如果主进程已有激活插件且仍然存在，则直接使用
      const matched =
        remoteActive && results.some((item) => item.filePath && item.filePath === remoteActive)
      if (matched) {
        activeFilePath.value = remoteActive || null
      } else {
        // 否则默认使用第一个插件，并持久化设置
        const firstPath = results[0].filePath ?? null
        activeFilePath.value = firstPath
        if (firstPath) {
          await runSnowdropSetActivePlugin(firstPath)
        }
      }
    } else {
      plugins.value = []
      activeFilePath.value = null
    }
    if (errors && errors.length) {
      errorMessage.value = errors.join('\n')
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

// 从本地文件导入新的音源插件
const handleImportPlugin = async (): Promise<void> => {
  loading.value = true
  errorMessage.value = null
  try {
    const { canceled, errors } = await runSnowdropTransformFromFile()
    if (canceled) {
      return
    }

    if (errors && errors.length) {
      errorMessage.value = errors.join('\n')
    }

    // 重新从主进程加载完整列表与当前激活插件
    await loadAllPlugins()
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

// 通过在线 URL 导入新的音源插件
const handleImportPluginFromUrl = async (): Promise<void> => {
  const url = importUrl.value.trim()
  if (!url) {
    errorMessage.value = '请输入有效的 URL 地址'
    return
  }
  loading.value = true
  errorMessage.value = null
  try {
    const { canceled, errors } = await runSnowdropTransformFromUrl(url)
    if (!canceled) {
      if (errors && errors.length) {
        errorMessage.value = errors.join('\n')
      }
      // 导入成功后刷新列表并关闭对话框
      await loadAllPlugins()
      showImportUrlModal.value = false
      importUrl.value = ''
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

// 处理导入方式选择
const handleImportSelect = async (key: 'file' | 'url'): Promise<void> => {
  if (key === 'file') {
    await handleImportPlugin()
  } else if (key === 'url') {
    showImportUrlModal.value = true
    importUrl.value = ''
  }
}

// 打开指定插件的日志视图
const handleOpenPluginLogs = (result: SnowdropTransformTestResult): void => {
  currentLogResult.value = result
  showLogsModal.value = true
}

// 从系统中移除指定插件
const handleRemovePlugin = async (index: number): Promise<void> => {
  const result = plugins.value[index]
  if (!result || !result.filePath) {
    plugins.value.splice(index, 1)
    return
  }

  loading.value = true
  errorMessage.value = null
  try {
    await runSnowdropRemovePlugin(result.filePath)
    plugins.value.splice(index, 1)
    // 如果删除的是当前激活的插件，则重置激活路径
    if (activeFilePath.value === result.filePath) {
      activeFilePath.value = null
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

// 将指定插件设置为当前使用的插件
const handleSetActivePlugin = async (
  result: SnowdropTransformTestResult
): Promise<void> => {
  if (!result.filePath || result.filePath === activeFilePath.value) {
    return
  }
  loading.value = true
  errorMessage.value = null
  try {
    const { success, activePluginPath } = await runSnowdropSetActivePlugin(result.filePath)
    if (success) {
      activeFilePath.value = activePluginPath
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="settings-content">
    <div class="section-group-title">首选设置</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'source.preferredPlatform' }"
      data-setting-key="source.preferredPlatform"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">首选搜索平台</div>
          <div class="sub-label">搜索歌曲时默认使用的音源平台</div>
        </div>
        <n-select
          v-model:value="settingsStore.source.preferredPlatform"
          :options="platformOptions"
          style="width: 200px"
        />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'source.preferredQuality' }"
      data-setting-key="source.preferredQuality"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">首选播放音质</div>
          <div class="sub-label">播放时优先尝试使用的音质</div>
        </div>
        <n-select
          v-model:value="settingsStore.source.preferredQuality"
          :options="qualityOptions"
          style="width: 200px"
        />
      </div>
    </n-card>

    <div class="section-group-title" style="margin-top: 24px;">音源与插件</div>

    <div
      data-setting-key="source.plugins"
      :bordered="true"
      size="small"
    >
      <div class="source-settings">
        <div class="source-settings-actions">
          <n-dropdown trigger="click" :options="importOptions" @select="handleImportSelect">
            <n-button type="primary" :loading="loading">
              导入音源插件
            </n-button>
          </n-dropdown>
          <n-button secondary :loading="loading" @click="loadAllPlugins">
            重新加载已保存插件
          </n-button>
        </div>

        <n-divider />

        <div v-if="errorMessage" class="snowdrop-test-error">
          {{ errorMessage }}
        </div>

        <div v-else-if="loading" class="snowdrop-test-loading">
          <n-spin size="small"> 正在解析或加载音源插件... </n-spin>
        </div>

        <template v-else-if="plugins.length">
          <div class="plugin-list">
            <div
              v-for="(result, index) in plugins"
              :key="result.filePath || index"
              class="setting-item"
            >
              <div
                class="plugin-card"
                :class="{ 'plugin-card--active': result.filePath === activeFilePath }"
              >
                <div class="plugin-card-main">
                  <div class="plugin-card-left">
                    <div class="plugin-title-row">
                      <span class="plugin-name">{{ result.meta.name }}</span>
                      <n-tag size="small" type="default" round> v{{ result.meta.version }} </n-tag>
                      <n-tag size="small" type="info" round> 已加载 </n-tag>
                      <n-tag
                        v-if="result.filePath === activeFilePath"
                        size="small"
                        type="success"
                        round
                      >
                        当前使用
                      </n-tag>
                    </div>
                    <div class="plugin-line">作者：{{ result.meta.author }}</div>
                    <div v-if="result.meta.description" class="plugin-line">
                      {{ result.meta.description }}
                    </div>
                    <div class="plugin-line">支持的音源：</div>
                    <div v-if="result.sources && result.sources.length" class="plugin-sources">
                      <n-tag
                        v-for="src in result.sources"
                        :key="src.id"
                        type="info"
                        size="small"
                        round
                        class="plugin-source-tag"
                      >
                        {{ src.name || src.id }}
                      </n-tag>
                    </div>
                    <div v-else class="plugin-line">暂无音源信息</div>
                  </div>
                  <div class="plugin-card-right">
                    <n-button
                      size="small"
                      type="primary"
                      tertiary
                      :disabled="result.filePath === activeFilePath"
                      @click="handleSetActivePlugin(result)"
                    >
                      设为当前插件
                    </n-button>
                    <n-button
                      size="small"
                      tertiary
                      :disabled="
                        !result.logs.length && !(result.runtimeLogs && result.runtimeLogs.length)
                      "
                      @click="handleOpenPluginLogs(result)"
                    >
                      日志
                    </n-button>
                    <n-button
                      size="small"
                      type="error"
                      tertiary
                      class="plugin-uninstall-btn"
                      @click="handleRemovePlugin(index)"
                    >
                      移除
                    </n-button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="snowdrop-meta">尚未导入音源插件，请先点击上方按钮选择文件。</div>
        </template>
      </div>
    </div>

    <n-modal v-model:show="showLogsModal" preset="card" title="插件日志" style="width: 860px">
      <div v-if="currentLogResult" class="plugin-logs-dialog">
        <div class="plugin-logs-block" v-if="currentLogResult.logs.length">
          <strong>转换日志：</strong>
          <n-code :code="currentLogResult.logs.join('\n')" language="bash" word-wrap />
        </div>
        <div
          class="plugin-logs-block"
          v-if="currentLogResult.runtimeLogs && currentLogResult.runtimeLogs.length"
        >
          <strong>插件输出日志：</strong>
          <n-code :code="currentLogResult.runtimeLogs.join('\n')" language="bash" word-wrap />
        </div>
        <div
          v-if="
            !currentLogResult.logs.length &&
            !(currentLogResult.runtimeLogs && currentLogResult.runtimeLogs.length)
          "
        >
          暂无可展示的日志。
        </div>
      </div>
    </n-modal>

    <n-modal
      v-model:show="showImportUrlModal"
      preset="dialog"
      title="从在线 URL 导入音源插件"
      style="width: 520px"
    >
      <div class="import-url-body">
        <div class="plugin-line">请输入落雪音源插件 JS 文件的网络地址：</div>
        <n-input
          v-model:value="importUrl"
          type="text"
          placeholder="例如：https://example.com/my-snowdrop-plugin.js"
        />
      </div>
      <template #action>
        <n-button @click="showImportUrlModal = false">取消</n-button>
        <n-button type="primary" :loading="loading" @click="handleImportPluginFromUrl">
          确认导入
        </n-button>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.source-settings {
  font-size: 13px;
}

.source-settings-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}

.source-settings-tip {
  font-size: 12px;
  color: #999;
}

.snowdrop-test-error {
  margin-top: 8px;
  color: #f56c6c;
  font-size: 12px;
}

.snowdrop-test-loading {
  margin-top: 8px;
}

.snowdrop-meta {
  margin-top: 8px;
  font-size: 12px;
}

.plugin-list {
  margin-top: 4px;
}

.plugin-list-item {
  margin-bottom: 4px;
}

.plugin-card {
  /* 每个插件项的卡片背景色 */
  background-color: var(--n-card-color);
  /* 每个插件项的轻微边框 */
  border: 1px solid var(--n-border-color);
  border-radius: 12px;
  padding: 12px 16px;
}

.plugin-card--active {
  /* 当前使用的插件高亮边框 */
  border-color: var(--n-primary-color);
}

.plugin-card-main {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.plugin-card-left {
  flex: 1;
}

.plugin-card-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  margin-left: 16px;
}

.plugin-name {
  font-size: 16px;
  font-weight: 600;
}

.plugin-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.plugin-line {
  font-size: 13px;
  margin-top: 4px;
}

.plugin-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.plugin-source-tag {
  font-size: 12px;
}

.plugin-uninstall-btn {
  margin-top: 4px;
}

.plugin-logs-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.plugin-logs-block {
  font-size: 12px;
}

.import-url-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
