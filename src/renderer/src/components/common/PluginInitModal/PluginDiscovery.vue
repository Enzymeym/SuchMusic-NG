<script setup lang="ts">
/**
 * 插件发现组件
 * 用于发现、导入和选择插件
 * @author SuchMusic Plugin System
 */
import { ref } from 'vue'
import {
  NButton,
  NCard,
  NInput,
  NRadioGroup,
  NRadio,
  NDivider,
  NAlert,
  NSpin,
  NTag,
  NIcon,
  NEmpty,
  useMessage
} from 'naive-ui'
import { usePluginStore } from '../../../stores/pluginStore'
import type { PluginInfo, PluginSource, PluginConfigItem } from '../../../types/plugin'

const message = useMessage()
const pluginStore = usePluginStore()

const emit = defineEmits<{
  (e: 'pluginDiscovered', plugin: {
    id: string
    code: string
    info: PluginInfo
    sources: PluginSource[]
    configUI: PluginConfigItem[]
  }): void
  (e: 'error', message: string): void
}>()

// 发现方式：'local' | 'url' | 'installed'
const discoveryMethod = ref<'local' | 'url' | 'installed'>('local')

// 加载状态
const loading = ref(false)

// 错误信息
const errorMsg = ref<string | null>(null)

// URL 输入
const pluginUrl = ref('')

// 已安装但未初始化的插件列表
const installedPlugins = ref<Array<{
  id: string
  info: PluginInfo
  sources: PluginSource[]
  configUI: PluginConfigItem[]
}>>([])

// 选中的已安装插件
const selectedInstalledPlugin = ref<string | null>(null)

/**
 * 从本地文件导入插件
 */
const handleImportFromLocal = async () => {
  loading.value = true
  errorMsg.value = null

  try {
    const result = await pluginStore.importPluginFromFile()

    if (result.canceled) {
      loading.value = false
      return
    }

    if (result.error) {
      errorMsg.value = result.error
      emit('error', result.error)
      loading.value = false
      return
    }

    if (result.plugin) {
      emit('pluginDiscovered', result.plugin)
    }
  } catch (err: any) {
    const msg = err.message || '导入插件失败'
    errorMsg.value = msg
    emit('error', msg)
  } finally {
    loading.value = false
  }
}

/**
 * 从 URL 导入插件
 */
const handleImportFromUrl = async () => {
  if (!pluginUrl.value.trim()) {
    message.warning('请输入插件 URL')
    return
  }

  loading.value = true
  errorMsg.value = null

  try {
    const result = await pluginStore.importPluginFromUrl(pluginUrl.value.trim())

    if (result.error) {
      errorMsg.value = result.error
      emit('error', result.error)
      loading.value = false
      return
    }

    if (result.plugin) {
      emit('pluginDiscovered', result.plugin)
    }
  } catch (err: any) {
    const msg = err.message || '从 URL 导入插件失败'
    errorMsg.value = msg
    emit('error', msg)
  } finally {
    loading.value = false
  }
}

/**
 * 加载已安装但未初始化的插件
 */
const loadInstalledPlugins = async () => {
  loading.value = true
  errorMsg.value = null

  try {
    const plugins = await pluginStore.getUninitializedPlugins()
    installedPlugins.value = plugins

    if (plugins.length === 0) {
      message.info('没有待初始化的插件')
    }
  } catch (err: any) {
    const msg = err.message || '加载插件列表失败'
    errorMsg.value = msg
    emit('error', msg)
  } finally {
    loading.value = false
  }
}

/**
 * 选择已安装的插件
 */
const handleSelectInstalledPlugin = async (pluginId: string) => {
  selectedInstalledPlugin.value = pluginId

  const plugin = installedPlugins.value.find(p => p.id === pluginId)
  if (!plugin) return

  loading.value = true

  try {
    const result = await pluginStore.getPluginById(pluginId)
    if (result) {
      emit('pluginDiscovered', result)
    }
  } catch (err: any) {
    const msg = err.message || '加载插件失败'
    errorMsg.value = msg
    emit('error', msg)
  } finally {
    loading.value = false
  }
}

// 切换发现方式时加载对应数据
const handleMethodChange = (method: 'local' | 'url' | 'installed') => {
  discoveryMethod.value = method
  errorMsg.value = null

  if (method === 'installed') {
    loadInstalledPlugins()
  }
}
</script>

