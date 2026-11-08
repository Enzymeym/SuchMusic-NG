<script setup lang="ts">
/**
 * 插件设置模态框
 *
 * 取代旧的「JSON UI Schema 动态渲染」：插件不再提供界面代码，
 * 只在初始化时声明设置项（switch / number / text / select），这里渲染成表单。
 * 洛雪 / 澜音插件没有声明式 schema，用同一套控件展示「音乐源开关 + 首选音质」。
 */
import { computed, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NInput,
  NInputNumber,
  NModal,
  NScrollbar,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  useMessage,
  useThemeVars
} from 'naive-ui'
import { usePluginStore, type PluginKind } from '../../stores/pluginStore'
import { useSourcePluginStore } from '../../stores/sourcePluginStore'
import type { PluginLogEntry, SettingField, V2PluginSummary } from '../../../../shared/plugin/types'

const props = defineProps<{
  show: boolean
  pluginId: string | null
  kind: PluginKind
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
}>()

const themeVars = useThemeVars()
const message = useMessage()
const pluginStore = usePluginStore()
const sourceStore = useSourcePluginStore()

// ========== 数据来源 ==========

const v2Plugin = computed<V2PluginSummary | null>(
  () => pluginStore.plugins.find((p) => p.id === props.pluginId) ?? null
)

const sourcePlugin = computed(() =>
  sourceStore.plugins.find((p) => p.id === props.pluginId) ?? null
)

const title = computed(() => v2Plugin.value?.name ?? sourcePlugin.value?.name ?? '插件设置')
const version = computed(() => v2Plugin.value?.version ?? sourcePlugin.value?.version ?? '')
const description = computed(
  () => v2Plugin.value?.description ?? sourcePlugin.value?.description ?? ''
)

const kindLabel: Record<PluginKind, string> = { v2: '插件', lx: '洛雪', ceru: '澜音' }
const kindTagType: Record<PluginKind, 'success' | 'info' | 'warning'> = {
  v2: 'success',
  lx: 'info',
  ceru: 'warning'
}

// ========== v2：声明式设置 ==========

const fields = ref<SettingField[]>([])
const draft = ref<Record<string, any>>({})
const loading = ref(false)
const loadError = ref('')
const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
const saveError = ref('')
let savedTimer: ReturnType<typeof setTimeout> | null = null

async function loadV2Settings(): Promise<void> {
  if (!props.pluginId) return
  loading.value = true
  loadError.value = ''
  try {
    const res = await window.api.plugins.getSettings(props.pluginId)
    if (!res.success) {
      loadError.value = res.error || '读取设置失败'
      fields.value = []
      draft.value = {}
      return
    }
    fields.value = res.schema ?? []
    draft.value = { ...(res.values ?? {}) }
  } catch (err: any) {
    loadError.value = err?.message || '读取设置失败'
  } finally {
    loading.value = false
  }
}

/** 写入一项设置（即时保存，失败保留 dirty 值并提示） */
async function commit(key: string, value: any): Promise<void> {
  if (!props.pluginId) return
  draft.value[key] = value
  saveState.value = 'saving'
  saveError.value = ''
  try {
    const res = await window.api.plugins.setSetting(props.pluginId, key, value)
    if (!res.success) {
      saveState.value = 'error'
      saveError.value = res.error || '保存失败'
      return
    }
    if (res.values) draft.value = { ...res.values }
    saveState.value = 'saved'
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => {
      if (saveState.value === 'saved') saveState.value = 'idle'
    }, 1800)
  } catch (err: any) {
    saveState.value = 'error'
    saveError.value = err?.message || '保存失败'
  }
}

const saveStateText = computed(() => {
  if (saveState.value === 'saving') return '保存中…'
  if (saveState.value === 'error') return `保存失败：${saveError.value}`
  if (saveState.value === 'saved') return '已保存'
  return ''
})

// ========== 洛雪 / 澜音：音乐源 + 音质 ==========

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
  '192k': '较高 192k',
  '320k': '较高 320k',
  flac: '无损 FLAC',
  flac24bit: '无损 24bit',
  hires: 'Hi-Res',
  atmos: '杜比全景声',
  atmos_plus: '全景声 Plus',
  master: '母带'
}

const QUALITY_ORDER = ['128k', '192k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master']

