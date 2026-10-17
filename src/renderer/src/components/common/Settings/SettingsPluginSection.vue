<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import {
  NCard,
  NButton,
  NTag,
  NSpace,
  NModal,
  NTabs,
  NTabPane,
  NSelect,
  NInput,
  NDropdown,
  NTooltip,
  useMessage
} from 'naive-ui'
import { usePluginStore, type PluginInfo } from '../../../stores/pluginStore'
import {
  useSourcePluginStore,
  type SourcePluginInfo,
  type SourceCapability
} from '../../../stores/sourcePluginStore'
import PluginRenderer from '../PluginRenderer.vue'

const props = defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  highlightKey?: string | null
}>()

const pluginStore = usePluginStore()
const sourceStore = useSourcePluginStore()
const message = useMessage()

/** 当前选中的插件 ID，null 表示列表视图（仅应用插件有详情页） */
const selectedPluginId = ref<string | null>(null)

/** 状态标签配置（应用插件） */
const stateConfig: Record<string, { type: 'success' | 'error' | 'warning' | 'info'; label: string }> = {
  running: { type: 'success', label: '运行中' },
  loaded: { type: 'info', label: '已加载' },
  error: { type: 'error', label: '错误' },
  unloaded: { type: 'warning', label: '已卸载' }
}

// ========== 统一插件模型（应用插件 + 音源插件合并成一个列表） ==========

type PluginKind = 'app' | 'lx' | 'ceru'
type PluginStateType = 'success' | 'error' | 'warning' | 'info' | 'default'

interface UnifiedPlugin {
  /** 列表 key：kind:id，避免两类插件 id 撞车 */
  key: string
  kind: PluginKind
  id: string
  name: string
  version: string
  author?: string
  description?: string
  stateLabel: string
  stateType: PluginStateType
  /** 是否处于「可用」状态（应用插件=已加载，音源插件=已启用） */
  active: boolean
  error?: string
  updateAlert?: { log?: string; updateUrl?: string }
  app?: PluginInfo
  source?: SourcePluginInfo
}

const kindLabel: Record<PluginKind, string> = { app: '应用', lx: '洛雪', ceru: '澜音' }

/** 音源平台显示名（洛雪 key / 澜音 providerId 都收敛到同一套名字） */
const SOURCE_ALIASES: Record<string, string> = {
  qq: 'tx',
  tencent: 'tx',
  qqmusic: 'tx',
  netease: 'wy',
  wangyi: 'wy',
  cloudmusic: 'wy',
  kugou: 'kg',
  kuwo: 'kw',
  migu: 'mg',
  localmusic: 'local'
}

const SOURCE_LABELS: Record<string, string> = {
  tx: 'QQ音乐',
  wy: '网易云音乐',
  kg: '酷狗音乐',
  kw: '酷我音乐',
  mg: '咪咕音乐',
  local: '本地音乐'
}

const QUALITY_LABELS: Record<string, string> = {
  '128k': '标准 128k',
  '320k': '较高 320k',
  flac: '无损 FLAC',
  flac24bit: '无损 24bit',
  hires: 'Hi-Res',
  atmos: '杜比全景声',
  atmos_plus: '全景声 Plus',
  master: '母带'
}

/** 音质从低到高排列，用于音质下拉的选项顺序 */
const QUALITY_ORDER = ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master']

function canonicalSource(key?: string): string {
  const raw = (key || '').toLowerCase()
  return SOURCE_ALIASES[raw] ?? raw
}

function sourceLabel(key: string): string {
  return SOURCE_LABELS[canonicalSource(key)] ?? key
}

function sourceCaps(plugin?: SourcePluginInfo | null): SourceCapability[] {
  return plugin?.capabilities?.sources ?? []
}

function appStateOf(plugin: PluginInfo): { label: string; type: PluginStateType } {
  const cfg = stateConfig[plugin.state]
  return cfg ? { label: cfg.label, type: cfg.type } : { label: plugin.state, type: 'info' }
}

function sourceStateOf(plugin: SourcePluginInfo): { label: string; type: PluginStateType } {
  if (!plugin.enabled || plugin.state === 'disabled') return { label: '已关闭', type: 'default' }
  if (plugin.state === 'error') return { label: '错误', type: 'error' }
  if (plugin.state === 'running') return { label: '运行中', type: 'success' }
  return { label: '已加载', type: 'info' }
}

