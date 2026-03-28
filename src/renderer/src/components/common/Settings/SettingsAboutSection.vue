<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { NCard, NIcon, useThemeVars, NAlert, NSpin, NButton } from 'naive-ui'
import MarkdownIt from 'markdown-it'
import { full as emoji } from 'markdown-it-emoji'
import markdownItGitHubAlerts from 'markdown-it-github-alerts'
import 'markdown-it-github-alerts/styles/github-colors-light.css';
import 'markdown-it-github-alerts/styles/github-colors-dark-class.css';
import 'markdown-it-github-alerts/styles/github-base.css';
import axios, { type AxiosError } from 'axios'

// 主题变量，用于控制关于页颜色与玻璃卡片样式
const themeVars = useThemeVars()

// GitHub Release 数据类型定义
interface GitHubRelease {
  tag_name: string;
  body: string;
  name?: string;
  published_at?: string;
  prerelease?: boolean;
}

// GitHub User 数据类型定义
interface GitHubUser {
  login: string;
  name: string;
  avatar_url: string;
  html_url: string;
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

// 应用名称与版本信息
const appName = computed(() => 'Such Music')
const appVersion = computed(() => '0.2.0')

// 更新日志相关
const showChangelog = ref(false)
const changelogLoading = ref(false)
const changelogContent = ref('')
const changelogError = ref('')
const currentChangelogVersion = ref('')

// 开发者信息
const developerInfo = ref<GitHubUser | null>(null)
const developerLoading = ref(false)

onMounted(() => {
  fetchChangelog()
  fetchDeveloperInfo()
})

// 获取开发者信息
const fetchDeveloperInfo = async () => {
  developerLoading.value = true
  const owner = 'Enzymeym'
  try {
    const { data } = await axios.get<GitHubUser>(`https://api.github.com/users/${owner}`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
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
    ;(window as any).electron.shell.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

// 获取更新日志
const fetchChangelog = async () => {
  showChangelog.value = true
  if (changelogContent.value) return

  changelogLoading.value = true
  changelogError.value = ''

  const owner = 'Enzymeym'
  const repo = 'SuchMusic-NG'

  // 辅助函数：获取 Release 列表
  const getReleases = async (): Promise<GitHubRelease[]> => {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases`
    try {
      const { data } = await axios.get<GitHubRelease[]>(url, {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
        params: { per_page: 10 }, // 仅获取最近的 10 个 release 即可
        timeout: 10000
      })
      return data
    } catch (error) {
       const axiosError = error as AxiosError;
       console.warn(`请求 GitHub Releases 列表失败: ${axiosError.message}`)
       return []
    }
  }

  try {
    const version = appVersion.value
    
    // 获取最近的 release 列表，避免通过 tag 猜测导致的 404 错误
    const releases = await getReleases()
    
    // 1. 在列表中查找当前版本
    // 优先匹配 name 字段为 v+version，其次匹配 tag_name
    let release = releases.find(r => 
      (r.name && r.name === `v${version}`) || 
      (r.tag_name === `v${version}` || r.tag_name === version)
    )

    if (release) {
      changelogContent.value = release.body || '该版本无详细更新说明'
      currentChangelogVersion.value = release.tag_name
    } else {
      // 2. 如果没找到，回退到列表中的第一个版本（通常是最新发布的）
      // 注意：GitHub API 返回的列表通常按 created_at 倒序排列
      const latest = releases[0]
      
      if (latest) {
        changelogContent.value = `> **提示**：未找到当前版本 (v${version}) 的更新日志，以下是最新${latest.prerelease ? '预发布' : ''}版本 (${latest.tag_name}) 的日志：\n\n` + (latest.body || '无详细说明')
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
      <div class="about-hero-title">
        {{ appName }}
      </div>
      <div class="about-hero-version">
        {{ appVersion }}
      </div>
      <div class="about-hero-toolbar">
        <button class="about-hero-github" type="button" @click="openGithub" title="GitHub">
          <n-icon size="22">
            <i class="mgc_github_line" />
          </n-icon>
        </button>
      </div>
    </div>

    <div class="about-cards">

      <n-alert type="info" style="margin-bottom: 12px;">
        注意：当前版本为为测试版，功能不完善，请谨慎使用
      </n-alert>
    
      <n-card
        class="about-card"
        :bordered="false"
        :style="{
          backgroundColor: themeVars.cardColor
        }"
      >
        <template #header>
          <div>开发者</div>
        </template>
        
        <div v-if="developerLoading" class="about-card-row" style="justify-content: center;">
          <n-spin size="small" />
        </div>

        <div v-else-if="developerInfo" class="developer-info">
          <img :src="developerInfo.avatar_url" class="developer-avatar" alt="avatar">
          <div class="developer-details">
            <div class="developer-name">{{ developerInfo.name || developerInfo.login }}</div>
            <a :href="developerInfo.html_url" target="_blank" class="developer-link">@{{ developerInfo.login }}</a>
          </div>
        </div>

        <div v-else class="about-card-row">
          <span class="about-card-label">主开发者</span>
          <span class="about-card-value">Enzymeym</span>
        </div>
      </n-card>
      
      <!-- 更新日志卡片 -->
      <n-card
        class="about-card changelog-card"
        :bordered="false"
        :style="{
          backgroundColor: themeVars.cardColor
        }"
      >
        <template #header>
          <div class="changelog-header">
            <span>更新日志</span>
          </div>
        </template>

        <div v-if="changelogLoading" class="loading-container">
          <n-spin size="medium" />
          <div class="loading-text">正在获取更新日志...</div>
        </div>
        
        <div v-else-if="changelogError" class="error-container">
          <n-icon size="32" color="#d03050" style="margin-bottom: 8px;">
             <i class="mgc_wifi_off_line"></i>
          </n-icon>
          <div class="error-text">{{ changelogError }}</div>
          <n-button size="small" secondary style="margin-top: 12px;" @click="fetchChangelog">重试</n-button>
        </div>
        
        <div v-else class="markdown-body changelog-content" v-html="renderedChangelog"></div>
      </n-card>
    </div>
  </div>
</template>

<style scoped>
/* 关于页根容器，模拟 HyperOS 中居中布局 */
.about-root {
  position: relative;
  padding-top: 32px;
  overflow: hidden;
}

/* 顶部彩虹动态流光背景，仅扩展水平方向 */
.about-root::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  width: 180%;
  height: 150px;

  opacity: 0.6;
  filter: blur(26px);
  transform: translateX(-50%);
  animation: about-hero-rainbow 14s ease-in-out infinite;
}

.about-hero {
  position: relative;
  text-align: center;
  margin-bottom: 24px;
  padding: 32px 16px 24px;
}

.about-hero-title {
  font-size: 30px;
  font-weight: 600;
  position: relative;
  z-index: 1;
}

.about-hero-version {
  margin-top: 6px;
  font-size: 13px;
  opacity: 0.7;
  position: relative;
  z-index: 1;
}

.about-hero-toolbar {
  position: relative;
  margin-top: 12px;
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1;
}

.about-hero-github {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 999px;
  border: none;
  cursor: pointer;
  background-color: rgba(0, 0, 0, 0.06);
  color: inherit;
  transition: background-color 0.2s, transform 0.15s;
}

.about-hero-github:hover {
  background-color: rgba(0, 0, 0, 0.12);
  transform: translateY(-1px);
}

.about-hero-update {
  position: absolute;
  right: 0;
  padding: 4px 12px;
  border-radius: 999px;
  border: none;
  cursor: pointer;
  font-size: 12px;
  background-color: rgba(255, 255, 255, 0.85);
  color: rgba(0, 0, 0, 0.75);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.04);
  backdrop-filter: blur(10px);
  transition: background-color 0.2s, transform 0.15s, box-shadow 0.2s;
}

.about-hero-update:hover {
  background-color: rgba(255, 255, 255, 0.98);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
  transform: translateY(-1px);
}

@keyframes about-hero-rainbow {
  0% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0% 50%;
  }
}

.about-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.about-card {
  backdrop-filter: blur(18px);
}

.about-card-title {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
  opacity: 0.85;
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

.about-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.about-link-icon {
  flex-shrink: 0;
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

:deep(.markdown-body h1) { font-size: 1.5em; border-bottom: 1px solid rgba(127,127,127,0.2); padding-bottom: 0.3em; }
:deep(.markdown-body h2) { font-size: 1.3em; border-bottom: 1px solid rgba(127,127,127,0.1); padding-bottom: 0.3em; }
:deep(.markdown-body h3) { font-size: 1.1em; }

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
  background-color: rgba(127,127,127,0.05);
  padding: 8px 12px;
  border-radius: 4px;
}

:deep(.markdown-body code) {
  background-color: rgba(127,127,127,0.15);
  padding: 0.2em 0.4em;
  border-radius: 4px;
  font-family: monospace;
  font-size: 0.9em;
}

:deep(.markdown-body pre) {
  background-color: rgba(127,127,127,0.1);
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  margin-bottom: 1em;
}

:deep(.markdown-body pre code) {
  background-color: transparent;
  padding: 0;
}

.developer-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.developer-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
}

.developer-details {
  display: flex;
  flex-direction: column;
}

.developer-name {
  font-weight: 600;
  font-size: 15px;
}

.developer-link {
  font-size: 13px;
  color: var(--n-text-color-3);
  text-decoration: none;
}

.developer-link:hover {
  text-decoration: underline;
}
</style>
