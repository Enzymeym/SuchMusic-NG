<script setup lang="ts">
/**
 * 插件管理（设置页）
 *
 * 三种插件（v2 / 洛雪 / 澜音）合并成一个列表：
 * - 列表只做「安装 / 启停 / 移除 / 打开设置」，不再内嵌任何插件自绘界面。
 * - 所有配置都在独立的设置模态框（`PluginSettingsModal`）里完成，
 *   v2 插件渲染自己声明的 `settings` schema，洛雪/澜音渲染音乐源开关 + 音质。
 */
import { computed, onMounted, ref } from 'vue'
import { NButton, NDropdown, NInput, NModal, NTag, NTooltip, useMessage } from 'naive-ui'
import { usePluginStore, type PluginKind } from '../../../stores/pluginStore'
import { useSourcePluginStore } from '../../../stores/sourcePluginStore'
import PluginSettingsModal from '../PluginSettingsModal.vue'

const props = defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  highlightKey?: string | null
}>()

const pluginStore = usePluginStore()
const sourceStore = useSourcePluginStore()
const message = useMessage()

// ========== 统一列表模型 ==========

type StateTagType = 'default' | 'success' | 'error' | 'warning' | 'info'

interface UnifiedItem {
  /** 列表 key：kind:id，两类插件 id 可能撞车 */
  key: string
  kind: PluginKind
  id: string
  name: string
  version: string
  author?: string
  description?: string
  stateLabel: string
  stateType: StateTagType
  /** 当前是否生效（v2 = enabled 且 running，音源 = enabled） */
  enabled: boolean
  error?: string
  updateAlert?: { log?: string; updateUrl?: string }
  /** 能力摘要文本 */
  capability: string
  /** 声明了几个可配置项（v2） */
  settingCount: number
}

const kindLabel: Record<PluginKind, string> = { v2: '插件', lx: '洛雪', ceru: '澜音' }

const SOURCE_LABELS: Record<string, string> = {
  tx: 'QQ音乐',
  wy: '网易云音乐',
  kg: '酷狗音乐',
  kw: '酷我音乐',
  mg: '咪咕音乐',
  local: '本地音乐'
}

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

function canonicalSource(key?: string): string {
  const raw = (key || '').toLowerCase()
  return SOURCE_ALIASES[raw] ?? raw
}

function sourceLabel(key: string): string {
  return SOURCE_LABELS[canonicalSource(key)] ?? key
}

const ACTION_LABELS: Record<string, string> = {
  musicUrl: '播放',
  musicSearch: '搜索',
  musicLyric: '歌词',
  musicPic: '封面',
  lyric: '歌词',
  pic: '封面',
  search: '搜索',
  playlist: '歌单'
}

function actionSummary(actions: string[]): string {
  const seen: string[] = []
  for (const action of actions) {
    const label = ACTION_LABELS[action]
    if (label && !seen.includes(label)) seen.push(label)
  }
  return seen.join(' · ')
}

const v2Items = computed<UnifiedItem[]>(() =>
  pluginStore.plugins.map((plugin) => {
    const stateLabel =
      plugin.state === 'running' ? '运行中' : plugin.state === 'disabled' ? '已停用' : '错误'
    const stateType: StateTagType =
      plugin.state === 'running' ? 'success' : plugin.state === 'disabled' ? 'default' : 'error'

    const actions = new Set<string>()
    for (const source of plugin.sources ?? []) {
      for (const action of source.actions ?? []) actions.add(action)
    }
    const sourceNames = (plugin.sources ?? []).map((s) => sourceLabel(s.key)).join(' / ')
    const capability = [sourceNames, actionSummary([...actions])].filter(Boolean).join(' · ')

    return {
      key: `v2:${plugin.id}`,
      kind: 'v2' as PluginKind,
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      author: plugin.author,
      description: plugin.description,
      stateLabel,
      stateType,
      enabled: plugin.enabled,
      error: plugin.error,
      updateAlert: plugin.updateAlert,
      capability,
      settingCount: plugin.settingCount ?? 0
    }
  })
)