function toUnified(plugin: PluginInfo | SourcePluginInfo, kind: PluginKind): UnifiedPlugin {
  if (kind === 'app') {
    const app = plugin as PluginInfo
    const state = appStateOf(app)
    return {
      key: `app:${app.id}`,
      kind: 'app',
      id: app.id,
      name: app.name,
      version: app.version,
      author: app.author,
      description: app.description,
      stateLabel: state.label,
      stateType: state.type,
      active: app.state === 'running' || app.state === 'loaded',
      app
    }
  }
  const source = plugin as SourcePluginInfo
  const state = sourceStateOf(source)
  return {
    key: `source:${source.id}`,
    kind,
    id: source.id,
    name: source.name,
    version: source.version,
    author: source.author,
    description: source.description,
    stateLabel: state.label,
    stateType: state.type,
    active: source.enabled && source.state === 'running',
    error: source.error,
    updateAlert: source.updateAlert,
    source
  }
}

const unifiedPlugins = computed<UnifiedPlugin[]>(() => {
  const apps = pluginStore.plugins.map((p) => toUnified(p, 'app'))
  const sources = sourceStore.plugins.map((p) => toUnified(p, p.kind))
  // 可用插件排前面，同类按名称排序，让「正在生效的」一眼可见
  return [...apps, ...sources].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
})

// ========== 搜索 + 分段筛选 ==========

/** 筛选：全部 / 应用插件 / 音源插件 */
const filter = ref<'all' | 'app' | 'source'>('all')
const keyword = ref('')

const counts = computed(() => ({
  all: unifiedPlugins.value.length,
  app: pluginStore.plugins.length,
  source: sourceStore.plugins.length
}))

const filterOptions = computed(() => [
  { key: 'all' as const, label: '全部', count: counts.value.all },
  { key: 'app' as const, label: '应用插件', count: counts.value.app },
  { key: 'source' as const, label: '音源插件', count: counts.value.source }
])

/** 拼装可搜索文本：名称 / 作者 / 描述 / 类型 / 平台名 / 插件 ID */
function searchTextOf(plugin: UnifiedPlugin): string {
  const parts = [
    plugin.name,
    plugin.author,
    plugin.description,
    plugin.id,
    kindLabel[plugin.kind]
  ]
  if (plugin.source) {
    for (const cap of sourceCaps(plugin.source)) {
      parts.push(cap.key, cap.name, sourceLabel(cap.key))
    }
  }
  return parts.filter(Boolean).join(' ').toLowerCase()
}

const visiblePlugins = computed<UnifiedPlugin[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  return unifiedPlugins.value.filter((plugin) => {
    if (filter.value === 'app' && plugin.kind !== 'app') return false
    if (filter.value === 'source' && plugin.kind === 'app') return false
    if (!kw) return true
    return searchTextOf(plugin).includes(kw)
  })
})

const listEmpty = computed(() => visiblePlugins.value.length === 0)
const installedEmpty = computed(() => unifiedPlugins.value.length === 0)

// ========== 音源插件的「音乐源 / 音质」设置（每个插件独立） ==========

/** 该插件是否启用了指定音乐源 */
function isSourceOn(plugin: SourcePluginInfo | null | undefined, key: string): boolean {
  if (!plugin) return false
  const list = plugin.settings?.sources
  if (!Array.isArray(list)) return true
  const target = canonicalSource(key)
  return list.some((item) => canonicalSource(item) === target)
}

/** 点击平台标签：切换该音乐源的启用状态 */
async function toggleSource(
  plugin: SourcePluginInfo | null | undefined,
  key: string,
  e?: Event
): Promise<void> {
  e?.stopPropagation()
  if (!plugin) return
  const declared = sourceCaps(plugin).map((s) => s.key)
  if (declared.length === 0) return
  const current = plugin.settings?.sources
  const enabled = new Set(
    (Array.isArray(current) ? current : declared).map((item) => canonicalSource(item))
  )
  const target = canonicalSource(key)
  if (enabled.has(target)) enabled.delete(target)
  else enabled.add(target)

  const next = declared.filter((item) => enabled.has(canonicalSource(item)))
  // 全部启用时存 null，避免以后插件新增音源被旧的显式白名单挡住
  const patch = next.length === declared.length ? null : next
  const ok = await sourceStore.setPreferences(plugin.id, { sources: patch })
  if (!ok) {
    message.error(sourceStore.notification?.message || '保存设置失败')
    sourceStore.clearNotification()
  }
}

