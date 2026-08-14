<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { NCard, NButton, NTag, NSpace, NModal, NTabs, NTabPane, NSelect } from 'naive-ui'
import { useMessage } from 'naive-ui'
import { usePluginStore, type PluginInfo } from '../../../stores/pluginStore'
import PluginRenderer from '../PluginRenderer.vue'

const props = defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  highlightKey?: string | null
}>()

const pluginStore = usePluginStore()
const message = useMessage()

/** 当前选中的插件 ID，null 表示列表视图 */
const selectedPluginId = ref<string | null>(null)

/** 状态标签配置 */
const stateConfig: Record<string, { type: 'success' | 'error' | 'warning' | 'info'; label: string }> = {
  running: { type: 'success', label: '运行中' },
  loaded: { type: 'info', label: '已加载' },
  error: { type: 'error', label: '错误' },
  unloaded: { type: 'warning', label: '已卸载' }
}

// ========== 列表操作 ==========

/** 点击添加插件 —— 弹出文件选择框 */
async function addPlugin(): Promise<void> {
  const ok = await pluginStore.selectAndLoadPlugin()
  if (ok) {
    message.success('插件加载成功')
  }
}

/** 移除插件 */
async function removePlugin(plugin: PluginInfo, e?: Event): Promise<void> {
  e?.stopPropagation()
  const ok = await pluginStore.removePlugin(plugin.id)
  if (ok) {
    if (selectedPluginId.value === plugin.id) {
      selectedPluginId.value = null
    }
    message.success(`插件 "${plugin.name}" 已移除`)
  } else {
    message.error('移除失败')
  }
}

/** 设置活跃插件 */
async function toggleActive(plugin: PluginInfo, e?: Event): Promise<void> {
  e?.stopPropagation()
  const newActiveId = plugin.isActive ? null : plugin.id
  const ok = await pluginStore.setActivePlugin(newActiveId)
  if (ok) {
    message.success(plugin.isActive ? '已取消激活' : `已激活 "${plugin.name}"`)
  }
}

/** 进入插件详情 */
function goDetail(plugin: PluginInfo): void {
  selectedPluginId.value = plugin.id
  activeTab.value = 'interface'
}

/** 返回列表 */
function goBackToList(): void {
  selectedPluginId.value = null
}

// ========== 详情状态 ==========

const activeTab = ref('interface')
const actionLoading = ref(false)

/** 权限策略状态：ask | allow | deny */
const permissionStates = reactive<Record<string, 'ask' | 'allow' | 'deny'>>({})
const permissionOptions = [
  { label: '询问', value: 'ask' },
  { label: '允许', value: 'allow' },
  { label: '拒绝', value: 'deny' }
]

/** 插件字段值（props 状态） */
const fieldValues = reactive<Record<string, any>>({})

const selectedPlugin = computed(
  () => pluginStore.plugins.find((p) => p.id === selectedPluginId.value) || null
)

/** 初始化权限默认策略 */
function initPermissionStates(): void {
  const p = selectedPlugin.value
  if (!p?.permissions) return
  for (const perm of p.permissions) {
    if (!(perm in permissionStates)) {
      permissionStates[perm] = 'ask'
    }
  }
}