function canonical(key?: string): string {
  const raw = (key || '').toLowerCase()
  if (['qq', 'tencent', 'qqmusic'].includes(raw)) return 'tx'
  if (['netease', 'wangyi', 'cloudmusic'].includes(raw)) return 'wy'
  if (raw === 'kugou') return 'kg'
  if (raw === 'kuwo') return 'kw'
  if (raw === 'migu') return 'mg'
  return raw
}

/** 该音乐源当前是否开启（settings.sources 为 null → 全开） */
function isSourceOn(key: string): boolean {
  const list = sourcePlugin.value?.settings?.sources
  if (!Array.isArray(list)) return true
  return list.some((item) => canonical(item) === canonical(key))
}

async function toggleSource(key: string, on: boolean): Promise<void> {
  const plugin = sourcePlugin.value
  if (!plugin) return
  const allKeys = (plugin.capabilities?.sources ?? []).map((s) => s.key)
  const currentOn = new Set(allKeys.filter((k) => isSourceOn(k)))
  if (on) currentOn.add(key)
  else currentOn.delete(key)

  // 全开存 null：这样插件后续新增音乐源时不会被旧白名单挡住
  const next = currentOn.size === allKeys.length ? null : [...currentOn]
  const ok = await sourceStore.setPreferences(plugin.id, { sources: next })
  if (!ok) message.error('保存失败')
}

async function changeQuality(value: string | null): Promise<void> {
  const plugin = sourcePlugin.value
  if (!plugin) return
  const ok = await sourceStore.setPreferences(plugin.id, { quality: value || null })
  if (!ok) message.error('保存失败')
}

const qualityOptions = computed(() => {
  const declared = new Set<string>()
  for (const cap of sourcePlugin.value?.capabilities?.sources ?? []) {
    for (const q of cap.qualities ?? []) declared.add(canonicalQuality(q))
  }
  const ordered = QUALITY_ORDER.filter((q) => declared.has(q))
  const list = ordered.length > 0 ? ordered : QUALITY_ORDER.slice(0, 5)
  return [
    { label: '跟随全局音质', value: '' },
    ...list.map((q) => ({ label: QUALITY_LABELS[q] ?? q, value: q }))
  ]
})

function canonicalQuality(q: string): string {
  return (q || '').toLowerCase()
}

// ========== 日志（仅 v2） ==========

const logs = ref<PluginLogEntry[]>([])
const logsLoading = ref(false)
const showLogs = ref(false)

async function loadLogs(): Promise<void> {
  if (!props.pluginId) return
  logsLoading.value = true
  try {
    const res = await window.api.plugins.getLogs(props.pluginId, 200)
    logs.value = res.success ? (res.entries ?? []) : []
  } finally {
    logsLoading.value = false
  }
}

async function clearLogs(): Promise<void> {
  if (!props.pluginId) return
  await window.api.plugins.clearLogs(props.pluginId)
  logs.value = []
}

// ========== 操作 ==========

const acting = ref(false)

async function handleReload(): Promise<void> {
  if (!props.pluginId) return
  acting.value = true
  try {
    const ok = await pluginStore.reload(props.pluginId)
    if (ok) {
      message.success('已重新加载')
      await loadV2Settings()
      if (showLogs.value) await loadLogs()
    }
  } finally {
    acting.value = false
  }
}

async function handleCheckUpdate(): Promise<void> {
  if (!props.pluginId) return
  acting.value = true
  try {
    const res = await pluginStore.checkUpdate(props.pluginId)
    if (res.hasNew) {
      message.info(`发现新版本 ${res.version}，请重新下载插件脚本后导入覆盖`)
      if (res.changelog) message.info(res.changelog)
    } else {
      message.success('已是最新版本（或插件未声明 @updateUrl）')
    }
  } finally {
    acting.value = false
  }
}

async function handleRemove(): Promise<void> {
  if (!props.pluginId) return
  const ok = await pluginStore.remove(props.pluginId)
  if (!ok && props.kind !== 'v2') {
    await sourceStore.remove(props.pluginId)
  }
  close()
}

async function handleToggleEnabled(): Promise<void> {
  if (!props.pluginId) return
  acting.value = true
  try {
    if (props.kind === 'v2') {
      const target = !(v2Plugin.value?.enabled ?? false)
      await pluginStore.setEnabled(props.pluginId, target)
      if (target) await loadV2Settings()
    } else {
      const target = !(sourcePlugin.value?.enabled ?? false)
      await sourceStore.setEnabled(props.pluginId, target)
    }
  } finally {
    acting.value = false
  }
}

