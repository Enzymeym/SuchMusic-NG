<script setup lang="ts">
import { NCard, NSwitch, NSelect, NButton } from 'naive-ui'
import { useSettingsStore } from '../../../stores/settingsStore'

// 使用设置仓库，驱动常规设置选项
const settingsStore = useSettingsStore()

// 关闭行为选项配置
const closeActionOptions = [
  { label: '最小化到任务栏', value: 'minimize' },
  { label: '退出应用', value: 'quit' }
]

// 更新通道选项配置
const updateChannelOptions = [
  { label: '正式版', value: 'stable' },
  { label: '测试版', value: 'beta' }
]

const handleRestartSetupWizard = () => {
  window.dispatchEvent(new CustomEvent('close-settings'))
  window.dispatchEvent(new CustomEvent('setup-wizard:restart'))
}

defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  // 当前高亮的设置项 key
  highlightKey?: string | null
}>()
</script>

<template>
  <div class="settings-content">
    <div class="section-group-title">系统行为</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': highlightKey === 'general.closeAction' }"
      data-setting-key="general.closeAction"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">关闭软件时</div>
          <div class="sub-label">选择关闭软件的方式</div>
        </div>
        <n-select
          v-model:value="settingsStore.general.closeAction"
          :options="closeActionOptions"
          style="width: 160px"
        />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': highlightKey === 'general.remindOnClose' }"
      data-setting-key="general.remindOnClose"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">每次关闭前都进行提醒</div>
        </div>
        <n-switch v-model:value="settingsStore.general.remindOnClose" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': highlightKey === 'general.taskbarProgress' }"
      data-setting-key="general.taskbarProgress"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">任务栏显示播放进度</div>
          <div class="sub-label">是否在任务栏显示歌曲播放进度</div>
        </div>
        <n-switch v-model:value="settingsStore.general.taskbarProgress" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': highlightKey === 'general.taskbarSongInfo' }"
      data-setting-key="general.taskbarSongInfo"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">任务栏显示歌曲信息</div>
          <div class="sub-label">播放时在任务栏应用名显示 歌曲名 - 歌手</div>
        </div>
        <n-switch v-model:value="settingsStore.general.taskbarSongInfo" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': highlightKey === 'general.autoCheckUpdate' }"
      data-setting-key="general.autoCheckUpdate"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">自动检查更新</div>
          <div class="sub-label">在每次开启软件时自动检查更新</div>
        </div>
        <n-switch v-model:value="settingsStore.general.autoCheckUpdate" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': highlightKey === 'general.updateChannel' }"
      data-setting-key="general.updateChannel"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">更新通道</div>
          <div class="sub-label">切换更新通道（测试版可体验最新功能，但不保证稳定性）</div>
        </div>
        <n-select
          v-model:value="settingsStore.general.updateChannel"
          :options="updateChannelOptions"
          style="width: 120px"
        />
      </div>
    </n-card>

    <div class="section-group-title">引导</div>

    <n-card
      class="setting-item"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">重新进行开屏设置向导</div>
          <div class="sub-label">重新体验首次使用时的基础设置向导</div>
        </div>
        <n-button secondary size="small" @click="handleRestartSetupWizard">
          开始向导
        </n-button>
      </div>
    </n-card>
  </div>
</template>
