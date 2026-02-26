<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NIcon, useThemeVars, useMessage, NAlert } from 'naive-ui'

// 主题变量，用于控制关于页颜色与玻璃卡片样式
const themeVars = useThemeVars()
const message = useMessage()

// 应用名称与版本信息
const appName = computed(() => 'Such Music')
const appVersion = computed(() => '0.1.0-beta-ui')

// 打开 GitHub 项目地址
const openGithub = () => {
  const url = 'https://github.com/Enzymeym/SuchMusic-NG'
  if ((window as any).electron?.shell) {
    ;(window as any).electron.shell.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

// 手动检查更新（占位实现，后续可接入真正的更新逻辑）
const checkUpdate = () => {
  message.info('正在检查更新...', { duration: 2000 })
  // 这里可以接入主进程 IPC，调用 autoUpdater 进行真正的更新检查
}
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
        <button class="about-hero-github" type="button" @click="openGithub">
          <n-icon size="22">
            <i class="mgc_github_line" />
          </n-icon>
        </button>
        <button style="display: none;" class="about-hero-update" type="button" @click="checkUpdate">
          检查更新
        </button>
      </div>
    </div>

    <div class="about-cards">

      <n-alert type="info" style="margin-bottom: 12px;">
        注意：当前版本为仅用于测试 UI，功能不完善，谨慎使用
      </n-alert>
    
      <n-card
        class="about-card"
        :bordered="false"
        :style="{
          backgroundColor: themeVars.cardColor,
          boxShadow: themeVars.boxShadow3
        }"
      >
        <div class="about-card-title">开发者</div>
        <div class="about-card-row">
          <span class="about-card-label">主开发者</span>
          <span class="about-card-value">Enzymeym</span>
        </div>
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
  border-radius: 18px;
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
</style>