const sourceItems = computed<UnifiedItem[]>(() =>
  sourceStore.plugins.map((plugin) => {
    const stateLabel = !plugin.enabled
      ? '已停用'
      : plugin.state === 'error'
        ? '错误'
        : plugin.state === 'running'
          ? '运行中'
          : '已加载'
    const stateType: StateTagType = !plugin.enabled
      ? 'default'
      : plugin.state === 'error'
        ? 'error'
        : 'success'

    const sources = plugin.capabilities?.sources ?? []
    const actions = new Set<string>()
    for (const cap of sources) {
      for (const action of cap.actions ?? []) actions.add(action)
    }
    const sourceNames = sources.map((cap) => sourceLabel(cap.key)).join(' / ')
    const capability = [sourceNames, actionSummary([...actions])].filter(Boolean).join(' · ')

    return {
      key: `${plugin.kind}:${plugin.id}`,
      kind: plugin.kind as PluginKind,
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      author: plugin.author,
      description: plugin.description,
      stateLabel,
      stateType,
      enabled: plugin.enabled,
      error: plugin.error,
      updateAlert: plugin.updateAlert,
      capability,
      settingCount: 0
    }
  })
)

const allItems = computed<UnifiedItem[]>(() =>
  [...v2Items.value, ...sourceItems.value].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
)

// ========== 搜索 / 筛选 ==========

const filter = ref<'all' | 'v2' | 'source'>('all')
const keyword = ref('')

const counts = computed(() => ({
  all: allItems.value.length,
  v2: v2Items.value.length,
  source: sourceItems.value.length
}))

const filterOptions = computed(() => [
  { key: 'all' as const, label: '全部', count: counts.value.all },
  { key: 'v2' as const, label: '插件', count: counts.value.v2 },
  { key: 'source' as const, label: '音源插件', count: counts.value.source }
])

const visibleItems = computed<UnifiedItem[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  return allItems.value.filter((item) => {
    if (filter.value === 'v2' && item.kind !== 'v2') return false
    if (filter.value === 'source' && item.kind === 'v2') return false
    if (!kw) return true
    const text = [item.name, item.author, item.description, item.id, item.capability, kindLabel[item.kind]]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return text.includes(kw)
  })
})

const installedEmpty = computed(() => allItems.value.length === 0)
const listEmpty = computed(() => visibleItems.value.length === 0)

// ========== 导入 / 启停 / 移除 ==========

const adding = ref(false)

/** 统一导入：主进程按脚本头自动识别 v2 / 洛雪 / 澜音 */
async function handleImport(): Promise<void> {
  adding.value = true
  try {
    const picked = await window.api.plugins.selectFile()
    if (!picked.success || !picked.filePath) return
    const res = await pluginStore.importFromFile(picked.filePath)
    if (!res.ok) return
    if (res.kind === 'v2') {
      message.success('插件已安装')
    } else {
      // 洛雪 / 澜音由音源注册表接管，重新拉一次列表
      await sourceStore.refresh()
      message.success(`已导入${res.kind === 'lx' ? '洛雪' : '澜音'}音源插件`)
    }
    pluginStore.clearNotification()
  } finally {
    adding.value = false
  }
}

/** 启用 / 停用（两种插件共用入口） */
async function toggleEnabled(item: UnifiedItem, e?: Event): Promise<void> {
  e?.stopPropagation()
  const target = !item.enabled
  if (item.kind === 'v2') {
    const ok = await pluginStore.setEnabled(item.id, target)
    if (ok) message.success(target ? `已启用「${item.name}」` : `已停用「${item.name}」`)
    else {
      message.error(pluginStore.notification?.message || '操作失败')
      pluginStore.clearNotification()
    }
    return
  }
  const ok = await sourceStore.setEnabled(item.id, target)
  if (ok) message.success(target ? `已启用「${item.name}」` : `已停用「${item.name}」`)
  else {
    message.error(sourceStore.notification?.message || '操作失败')
    sourceStore.clearNotification()
  }
}

async function checkUpdate(item: UnifiedItem): Promise<void> {
  if (item.kind !== 'v2') return
  const res = await pluginStore.checkUpdate(item.id)
  if (res.hasNew) message.info(`发现新版本 v${res.version}，请下载新脚本后重新导入覆盖`)
  else message.success('已是最新版本（或插件未声明 @updateUrl）')
}

async function removeItem(item: UnifiedItem): Promise<void> {
  const ok =
    item.kind === 'v2' ? await pluginStore.remove(item.id) : await sourceStore.remove(item.id)
  if (ok) {
    if (pluginStore.settingsTarget?.pluginId === item.id) pluginStore.closeSettings()
    message.success(`已移除「${item.name}」`)
  } else {
    message.error('移除失败')
  }
}

