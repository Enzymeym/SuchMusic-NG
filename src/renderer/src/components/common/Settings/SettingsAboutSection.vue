<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { NCard, NIcon, useThemeVars, NAlert, NSpin, NButton, NProgress, NTag, useMessage, NModal, NScrollbar } from 'naive-ui'
import MarkdownIt from 'markdown-it'
import { full as emoji } from 'markdown-it-emoji'
import markdownItGitHubAlerts from 'markdown-it-github-alerts'
import 'markdown-it-github-alerts/styles/github-colors-light.css'
import 'markdown-it-github-alerts/styles/github-colors-dark-class.css'
import 'markdown-it-github-alerts/styles/github-base.css'
import axios, { type AxiosError } from 'axios'
import { useUpdater } from '../../../composables/useUpdater'
import { useSettingsStore } from '../../../stores/settingsStore'
import LegalTexts from '../LegalTexts.vue'

// 主题变量，用于控制关于页颜色与玻璃卡片样式
const themeVars = useThemeVars()
const message = useMessage()
const settingsStore = useSettingsStore()

// 双击应用名称触发打开隐藏的 Morphaeum 实验分区
const emit = defineEmits<{
  (e: 'open-morphaeum'): void
}>()

const handleAppNameDblClick = () => {
  message.success('正在进入 Morphaeum 变形实验室...')
  emit('open-morphaeum')
}

// 使用更新系统 composable
const {
  updateInfo,
  currentVersion,
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
  getCurrentVersion,
  formatBytes,
  formatSpeed
} = useUpdater()

// GitHub Release 数据类型定义
interface GitHubRelease {
  tag_name: string
  body: string
  name?: string
  published_at?: string
  prerelease?: boolean
}

// GitHub User 数据类型定义
interface GitHubUser {
  login: string
  name: string
  avatar_url: string
  html_url: string
}

// 初始化 MarkdownIt，处理可能的导入兼容性问题
let md: MarkdownIt | null = null
try {
  // @ts-ignore: Handle potential default export mismatch
  const MarkdownItClass = MarkdownIt.default || MarkdownIt
  md = new MarkdownItClass({
    html: false,
    linkify: true,
    typographer: true
  })
  if (md) {
    md.use(emoji)
    md.use(markdownItGitHubAlerts)
  }
} catch (e) {
  console.error('Failed to initialize MarkdownIt:', e)
}

// 应用名称固定显示为产品名 Such Music（package.json 的 name 字段为内部包名，不用于展示）
const appName = 'Such Music'
const appDescription = __APP_DESCRIPTION__
// 优先使用注入的真实版本号，IPC 未返回时也无需硬编码回退
const appVersion = computed(() => currentVersion.value || __APP_VERSION__)

// 预发布标签：跟随版本号后缀自动识别（canary/beta/alpha/rc），正式版返回空串不显示标签
const releaseTag = computed(() => {
  const v = appVersion.value.toLowerCase()
  if (v.includes('canary')) return 'Canary'
  if (v.includes('beta')) return 'Beta'
  if (v.includes('alpha')) return 'Alpha'
  if (v.includes('rc')) return 'RC'
  return ''
})

// 是否预发布版本：驱动 Beta 提示与标签显示
const isPrerelease = computed(() => !!releaseTag.value)

// 去掉预发布后缀的基础版本号，用于版本徽章展示（后缀由 releaseTag 单独显示）
const baseVersion = computed(() => {
  const match = appVersion.value.match(/\d+\.\d+\.\d+/)
  return match ? match[0] : appVersion.value
})

// 更新日志相关
const showChangelog = ref(false)
const changelogLoading = ref(false)
const changelogContent = ref('')
const changelogError = ref('')
const currentChangelogVersion = ref('')

// 开发者信息
const developerInfo = ref<GitHubUser | null>(null)
const developerLoading = ref(false)

// 法律信息（隐私政策与在线服务声明）弹窗
const showLegalModal = ref(false)

onMounted(() => {
  fetchChangelog()
  fetchDeveloperInfo()
})

/**
 * 处理检查更新按钮点击
 */
