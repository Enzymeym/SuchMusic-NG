<script setup lang="ts">
import { computed, onMounted, ref, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NButton, NTag, NSpace, NCard, NSelect,
  useMessage, NModal, NScrollbar, NTabs, NTabPane
} from 'naive-ui'
import { usePluginStore } from '../stores/pluginStore'
import PluginRenderer from '../components/common/PluginRenderer.vue'

const route = useRoute()
const router = useRouter()
const pluginStore = usePluginStore()
const message = useMessage()

const pluginId = computed(() => route.params.id as string)
const plugin = computed(() => pluginStore.plugins.find((p) => p.id === pluginId.value))

const showConfirmModal = ref(false)
const pendingConfirm = ref<any>(null)
const showBatchConfirmModal = ref(false)
const pendingBatchConfirm = ref<any>(null)
const actionLoading = ref(false)
const activeTab = ref('interface')

// 权限策略状态：ask | allow | deny
const permissionStates = reactive<Record<string, 'ask' | 'allow' | 'deny'>>({})
const permissionOptions = [
  { label: '询问', value: 'ask' },
  { label: '允许', value: 'allow' },
  { label: '拒绝', value: 'deny' }
]

// 初始化权限默认策略
function initPermissionStates(): void {
  const p = plugin.value
  if (!p?.permissions) return
  for (const perm of p.permissions) {
    if (!(perm in permissionStates)) {
      permissionStates[perm] = 'ask'
    }
  }
}

// 插件字段值（props 状态）
const fieldValues = reactive<Record<string, any>>({})

onMounted(() => {
  if (pluginStore.plugins.length === 0) {
    pluginStore.initListeners()
    pluginStore.refreshPluginList()
  }

  window.api.plugins.onConfirmRequest((request) => {
    pendingConfirm.value = request
    showConfirmModal.value = true
  })

  window.api.plugins.onBatchConfirmRequest((request) => {
    pendingBatchConfirm.value = request
    showBatchConfirmModal.value = true
  })

  // 初始化后拉取插件状态
  fetchPluginProps()
  initPermissionStates()

  // 监听插件 setProps 实时更新 UI
  window.api.plugins.onPropsChanged((data: { pluginId: string; props: Record<string, any> }) => {
    if (data.pluginId === pluginId.value) {
      Object.assign(fieldValues, data.props)
    }
  })
})

watch(plugin, () => {
  initPermissionStates()
})

/** 从插件获取当前状态 */
async function fetchPluginProps(): Promise<void> {
  const p = plugin.value
  if (!p) return
  try {
    const status = await pluginStore.callPluginMethod(p.id, 'getStatus')
    if (status) {
      Object.assign(fieldValues, status)
      // 同步解密器路径和 NCM 目录
      if (status.decryptorPath) fieldValues.decryptorPath = status.decryptorPath
      if (status.ncmDir) fieldValues.ncmDir = status.ncmDir
      if (status.musicDir) fieldValues.musicDir = status.musicDir
      if (status.isDecryptorValid) fieldValues.decryptorStatusText = '有效'
    }
  } catch {
    // 忽略
  }
}

const stateConfig: Record<string, { type: 'success' | 'error' | 'warning' | 'info'; label: string }> = {
  running: { type: 'success', label: '运行中' },
  loaded: { type: 'info', label: '已加载' },
  error: { type: 'error', label: '错误' },
  unloaded: { type: 'warning', label: '已卸载' }
}

/** 处理 UI 操作按钮 */
async function handleAction(method: string): Promise<void> {
  const p = plugin.value
  if (!p) return
  actionLoading.value = true
  try {
    await pluginStore.callPluginMethod(p.id, method)
    // 方法执行后刷新状态
    await fetchPluginProps()
  } catch (err: any) {
    message.error(err.message || '操作失败')
  } finally {
    actionLoading.value = false
  }
}

/** 处理字段操作（浏览按钮等） */
async function handleFieldAction(key: string, action: string): Promise<void> {
  const p = plugin.value
  if (!p) return
  if (action === 'browse') {
    // 选择文件（exe）
    const result = await window.api.plugins.selectFile()
    if (result.success && result.filePath) {
      fieldValues[key] = result.filePath
      await pluginStore.callPluginMethod(p.id, 'setDecryptorPath', result.filePath)
    }
  } else if (action === 'browseDir') {
    const result = await window.api.plugins.selectDirectory()
    if (result.success && result.filePath) {
      fieldValues[key] = result.filePath
      await pluginStore.callPluginMethod(p.id, 'setNcmDir', result.filePath)
    }
  }
}

/** 处理字段值更新 */
async function handleUpdateValue(key: string, value: any): Promise<void> {
  fieldValues[key] = value
  // 同步值到插件：尝试调用 set + Key 首字母大写 方法
  const p = plugin.value
  if (!p) return
  const methodName = 'set' + key.charAt(0).toUpperCase() + key.slice(1)
  try {
    await pluginStore.callPluginMethod(p.id, methodName, value)
  } catch {
    // 插件未实现对应 setter 则忽略
  }
}

