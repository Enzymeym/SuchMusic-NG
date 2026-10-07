<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import {
  NAlert,
  NButton,
  NIcon,
  NModal,
  NProgress,
  NScrollbar,
  NTag,
  useMessage,
  useThemeVars
} from 'naive-ui'
import { useUpdater } from '../../composables/useUpdater'
import { useSettingsStore } from '../../stores/settingsStore'

const message = useMessage()
const settingsStore = useSettingsStore()
// 弹窗 teleport 到 body 后无法完整继承 n-config-provider 的 CSS 变量，
// 需通过 useThemeVars 取实际颜色值内联，确保图标 / 进度条颜色正常
const themeVars = useThemeVars()

const {
  updateInfo,
  downloadProgress,
  error,
  isChecking,
  isUpdateAvailable,
  isDownloading,
  isDownloaded,
  hasError,
  checkUpdate,
  downloadUpdate,
  installUpdate,
  dismissUpdate,
  formatBytes,
  formatSpeed
} = useUpdater()

/**
 * 弹窗显示状态：仅在「发现更新 / 下载中 / 下载完成 / 出错」时弹出，
 * 启动自动检查未发现更新时保持静默
 */
const showDialog = ref(false)

watch(
  [isUpdateAvailable, isDownloading, isDownloaded, hasError],
  () => {
    showDialog.value =
      isUpdateAvailable.value || isDownloading.value || isDownloaded.value || hasError.value
  },
  { immediate: true }
)

/**
 * 弹窗标题
 */
const dialogTitle = computed(() => {
  if (hasError.value) return '更新出错'
  if (isDownloading.value) return '正在下载更新'
  if (isDownloaded.value) return '更新下载完成'
  return '发现新版本'
})

/**
 * 状态强调色：错误红 / 完成绿 / 下载与检查用主色 / 其余用警告色。
 * 通过 CSS 变量 --ud-accent 下发，供状态徽标等处复用
 */
const statusColor = computed(() => {
  if (hasError.value) return themeVars.value.errorColor
  if (isDownloaded.value) return themeVars.value.successColor
  if (isDownloading.value || isChecking.value) return themeVars.value.primaryColor
  return themeVars.value.warningColor
})

/** 状态图标（MingCute 线性图标类名） */
const statusIcon = computed(() => {
  if (isChecking.value) return 'mgc_loading_line'
  if (hasError.value) return 'mgc_close_circle_line'
  if (isDownloaded.value) return 'mgc_check_circle_line'
  if (isDownloading.value) return 'mgc_download_3_line'
  return 'mgc_rocket_line'
})

/** n-alert 提示类型 */
const alertType = computed<'error' | 'success' | 'info' | 'warning'>(() => {
  if (hasError.value) return 'error'
  if (isDownloaded.value) return 'success'
  if (isDownloading.value || isChecking.value) return 'info'
  return 'info'
})

/** 把强调色注入为局部 CSS 变量（供样式中的 color-mix 使用） */
const accentStyle = computed<Record<string, string>>(() => ({
  '--ud-accent': statusColor.value
}))

/**
 * 处理检查更新
 */
const handleCheck = async () => {
  const result = await checkUpdate(settingsStore.general.updateChannel, {
    autoDownload: true,
    silent: false
  })
  if (result?.hasUpdate) {
    message.info(`发现新版本: v${result.latestVersion}`)
  } else if (result && !result.hasUpdate) {
    message.success('当前已是最新版本')
  }
}

// 启动时按用户设置自动检查更新（未开启则保持静默；网络异常不弹错误）
onMounted(() => {
  if (settingsStore.general.autoCheckUpdate) {
    checkUpdate(settingsStore.general.updateChannel, { autoDownload: true, silent: true })
  }
})

/**
 * 处理下载更新
 */
const handleDownload = async () => {
  const success = await downloadUpdate()
  if (success) {
    message.success('下载完成，点击安装以应用更新')
  }
}

/**
 * 处理安装更新
 */
const handleInstall = async () => {
  await installUpdate()
}

/**
 * 处理忽略/关闭更新
 */
const handleDismiss = () => {
  dismissUpdate()
  showDialog.value = false
}

/** 当前版本号 */
const currentVersion = computed(() => updateInfo.value?.currentVersion ?? '')
/** 远程最新版本号 */
const latestVersion = computed(() => updateInfo.value?.latestVersion ?? '')

/** 发布时间（YYYY-MM-DD） */
const publishedDate = computed(() => {
  const raw = updateInfo.value?.publishedAt
  if (!raw) return ''
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
})