const handleCheckUpdate = async () => {
  const result = await checkUpdate(settingsStore.general.updateChannel)
  if (result?.hasUpdate) {
    message.info(`发现新版本: v${result.latestVersion}`)
  } else if (result && !result.hasUpdate) {
    message.success('当前已是最新版本')
  } else if (result?.error) {
    message.error(result.error)
  }
}

/**
 * 处理下载更新按钮点击
 */
const handleDownloadUpdate = async () => {
  const success = await downloadUpdate()
  if (success) {
    message.success('下载完成')
  }
}

/**
 * 处理安装更新按钮点击
 */
const handleInstallUpdate = async () => {
  await installUpdate()
}

// 获取开发者信息
const fetchDeveloperInfo = async () => {
  developerLoading.value = true
  const owner = 'Enzymeym'
  try {
    const { data } = await axios.get<GitHubUser>(`https://api.github.com/users/${owner}`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
      timeout: 10000
    })
    developerInfo.value = data
  } catch (error) {
    console.warn('获取开发者信息失败:', error)
  } finally {
    developerLoading.value = false
  }
}

// 打开 GitHub 项目地址
const openGithub = () => {
  const url = 'https://github.com/Enzymeym/SuchMusic-NG'
  if ((window as any).electron?.shell) {
    ; (window as any).electron.shell.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

/**
 * 打开赞助页面链接
 * 优先使用 Electron shell 打开外部链接，否则使用浏览器新标签页打开
 */
const openSponsor = () => {
  const url = 'https://ifdian.net/a/enzymeym?tab=home'
  if ((window as any).electron?.shell) {
    ; (window as any).electron.shell.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

// 获取更新日志（从 GitHub Releases 动态获取）
const fetchChangelog = async () => {
  showChangelog.value = true
  if (changelogContent.value) return

  changelogLoading.value = true
  changelogError.value = ''

  // 等待实际版本号加载完成，避免使用回退版本号导致更新日志与当前版本不匹配
  let version = appVersion.value
  if (!currentVersion.value) {
    try {
      version = (await getCurrentVersion()) || version
    } catch {
      // 获取版本失败时沿用回退版本号
    }
  }

  const owner = 'Enzymeym'
  const repo = 'SuchMusic-NG'

  // 辅助函数：获取 Release 列表
  const getReleases = async (): Promise<GitHubRelease[]> => {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases`
    try {
      const { data } = await axios.get<GitHubRelease[]>(url, {
        headers: { Accept: 'application/vnd.github.v3+json' },
        params: { per_page: 10 }, // 仅获取最近的 10 个 release 即可
        timeout: 10000
      })
      return data
    } catch (error) {
      const axiosError = error as AxiosError
      console.warn(`请求 GitHub Releases 列表失败: ${axiosError.message}`)
      return []
    }
  }

  try {
    // 获取最近的 release 列表，避免通过 tag 猜测导致的 404 错误
    const releases = await getReleases()

    // 1. 在列表中查找当前版本
    // 优先匹配 name 字段为 v+version，其次匹配 tag_name
    const release = releases.find(
      (r) =>
        (r.name && r.name === `v${version}`) ||
        r.tag_name === `v${version}` ||
        r.tag_name === version
    )

    if (release) {
      changelogContent.value = release.body || '该版本无详细更新说明'
      currentChangelogVersion.value = release.tag_name
    } else {
      // 2. 如果没找到，回退到列表中的第一个版本（通常是最新发布的）
      // 注意：GitHub API 返回的列表通常按 created_at 倒序排列
      const latest = releases[0]

      if (latest) {
        changelogContent.value =
          `> **提示**：未找到当前版本 (v${version}) 的更新日志，以下是最新${latest.prerelease ? '预发布' : ''}版本 (${latest.tag_name}) 的日志：\n\n` +
          (latest.body || '无详细说明')
        currentChangelogVersion.value = latest.tag_name
      } else {
        throw new Error('未找到任何更新日志信息')
      }
    }
  } catch (e: any) {
    console.error('Fetch changelog error:', e)
    changelogError.value = '获取更新日志失败，请检查网络连接或稍后重试。'
  } finally {
    changelogLoading.value = false
  }
}

// 监听 markdown-it 渲染错误
const renderedChangelog = computed(() => {
  try {
    if (!md) {
      return '<p>更新日志渲染组件初始化失败。</p>'
    }
    return md.render(changelogContent.value || '')
  } catch (e) {
    console.error('Render changelog failed:', e)
    return '<p>更新日志渲染出错。</p>'
  }
})

// 手动检查更新（占位实现，后续可接入真正的更新逻辑）
// const checkUpdate = () => {
//   message.info('正在检查更新...', { duration: 2000 })
//   // 这里可以接入主进程 IPC，调用 autoUpdater 进行真正的更新检查
// }
</script>

<template>
  <div class="settings-content about-root">
    <div class="about-hero">
      <img src="../../../assets/icon.png" alt="logo" class="about-logo" />
      <div class="about-hero-title" title="Such Music" @dblclick="handleAppNameDblClick">
        {{ appName }}
      </div>
      <div class="about-hero-meta">
        <n-tag size="small" :bordered="false" round>v{{ baseVersion }}</n-tag>
        <n-tag v-if="releaseTag" size="small" :bordered="false" round type="warning">{{ releaseTag }}</n-tag>
      </div>
      <div v-if="appDescription" class="about-hero-desc">
        {{ appDescription }}
      </div>
      <div class="about-hero-actions">
        <n-button size="small" secondary @click="openGithub">
          <template #icon>
            <n-icon><i class="mgc_github_line" /></n-icon>
          </template>
          项目主页
        </n-button>
        <n-button size="small" secondary class="about-sponsor-btn" @click="openSponsor">
          <template #icon>
            <n-icon><i class="mgc_heart_line" style="color: #d03050" /></n-icon>
          </template>
          赞助
        </n-button>
        <n-button size="small" type="primary" @click="handleCheckUpdate">
          <template #icon>
            <n-icon><i class="mgc_refresh_1_line" /></n-icon>
          </template>
          检查更新
        </n-button>
      </div>

      <!-- 更新状态卡片 -->
      <div class="update-status-card" v-if="isUpdateAvailable || isDownloading || isDownloaded || hasError">
        <div v-if="isChecking" class="update-status-item">
          <n-spin size="small" />
          <span>正在检查更新...</span>
        </div>
        <div v-else-if="hasError" class="update-status-item update-status-error">
          <i class="mgc_close_circle_line" />
          <span>{{ error || '检查更新失败' }}</span>
          <n-button size="tiny" @click="handleCheckUpdate">重试</n-button>
        </div>
        <div v-else-if="isUpdateAvailable && !isDownloading && !isDownloaded" class="update-status-item">
          <i class="mgc_alert_line" />
          <span>发现新版本: v{{ updateInfo?.latestVersion }}</span>
          <n-button size="tiny" type="primary" @click="handleDownloadUpdate">立即下载</n-button>
        </div>
        <div v-else-if="isDownloading" class="update-status-item update-status-downloading">
          <i class="mgc_download_3_line" />
          <div class="update-download-info">
            <span>正在下载更新... {{ downloadProgress.percent }}%</span>
            <n-progress type="line" :percentage="downloadProgress.percent" :show-indicator="false" :height="4"
              :border-radius="2" style="width: 120px" />
            <span class="update-download-detail">
              {{ formatBytes(downloadProgress.downloaded) }} /
              {{ formatBytes(downloadProgress.total) }}
              <span v-if="downloadProgress.speed > 0">({{ formatSpeed(downloadProgress.speed) }})</span>
            </span>
          </div>
        </div>
        <div v-else-if="isDownloaded" class="update-status-item">
          <i class="mgc_check_circle_line" />
          <span>下载完成，准备安装</span>
          <n-button size="tiny" type="success" @click="handleInstallUpdate">立即安装</n-button>
        </div>
      </div>

    </div>

    <!-- 预发布提示：跟随版本号后缀，正式版不显示 -->
    <n-alert
      v-if="isPrerelease"
      type="warning"
      :bordered="false"
      class="beta-notice"
    >
      <template #icon>
        <n-icon><i class="mgc_alert_line" /></n-icon>
      </template>
      当前为 {{ releaseTag }} 版本（v{{ baseVersion }}），功能可能不完善，请谨慎使用
    </n-alert>

    <div class="about-cards">
      <n-card class="about-card" :bordered="false" :style="{
        backgroundColor: themeVars.cardColor
      }">
        <template #header>
          <div class="about-card-header">
            <span class="about-card-icon"><n-icon><i class="mgc_user_3_line" /></n-icon></span>
            <span>开发者</span>
          </div>
        </template>

        <div v-if="developerLoading" class="about-card-row" style="justify-content: center">
          <n-spin size="small" />
        </div>

        <div v-else-if="developerInfo" class="developer-info">
          <img :src="developerInfo.avatar_url" class="developer-avatar" alt="avatar" />
          <div class="developer-details">
            <div class="developer-name">{{ developerInfo.name || developerInfo.login }}</div>
            <div class="developer-handle">@{{ developerInfo.login }}</div>
          </div>
          <n-button size="small" secondary @click="openGithub">
            GitHub
            <template #icon>
              <n-icon size="14"><i class="mgc_arrow_right_line" /></n-icon>
            </template>
          </n-button>
        </div>

        <div v-else class="about-card-row">
          <span class="about-card-label">主开发者</span>
          <span class="about-card-value">Enzymeym</span>
        </div>
      </n-card>

      <!-- 法律信息卡片 -->
      <n-card class="about-card" :bordered="false" :style="{
        backgroundColor: themeVars.cardColor
      }">
        <template #header>
          <div class="about-card-header">
            <span class="about-card-icon"><n-icon><i class="mgc_shield_line" /></n-icon></span>
            <span>法律信息</span>
          </div>
        </template>
        <div class="about-card-row legal-row">
          <span class="about-card-label">隐私政策与在线服务声明</span>
          <n-button size="small" secondary @click="showLegalModal = true">查看</n-button>
        </div>
      </n-card>

      <!-- 更新日志卡片 -->
      <n-card class="about-card changelog-card" :bordered="false" :style="{
        backgroundColor: themeVars.cardColor
      }">
        <template #header>
          <div class="about-card-header">
            <span class="about-card-icon"><n-icon><i class="mgc_history_line" /></n-icon></span>
            <span>更新日志</span>
            <n-tag v-if="currentChangelogVersion" size="small" :bordered="false" round>{{ currentChangelogVersion }}</n-tag>
          </div>
        </template>

        <div v-if="changelogLoading" class="loading-container">
          <n-spin size="medium" />
          <div class="loading-text">正在获取更新日志...</div>
        </div>

        <div v-else-if="changelogError" class="error-container">
          <n-icon size="32" color="#d03050" style="margin-bottom: 8px">
            <i class="mgc_wifi_off_line"></i>
          </n-icon>
          <div class="error-text">{{ changelogError }}</div>
          <n-button size="small" secondary style="margin-top: 12px" @click="fetchChangelog">重试</n-button>
        </div>

        <div v-else class="markdown-body changelog-content" v-html="renderedChangelog"></div>
      </n-card>
    </div>

    <!-- 隐私政策与在线服务声明弹窗 -->
    <n-modal
      v-model:show="showLegalModal"
      preset="card"
      title="隐私政策与在线服务声明"
      :bordered="false"
      size="medium"
      style="width: 640px; max-width: 90vw"
    >
      <n-scrollbar style="max-height: 60vh">
        <LegalTexts />
      </n-scrollbar>
    </n-modal>
  </div>
</template>

<style scoped>
.about-root {
  position: relative;
  width: 100%;
  padding: 24px 4px 0 0;
}

.about-hero {
  position: relative;
  z-index: 1;
  text-align: center;
  margin-bottom: 16px;
  padding: 24px 16px 20px;
}

.about-logo {
  width: 64px;
  height: 64px;
  border-radius: 14px;
  margin: 0 auto 12px;
  display: block;
  object-fit: cover;
}

.about-hero-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0.5px;
  position: relative;
  z-index: 1;
}

.about-hero-meta {
  margin-top: 8px;
  display: flex;
  justify-content: center;
  gap: 6px;
  align-items: center;
  position: relative;
  z-index: 1;
}

.about-hero-desc {
  margin-top: 8px;
  font-size: 13px;
  opacity: 0.55;
  position: relative;
  z-index: 1;
}

.about-hero-actions {
  position: relative;
  margin-top: 16px;
  display: flex;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  z-index: 1;
}

.about-sponsor-btn :deep(.n-icon) {
  color: #d03050;
}

.about-cards {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.about-card {
  backdrop-filter: blur(18px);
}

.about-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}

.about-card-icon {
  display: inline-flex;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  align-items: center;
  justify-content: center;
  background: rgba(127, 127, 127, 0.1);
  font-size: 15px;
  color: v-bind('themeVars.primaryColor');
  flex-shrink: 0;
}

.about-card-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  padding: 4px 0;
}

.about-card-label {
  opacity: 0.7;
}

.about-card-value {
  margin-left: 24px;
}

.beta-notice {
  position: relative;
  z-index: 1;
  margin-bottom: 16px;
}

.developer-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.developer-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.developer-details {
  flex: 1;
  min-width: 0;
}

.developer-name {
  font-weight: 600;
  font-size: 14px;
}

.developer-handle {
  font-size: 12px;
  color: v-bind('themeVars.textColor3');
  margin-top: 2px;
}

.loading-container,
.error-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  text-align: center;
}

.changelog-content {
  padding-top: 0px !important;
  transform: translateY(-16px);
}

.markdown-body {
  font-size: 14px;
  line-height: 1.6;
}

:deep(.markdown-body h1),
:deep(.markdown-body h2),
:deep(.markdown-body h3) {
  margin-top: 1.2em;
  margin-bottom: 0.6em;
  font-weight: 600;
  line-height: 1.25;
}

:deep(.markdown-body h1) {
  font-size: 1.5em;
  border-bottom: 1px solid rgba(127, 127, 127, 0.2);
  padding-bottom: 0.3em;
}

:deep(.markdown-body h2) {
  font-size: 1.3em;
  border-bottom: 1px solid rgba(127, 127, 127, 0.1);
  padding-bottom: 0.3em;
}

:deep(.markdown-body h3) {
  font-size: 1.1em;
}

:deep(.markdown-body ul),
:deep(.markdown-body ol) {
  padding-left: 20px;
  margin-bottom: 1em;
}

:deep(.markdown-body li) {
  margin-bottom: 0.25em;
}

:deep(.markdown-body p) {
  margin-bottom: 1em;
}

:deep(.markdown-body a) {
  color: v-bind('themeVars.primaryColor');
  text-decoration: none;
}

:deep(.markdown-body a:hover) {
  text-decoration: underline;
}

:deep(.markdown-body blockquote) {
  border-left: 4px solid rgba(127, 127, 127, 0.2);
  padding-left: 1em;
  color: v-bind('themeVars.textColor3');
  margin: 1em 0;
  background-color: rgba(127, 127, 127, 0.05);
  padding: 8px 12px;
  border-radius: 4px;
}

:deep(.markdown-body code) {
  background-color: rgba(127, 127, 127, 0.15);
  padding: 0.2em 0.4em;
  border-radius: 4px;
  font-family: monospace;
  font-size: 0.9em;
}

:deep(.markdown-body pre) {
  background-color: rgba(127, 127, 127, 0.1);
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  margin-bottom: 1em;
}

:deep(.markdown-body pre code) {
  background-color: transparent;
  padding: 0;
}

/* 更新状态卡片 */
.update-status-card {
  position: relative;
  z-index: 1;
  margin-top: 16px;
  padding: 12px 16px;
  border-radius: 10px;
  background-color: rgba(127, 127, 127, 0.08);
  backdrop-filter: blur(10px);
}

.update-status-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  justify-content: center;
}

.update-status-error {
  color: #d03050;
}

.update-status-downloading {
  flex-direction: column;
  gap: 6px;
}

.update-download-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.update-download-detail {
  font-size: 11px;
  opacity: 0.7;
}
</style>