function moreOptions(item: UnifiedItem): { label: string; key: string }[] {
  const options: { label: string; key: string }[] = []
  if (item.kind === 'v2') options.push({ label: '检查更新', key: 'update' })
  options.push({ label: '移除插件', key: 'remove' })
  return options
}

function handleMore(item: UnifiedItem, key: string): void {
  if (key === 'update') void checkUpdate(item)
  if (key === 'remove') void removeItem(item)
}

// ========== 设置模态框 ==========

const settingsShow = computed({
  get: () => !!pluginStore.settingsTarget,
  set: (value: boolean) => {
    if (!value) pluginStore.closeSettings()
  }
})

function openSettings(item: UnifiedItem): void {
  pluginStore.openSettings(item.id, item.kind)
}

// ========== 批量敏感操作确认 ==========

const showBatchConfirm = computed(() => !!pluginStore.pendingBatchConfirm)

async function respondConfirm(confirmed: boolean): Promise<void> {
  await pluginStore.respondBatchConfirm(confirmed)
}

// ========== 刷新 ==========

const refreshing = ref(false)

async function refreshAll(): Promise<void> {
  refreshing.value = true
  try {
    await Promise.all([pluginStore.refresh(), sourceStore.refresh()])
  } finally {
    refreshing.value = false
  }
}

// ========== 生命周期 ==========

onMounted(() => {
  pluginStore.initListeners()
  sourceStore.initListeners()
  void refreshAll()
})
</script>