/** 是否展示「更新内容」区块（出错时不展示，避免与错误提示混杂） */
const showNotes = computed(() => isUpdateAvailable.value && !hasError.value)

/** 更新内容原始 Markdown（来自 GitHub Release 正文） */
const rawNotes = computed(() => updateInfo.value?.releaseNotes ?? '')

/**
 * 渲染后的更新内容 HTML。
 *
 * release notes 是 Markdown；markdown-it 体积偏大（且「关于页」本就为减小启动体积做了懒加载），
 * 所以这里同样动态 import，只在真的需要渲染更新内容时才加载，未就绪时先展示纯文本。
 */
const renderedNotes = ref('')
/** 防止过期的异步渲染结果覆盖新内容 */
let notesToken = 0

watch(
  rawNotes,
  async (text) => {
    const token = ++notesToken
    const source = (text ?? '').trim()
    if (!source) {
      renderedNotes.value = ''
      return
    }
    try {
      const { renderMarkdown } = await import('../../utils/markdown')
      if (token !== notesToken) return
      renderedNotes.value = renderMarkdown(source)
    } catch (e) {
      // 渲染器加载失败时保持 renderedNotes 为空，模板退化为纯文本展示
      console.error('[UpdateNotification] Markdown 渲染器加载失败，退化为纯文本:', e)
      if (token === notesToken) renderedNotes.value = ''
    }
  },
  { immediate: true }
)

/**
 * 获取状态文本（标题已表达主状态，这里只补充细节信息）
 */
const statusText = computed(() => {
  if (isChecking.value) return '正在检查更新…'
  if (isDownloaded.value) return '点击「立即安装」将重启应用完成更新'
  if (hasError.value) return error.value || '更新出错，请稍后重试'
  if (isUpdateAvailable.value) return '新版本已就绪，可立即下载体验新内容'
  return ''
})
</script>

<template>
  <n-modal
    v-model:show="showDialog"
    preset="card"
    class="update-dialog-modal"
    :bordered="false"
    :mask-closable="!isDownloading"
    style="width: min(464px, calc(100vw - 32px))"
  >
    <!-- 自定义头部：状态徽标 + 标题 + 版本标签 -->
    <template #header>
      <div class="ud-header" :style="accentStyle">
        <span class="ud-badge">
          <n-icon :size="23" :class="{ 'ud-spin': isChecking }">
            <i :class="statusIcon" />
          </n-icon>
        </span>
        <div class="ud-headings">
          <div class="ud-title">{{ dialogTitle }}</div>
          <div class="ud-versions">
            <n-tag v-if="currentVersion" size="small" :bordered="false">
              v{{ currentVersion }}
            </n-tag>
            <n-icon v-if="currentVersion || latestVersion" :size="12" class="ud-ver-arrow">
              <i class="mgc_arrow_right_line" />
            </n-icon>
            <n-tag v-if="latestVersion" size="small" type="primary" :bordered="false">
              v{{ latestVersion }}
            </n-tag>
            <n-tag v-if="updateInfo?.isPrerelease" size="small" type="warning" :bordered="false">
              预发布
            </n-tag>
          </div>
        </div>
      </div>
    </template>

    <div class="ud-body" :style="accentStyle">
      <!-- 状态 / 错误提示 -->
      <n-alert
        v-if="statusText"
        class="ud-alert"
        :type="alertType"
        :show-icon="hasError"
        :bordered="false"
      >
        {{ statusText }}
      </n-alert>

      <!-- 下载进度 -->
      <div v-if="isDownloading && downloadProgress.total > 0" class="ud-progress">
        <div class="ud-progress-head">
          <span class="ud-progress-percent">{{ downloadProgress.percent }}%</span>
          <span class="ud-progress-detail">
            {{ formatBytes(downloadProgress.downloaded) }} /
            {{ formatBytes(downloadProgress.total) }}
            <template v-if="downloadProgress.speed > 0">
              · {{ formatSpeed(downloadProgress.speed) }}
            </template>
          </span>
        </div>
        <n-progress
          type="line"
          :percentage="downloadProgress.percent"
          :show-indicator="false"
          :height="6"
          :border-radius="3"
          :color="statusColor"
        />
      </div>

      <!-- 更新内容 -->
      <section v-if="showNotes" class="ud-notes">
        <div class="ud-notes-head">
          <span class="ud-notes-title">更新内容</span>
          <span v-if="publishedDate" class="ud-notes-date">{{ publishedDate }}</span>
        </div>
        <n-scrollbar class="ud-notes-scroll" :size="6">
          <div class="ud-notes-inner">
            <!-- release notes 为 Markdown，走 utils/markdown 渲染（含 emoji / GitHub 提示块）；
                 渲染器尚未加载完成时先以纯文本占位 -->
            <div v-if="renderedNotes" class="ud-md" v-html="renderedNotes" />
            <pre v-else-if="rawNotes.trim()" class="ud-notes-body">{{ rawNotes }}</pre>
            <p v-else class="ud-notes-empty">该版本暂无详细更新说明</p>
          </div>
        </n-scrollbar>
      </section>
    </div>

    <template #footer>
      <div class="ud-actions">
        <template v-if="isUpdateAvailable && !isDownloading && !isDownloaded">
          <n-button type="primary" @click="handleDownload">
            <template #icon>
              <n-icon><i class="mgc_download_3_line" /></n-icon>
            </template>
            立即下载
          </n-button>
          <n-button text @click="handleDismiss">稍后提醒</n-button>
        </template>

        <template v-else-if="isDownloaded">
          <n-button type="primary" @click="handleInstall">
            <template #icon>
              <n-icon><i class="mgc_check_circle_line" /></n-icon>
            </template>
            立即安装
          </n-button>
          <n-button text @click="handleDismiss">稍后安装</n-button>
        </template>

        <template v-else-if="isDownloading">
          <n-button text @click="handleDismiss">后台下载</n-button>
        </template>

        <template v-else-if="hasError">
          <n-button @click="handleCheck">
            <template #icon>
              <n-icon><i class="mgc_refresh_2_line" /></n-icon>
            </template>
            重试
          </n-button>
          <n-button text @click="handleDismiss">关闭</n-button>
        </template>
      </div>
    </template>
  </n-modal>
