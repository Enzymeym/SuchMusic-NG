<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NSwitch, NSlider, NSelect, NAlert, NColorPicker } from 'naive-ui'
import { useSettingsStore } from '../../../stores/settingsStore'

// 使用设置仓库驱动歌词相关设置
const settingsStore = useSettingsStore()

const props = defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  // 当前高亮的设置项 key
  highlightKey?: string | null
}>()

// 歌词区域占比（右侧歌词区宽度百分比）
const lyricsAreaPercent = computed({
  get: () => settingsStore.playback.lyricsAreaRatio,
  set: (val: number) => {
    const clamped = Math.min(Math.max(val, 30), 70)
    settingsStore.playback.lyricsAreaRatio = clamped
  }
})

// 歌词字号（px）
const lyricsFontSize = computed({
  get: () => settingsStore.playback.lyricsFontSize,
  set: (val: number) => {
    const clamped = Math.min(Math.max(val, 16), 40)
    settingsStore.playback.lyricsFontSize = clamped
  }
})

const playerBackgroundStyleOptions = [
  { label: '传统模糊背景', value: 'classic' },
  { label: '动态背景（AMLL）', value: 'amll' }
]

</script>

<template>
  <div class="settings-content">
    <div class="section-group-title">歌词显示</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsAutoSize' }"
      data-setting-key="playback.lyricsAutoSize"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">自适应歌词大小</div>
          <div class="sub-label">根据播放页可用空间自动调整歌词字号（全屏推荐开启）</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.lyricsAutoSize" />
      </div>
    </n-card>

    <div class="section-group-title" style="margin-top: 16px;">播放页</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.playerBackgroundStyle' }"
      data-setting-key="playback.playerBackgroundStyle"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">播放页背景样式</div>
          <div class="sub-label">在传统模糊背景和 AMLL 动态背景之间切换</div>
        </div>
        <n-select
          v-model:value="settingsStore.playback.playerBackgroundStyle"
          :options="playerBackgroundStyleOptions"
          style="width: 220px"
        />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsFontSize' }"
      data-setting-key="playback.lyricsFontSize"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">歌词字号</div>
          <div class="sub-label">关闭自适应后生效，控制播放页歌词整体大小</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; min-width: 220px">
          <n-slider
            v-model:value="lyricsFontSize"
            :min="16"
            :max="40"
            :step="1"
            :tooltip="false"
            style="width: 160px"
          />
          <span class="time-text">{{ lyricsFontSize }} px</span>
        </div>
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsAreaRatio' }"
      data-setting-key="playback.lyricsAreaRatio"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">播放页布局</div>
          <div class="sub-label">调节封面与歌词在播放页中的占比（右侧为歌词区域）</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; min-width: 260px">
          <n-slider
            v-model:value="lyricsAreaPercent"
            :min="30"
            :max="70"
            :step="1"
            :tooltip="false"
            style="width: 180px"
          />
          <span class="time-text"
            >封面 {{ 100 - lyricsAreaPercent }}% / 歌词 {{ lyricsAreaPercent }}%</span
          >
        </div>
      </div>
    </n-card>

    <n-alert
      v-if="settingsStore.playback.playerBackgroundStyle === 'amll'"
      style="margin-bottom: 8px"
      type="warning"
    >
      虽然目前我们支持关闭 AMLL 歌词模式，但我们不推荐您这么做
    </n-alert>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsAppleStyle' }"
      data-setting-key="playback.lyricsAppleStyle"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">Apple 风格歌词（AppleMusic-like-lyrics）</div>
          <div class="sub-label">开启后使用 Apple Music 风格逐字高亮歌词；关闭使用简洁列表样式</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.lyricsAppleStyle" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsBlurEnabled' }"
      data-setting-key="playback.lyricsBlurEnabled"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">模糊效果</div>
          <div class="sub-label">控制 Apple 风格歌词背后的模糊玻璃效果展示</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.lyricsBlurEnabled" />
      </div>
    </n-card>


    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsSpringEnabled' }"
      data-setting-key="playback.lyricsSpringEnabled"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">弹簧动效</div>
          <div class="sub-label">控制 Apple 风格歌词的弹簧滚动与缩放动效</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.lyricsSpringEnabled" />
      </div>
    </n-card>

    <div class="section-group-title" style="margin-top: 16px;">桌面歌词</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.desktopLyricsLocked' }"
      data-setting-key="playback.desktopLyricsLocked"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">锁定歌词窗口</div>
          <div class="sub-label">锁定后窗口无法拖动，鼠标穿透（悬停时短暂解锁）</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.desktopLyricsLocked" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.desktopLyricsShowNextLine' }"
      data-setting-key="playback.desktopLyricsShowNextLine"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">显示下一行</div>
          <div class="sub-label">桌面歌词是否同时显示下一句</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.desktopLyricsShowNextLine" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.desktopLyricsFontSize' }"
      data-setting-key="playback.desktopLyricsFontSize"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">字体大小</div>
          <div class="sub-label">控制桌面歌词的字体大小</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; min-width: 220px">
          <n-slider
            v-model:value="settingsStore.playback.desktopLyricsFontSize"
            :min="12"
            :max="60"
            :step="1"
            :tooltip="false"
            style="width: 160px"
          />
          <span class="time-text">{{ settingsStore.playback.desktopLyricsFontSize }} px</span>
        </div>
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.desktopLyricsOpacity' }"
      data-setting-key="playback.desktopLyricsOpacity"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">透明度</div>
          <div class="sub-label">控制桌面歌词窗口的透明度</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; min-width: 220px">
          <n-slider
            v-model:value="settingsStore.playback.desktopLyricsOpacity"
            :min="0.1"
            :max="1.0"
            :step="0.05"
            :tooltip="false"
            style="width: 160px"
          />
          <span class="time-text">{{ Math.round(settingsStore.playback.desktopLyricsOpacity * 100) }}%</span>
        </div>
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.desktopLyricsAlign' }"
      data-setting-key="playback.desktopLyricsAlign"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">对齐方式</div>
          <div class="sub-label">左/中/右对齐</div>
        </div>
        <n-select
          v-model:value="settingsStore.playback.desktopLyricsAlign"
          :options="[
            { label: '左对齐', value: 'left' },
            { label: '居中', value: 'center' },
            { label: '右对齐', value: 'right' }
          ]"
          style="width: 120px"
        />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.desktopLyricsColor' }"
      data-setting-key="playback.desktopLyricsColor"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">普通歌词颜色</div>
          <div class="sub-label">未播放歌词的颜色</div>
        </div>
        <n-color-picker
          v-model:value="settingsStore.playback.desktopLyricsColor"
          :show-alpha="true"
          :modes="['hex']"
          style="width: 120px"
        />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.desktopLyricsActiveColor' }"
      data-setting-key="playback.desktopLyricsActiveColor"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">高亮歌词颜色</div>
          <div class="sub-label">当前播放歌词的颜色</div>
        </div>
        <n-color-picker
          v-model:value="settingsStore.playback.desktopLyricsActiveColor"
          :show-alpha="true"
          :modes="['hex']"
          style="width: 120px"
        />
      </div>
    </n-card>
  </div>
</template>
