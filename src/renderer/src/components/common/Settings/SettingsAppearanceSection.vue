<script setup lang="ts">
import { computed, h } from 'vue'
import { NCard, NSelect, NColorPicker, NSwitch } from 'naive-ui'
import { useSettingsStore } from '../../../stores/settingsStore'
import { setPrimaryColor } from '../../../themes'

// 使用设置仓库，驱动外观设置选项
const settingsStore = useSettingsStore()

// 字体选项由父组件传入，便于复用与懒加载
const props = defineProps<{
  fontOptions: { label: string; value: string }[]
  globalFontOptions: { label: string; value: string }[]
  settingItemBgColor: string
  settingItemBorderColor: string
  // 当前高亮的设置项 key
  highlightKey?: string | null
  // 是否为 Mac 平台
  isMac?: boolean
}>()

// 字体标签渲染函数，使用对应字体展示名称（恢复为单行展示）
const renderFontLabel = (option: { label: string; value: string }) => {
  return h('span', { style: { fontFamily: option.value } }, option.label)
}

// 主题色预设列表（用于根据预设值映射颜色）
const themeColorPresets = [
  { label: '默认蓝', value: 'default', color: '#2C8EFD' },
  { label: '清新绿', value: 'green', color: '#2fd16c' },
  { label: '活力橙', value: 'orange', color: '#f0a020' },
  { label: '少女粉', value: 'pink', color: '#f472b6' },
  { label: '葡萄紫', value: 'purple', color: '#8b5cf6' }
]

// 主题模式选项列表
const themeModeOptions = [
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
  { label: '跟随系统', value: 'system' }
]

// 主题颜色预设下拉选项（包含自定义）
const themePresetOptions = [
  { label: '默认蓝', value: 'default' },
  { label: '清新绿', value: 'green' },
  { label: '活力橙', value: 'orange' },
  { label: '少女粉', value: 'pink' },
  { label: '葡萄紫', value: 'purple' },
  { label: '自定义', value: 'custom' }
]

// 当前主题色值（优先使用自定义颜色）
const currentThemeColor = computed(() => {
  return settingsStore.appearance.customThemeColor || '#2C8EFD'
})

// 选择预设时应用对应主题色（非自定义时立即生效）
const handlePresetChange = (presetValue: string) => {
  settingsStore.appearance.themeColorPreset = presetValue
  if (presetValue === 'custom') {
    return
  }
  const preset = themeColorPresets.find((p) => p.value === presetValue)
  if (preset) {
    settingsStore.appearance.customThemeColor = preset.color
    // 立即更新全局主题主色
    setPrimaryColor(preset.color)
  }
}

// 当用户在颜色选择器中选择自定义颜色时，同步到设置，并标记为 custom
const handleCustomColorChange = (color: string | null) => {
  if (!color) return
  settingsStore.appearance.customThemeColor = color
  settingsStore.appearance.themeColorPreset = 'custom'
  // 立即更新全局主题主色
  setPrimaryColor(color)
}
</script>

<template>
  <div class="settings-content">
    <div v-if="!props.isMac">
      <div class="section-group-title">字体设置</div>

      <n-card
        class="setting-item"
        :class="{ 'setting-item--highlight': props.highlightKey === 'appearance.globalFont' }"
        data-setting-key="appearance.globalFont"
        :bordered="true"
        size="small"
        :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
      >
        <div class="setting-row">
          <div class="setting-label">
            <div class="main-label">全局字体</div>
            <div class="sub-label">软件界面的主要字体</div>
          </div>
          <n-select
            v-model:value="settingsStore.appearance.globalFont"
            :options="props.globalFontOptions"
            :render-label="renderFontLabel"
            filterable
            placeholder="选择字体"
            style="width: 200px"
          />
        </div>
      </n-card>
    </div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'appearance.lyricsFont' }"
      data-setting-key="appearance.lyricsFont"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">歌词字体</div>
          <div class="sub-label">歌词界面的显示字体</div>
        </div>
        <n-select
          v-model:value="settingsStore.appearance.lyricsFont"
          :options="props.fontOptions"
          :render-label="renderFontLabel"
          filterable
          placeholder="选择字体"
          style="width: 200px"
        />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'appearance.taskbarLyricsFont' }"
      data-setting-key="appearance.taskbarLyricsFont"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">任务栏歌词字体</div>
          <div class="sub-label">任务栏歌词的显示字体</div>
        </div>
        <n-select
          v-model:value="settingsStore.appearance.taskbarLyricsFont"
          :options="props.fontOptions"
          :render-label="renderFontLabel"
          filterable
          placeholder="选择字体"
          style="width: 200px"
        />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'appearance.desktopLyricsFont' }"
      data-setting-key="appearance.desktopLyricsFont"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">桌面歌词字体</div>
          <div class="sub-label">桌面歌词窗口的显示字体</div>
        </div>
        <n-select
          v-model:value="settingsStore.appearance.desktopLyricsFont"
          :options="props.fontOptions"
          :render-label="renderFontLabel"
          filterable
          placeholder="选择字体"
          style="width: 200px"
        />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'appearance.songListStyle' }"
      data-setting-key="appearance.songListStyle"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">歌曲列表样式</div>
          <div class="sub-label">除歌单页面外的全局歌曲列表样式</div>
        </div>
        <n-select
          v-model:value="settingsStore.appearance.songListStyle"
          :options="[
            { label: '卡片模式', value: 'card' },
            { label: '简约模式', value: 'plain' }
          ]"
          style="width: 200px"
        />
      </div>
    </n-card>

    <div class="section-group-title" style="margin-top: 24px;">桌面歌词</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.desktopLyricsForceDuet' }"
      data-setting-key="playback.desktopLyricsForceDuet"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">强制对唱模式</div>
          <div class="sub-label">强制开启左右交替的对唱展示效果</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.desktopLyricsForceDuet" />
      </div>
    </n-card>

    <div class="section-group-title" style="margin-top: 24px;">主题设置</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'appearance.themeMode' }"
      data-setting-key="appearance.themeMode"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">主题模式</div>
          <div class="sub-label">调节全局明暗模式</div>
        </div>
        <n-select
          v-model:value="settingsStore.appearance.themeMode"
          :options="themeModeOptions"

          style="width: 200px"
        />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'appearance.themeColor' }"
      data-setting-key="appearance.themeColor"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">主题颜色预设</div>
          <div class="sub-label">选择一个预设主题主色或使用自定义</div>
        </div>
        <n-select
          v-model:value="settingsStore.appearance.themeColorPreset"
          :options="themePresetOptions"
          style="width: 200px"
          @update:value="handlePresetChange"
        />
      </div>
    </n-card>

    <n-card
      v-if="settingsStore.appearance.themeColorPreset === 'custom'"
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'appearance.customThemeColor' }"
      data-setting-key="appearance.customThemeColor"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row" style="align-items: flex-start;">
        <div class="setting-label">
          <div class="main-label">自定义主题色</div>
          <div class="sub-label">设置自定义主题色</div>
        </div>
        <div
          style="
            display: flex;
            flex-direction: row;
            align-items: center;
            height: 42px;
            min-width: 160px;
          "
        >
          <n-color-picker
            :value="currentThemeColor"
            :modes="['hex']"
            size="small"
            :show-alpha="false"
            @update:value="handleCustomColorChange"
          />
        </div>
      </div>
    </n-card>
  </div>
</template>