/** 音质下拉选项：跟随全局 + 插件声明的音质 */
function qualityOptions(plugin?: SourcePluginInfo | null) {
  const declared = new Set<string>()
  for (const cap of sourceCaps(plugin)) {
    for (const q of cap.qualities ?? []) declared.add(q)
  }
  for (const provider of plugin?.capabilities?.providers ?? []) {
    for (const q of provider.qualities ?? []) declared.add(q)
  }
  const options = QUALITY_ORDER.filter((q) => declared.has(q)).map((q) => ({
    label: QUALITY_LABELS[q] ?? q,
    value: q
  }))
  return [{ label: '跟随全局', value: '' }, ...options]
}

/** 当前音质（空字符串表示跟随全局） */
function currentQuality(plugin?: SourcePluginInfo | null): string {
  return plugin?.settings?.quality ?? ''
}

async function changeQuality(
  plugin: SourcePluginInfo | null | undefined,
  value: string
): Promise<void> {
  if (!plugin) return
  const ok = await sourceStore.setPreferences(plugin.id, { quality: value || null })
  if (!ok) {
    message.error(sourceStore.notification?.message || '保存设置失败')
    sourceStore.clearNotification()
  }
}

/** 已关闭全部音乐源时给出提示 */
function allSourcesOff(plugin?: SourcePluginInfo | null): boolean {
  const list = plugin?.settings?.sources
  return Array.isArray(list) && list.length === 0
}

/** 插件能力摘要（播放 / 歌词 / 搜索 / 歌单） */
function capabilityText(plugin?: SourcePluginInfo | null): string {
  const actions = new Set<string>()
  for (const cap of sourceCaps(plugin)) {
    for (const action of cap.actions ?? []) actions.add(action)
  }
  const labels: string[] = []
  if (actions.has('musicUrl')) labels.push('播放')
  if (actions.has('lyric')) labels.push('歌词')
  if (actions.has('search')) labels.push('搜索')
  if (actions.has('playlist')) labels.push('歌单')
  return labels.join(' · ')
}

// ========== 列表操作（两种插件共用） ==========

/** 添加插件：应用插件 / 音源插件 */
const addOptions = [
  { label: '应用插件（.ts / .js）', key: 'app' },
  { label: '音源插件（洛雪 / 澜音）', key: 'source' }
]

const adding = ref(false)

async function handleAddSelect(key: string): Promise<void> {
  if (key === 'source') {
    adding.value = true
    try {
      const { ok, canceled } = await sourceStore.selectAndLoad()
      if (ok) message.success('音源插件加载成功')
      else if (!canceled) message.error(sourceStore.notification?.message || '音源插件加载失败')
      sourceStore.clearNotification()
    } finally {
      adding.value = false
    }
    return
  }
  if (await pluginStore.selectAndLoadPlugin()) message.success('插件加载成功')
}

/** 移除插件 */
async function removePlugin(plugin: PluginInfo, e?: Event): Promise<void> {
  e?.stopPropagation()
  const ok = await pluginStore.removePlugin(plugin.id)
  if (ok) {
    if (selectedPluginId.value === plugin.id) selectedPluginId.value = null
    message.success(`插件 "${plugin.name}" 已移除`)
  } else {
    message.error('移除失败')
  }
}

async function removeSourcePlugin(plugin: SourcePluginInfo, e?: Event): Promise<void> {
  e?.stopPropagation()
  const ok = await sourceStore.remove(plugin.id)
  message[ok ? 'success' : 'error'](ok ? `已移除 "${plugin.name}"` : '移除失败')
}

/** 设置活跃插件（应用插件） */
async function toggleActive(
  plugin: PluginInfo | null | undefined,
  e?: Event
): Promise<void> {
  e?.stopPropagation()
  if (!plugin) return
  const ok = await pluginStore.setActivePlugin(plugin.isActive ? null : plugin.id)
  if (ok) message.success(plugin.isActive ? '已取消激活' : `已激活 "${plugin.name}"`)
}