const enabled = computed(() =>
  props.kind === 'v2' ? !!v2Plugin.value?.enabled : !!sourcePlugin.value?.enabled
)

function close(): void {
  emit('update:show', false)
}

// ========== 生命周期 ==========

watch(
  () => [props.show, props.pluginId, props.kind] as const,
  async ([show, pluginId, kind]) => {
    if (!show || !pluginId) return
    showLogs.value = false
    logs.value = []
    saveState.value = 'idle'
    if (kind === 'v2') {
      await loadV2Settings()
    } else {
      if (sourceStore.plugins.length === 0) await sourceStore.refresh()
    }
  },
  { immediate: true }
)

watch(showLogs, (value) => {
  if (value && logs.value.length === 0) void loadLogs()
})
</script>

<template>
  <n-modal
    :show="show"
    :mask-closable="true"
    style="border-radius: 14px; overflow: hidden"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <n-card
      class="plugin-modal-card"
      :bordered="false"
      role="dialog"
      aria-modal="true"
      :style="{
        backgroundColor: themeVars.modalColor,
        width: 'min(880px, calc(100vw - 96px))',
        height: 'min(760px, calc(100vh - 96px))'
      }"
      content-style="padding: 0; display: flex; flex-direction: column; min-height: 0; flex: 1;"
    >
      <!-- 头部 -->
      <div class="modal-header">
        <div class="header-main">
          <div class="plugin-avatar">{{ (title || 'P').slice(0, 1).toUpperCase() }}</div>
          <div class="header-text">
            <div class="header-title-row">
              <span class="header-title">{{ title }}</span>
              <span v-if="version" class="header-version">v{{ version }}</span>
              <n-tag size="tiny" round :type="kindTagType[kind]">{{ kindLabel[kind] }}</n-tag>
              <n-tag v-if="!enabled" size="tiny" round type="default">已停用</n-tag>
            </div>
            <div v-if="description" class="header-desc">{{ description }}</div>
          </div>
        </div>
        <button class="close-btn" type="button" aria-label="关闭" @click="close">
          <i class="mgc_close_line"></i>
        </button>
      </div>

      <n-scrollbar class="modal-body-scroll">
        <div class="modal-body">
        <!-- 停用提示 -->
        <n-alert v-if="!enabled" type="warning" :bordered="false" class="block">
          插件已停用，设置不可编辑。启用后可继续配置。
        </n-alert>

        <!-- v2：声明式表单 -->
        <template v-if="kind === 'v2'">
          <div v-if="loading" class="state-block"><n-spin size="small" /> 正在读取设置…</div>
          <n-alert v-else-if="loadError" type="error" :bordered="false" class="block">
            {{ loadError }}
          </n-alert>
          <template v-else>
            <div class="section-label">设置</div>
            <div v-if="fields.length === 0" class="empty-hint">
              该插件没有声明可配置项（`such.register({ settings })` 为空）
            </div>
            <div v-else class="field-list">
              <div v-for="field in fields" :key="field.key" class="field">
                <div class="field-meta">
                  <div class="field-label">{{ field.label }}</div>
                  <div v-if="field.description" class="field-desc">{{ field.description }}</div>
                </div>
                <div class="field-control">
                  <n-switch
                    v-if="field.type === 'switch'"
                    :value="draft[field.key] ?? field.default"
                    :disabled="!enabled"
                    @update:value="(v: boolean) => commit(field.key, v)"
                  />
                  <n-input-number
                    v-else-if="field.type === 'number'"
                    :value="draft[field.key] ?? field.default"
                    :min="field.min"
                    :max="field.max"
                    :step="field.step"
                    :disabled="!enabled"
                    size="small"
                    style="width: 160px"
                    @update:value="(v: number | null) => commit(field.key, v ?? 0)"
                  />
                  <n-input
                    v-else-if="field.type === 'text'"
                    :value="String(draft[field.key] ?? field.default ?? '')"
                    :type="field.multiline ? 'textarea' : 'text'"
                    :placeholder="field.placeholder"
                    :disabled="!enabled"
                    :rows="field.multiline ? 3 : undefined"
                    size="small"
                    @update:value="(v: string) => (draft[field.key] = v)"
                    @blur="commit(field.key, draft[field.key])"
                    @keyup.enter="commit(field.key, draft[field.key])"
                  />
                  <n-select
                    v-else-if="field.type === 'select'"
                    :value="draft[field.key] ?? field.default"
                    :options="field.options"
                    :disabled="!enabled"
                    size="small"
                    style="width: 200px"
                    @update:value="(v: string) => commit(field.key, v)"
                  />
                </div>
              </div>
            </div>
          </template>
        </template>

        <!-- 洛雪 / 澜音：音乐源 + 音质 -->
        <template v-else>
          <div class="section-label">音乐源</div>
          <div v-if="!(sourcePlugin?.capabilities?.sources ?? []).length" class="empty-hint">
            该插件没有声明任何音乐源
          </div>
          <div v-else class="chip-row">
            <button
              v-for="cap in sourcePlugin?.capabilities?.sources ?? []"
              :key="cap.key"
              type="button"
              class="chip"
              :class="{ 'chip--on': isSourceOn(cap.key) }"
              :disabled="!enabled"
              @click="toggleSource(cap.key, !isSourceOn(cap.key))"
            >
              {{ SOURCE_LABELS[canonical(cap.key)] ?? cap.name ?? cap.key }}
            </button>
          </div>
          <p class="hint">全部开启时会记录为「全选」，插件以后新增音乐源会自动生效。</p>

          <div class="section-label">首选音质</div>
          <n-select
            :value="sourcePlugin?.settings?.quality ?? ''"
            :options="qualityOptions"
            :disabled="!enabled"
            size="small"
            style="width: 220px"
            @update:value="changeQuality"
          />
          <p class="hint">播放时优先使用该音质，低于此档位时回退到插件支持的最高档。</p>
        </template>

        <!-- 插件信息 -->
        <div class="section-label">插件信息</div>
        <div class="info-grid">
          <div class="info-row">
            <span class="info-key">标识</span>
            <span class="info-value mono">{{ v2Plugin?.headerId ?? pluginId }}</span>
          </div>
          <div v-if="v2Plugin" class="info-row">
            <span class="info-key">API 级别</span>
            <span class="info-value">{{ v2Plugin.apiLevel }}</span>
          </div>
          <div v-if="v2Plugin?.grants?.length" class="info-row">
            <span class="info-key">授权</span>
            <span class="info-value">
              <n-tag v-for="g in v2Plugin.grants" :key="g" size="tiny" round class="grant-tag">
                {{ g }}
              </n-tag>
            </span>
          </div>
          <div v-if="v2Plugin?.sources?.length" class="info-row">
            <span class="info-key">音源</span>
            <span class="info-value">
              {{ v2Plugin.sources.map((s) => s.name).join(' / ') }}
            </span>
          </div>
          <div v-if="v2Plugin?.author ?? sourcePlugin?.author" class="info-row">
            <span class="info-key">作者</span>
            <span class="info-value">{{ v2Plugin?.author ?? sourcePlugin?.author }}</span>
          </div>
          <div v-if="v2Plugin?.filePath ?? sourcePlugin?.filePath" class="info-row">
            <span class="info-key">文件</span>
            <span class="info-value mono ellipsis" :title="v2Plugin?.filePath ?? sourcePlugin?.filePath">
              {{ v2Plugin?.filePath ?? sourcePlugin?.filePath }}
            </span>
          </div>
        </div>

        <!-- 日志（仅 v2） -->
        <template v-if="kind === 'v2'">
          <div class="section-label section-label--row">
            <button type="button" class="link-btn" @click="showLogs = !showLogs">
              {{ showLogs ? '收起日志' : '查看日志' }}
            </button>
            <button v-if="showLogs && logs.length" type="button" class="link-btn" @click="clearLogs">
              清空
            </button>
          </div>
          <n-scrollbar v-if="showLogs" class="log-scroll">
            <div class="log-box">
              <div v-if="logsLoading" class="log-empty">读取中…</div>
              <div v-else-if="logs.length === 0" class="log-empty">暂无日志</div>
              <div v-for="(entry, i) in logs" :key="i" class="log-line" :class="`log-${entry.level}`">
                <span class="log-time">{{ new Date(entry.t).toLocaleTimeString() }}</span>
                <span class="log-text">{{ entry.message }}</span>
              </div>
            </div>
          </n-scrollbar>
        </template>
        </div>
      </n-scrollbar>

      <!-- 底部 -->
      <div class="modal-footer">
        <span class="save-state" :class="{ 'save-state--error': saveState === 'error' }">
          {{ saveStateText }}
        </span>
        <div class="footer-actions">
          <n-button quaternary size="small" :disabled="acting" @click="handleToggleEnabled">
            {{ enabled ? '停用' : '启用' }}
          </n-button>
          <n-button
            v-if="kind === 'v2'"
            quaternary
            size="small"
            :disabled="acting"
            @click="handleReload"
          >
            重载
          </n-button>
          <n-button
            v-if="kind === 'v2'"
            quaternary
            size="small"
            :disabled="acting"
            @click="handleCheckUpdate"
          >
            检查更新
          </n-button>
          <n-button quaternary size="small" type="error" :disabled="acting" @click="handleRemove">
            移除
          </n-button>
          <n-button size="small" type="primary" @click="close">完成</n-button>
        </div>
      </div>
    </n-card>
  </n-modal>
