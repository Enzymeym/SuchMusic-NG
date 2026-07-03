<script setup lang="ts">
import { computed, h } from 'vue'
import { NCard, NSelect, NColorPicker, NSwitch, NSlider } from 'naive-ui'
import { useSettingsStore } from '../../../stores/settingsStore'

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
/**
 * 渲染字体下拉选项，用该字体本身展示字体名称，实现所见即所得
 * 使用解码后的字体名称作为 fontFamily，并用解码后的名称作为显示文字
 * @param option 包含字体名称（label）和值（value）的选项对象
 * @returns 使用对应字体渲染的 span VNode
 */
const renderFontLabel = (option: { label: string; value: string }) => {
  // option.value 已在上游 SettingsModal 中经过 decodeMojibake 解码
  // 如果字体名仍然无效（如 fallback 值 "follow_global"），则不应用 fontFamily
  const isFollowGlobal = option.value === 'follow_global'
  return h('span', {
    style: isFollowGlobal ? {} : { fontFamily: option.value }
  }, option.label)
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
  }
}

// 当用户在颜色选择器中选择自定义颜色时，同步到设置，并标记为 custom
const handleCustomColorChange = (color: string | null) => {
  if (!color) return
  settingsStore.appearance.customThemeColor = color
  settingsStore.appearance.themeColorPreset = 'custom'
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

    <div class="section-group-title" style="margin-top: 24px;">播放页布局</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsAreaRatio' }"
      data-setting-key="playback.lyricsAreaRatio"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">播放页布局</div>
          <div class="sub-label">调节封面与歌词在播放页中的占比（右侧为歌词区域）</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; min-width: 260px">
          <n-slider
            v-model:value="settingsStore.playback.lyricsAreaRatio"
            :min="30"
            :max="70"
            :step="1"
            :tooltip="false"
            style="width: 180px"
          />
          <span class="time-text"
            >封面 {{ 100 - settingsStore.playback.lyricsAreaRatio }}% / 歌词
            {{ settingsStore.playback.lyricsAreaRatio }}%</span
          >
        </div>
      </div>
    </n-card>

    <div class="section-group-title" style="margin-top: 24px;">主题设置</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'appearance.themeColorFollowsCover' }"
      data-setting-key="appearance.themeColorFollowsCover"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">主题色跟随封面</div>
          <div class="sub-label">开启后全局主题主色将根据当前播放歌曲的封面自动提取并改变</div>
        </div>
        <n-switch v-model:value="settingsStore.appearance.themeColorFollowsCover" />
      </div>
    </n-card>

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
          <div class="main-label" :style="settingsStore.appearance.themeColorFollowsCover ? { color: 'var(--n-text-color-disabled)' } : {}">主题颜色预设</div>
          <div class="sub-label" :style="settingsStore.appearance.themeColorFollowsCover ? { color: 'var(--n-text-color-disabled)' } : {}">选择一个预设主题主色或使用自定义</div>
        </div>
        <n-select
          v-model:value="settingsStore.appearance.themeColorPreset"
          :options="themePresetOptions"
          :disabled="settingsStore.appearance.themeColorFollowsCover"
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
          <div class="main-label" :style="settingsStore.appearance.themeColorFollowsCover ? { color: 'var(--n-text-color-disabled)' } : {}">自定义主题色</div>
          <div class="sub-label" :style="settingsStore.appearance.themeColorFollowsCover ? { color: 'var(--n-text-color-disabled)' } : {}">设置自定义主题色</div>
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
            :disabled="settingsStore.appearance.themeColorFollowsCover"
            :show-alpha="false"
            @update:value="handleCustomColorChange"
          />
        </div>
      </div>
    </n-card>
  </div>
</template>