</template>

<!--
  说明：n-modal 的卡片由 naive-ui 渲染，不带本组件的 scoped 属性，
  因此这里使用全局样式，依靠 .update-dialog-modal / .ud-* 专属类名避免污染。
-->
<style>
/* ==================== 更新弹窗 ==================== */
.update-dialog-modal {
  --ud-accent: #2c8efd;
  --ud-text-2: rgba(70, 74, 84, 0.9);
  --ud-text-3: rgba(120, 126, 138, 0.85);
  --ud-surface: rgba(0, 0, 0, 0.035);

  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.26);
  transition: box-shadow 0.2s ease;
}

/* 深色主题：补描边让卡片从近黑底浮出，并切换为亮色文字 */
html[data-theme='dark'] .update-dialog-modal {
  --ud-text-2: rgba(232, 233, 240, 0.84);
  --ud-text-3: rgba(232, 233, 240, 0.55);
  --ud-surface: rgba(255, 255, 255, 0.055);

  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 18px 52px rgba(0, 0, 0, 0.5);
}

/* ---------- 头部 ---------- */
.update-dialog-modal .n-card-header {
  padding: 20px 20px 14px;
}

.ud-header {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.ud-badge {
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  border-radius: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ud-accent);
  background: color-mix(in srgb, var(--ud-accent) 16%, transparent);
}

.ud-headings {
  min-width: 0;
  flex: 1;
}