</template>

<style scoped>
/* 固定高度的卡片：头部 / 滚动区 / 底部三段式，内容超出时只滚中间 */
.plugin-modal-card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--n-border-color);
}

.header-main {
  display: flex;
  gap: 12px;
  min-width: 0;
}

.plugin-avatar {
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 16px;
  color: var(--n-text-color-1);
  background: rgba(128, 128, 128, 0.16);
}

.header-text {
  min-width: 0;
}

.header-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.header-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--n-text-color-1);
}

.header-version {
  font-size: 12px;
  color: var(--n-text-color-3);
  font-variant-numeric: tabular-nums;
}

.header-desc {
  margin-top: 4px;
  font-size: 12px;
  color: var(--n-text-color-3);
  line-height: 1.5;
}

.close-btn {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--n-text-color-3);
  cursor: pointer;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.16s ease, color 0.16s ease;
}

.close-btn:hover {
  background: rgba(128, 128, 128, 0.16);
  color: var(--n-text-color-1);
}

.modal-body-scroll {
  flex: 1;
  min-height: 0;
}

.modal-body {
  padding: 4px 20px 8px;
}

.block {
  margin-top: 12px;
}

.section-label {
  margin: 18px 0 10px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--n-text-color-3);
}

.section-label--row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.link-btn {
  border: none;
  background: transparent;
  padding: 0;
  color: #3d889b;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}

.link-btn:hover {
  text-decoration: underline;
}

.empty-hint,
.state-block {
  font-size: 13px;
  color: var(--n-text-color-3);
  padding: 10px 0 4px;
}

.state-block {
  display: flex;
  align-items: center;
  gap: 8px;
}

.field-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(128, 128, 128, 0.08);
}