<template>
  <div class="plugin-discovery">
    <!-- 发现方式选择 -->
    <div class="discovery-method">
      <n-radio-group :value="discoveryMethod" @update:value="handleMethodChange">
        <n-radio value="local">
          <span class="method-label">
            <n-icon><i class="mgc_folder_line" /></n-icon>
            从本地文件导入
          </span>
        </n-radio>
        <n-radio value="url">
          <span class="method-label">
            <n-icon><i class="mgc_link_line" /></n-icon>
            从在线 URL 导入
          </span>
        </n-radio>
        <n-radio value="installed">
          <span class="method-label">
            <n-icon><i class="mgc_box_line" /></n-icon>
            选择已安装插件
          </span>
        </n-radio>
      </n-radio-group>
    </div>

    <n-divider />

    <!-- 错误提示 -->
    <n-alert v-if="errorMsg" type="error" :title="'导入失败'" closable @close="errorMsg = null">
      {{ errorMsg }}
    </n-alert>

    <!-- 本地文件导入 -->
    <div v-if="discoveryMethod === 'local'" class="discovery-panel">
      <p class="discovery-hint">
        请选择本地插件文件（.js 格式）。支持原生 SuchMusic 插件和 LX 兼容插件。
      </p>
      <n-button
        type="primary"
        size="large"
        :loading="loading"
        @click="handleImportFromLocal"
      >
        <template #icon>
          <n-icon><i class="mgc_folder_open_line" /></n-icon>
        </template>
        选择插件文件
      </n-button>
    </div>

    <!-- URL 导入 -->
    <div v-else-if="discoveryMethod === 'url'" class="discovery-panel">
      <p class="discovery-hint">
        请输入插件文件的在线 URL 地址。插件将被下载并安装。
      </p>
      <div class="url-input-group">
        <n-input
          v-model:value="pluginUrl"
          placeholder="https://example.com/plugin.js"
          :disabled="loading"
          @keyup.enter="handleImportFromUrl"
        />
        <n-button
          type="primary"
          :loading="loading"
          :disabled="!pluginUrl.trim()"
          @click="handleImportFromUrl"
        >
          导入
        </n-button>
      </div>
    </div>

    <!-- 已安装插件 -->
    <div v-else-if="discoveryMethod === 'installed'" class="discovery-panel">
      <div v-if="loading" class="loading-container">
        <n-spin size="medium" />
        <p>正在加载插件列表...</p>
      </div>

      <div v-else-if="installedPlugins.length === 0" class="empty-container">
        <n-empty description="没有待初始化的插件">
          <template #extra>
            <n-button @click="loadInstalledPlugins">刷新列表</n-button>
          </template>
        </n-empty>
      </div>

      <div v-else class="installed-plugins-list">
        <p class="discovery-hint">选择要初始化的插件：</p>
        <n-card
          v-for="plugin in installedPlugins"
          :key="plugin.id"
          size="small"
          :class="['plugin-card', { 'plugin-card--selected': selectedInstalledPlugin === plugin.id }]"
          hoverable
          @click="handleSelectInstalledPlugin(plugin.id)"
        >
          <div class="plugin-card-content">
            <div class="plugin-info">
              <div class="plugin-header">
                <span class="plugin-name">{{ plugin.info.name }}</span>
                <n-tag size="small" type="default">v{{ plugin.info.version }}</n-tag>
              </div>
              <div class="plugin-meta">
                <span>作者: {{ plugin.info.author }}</span>
              </div>
              <div v-if="plugin.info.description" class="plugin-desc">
                {{ plugin.info.description }}
              </div>
              <div v-if="plugin.sources.length" class="plugin-sources">
                <n-tag
                  v-for="source in plugin.sources"
                  :key="source.id"
                  size="small"
                  type="info"
                  round
                >
                  {{ source.name }}
                </n-tag>
              </div>
            </div>
            <div class="plugin-select-icon">
              <i
                class="mgc_check_circle_fill"
                :style="{
                  opacity: selectedInstalledPlugin === plugin.id ? 1 : 0,
                  color: 'var(--n-primary-color)'
                }"
              />
            </div>
          </div>
        </n-card>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.plugin-discovery {
  .discovery-method {
    .n-radio-group {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .method-label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;

      .n-icon {
        font-size: 18px;
      }
    }
  }

  .discovery-panel {
    padding: 16px 0;

    .discovery-hint {
      color: var(--n-text-color-3);
      font-size: 13px;
      margin-bottom: 16px;
    }

    .url-input-group {
      display: flex;
      gap: 12px;

      .n-input {
        flex: 1;
      }
    }
  }

  .loading-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 0;
    gap: 12px;

    p {
      color: var(--n-text-color-3);
      font-size: 13px;
    }
  }

  .empty-container {
    padding: 40px 0;
  }

  .installed-plugins-list {
    .plugin-card {
      margin-bottom: 12px;
      cursor: pointer;
      transition: all 0.2s ease;

      &--selected {
        border-color: var(--n-primary-color);
        background-color: var(--n-primary-color-hover);
      }

      &:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
      }
    }

    .plugin-card-content {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }

    .plugin-info {
      flex: 1;

      .plugin-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;

        .plugin-name {
          font-size: 15px;
          font-weight: 600;
        }
      }

      .plugin-meta {
        font-size: 12px;
        color: var(--n-text-color-3);
        margin-bottom: 8px;
      }

      .plugin-desc {
        font-size: 13px;
        color: var(--n-text-color-2);
        margin-bottom: 8px;
        line-height: 1.4;
      }

      .plugin-sources {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
    }

    .plugin-select-icon {
      font-size: 24px;
      margin-left: 12px;
      display: flex;
      align-items: center;

      i {
        transition: opacity 0.2s ease;
      }
    }
  }
}
</style>