/** 启用 / 关闭音源插件 */
async function toggleSourceEnabled(
  plugin: SourcePluginInfo | null | undefined,
  e?: Event
): Promise<void> {
  e?.stopPropagation()
  if (!plugin) return
  const ok = await sourceStore.setEnabled(plugin.id, !plugin.enabled)
  if (ok) {
    message.success(plugin.enabled ? `已关闭 "${plugin.name}"` : `已启用 "${plugin.name}"`)
  } else {
    message.error(sourceStore.notification?.message || '操作失败')
    sourceStore.clearNotification()
  }
}

/** 刷新两类插件列表 */
const refreshing = ref(false)
async function refreshAll(): Promise<void> {
  refreshing.value = true
  try {
    await Promise.all([pluginStore.refreshPluginList(), sourceStore.refresh()])
  } finally {
    refreshing.value = false
  }
}

/** 卡片「更多」菜单 */
function moreOptions(plugin: UnifiedPlugin) {
  if (plugin.kind === 'app') {
    return [
      { label: '查看详情', key: 'detail' },
      { label: '检查更新', key: 'update' },
      { label: '移除插件', key: 'remove' }
    ]
  }
  return [{ label: '移除插件', key: 'remove' }]
}

async function handleMore(plugin: UnifiedPlugin, key: string): Promise<void> {
  if (key === 'detail' && plugin.app) {
    goDetail(plugin.app)
    return
  }
  if (key === 'update' && plugin.app) {
    try {
      const result = await pluginStore.checkPluginUpdate(plugin.app.id)
      if (result?.hasNew) message.info(`发现新版本 v${result.version}`)
      else message.success('当前已是最新版本')
    } catch {
      message.error('检查更新失败')
    }
    return
  }
  if (key === 'remove') {
    if (plugin.app) await removePlugin(plugin.app)
    else if (plugin.source) await removeSourcePlugin(plugin.source)
  }
}

/** 进入插件详情（仅应用插件） */
function goDetail(plugin: PluginInfo): void {
  selectedPluginId.value = plugin.id
  activeTab.value = 'interface'
}