async function checkUpdate(): Promise<void> {
  const p = plugin.value
  if (!p) return
  try {
    const result = await pluginStore.checkPluginUpdate(p.id)
    if (result?.hasNew) {
      message.info(`发现新版本 v${result.version}`)
    } else {
      message.success('当前已是最新版本')
    }
  } catch {
    message.error('检查更新失败')
  }
}

async function handleConfirm(): Promise<void> {
  await pluginStore.respondConfirm(true)
  showConfirmModal.value = false
  pendingConfirm.value = null
}

async function handleReject(): Promise<void> {
  await pluginStore.respondConfirm(false)
  showConfirmModal.value = false
  pendingConfirm.value = null
}

async function handleBatchConfirm(): Promise<void> {
  await pluginStore.respondBatchConfirm(true)
  showBatchConfirmModal.value = false
  pendingBatchConfirm.value = null
}

async function handleBatchReject(): Promise<void> {
  await pluginStore.respondBatchConfirm(false)
  showBatchConfirmModal.value = false
  pendingBatchConfirm.value = null
}

async function handleRemove(): Promise<void> {
  const p = plugin.value
  if (!p) return
  const ok = await pluginStore.removePlugin(p.id)
  if (ok) {
    message.success('插件已移除')
    router.push('/plugins')
  }
}

async function toggleActive(): Promise<void> {
  const p = plugin.value
  if (!p) return
  const newId = p.isActive ? null : p.id
  const ok = await pluginStore.setActivePlugin(newId)
  if (ok) {
    message.success(p.isActive ? '已取消激活' : '已激活')
  }
}
</script>