/** 从插件获取当前状态 */
async function fetchPluginProps(): Promise<void> {
  const p = selectedPlugin.value
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

watch(selectedPlugin, (p) => {
  if (!p) return
  for (const key of Object.keys(fieldValues)) delete fieldValues[key]
  for (const key of Object.keys(permissionStates)) delete permissionStates[key]
  initPermissionStates()
  fetchPluginProps()
})

// ========== 详情操作 ==========

/** 处理 UI 操作按钮 */
async function handleAction(method: string): Promise<void> {
  const p = selectedPlugin.value
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
  const p = selectedPlugin.value
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
  const p = selectedPlugin.value
  if (!p) return
  const methodName = 'set' + key.charAt(0).toUpperCase() + key.slice(1)
  try {
    await pluginStore.callPluginMethod(p.id, methodName, value)
  } catch {
    // 插件未实现对应 setter 则忽略
  }
}

async function checkUpdate(): Promise<void> {
  const p = selectedPlugin.value
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

async function handleRemoveFromDetail(): Promise<void> {
  const p = selectedPlugin.value
  if (!p) return
  const ok = await pluginStore.removePlugin(p.id)
  if (ok) {
    message.success('插件已移除')
    selectedPluginId.value = null
  }
}

async function toggleActiveFromDetail(): Promise<void> {
  const p = selectedPlugin.value
  if (!p) return
  const newId = p.isActive ? null : p.id
  const ok = await pluginStore.setActivePlugin(newId)
  if (ok) {
    message.success(p.isActive ? '已取消激活' : '已激活')
  }
}

// 敏感操作确认弹窗（由 pluginStore 统一监听驱动）
const showConfirmModal = computed(() => !!pluginStore.pendingConfirm)
const showBatchConfirmModal = computed(() => !!pluginStore.pendingBatchConfirm)

async function handleConfirm(): Promise<void> {
  await pluginStore.respondConfirm(true)
}

async function handleReject(): Promise<void> {
  await pluginStore.respondConfirm(false)
}

async function handleBatchConfirm(): Promise<void> {
  await pluginStore.respondBatchConfirm(true)
}

async function handleBatchReject(): Promise<void> {
  await pluginStore.respondBatchConfirm(false)
}

// ========== 生命周期 ==========

let offPropsChanged: (() => void) | null = null

onMounted(() => {
  pluginStore.initListeners()
  pluginStore.refreshPluginList()

  // 监听插件 setProps 实时更新 UI
  offPropsChanged = window.api.plugins.onPropsChanged(
    (data: { pluginId: string; props: Record<string, any> }) => {
      if (data.pluginId === selectedPluginId.value) {
        Object.assign(fieldValues, data.props)
      }
    }
  )
})

onBeforeUnmount(() => {
  offPropsChanged?.()
})
</script>

<template>
  <div class="settings-content plugin-section-root">
    <!-- 列表视图 -->
    <div v-if="!selectedPlugin" class="plugin-view-list">
      <div class="plugin-section-header" data-setting-key="plugins.manage">
        <div class="section-group-title">插件管理</div>
      </div>

      <!-- 空状态 -->
      <div v-if="pluginStore.plugins.length === 0" class="plugin-empty">
        <div class="plugin-empty-icon">
          <i class="mgc_extension_line"></i>
        </div>
        <p class="plugin-empty-title">暂无插件</p>
        <p class="plugin-empty-desc">选择 .ts 或 .js 插件文件，加载后即可在此管理</p>
        <n-button type="primary" size="medium" @click="addPlugin">
          <template #icon>
            <i class="mgc_add_line" style="font-size: 14px"></i>
          </template>
          添加插件
        </n-button>
      </div>

      <!-- 插件卡片列表 -->
      <div v-else class="plugin-list">
        <div class="plugin-list-toolbar">
          <span class="plugin-count">共 {{ pluginStore.plugins.length }} 个插件</span>
          <n-button type="primary" size="small" @click="addPlugin">
            <template #icon>
              <i class="mgc_add_line" style="font-size: 14px"></i>
            </template>
            添加插件
          </n-button>
        </div>
        <n-card
          v-for="plugin in pluginStore.plugins"
          :key="plugin.id"
          class="setting-item plugin-card"
          hoverable
          :style="{
            backgroundColor: props.settingItemBgColor,
            borderColor: props.settingItemBorderColor
          }"
          @click="goDetail(plugin)"
        >
          <div class="plugin-card-row">
            <div class="plugin-card-main">
              <div class="plugin-card-title-row">
                <span class="plugin-card-name">{{ plugin.name }}</span>
                <n-tag :type="stateConfig[plugin.state]?.type || 'info'" size="small" round>
                  {{ stateConfig[plugin.state]?.label || plugin.state }}
                </n-tag>
              </div>
              <p class="plugin-card-desc">{{ plugin.description || '暂无描述' }}</p>
              <div class="plugin-card-meta">
                <span class="meta-item">v{{ plugin.version }}</span>
                <span class="meta-divider">·</span>
                <span class="meta-item">{{ plugin.author }}</span>
                <template v-if="plugin.isActive">
                  <span class="meta-divider">·</span>
                  <span class="meta-item meta-active">
                    <i class="mgc_check_circle_fill" style="font-size: 12px; margin-right: 3px"></i>活跃
                  </span>
                </template>
              </div>
            </div>
            <div class="plugin-card-actions">
              <n-button
                size="small"
                :type="plugin.isActive ? 'warning' : 'primary'"
                tertiary
                @click="toggleActive(plugin, $event)"
              >
                {{ plugin.isActive ? '取消激活' : '激活' }}
              </n-button>
              <n-button size="small" type="error" tertiary @click="removePlugin(plugin, $event)">
                移除
              </n-button>
            </div>
          </div>
        </n-card>
      </div>
    </div>

    <!-- 详情视图 -->
    <div v-else class="plugin-detail">
      <div class="detail-back-row">
        <n-button size="small" quaternary @click="goBackToList">
          <template #icon>
            <i class="mgc_left_line" style="font-size: 14px"></i>
          </template>
          返回列表
        </n-button>
      </div>

      <n-tabs v-model:value="activeTab" type="segment" animated>
        <!-- 插件界面 -->
        <n-tab-pane name="interface" tab="插件界面">
          <div v-if="selectedPlugin.uiSchema" class="plugin-ui-area">
            <PluginRenderer
              :schema="selectedPlugin.uiSchema"
              :values="fieldValues"
              :loading="actionLoading"
              @action="handleAction"
              @field-action="handleFieldAction"
              @update-value="handleUpdateValue"
            />
          </div>
          <div v-else class="empty-tab-content">
            <i class="mgc_extension_line" style="font-size: 36px; color: var(--n-text-color-4)"></i>
            <p>该插件没有提供 UI 界面</p>
          </div>
        </n-tab-pane>

        <!-- 插件信息 -->
        <n-tab-pane name="info" tab="插件信息">
          <!-- 标题行 -->
          <div class="title-row">
            <div class="title-left">
              <h1 class="plugin-name">{{ selectedPlugin.name }}</h1>
              <n-tag :type="stateConfig[selectedPlugin.state]?.type || 'info'" size="small" round>
                {{ stateConfig[selectedPlugin.state]?.label || selectedPlugin.state }}
              </n-tag>
              <n-tag v-if="selectedPlugin.isActive" type="success" size="small" round>活跃</n-tag>
            </div>
            <n-space>
              <n-button
                @click="toggleActiveFromDetail"
                :type="selectedPlugin.isActive ? 'warning' : 'primary'"
                tertiary
              >
                {{ selectedPlugin.isActive ? '取消激活' : '激活' }}
              </n-button>
              <n-button @click="checkUpdate" tertiary>检查更新</n-button>
              <n-button type="error" tertiary @click="handleRemoveFromDetail">移除</n-button>
            </n-space>
          </div>

          <p class="plugin-desc">{{ selectedPlugin.description || '暂无描述' }}</p>

          <h3 class="section-title">基本信息</h3>
          <div class="info-cards">
            <n-card size="small" class="info-card">
              <span class="info-label">插件 ID</span>
              <span class="info-value">{{ selectedPlugin.id }}</span>
            </n-card>
            <n-card size="small" class="info-card">
              <span class="info-label">版本</span>
              <span class="info-value">v{{ selectedPlugin.version }}</span>
            </n-card>
            <n-card size="small" class="info-card">
              <span class="info-label">作者</span>
              <span class="info-value">{{ selectedPlugin.author }}</span>
            </n-card>
            <n-card size="small" class="info-card">
              <span class="info-label">类型</span>
              <n-tag v-if="selectedPlugin.isUIWidget" type="info" size="tiny" round>UI 插件</n-tag>
              <n-tag v-else type="info" size="tiny" round>功能插件</n-tag>
            </n-card>
            <n-card size="small" class="info-card info-card-full">
              <span class="info-label">文件路径</span>
              <span class="info-value file-path">{{ selectedPlugin.filePath }}</span>
            </n-card>
          </div>

          <h3 class="section-title">权限声明</h3>
          <div v-if="selectedPlugin.permissions?.length" class="permission-cards">
            <n-card
              v-for="perm in selectedPlugin.permissions"
              :key="perm"
              size="small"
              class="permission-card"
            >
              <div class="permission-card-row">
                <div class="permission-name">
                  <i class="mgc_shield_line" style="font-size: 16px; margin-right: 6px"></i>
                  <span>{{ perm }}</span>
                </div>
                <n-select
                  v-model:value="permissionStates[perm]"
                  :options="permissionOptions"
                  class="permission-select"
                />
              </div>
            </n-card>
          </div>
          <p v-else class="no-data">无需特殊权限</p>
        </n-tab-pane>
      </n-tabs>
    </div>

    <!-- 敏感操作确认弹窗 -->
    <n-modal
      :show="showConfirmModal"
      preset="dialog"
      title="操作确认"
      positive-text="确认执行"
      negative-text="拒绝"
      @positive-click="handleConfirm"
      @negative-click="handleReject"
      :closable="false"
      :mask-closable="false"
    >
      <div style="padding: 8px 0">
        <p style="margin-bottom: 8px; font-size: 14px">
          插件 <strong>{{ pluginStore.pendingConfirm?.pluginName }}</strong> 请求执行敏感操作：
        </p>
        <n-tag type="warning" size="medium" round>{{ pluginStore.pendingConfirm?.operation }}</n-tag>
        <p style="margin-top: 8px; font-size: 12px; color: var(--n-text-color-3); word-break: break-all">
          {{ pluginStore.pendingConfirm?.detail }}
        </p>
      </div>
    </n-modal>

    <!-- 批量敏感操作确认弹窗 -->
    <n-modal
      :show="showBatchConfirmModal"
      preset="dialog"
      title="批量操作确认"
      positive-text="全部确认"
      negative-text="全部拒绝"
      @positive-click="handleBatchConfirm"
      @negative-click="handleBatchReject"
      :closable="false"
      :mask-closable="false"
    >
      <div style="padding: 8px 0">
        <p style="margin-bottom: 12px; font-size: 14px">
          插件 <strong>{{ pluginStore.pendingBatchConfirm?.pluginName }}</strong> 请求执行以下
          {{ pluginStore.pendingBatchConfirm?.operations?.length || 0 }} 项敏感操作：
        </p>
        <div v-for="(op, idx) in pluginStore.pendingBatchConfirm?.operations || []" :key="op.opId"
          style="padding: 8px 12px; margin-bottom: 6px; background: var(--n-color-embedded); border-radius: 6px; border-left: 3px solid var(--n-warning-color)">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
            <n-tag type="warning" size="tiny" round>{{ op.operation }}</n-tag>
            <span style="font-size: 12px; color: var(--n-text-color-4)">#{{ Number(idx) + 1 }}</span>
          </div>
          <p style="margin: 0; font-size: 12px; color: var(--n-text-color-3); word-break: break-all">
            {{ op.detail }}
          </p>
        </div>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
/* 分区标题 */
.plugin-section-header {
  display: flex;
  align-items: center;
  margin-top: 8px;
}

.plugin-section-header .section-group-title {
  margin-bottom: 0;
}

/* 列表 / 详情视图进入动画 */
.plugin-view-list,
.plugin-detail {
  animation: plugin-view-in 0.22s ease;
}

@keyframes plugin-view-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 空状态 */
.plugin-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 0;
  gap: 8px;
}