function openPermissions(plugin: PluginInfo | null | undefined, e?: Event): void {
  e?.stopPropagation()
  if (!plugin) return
  selectedPluginId.value = plugin.id
  activeTab.value = 'info'
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
  const ok = await pluginStore.setActivePlugin(p.isActive ? null : p.id)
  if (ok) message.success(p.isActive ? '已取消激活' : '已激活')
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
  sourceStore.initListeners()
  sourceStore.refresh()

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
      <!-- 页头：标题 + 已安装数量 + 添加插件 -->
      <div class="plugin-header" data-setting-key="plugins.manage">
        <div class="plugin-header-text">
          <div class="plugin-header-title">插件管理</div>
          <div class="plugin-header-sub">
            已安装 {{ counts.all }} 个插件
            <span v-if="counts.source > 0" class="plugin-header-sub-extra">
              · 音源 {{ counts.source }}
            </span>
          </div>
        </div>
        <n-dropdown trigger="click" :options="addOptions" @select="handleAddSelect">
          <n-button type="primary" size="medium" :loading="adding">
            <template #icon>
              <i class="mgc_plus_line" style="font-size: 15px"></i>
            </template>
            <span class="add-btn-label">
              添加插件
              <i class="mgc_down_line add-btn-chevron"></i>
            </span>
          </n-button>
        </n-dropdown>
      </div>

      <!-- 工具条：搜索 / 分段筛选 / 刷新 -->
      <div class="plugin-toolbar">
        <n-input
          v-model:value="keyword"
          class="plugin-search"
          placeholder="搜索插件名称、作者或平台"
          clearable
        >
          <template #prefix>
            <i class="mgc_search_line" style="font-size: 15px; opacity: 0.7"></i>
          </template>
        </n-input>

        <div class="segmented" role="tablist">
          <button
            v-for="opt in filterOptions"
            :key="opt.key"
            type="button"
            role="tab"
            class="segmented-item"
            :class="{ active: filter === opt.key }"
            :aria-selected="filter === opt.key"
            @click="filter = opt.key"
          >
            <span class="segmented-label">{{ opt.label }}</span>
            <span class="segmented-count">{{ opt.count }}</span>
          </button>
        </div>

        <n-button class="plugin-refresh" quaternary :loading="refreshing" @click="refreshAll">
          <template #icon>
            <i class="mgc_refresh_2_line" style="font-size: 15px"></i>
          </template>
          刷新
        </n-button>
      </div>

      <!-- 空状态：一个插件都没有 -->
      <div v-if="installedEmpty" class="plugin-empty">
        <div class="plugin-empty-icon">
          <i class="mgc_extension_line"></i>
        </div>
        <p class="plugin-empty-title">暂无插件</p>
        <p class="plugin-empty-desc">
          应用插件（.ts / .js）用于扩展功能；音源插件（洛雪 / 澜音）用于搜索与播放
        </p>
        <div class="plugin-empty-actions">
          <n-button type="primary" size="medium" @click="handleAddSelect('app')">
            <template #icon>
              <i class="mgc_plus_line" style="font-size: 14px"></i>
            </template>
            添加应用插件
          </n-button>
          <n-button size="medium" secondary @click="handleAddSelect('source')">
            <template #icon>
              <i class="mgc_plus_line" style="font-size: 14px"></i>
            </template>
            添加音源插件
          </n-button>
        </div>
      </div>

      <!-- 空状态：筛选/搜索无结果 -->
      <div v-else-if="listEmpty" class="plugin-empty plugin-empty--compact">
        <i class="mgc_search_line plugin-empty-icon-sm"></i>
        <p class="plugin-empty-title">没有符合条件的插件</p>
        <p class="plugin-empty-desc">换个关键词，或切换上方的筛选条件</p>
      </div>

      <!-- 合并后的插件列表 -->
      <div v-else class="plugin-list">
        <div
          v-for="plugin in visiblePlugins"
          :key="plugin.key"
          class="plugin-card"
          :class="[`is-${plugin.kind}`, { 'is-clickable': plugin.kind === 'app' }]"
          :style="{
            backgroundColor: props.settingItemBgColor,
            borderColor: props.settingItemBorderColor
          }"
          @click="plugin.kind === 'app' && plugin.app ? goDetail(plugin.app) : undefined"
        >
          <div class="plugin-card-row">
            <!-- 主体 -->
            <div class="plugin-card-main">
              <div class="plugin-card-title-row">
                <span class="plugin-card-name">{{ plugin.name }}</span>
                <span class="plugin-kind-badge" :class="`badge-${plugin.kind}`">
                  {{ kindLabel[plugin.kind] }}
                </span>
                <span class="plugin-card-version">v{{ plugin.version }}</span>
                <n-tag :type="plugin.stateType" size="tiny" round :bordered="false">
                  {{ plugin.stateLabel }}
                </n-tag>
                <n-tag
                  v-if="plugin.app?.isActive"
                  type="success"
                  size="tiny"
                  round
                  :bordered="false"
                >
                  已激活
                </n-tag>
              </div>

              <p class="plugin-card-desc">{{ plugin.description || '暂无描述' }}</p>

              <!-- 音源插件：每个插件独立的音乐源开关 + 音质 -->
              <div v-if="plugin.source" class="plugin-source-settings">
                <div class="source-chips">
                  <span class="source-chips-label">音乐源</span>
                  <button
                    v-for="cap in sourceCaps(plugin.source)"
                    :key="cap.key"
                    type="button"
                    class="source-chip"
                    :class="{ off: !isSourceOn(plugin.source, cap.key) }"
                    :title="
                      isSourceOn(plugin.source, cap.key)
                        ? `点击关闭「${sourceLabel(cap.key)}」`
                        : `点击启用「${sourceLabel(cap.key)}」`
                    "
                    @click="toggleSource(plugin.source, cap.key, $event)"
                  >
                    <i v-if="isSourceOn(plugin.source, cap.key)" class="mgc_check_line"></i>
                    {{ sourceLabel(cap.key) }}
                  </button>
                  <span v-if="allSourcesOff(plugin.source)" class="source-chips-warning">
                    全部音乐源已关闭，该插件暂不参与解析
                  </span>
                </div>

                <div class="source-quality">
                  <span class="source-chips-label">音质</span>
                  <n-select
                    size="tiny"
                    class="source-quality-select"
                    :value="currentQuality(plugin.source)"
                    :options="qualityOptions(plugin.source)"
                    :disabled="!plugin.source?.enabled"
                    @update:value="(v: string) => changeQuality(plugin.source, v)"
                  />
                </div>
              </div>

              <!-- 底部信息 -->
              <div class="plugin-card-meta">
                <span v-if="plugin.author" class="meta-item">{{ plugin.author }}</span>
                <template v-if="plugin.author && plugin.source">
                  <span class="meta-divider">·</span>
                </template>
                <span v-if="plugin.source" class="meta-item">
                  {{ capabilityText(plugin.source) || '音源插件' }}
                </span>
                <span v-if="!plugin.source" class="meta-item">
                  {{ plugin.app?.isUIWidget ? 'UI 插件' : '功能插件' }}
                </span>
                <span v-if="plugin.app?.permissions?.length" class="meta-item meta-perm">
                  <i class="mgc_shield_line" style="font-size: 11px; margin-right: 3px"></i>
                  {{ plugin.app.permissions.length }} 项权限
                </span>
              </div>

              <p v-if="plugin.error" class="plugin-card-error">{{ plugin.error }}</p>
              <p v-if="plugin.updateAlert?.log" class="plugin-card-update">
                {{ plugin.updateAlert.log }}
                <a
                  v-if="plugin.updateAlert?.updateUrl"
                  :href="plugin.updateAlert.updateUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="plugin-card-update-link"
                  @click.stop
                  >前往更新</a
                >
              </p>
            </div>

            <!-- 操作区：统一用 MingCute 图标按钮 + 悬浮说明 -->
            <div class="plugin-card-actions" @click.stop>
              <n-tooltip v-if="plugin.app" placement="top" :show-arrow="false">
                <template #trigger>
                  <n-button
                    class="icon-action"
                    :class="{ 'is-on': plugin.app.isActive }"
                    quaternary
                    circle
                    size="small"
                    @click="toggleActive(plugin.app, $event)"
                  >
                    <i class="mgc_power_line"></i>
                  </n-button>
                </template>
                {{ plugin.app.isActive ? '取消激活' : '激活' }}
              </n-tooltip>

              <n-tooltip v-if="plugin.app" placement="top" :show-arrow="false">
                <template #trigger>
                  <n-button
                    class="icon-action"
                    quaternary
                    circle
                    size="small"
                    @click="openPermissions(plugin.app, $event)"
                  >
                    <i class="mgc_shield_line"></i>
                  </n-button>
                </template>
                权限
              </n-tooltip>

              <n-tooltip v-if="plugin.source" placement="top" :show-arrow="false">
                <template #trigger>
                  <n-button
                    class="icon-action"
                    :class="{ 'is-on': plugin.source.enabled }"
                    quaternary
                    circle
                    size="small"
                    @click="toggleSourceEnabled(plugin.source, $event)"
                  >
                    <i class="mgc_power_line"></i>
                  </n-button>
                </template>
                {{ plugin.source.enabled ? '关闭插件' : '启用插件' }}
              </n-tooltip>

              <n-dropdown
                trigger="click"
                placement="bottom-end"
                :options="moreOptions(plugin)"
                @select="(key: string) => handleMore(plugin, key)"
              >
                <n-button class="icon-action" quaternary circle size="small">
                  <i class="mgc_more_2_line"></i>
                </n-button>
              </n-dropdown>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 详情视图（仅应用插件） -->
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