.field-meta {
  min-width: 0;
}

.field-label {
  font-size: 13px;
  color: var(--n-text-color-1);
}

.field-desc {
  margin-top: 3px;
  font-size: 11px;
  color: var(--n-text-color-3);
  line-height: 1.5;
}

.field-control {
  flex: 0 0 auto;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--n-border-color);
  background: transparent;
  color: var(--n-text-color-3);
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.16s ease;
}

.chip:hover:not(:disabled) {
  border-color: var(--n-border-color-hover);
  color: var(--n-text-color-1);
}

.chip--on {
  background: rgba(61, 136, 155, 0.16);
  border-color: rgba(61, 136, 155, 0.5);
  color: #3d889b;
}

.chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hint {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--n-text-color-4);
  line-height: 1.6;
}

.info-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-row {
  display: flex;
  gap: 12px;
  font-size: 12px;
  line-height: 1.6;
}

.info-key {
  flex: 0 0 68px;
  color: var(--n-text-color-4);
}

.info-value {
  flex: 1;
  min-width: 0;
  color: var(--n-text-color-2);
}

.info-value.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.grant-tag {
  margin-right: 6px;
}

.log-scroll {
  max-height: 240px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.18);
}

.log-box {
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.7;
}

.log-empty {
  color: var(--n-text-color-4);
}

.log-line {
  display: flex;
  gap: 8px;
  color: var(--n-text-color-2);
  word-break: break-all;
}

.log-time {
  flex: 0 0 auto;
  color: var(--n-text-color-4);
}

.log-warn {
  color: #d9a441;
}

.log-error {
  color: #e06c6c;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--n-border-color);
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.save-state {
  font-size: 11px;
  color: var(--n-text-color-4);
}

.save-state--error {
  color: #e06c6c;
}
</style>