.ud-title {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ud-versions {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.ud-ver-arrow {
  color: var(--ud-text-3);
  display: inline-flex;
}

/* ---------- 内容区 ---------- */
.update-dialog-modal .n-card__content {
  padding: 2px 20px 18px;
}

.ud-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ud-alert {
  border-radius: 10px;
}

.ud-alert .n-alert-body__content {
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
}

/* ---------- 下载进度 ---------- */
.ud-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ud-progress-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.ud-progress-percent {
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
  color: var(--ud-accent);
  font-variant-numeric: tabular-nums;
}

.ud-progress-detail {
  font-size: 12px;
  color: var(--ud-text-3);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* ---------- 更新内容 ---------- */
.ud-notes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ud-notes-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ud-notes-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  padding-left: 9px;
  border-left: 3px solid var(--ud-accent);
}

.ud-notes-date {
  font-size: 12px;
  color: var(--ud-text-3);
  font-variant-numeric: tabular-nums;
}

/* n-scrollbar 外层负责圆角与底色，内层负责滚动内容内边距 */
.ud-notes-scroll {
  max-height: 220px;
  overflow: hidden;
  border-radius: 12px;
  background: var(--ud-surface);
}

.ud-notes-inner {
  padding: 12px 14px;
}

/* ---------- 更新内容（Markdown 渲染） ---------- */
.ud-md {
  font-size: 12.5px;
  line-height: 1.75;
  word-break: break-word;
  overflow-wrap: anywhere;
}

/* GitHub Alerts 只有 .dark 类变体，而本应用暗色主题用的是 html[data-theme='dark']，
   故在此补一份深色取值；作用域限定在更新内容区，不会外溢到其他页面 */
html[data-theme='dark'] .ud-md {
  --color-note: #2f81f7;
  --color-tip: #3fb950;
  --color-warning: #d29922;
  --color-severe: #db6d28;
  --color-caution: #f85149;
  --color-important: #a371f7;
}

/* 首尾元素不留多余外边距，避免滚动区上下出现空白 */
.ud-md > :first-child {
  margin-top: 0;
}

.ud-md > :last-child {
  margin-bottom: 0;
}

.ud-md p {
  margin: 0 0 0.7em;
}

.ud-md h1,
.ud-md h2,
.ud-md h3,
.ud-md h4,
.ud-md h5,
.ud-md h6 {
  margin: 1em 0 0.45em;
  font-weight: 600;
  line-height: 1.35;
  color: inherit;
}

.ud-md h1 {
  font-size: 1.24em;
  padding-bottom: 0.25em;
  border-bottom: 1px solid var(--ud-surface);
}

.ud-md h2 {
  font-size: 1.14em;
  padding-bottom: 0.2em;
  border-bottom: 1px solid var(--ud-surface);
}

.ud-md h3 {
  font-size: 1.05em;
}

.ud-md h4,
.ud-md h5,
.ud-md h6 {
  font-size: 1em;
}

.ud-md ul,
.ud-md ol {
  margin: 0 0 0.7em;
  padding-left: 1.35em;
}

.ud-md li {
  margin: 0 0 0.28em;
}

.ud-md li::marker {
  color: var(--ud-accent);
}

.ud-md li > ul,
.ud-md li > ol {
  margin: 0.28em 0 0;
}

/* 任务列表（- [x]）不显示额外项目符号 */
.ud-md li:has(> input[type='checkbox']) {
  list-style: none;
  margin-left: -1.1em;
}

.ud-md input[type='checkbox'] {
  margin-right: 6px;
  vertical-align: -1px;
  accent-color: var(--ud-accent);
}

.ud-md a {
  color: var(--ud-accent);
  text-decoration: none;
}

.ud-md a:hover {
  text-decoration: underline;
}

.ud-md strong {
  font-weight: 600;
}

.ud-md code {
  padding: 0.15em 0.4em;
  border-radius: 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
  background: var(--ud-surface);
}

.ud-md pre {
  margin: 0 0 0.7em;
  padding: 10px 12px;
  border-radius: 9px;
  overflow-x: auto;
  background: var(--ud-surface);
}

.ud-md pre code {
  padding: 0;
  background: transparent;
  font-size: 0.92em;
}

.ud-md blockquote {
  margin: 0 0 0.7em;
  padding: 2px 0 2px 12px;
  border-left: 3px solid var(--ud-surface);
  color: var(--ud-text-3);
}

.ud-md hr {
  height: 0;
  margin: 1em 0;
  border: none;
  border-top: 1px solid var(--ud-surface);
}

.ud-md img {
  max-width: 100%;
  border-radius: 8px;
}

.ud-md table {
  width: 100%;
  margin: 0 0 0.7em;
  border-collapse: collapse;
  font-size: 0.96em;
}

.ud-md th,
.ud-md td {
  padding: 5px 9px;
  border: 1px solid var(--ud-surface);
  text-align: left;
}

.ud-md th {
  font-weight: 600;
  background: var(--ud-surface);
}

/* GitHub Alerts 提示块：收紧间距以适配弹窗内的字号 */
.ud-md .markdown-alert {
  padding: 8px 12px;
  margin-bottom: 0.7em;
  border-radius: 0 8px 8px 0;
}

.ud-md .markdown-alert .markdown-alert-title {
  font-size: 12.5px;
  font-weight: 600;
}

.ud-md .markdown-alert > p {
  margin-bottom: 0.4em;
}

/* Markdown 渲染器加载完成前的纯文本占位 */
.ud-notes-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12.5px;
  line-height: 1.7;
  font-family: inherit;
  color: var(--ud-text-2);
}

.ud-notes-empty {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--ud-text-3);
}

/* ---------- 底部操作 ---------- */
.update-dialog-modal .n-card__footer {
  padding: 14px 20px 18px;
}

.ud-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

/* ---------- 动效 ---------- */
.ud-spin {
  animation: ud-spin 1s linear infinite;
}

@keyframes ud-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes ud-fade-up {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.ud-body > * {
  animation: ud-fade-up 0.26s ease both;
}
</style>
