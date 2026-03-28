<script setup lang="ts">
import { NCard, NSwitch, NSelect, NList, NListItem, NButton } from 'naive-ui'
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

const getPlatformName = (key: string) => {
  const map: Record<string, string> = {
    tx: 'QQ音乐',
    kg: '酷狗音乐',
    wy: '网易云音乐',
    kw: '酷我音乐',
    bilibili: '哔哩哔哩',
    mg: '咪咕音乐'
  }
  return map[key] || key
}

const moveUp = (index: number) => {
  if (index <= 0) return
  const list = settingsStore.general.searchResultOrder
  const temp = list[index]
  list[index] = list[index - 1]
  list[index - 1] = temp
}

const moveDown = (index: number) => {
  const list = settingsStore.general.searchResultOrder
  if (index >= list.length - 1) return
  const temp = list[index]
  list[index] = list[index + 1]
  list[index + 1] = temp
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
      :class="{ 'setting-item--highlight': highlightKey === 'general.onlineServices' }"
      data-setting-key="general.onlineServices"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">在线服务</div>
          <div class="sub-label">是否开启软件的在线服务</div>
        </div>
        <n-switch v-model:value="settingsStore.general.onlineServices" />
      </div>
    </n-card>

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
      :class="{ 'setting-item--highlight': highlightKey === 'general.orpheusProtocol' }"
      data-setting-key="general.orpheusProtocol"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">通过 Orpheus 协议唤起本应用</div>
          <div class="sub-label">
            该协议通常用于官方网页端唤起官方客户端，启用后可能导致官方客户端无法被唤起
          </div>
        </div>
        <n-switch v-model:value="settingsStore.general.orpheusProtocol" />
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
    <div class="section-group-title" style="margin-top: 24px;">搜索结果排序</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': highlightKey === 'general.searchResultOrder' }"
      data-setting-key="general.searchResultOrder"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <n-list hoverable clickable>
        <n-list-item v-for="(item, index) in settingsStore.general.searchResultOrder" :key="item">
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 0;">
            <span>{{ getPlatformName(item) }}</span>
            <div style="display: flex; gap: 8px;">
              <n-button size="tiny" @click="moveUp(index)" :disabled="index === 0">上移</n-button>
              <n-button size="tiny" @click="moveDown(index)" :disabled="index === settingsStore.general.searchResultOrder.length - 1">下移</n-button>
            </div>
          </div>
        </n-list-item>
      </n-list>
    </n-card>
  </div>
</template>