<template>
  <div class="settings-content plugin-section-root">
    <!-- 页头 -->
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
      <n-button type="primary" size="medium" :loading="adding" @click="handleImport">
        <template #icon>
          <i class="mgc_plus_line" style="font-size: 15px"></i>
        </template>
        导入插件
      </n-button>
    </div>

    <!-- 工具条 -->
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
        选择插件脚本文件导入，支持 v2 插件、洛雪（LX）与澜音（Ceru）音源插件
      </p>
      <div class="plugin-empty-actions">
        <n-button type="primary" size="medium" :loading="adding" @click="handleImport">
          <template #icon>
            <i class="mgc_plus_line" style="font-size: 14px"></i>
          </template>
          导入插件
        </n-button>
      </div>
    </div>

    <!-- 空状态：筛选 / 搜索无结果 -->
    <div v-else-if="listEmpty" class="plugin-empty plugin-empty--compact">
      <i class="mgc_search_line plugin-empty-icon-sm"></i>
      <p class="plugin-empty-title">没有符合条件的插件</p>
      <p class="plugin-empty-desc">换个关键词，或切换上方的筛选条件</p>
    </div>

    <!-- 插件列表 -->
    <div v-else class="plugin-list">
      <div
        v-for="item in visibleItems"
        :key="item.key"
        class="plugin-card"
        :style="{
          backgroundColor: props.settingItemBgColor,
          borderColor: props.settingItemBorderColor
        }"
        @click="openSettings(item)"
      >
        <div class="plugin-card-row">
          <div class="plugin-card-main">
            <div class="plugin-card-title-row">
              <span class="plugin-card-name">{{ item.name }}</span>
              <span class="plugin-kind-badge" :class="`badge-${item.kind}`">
                {{ kindLabel[item.kind] }}
              </span>
              <span class="plugin-card-version">v{{ item.version }}</span>
              <n-tag :type="item.stateType" size="tiny" round :bordered="false">
                {{ item.stateLabel }}
              </n-tag>
            </div>

            <p class="plugin-card-desc">{{ item.description || '暂无描述' }}</p>

            <div class="plugin-card-meta">
              <span v-if="item.author" class="meta-item">{{ item.author }}</span>
              <span v-if="item.author && item.capability" class="meta-divider">·</span>
              <span v-if="item.capability" class="meta-item">{{ item.capability }}</span>
              <span v-if="item.kind === 'v2' && item.settingCount > 0" class="meta-item">
                <i class="mgc_settings_3_line" style="font-size: 11px; margin-right: 3px"></i>
                {{ item.settingCount }} 项设置
              </span>
            </div>

            <p v-if="item.error" class="plugin-card-error">{{ item.error }}</p>
            <p v-if="item.updateAlert?.log" class="plugin-card-update">
              {{ item.updateAlert.log }}
              <a
                v-if="item.updateAlert?.updateUrl"
                :href="item.updateAlert.updateUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="plugin-card-update-link"
                @click.stop
                >前往更新</a
              >
            </p>
          </div>

          <div class="plugin-card-actions" @click.stop>
            <n-tooltip placement="top" :show-arrow="false">
              <template #trigger>
                <n-button
                  class="icon-action"
                  :class="{ 'is-on': item.enabled }"
                  quaternary
                  circle
                  size="small"
                  @click="toggleEnabled(item, $event)"
                >
                  <i class="mgc_power_line"></i>
                </n-button>
              </template>
              {{ item.enabled ? '停用' : '启用' }}
            </n-tooltip>

            <n-tooltip placement="top" :show-arrow="false">
              <template #trigger>
                <n-button class="icon-action" quaternary circle size="small" @click="openSettings(item)">
                  <i class="mgc_settings_3_line"></i>
                </n-button>
              </template>
              设置
            </n-tooltip>

            <n-dropdown
              trigger="click"
              placement="bottom-end"
              :options="moreOptions(item)"
              @select="(key: string) => handleMore(item, key)"
            >
              <n-button class="icon-action" quaternary circle size="small">
                <i class="mgc_more_2_line"></i>
              </n-button>
            </n-dropdown>
          </div>
        </div>
      </div>
    </div>

    <!-- 插件设置模态框（v2 声明式表单 / 洛雪澜音音乐源） -->
    <PluginSettingsModal
      :show="settingsShow"
      :plugin-id="pluginStore.settingsTarget?.pluginId ?? null"
      :kind="pluginStore.settingsTarget?.kind ?? 'v2'"
      @update:show="(v: boolean) => (settingsShow = v)"
    />

    <!-- 敏感操作批量确认 -->
    <n-modal
      :show="showBatchConfirm"
      preset="dialog"
      title="插件权限确认"
      positive-text="全部允许"
      negative-text="全部拒绝"
      :closable="false"
      :mask-closable="false"
      @positive-click="respondConfirm(true)"
      @negative-click="respondConfirm(false)"
    >
      <div class="confirm-body">
        <p class="confirm-title">
          插件 <strong>{{ pluginStore.pendingBatchConfirm?.pluginName }}</strong> 请求执行以下
          {{ pluginStore.pendingBatchConfirm?.operations?.length || 0 }} 项敏感操作：
        </p>
        <div
          v-for="(op, idx) in pluginStore.pendingBatchConfirm?.operations || []"
          :key="op.opId"
          class="confirm-item"
        >
          <div class="confirm-item-head">
            <n-tag type="warning" size="tiny" round>{{ op.operation }}</n-tag>
            <span class="confirm-index">#{{ Number(idx) + 1 }}</span>
          </div>
          <p class="confirm-detail">{{ op.detail }}</p>
        </div>
        <p class="confirm-hint">
          「执行程序 / 读写文件」类操作只应在你信任该插件时允许。
        </p>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
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
  transition:
    background-color 0.16s ease,
    color 0.16s ease;
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
  cursor: pointer;
  transition:
    border-color 0.18s ease,
    transform 0.18s ease,
    box-shadow 0.18s ease;
}

.plugin-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.12);
}

.plugin-card:active {
  transform: scale(0.995);
}

.plugin-card-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

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

.badge-v2 {
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
html[data-theme='light'] .badge-v2 {
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

/* ========== 确认弹窗 ========== */
.confirm-body {
  padding: 6px 0;
}

.confirm-title {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--n-text-color-2);
}

.confirm-item {
  padding: 8px 12px;
  margin-bottom: 6px;
  border-radius: 8px;
  background: var(--n-color-embedded);
  border-left: 3px solid var(--n-warning-color);
}

.confirm-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.confirm-index {
  font-size: 12px;
  color: var(--n-text-color-4);
}

.confirm-detail {
  margin: 0;
  font-size: 12px;
  color: var(--n-text-color-3);
  word-break: break-all;
}

.confirm-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--n-text-color-4);
}

@media (prefers-reduced-motion: reduce) {
  .plugin-card {
    transition: none;
  }
}
</style>