/* ========== 页头 ========== */
.plugin-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin: 8px 0 16px;
}

.plugin-header-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--n-text-color-1);
  line-height: 1.3;
}

.plugin-header-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--n-text-color-3);
}

.plugin-header-sub-extra {
  color: var(--n-text-color-4);
}

.add-btn-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.add-btn-chevron {
  font-size: 12px;
  opacity: 0.85;
}

/* ========== 工具条 ========== */
.plugin-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.plugin-search {
  flex: 1 1 260px;
  min-width: 200px;
}

/* 分段选择器 */
.segmented {
  display: inline-flex;
  align-items: center;
  padding: 3px;
  gap: 2px;
  border-radius: 10px;
  background: rgba(128, 128, 128, 0.12);
  flex-shrink: 0;
}

.segmented-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--n-text-color-3);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
  font-family: inherit;
}

.segmented-item:hover {
  color: var(--n-text-color-1);
}

.segmented-item.active {
  background: rgba(128, 128, 128, 0.28);
  color: var(--n-text-color-1);
}

.segmented-count {
  font-size: 11px;
  color: var(--n-text-color-4);
  font-variant-numeric: tabular-nums;
}

.segmented-item.active .segmented-count {
  color: var(--n-text-color-2);
}

.plugin-refresh {
  flex-shrink: 0;
}

/* ========== 空状态 ========== */
.plugin-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 0;
  gap: 8px;
}

