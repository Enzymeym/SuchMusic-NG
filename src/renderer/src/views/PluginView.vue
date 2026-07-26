<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NCard, NButton, NTag, NSpace, useMessage } from 'naive-ui'
import { usePluginStore, type PluginInfo } from '../stores/pluginStore'

const router = useRouter()
const pluginStore = usePluginStore()
const message = useMessage()

onMounted(() => {
  pluginStore.initListeners()
  pluginStore.refreshPluginList()
})

/** 状态标签配置 */
const stateConfig: Record<string, { type: 'success' | 'error' | 'warning' | 'info'; label: string }> = {
  running: { type: 'success', label: '运行中' },
  loaded: { type: 'info', label: '已加载' },
  error: { type: 'error', label: '错误' },
  unloaded: { type: 'warning', label: '已卸载' }
}

/** 跳转插件详情 */
function goDetail(plugin: PluginInfo): void {
  router.push(`/plugin/${plugin.id}`)
}

/** 点击添加插件 —— 弹出文件选择框 */
async function addPlugin(): Promise<void> {
  const ok = await pluginStore.selectAndLoadPlugin()
  if (ok) {
    message.success('插件加载成功')
  }
}

/** 移除插件 */
async function removePlugin(plugin: PluginInfo, e: Event): Promise<void> {
  e.stopPropagation()
  const ok = await pluginStore.removePlugin(plugin.id)
  if (ok) {
    message.success(`插件 "${plugin.name}" 已移除`)
  } else {
    message.error('移除失败')
  }
}

/** 设置活跃插件 */
async function toggleActive(plugin: PluginInfo, e: Event): Promise<void> {
  e.stopPropagation()
  const newActiveId = plugin.isActive ? null : plugin.id
  const ok = await pluginStore.setActivePlugin(newActiveId)
  if (ok) {
    message.success(plugin.isActive ? '已取消激活' : `已激活 "${plugin.name}"`)
  }
}
</script>

<template>
  <div class="plugin-view">
    <!-- 头部 -->
    <div class="plugin-header">
      <div class="header-left">
        <h1 class="page-title">插件管理</h1>
        <span class="plugin-count" v-if="pluginStore.plugins.length">
          共 {{ pluginStore.plugins.length }} 个插件
        </span>
      </div>
      <n-button type="primary" @click="addPlugin">
        <template #icon>
          <i class="mgc_add_line" style="font-size: 16px"></i>
        </template>
        添加插件
      </n-button>
    </div>

    <!-- 内容区域 -->
    <div class="plugin-content">
      <!-- 空状态 -->
      <div v-if="pluginStore.plugins.length === 0" class="empty-state">
        <i class="mgc_extension_line" style="font-size: 64px; color: var(--n-text-color-4)"></i>
        <p class="empty-title">暂无插件</p>
        <p class="empty-desc">点击右上角「添加插件」选择 .ts 或 .js 插件文件</p>
      </div>

      <!-- 插件卡片网格 -->
      <div v-else class="plugin-grid">
        <n-card
          v-for="plugin in pluginStore.plugins"
          :key="plugin.id"
          class="plugin-card"
          hoverable
          @click="goDetail(plugin)"
        >
          <template #header>
            <div class="card-header">
              <div class="card-title-row">
                <span class="card-name">{{ plugin.name }}</span>
                <n-tag
                  :type="stateConfig[plugin.state]?.type || 'info'"
                  size="small"
                  round
                >
                  {{ stateConfig[plugin.state]?.label || plugin.state }}
                </n-tag>
              </div>
              <n-tag v-if="plugin.isActive" type="success" size="tiny" round>
                活跃
              </n-tag>
            </div>
          </template>

          <div class="card-body">
            <p class="card-desc">{{ plugin.description || '暂无描述' }}</p>
            <div class="card-meta">
              <span class="meta-item">v{{ plugin.version }}</span>
              <span class="meta-divider">·</span>
              <span class="meta-item">{{ plugin.author }}</span>
            </div>
          </div>

          <template #action>
            <n-space>
              <n-button
                size="small"
                :type="plugin.isActive ? 'warning' : 'primary'"
                ghost
                @click="toggleActive(plugin, $event)"
              >
                {{ plugin.isActive ? '取消激活' : '激活' }}
              </n-button>
              <n-button size="small" type="error" ghost @click="removePlugin(plugin, $event)">
                移除
              </n-button>
            </n-space>
          </template>
        </n-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 64px 24px 0;
  box-sizing: border-box;
}

.plugin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.page-title {
  font-size: 22px;
  font-weight: 700;
  margin: 0;
  color: var(--n-text-color-1);
}

.plugin-count {
  font-size: 13px;
  color: var(--n-text-color-3);
}

.plugin-content {
  flex: 1;
  overflow: auto;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
}

.empty-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--n-text-color-3);
  margin: 0;
}

.empty-desc {
  font-size: 13px;
  color: var(--n-text-color-4);
  margin: 0;
}

/* 卡片网格 */
.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  padding-bottom: 24px;
}

.plugin-card {
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}

.plugin-card:hover {
  transform: translateY(-2px);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--n-text-color-1);
}

.card-body {
  min-height: 60px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
}

.card-desc {
  font-size: 13px;
  color: var(--n-text-color-3);
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--n-text-color-4);
}

.meta-divider {
  color: var(--n-border-color);
}
</style>