.plugin-empty-icon {
  width: 64px;
  height: 64px;
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30px;
  color: var(--n-primary-color);
  background: color-mix(in srgb, var(--n-primary-color) 10%, transparent);
  margin-bottom: 4px;
}

.plugin-empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--n-text-color-3);
  margin: 0;
}

.plugin-empty-desc {
  font-size: 13px;
  color: var(--n-text-color-4);
  margin: 0;
}

.plugin-empty .n-button {
  margin-top: 8px;
}

/* 插件列表 */
.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 列表工具栏：插件数量 + 添加按钮 */
.plugin-list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}

.plugin-count {
  font-size: 12px;
  color: var(--n-text-color-3);
}

.plugin-card {
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.plugin-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.12);
}

/* 按下即时反馈（按压时短暂贴下） */
.plugin-card:active {
  transform: scale(0.992);
  transition-duration: 0.05s;
}

.plugin-card-row {
  display: flex;
  align-items: center;
  gap: 14px;
}

.plugin-card-main {
  min-width: 0;
  flex: 1;
}

.plugin-card-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.plugin-card-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--n-text-color-1);
}

.plugin-card-desc {
  font-size: 13px;
  color: var(--n-text-color-3);
  margin: 0 0 6px;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.plugin-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--n-text-color-4);
}

.meta-divider {
  color: var(--n-border-color);
}

.meta-active {
  display: inline-flex;
  align-items: center;
  color: var(--n-success-color);
}

.plugin-card-actions {
  display: flex;
  flex-direction: row;
  gap: 8px;
  flex-shrink: 0;
}

/* 减弱动态偏好：关闭进入动画与卡片位移 */
@media (prefers-reduced-motion: reduce) {
  .plugin-view-list,
  .plugin-detail {
    animation: none;
  }

  .plugin-card {
    transition: none;
  }
}

/* 详情视图 */
.plugin-detail {
  padding-bottom: 12px;
}

.detail-back-row {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}

.title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.title-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.plugin-name {
  font-size: 20px;
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