.plugin-empty--compact {
  padding: 32px 0;
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

.plugin-empty-icon-sm {
  font-size: 30px;
  color: var(--n-text-color-4);
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
  text-align: center;
  max-width: 460px;
}

.plugin-empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

/* ========== 插件列表 ========== */
.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.plugin-card {
  padding: 14px 16px;
  border: 1px solid transparent;
  border-radius: 12px;
  transition: border-color 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
}

.plugin-card.is-clickable {
  cursor: pointer;
}

.plugin-card.is-clickable:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.12);
}

.plugin-card.is-clickable:active {
  transform: scale(0.995);
}

.plugin-card-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

/* 主体 */
.plugin-card-main {
  min-width: 0;
  flex: 1;
}

.plugin-card-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}

.plugin-card-name {
  font-size: 15px;
  font-weight: 650;
  color: var(--n-text-color-1);
}

.plugin-card-version {
  font-size: 12px;
  color: var(--n-text-color-4);
  font-variant-numeric: tabular-nums;
}

.plugin-kind-badge {
  height: 18px;
  padding: 0 7px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  line-height: 1;
  letter-spacing: 0.2px;
}

.badge-app {
  color: #a9b6ff;
  background: rgba(91, 140, 255, 0.16);
}

.badge-lx {
  color: #6ee7b7;
  background: rgba(52, 211, 153, 0.16);
}

.badge-ceru {
  color: #93c5fd;
  background: rgba(56, 189, 248, 0.16);
}

/* 浅色模式下徽标文字需要更深，否则在浅底上对比度不足 */
html[data-theme='light'] .badge-app {
  color: #3b5bdb;
  background: rgba(91, 140, 255, 0.14);
}

html[data-theme='light'] .badge-lx {
  color: #0b8f5f;
  background: rgba(16, 185, 129, 0.14);
}

html[data-theme='light'] .badge-ceru {
  color: #1f6feb;
  background: rgba(56, 189, 248, 0.16);
}

.plugin-card-desc {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--n-text-color-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 音源插件的音乐源 / 音质设置：音乐源在上，音质在下 */
.plugin-source-settings {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin: 0 0 8px;
}

.source-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.source-chips-label {
  font-size: 11px;
  color: var(--n-text-color-4);
  margin-right: 2px;
  flex-shrink: 0;
  /* 让「音乐源 / 音质」两行左对齐后控件起点一致 */
  min-width: 34px;
}

.source-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid rgba(128, 128, 128, 0.22);
  background: rgba(128, 128, 128, 0.12);
  color: var(--n-text-color-2);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  transition: background-color 0.16s ease, opacity 0.16s ease, border-color 0.16s ease;
  font-family: inherit;
}

.source-chip i {
  font-size: 11px;
  color: var(--n-primary-color);
}

.source-chip:hover {
  background: rgba(128, 128, 128, 0.22);
}

.source-chip.off {
  background: transparent;
  border-style: dashed;
  color: var(--n-text-color-4);
  opacity: 0.72;
}

.source-chip.off:hover {
  opacity: 1;
}

.source-chips-warning {
  font-size: 11px;
  color: var(--n-warning-color, #f0a020);
}

.source-quality {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.source-quality-select {
  width: 118px;
}

/* 底部信息 */
.plugin-card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--n-text-color-4);
}

.meta-divider {
  color: var(--n-border-color);
}

.meta-perm {
  display: inline-flex;
  align-items: center;
}

.plugin-card-error {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--n-error-color, #d03050);
  word-break: break-word;
}

.plugin-card-update {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--n-warning-color, #f0a020);
  word-break: break-word;
}

.plugin-card-update-link {
  margin-left: 6px;
  color: var(--n-primary-color, #2c8efd);
}

/* 操作区 */
.plugin-card-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

/* 图标按钮：默认弱化，悬浮显现；生效状态用主色区分 */
.icon-action i {
  font-size: 17px;
  color: var(--n-text-color-3);
  transition: color 0.16s ease;
}

.icon-action:hover i {
  color: var(--n-text-color-1);
}

.icon-action.is-on i {
  color: var(--n-primary-color);
}

/* 减弱动态偏好 */
@media (prefers-reduced-motion: reduce) {
  .plugin-view-list,
  .plugin-detail {
    animation: none;
  }

  .plugin-card {
    transition: none;
  }
}

/* ========== 详情视图 ========== */
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