<template>
  <div class="detail-view" v-if="plugin">
    <n-scrollbar class="detail-body">
      <div class="info-section">
        <!-- 标题行 -->
        <div class="title-row">
          <div class="title-left">
            <h1 class="plugin-name">{{ plugin.name }}</h1>
            <n-tag :type="stateConfig[plugin.state]?.type || 'info'" size="small" round>
              {{ stateConfig[plugin.state]?.label || plugin.state }}
            </n-tag>
            <n-tag v-if="plugin.isActive" type="success" size="small" round>活跃</n-tag>
          </div>
          <n-space>
            <n-button @click="toggleActive" :type="plugin.isActive ? 'warning' : 'primary'" ghost>
              {{ plugin.isActive ? '取消激活' : '激活' }}
            </n-button>
            <n-button @click="checkUpdate" ghost>检查更新</n-button>
            <n-button type="error" ghost @click="handleRemove">移除</n-button>
          </n-space>
        </div>

        <n-tabs v-model:value="activeTab" type="segment" animated>
          <!-- 插件界面 -->
          <n-tab-pane name="interface" tab="插件界面">
            <div v-if="plugin.uiSchema" class="plugin-ui-area">
              <PluginRenderer :schema="plugin.uiSchema" :values="fieldValues" :loading="actionLoading"
                @action="handleAction" @field-action="handleFieldAction" @update-value="handleUpdateValue" />
            </div>
            <div v-else class="empty-tab-content">
              <i class="mgc_extension_line" style="font-size: 36px; color: var(--n-text-color-4)"></i>
              <p>该插件没有提供 UI 界面</p>
            </div>
          </n-tab-pane>

          <!-- 插件信息 -->
          <n-tab-pane name="info" tab="插件信息">
            <p class="plugin-desc">{{ plugin.description || '暂无描述' }}</p>

            <h3 class="section-title">基本信息</h3>
            <div class="info-cards">
              <n-card size="small" class="info-card">
                <span class="info-label">插件 ID</span>
                <span class="info-value">{{ plugin.id }}</span>
              </n-card>
              <n-card size="small" class="info-card">
                <span class="info-label">版本</span>
                <span class="info-value">v{{ plugin.version }}</span>
              </n-card>
              <n-card size="small" class="info-card">
                <span class="info-label">作者</span>
                <span class="info-value">{{ plugin.author }}</span>
              </n-card>
              <n-card size="small" class="info-card">
                <span class="info-label">类型</span>
                <n-tag v-if="plugin.isUIWidget" type="info" size="tiny" round>UI 插件</n-tag>
                <n-tag v-else type="info" size="tiny" round>功能插件</n-tag>
              </n-card>
              <n-card size="small" class="info-card info-card-full">
                <span class="info-label">文件路径</span>
                <span class="info-value file-path">{{ plugin.filePath }}</span>
              </n-card>
            </div>

            <h3 class="section-title">权限声明</h3>
            <div v-if="plugin.permissions?.length" class="permission-cards">
              <n-card v-for="perm in plugin.permissions" :key="perm" size="small" class="permission-card">
                <div class="permission-card-row">
                  <div class="permission-name">
                    <i class="mgc_shield_line" style="font-size: 16px; margin-right: 6px"></i>
                    <span>{{ perm }}</span>
                  </div>
                  <n-select v-model:value="permissionStates[perm]" :options="permissionOptions"
                    class="permission-select" />
                </div>
              </n-card>
            </div>
            <p v-else class="no-data">无需特殊权限</p>
          </n-tab-pane>
        </n-tabs>
      </div>
    </n-scrollbar>

    <!-- 敏感操作确认弹窗 -->
    <n-modal v-model:show="showConfirmModal" preset="dialog" title="操作确认" positive-text="确认执行" negative-text="拒绝"
      @positive-click="handleConfirm" @negative-click="handleReject" :closable="false" :mask-closable="false">
      <div style="padding: 8px 0">
        <p style="margin-bottom: 8px; font-size: 14px">
          插件 <strong>{{ pendingConfirm?.pluginName }}</strong> 请求执行敏感操作：
        </p>
        <n-tag type="warning" size="medium" round>{{ pendingConfirm?.operation }}</n-tag>
        <p style="margin-top: 8px; font-size: 12px; color: var(--n-text-color-3); word-break: break-all">
          {{ pendingConfirm?.detail }}
        </p>
      </div>
    </n-modal>

    <!-- 批量敏感操作确认弹窗 -->
    <n-modal v-model:show="showBatchConfirmModal" preset="dialog" title="批量操作确认" positive-text="全部确认"
      negative-text="全部拒绝" @positive-click="handleBatchConfirm" @negative-click="handleBatchReject" :closable="false"
      :mask-closable="false">
      <div style="padding: 8px 0">
        <p style="margin-bottom: 12px; font-size: 14px">
          插件 <strong>{{ pendingBatchConfirm?.pluginName }}</strong> 请求执行以下 {{ pendingBatchConfirm?.operations?.length ||
          0 }} 项敏感操作：
        </p>
        <n-scrollbar style="max-height: 300px">
          <div v-for="(op, idx) in pendingBatchConfirm?.operations || []" :key="op.opId"
            style="padding: 8px 12px; margin-bottom: 6px; background: var(--n-color-embedded); border-radius: 6px; border-left: 3px solid var(--n-warning-color)">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
              <n-tag type="warning" size="tiny" round>{{ op.operation }}</n-tag>
              <span style="font-size: 12px; color: var(--n-text-color-4)">#{{ Number(idx) + 1 }}</span>
            </div>
            <p style="margin: 0; font-size: 12px; color: var(--n-text-color-3); word-break: break-all">
              {{ op.detail }}
            </p>
          </div>
        </n-scrollbar>
      </div>
    </n-modal>
  </div>

  <div class="detail-view not-found" v-else>
    <div class="empty-state">
      <i class="mgc_extension_line" style="font-size: 48px; color: var(--n-text-color-4)"></i>
      <p>插件未找到</p>
      <n-button @click="router.push('/plugins')">返回列表</n-button>
    </div>
  </div>
</template>

<style scoped>
.detail-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 24px 0;
  box-sizing: border-box;
}

.detail-view.not-found {
  align-items: center;
  justify-content: center;
}

.detail-body {
  flex: 1;
  padding-bottom: 24px;
}

.info-section {
  padding-right: 24px;
}

.title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.title-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.plugin-name {
  font-size: 22px;
  font-weight: 700;
  margin: 0;
  color: var(--n-text-color-1);
}

.plugin-desc {
  font-size: 14px;
  color: var(--n-text-color-3);
  margin: 0 0 16px;
  line-height: 1.6;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 12px;
  color: var(--n-text-color-2);
}

.info-cards {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.info-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-card-full {
  grid-column: 1 / -1;
}

.info-label {
  font-size: 12px;
  color: var(--n-text-color-4);
}

.info-value {
  font-size: 14px;
  font-weight: 500;
  color: var(--n-text-color-1);
}

.plugin-ui-area {
  margin: 8px 0;
}

.file-path {
  font-size: 12px;
  color: var(--n-text-color-3);
  word-break: break-all;
  font-family: monospace;
}

.permission-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.permission-card {
  --n-padding-top: 10px;
  --n-padding-bottom: 10px;
}

.permission-card-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.permission-name {
  display: flex;
  align-items: center;
  font-size: 14px;
  font-weight: 500;
  color: var(--n-text-color-1);
}

.permission-select {
  width: 100px;
  flex-shrink: 0;
}

.no-data {
  font-size: 13px;
  color: var(--n-text-color-4);
  margin: 0;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--n-text-color-3);
}

.empty-tab-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 0;
  color: var(--n-text-color-3);
  font-size: 14px;
}
</style>
