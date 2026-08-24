<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NSwitch, NSlider, NSelect, NAlert, NColorPicker, NInput } from 'naive-ui'
import { useSettingsStore } from '../../../stores/settingsStore'

/**
 * 歌词设置组件
 * 接收父组件传入的主题色和边框色，以及高亮设置项 key
 */
const settingsStore = useSettingsStore()

const props = defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  /** 当前高亮的设置项 key */
  highlightKey?: string | null
}>()

/**
 * 歌词字号（px），范围 16-40
 * 关闭自适应时可用
 */
const lyricsFontSize = computed({
  get: () => settingsStore.playback.lyricsFontSize,
  set: (val: number) => {
    const clamped = Math.min(Math.max(val, 16), 40)
    settingsStore.playback.lyricsFontSize = clamped
  }
})

/**
 * 翻译/音译歌词字号，范围 10-28
 * 仅在自适应大小开启时可用，否则禁用并置灰
 */
const lyricsTranslationSize = computed({
  get: () => settingsStore.playback.lyricsTranslationSize,
  set: (val: number) => {
    const clamped = Math.min(Math.max(val, 10), 28)
    settingsStore.playback.lyricsTranslationSize = clamped
  }
})

/**
 * AMLL 逐字歌词渐变宽度，范围 0.0-1.0
 */
const amllWordFadeWidth = computed({
  get: () => settingsStore.playback.amllWordFadeWidth,
  set: (val: number) => {
    const clamped = Math.min(Math.max(val, 0), 1)
    settingsStore.playback.amllWordFadeWidth = clamped
  }
})

/**
 * 预览区使用的字体族，取自外观设置中的歌词字体
 */
const previewFontFamily = computed(() => settingsStore.appearance.lyricsFont)

/**
 * 预览区主歌词字号
 */
const previewFontSize = computed(() => settingsStore.playback.lyricsFontSize)

/**
 * 预览区翻译/音译字号
 */
const previewTranslationSize = computed(() => settingsStore.playback.lyricsTranslationSize)

/**
 * 模拟歌词行（预览用）：第一行已播放，第二行当前高亮
 */
const mockLyricLines = [
  { text: '这是一段已经播放过的歌词', active: false, passed: true },
  { text: '当前正在高亮显示的歌词行', active: true, passed: false }
]

/**
 * 模拟翻译文本（预览用）
 */
const mockTranslation = 'The currently highlighted lyric line'

/**
 * 模拟音译文本（预览用）
 */
const mockTransliteration = 'dāng qián gāo liàng gē cí háng'

const playerBackgroundStyleOptions = [
  { label: '传统模糊背景', value: 'classic' },
  { label: '动态背景（AMLL）', value: 'amll' }
]

</script>

<template>
  <div class="settings-content">
    <!-- ==================== 0. 歌词预览 ==================== -->
    <n-card
      class="lyrics-preview-card"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="preview-header">歌词预览</div>
      <div
        class="preview-stage"
        :style="{
          fontFamily: previewFontFamily,
          '--preview-font-size': previewFontSize + 'px',
          '--preview-translation-size': previewTranslationSize + 'px'
        }"
      >
        <div
          v-for="(line, index) in mockLyricLines"
          :key="index"
          class="preview-line-wrapper"
        >
          <!-- 已播放行：开启隐藏已播放时跳过 -->
          <template v-if="!line.passed || !settingsStore.playback.amllHidePassedLines">
            <div
              class="preview-line"
              :class="{
                'preview-line--passed': line.passed,
                'preview-line--active': line.active
              }"
              :style="{ fontSize: previewFontSize + 'px' }"
            >
              {{ line.text }}
            </div>
            <!-- 翻译行 -->
            <div
              v-if="line.active && settingsStore.playback.lyricsShowTranslation"
              class="preview-translation"
              :style="{ fontSize: previewTranslationSize + 'px' }"
            >
              {{ mockTranslation }}
            </div>
            <!-- 音译行 -->
            <div
              v-if="line.active && settingsStore.playback.lyricsShowTransliteration"
              class="preview-transliteration"
              :style="{ fontSize: previewTranslationSize + 'px' }"
            >
              {{ mockTransliteration }}
            </div>
          </template>
        </div>
      </div>
    </n-card>

    <!-- ==================== 1. 歌词显示 ==================== -->
    <div class="section-group-title">歌词显示</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsAutoSize' }"
      data-setting-key="playback.lyricsAutoSize"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">自适应歌词大小</div>
          <div class="sub-label">根据播放页可用空间自动调整歌词字号（全屏推荐开启）</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.lyricsAutoSize" />
      </div>
    </n-card>

    <!-- ==================== 2. 翻译与音译 ==================== -->
    <div class="section-group-title" style="margin-top: 16px;">翻译与音译</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsShowTranslation' }"
      data-setting-key="playback.lyricsShowTranslation"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">显示翻译歌词</div>
          <div class="sub-label">在播放页和桌面歌词中显示翻译内容</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.lyricsShowTranslation" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsShowTransliteration' }"
      data-setting-key="playback.lyricsShowTransliteration"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">显示音译歌词</div>
          <div class="sub-label">在播放页和桌面歌词中显示罗马音等音译内容</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.lyricsShowTransliteration" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsTranslationSize' }"
      data-setting-key="playback.lyricsTranslationSize"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label" :style="!settingsStore.playback.lyricsAutoSize ? { color: 'var(--n-text-color-disabled)' } : {}">翻译/音译字号</div>
          <div class="sub-label" :style="!settingsStore.playback.lyricsAutoSize ? { color: 'var(--n-text-color-disabled)' } : {}">控制翻译和音译歌词的显示字号（仅在自适应大小开启时生效）</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; min-width: 220px">
          <n-slider
            v-model:value="lyricsTranslationSize"
            :min="10"
            :max="28"
            :step="1"
            :tooltip="false"
            :disabled="!settingsStore.playback.lyricsAutoSize"
            style="width: 160px"
          />
          <span
            class="time-text"
            :style="!settingsStore.playback.lyricsAutoSize ? { color: 'var(--n-text-color-disabled)' } : {}"
          >{{ lyricsTranslationSize }} px</span>
        </div>
      </div>
    </n-card>

    <!-- ==================== 3. 播放页 ==================== -->
    <div class="section-group-title" style="margin-top: 16px;">播放页</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.playerBackgroundStyle' }"
      data-setting-key="playback.playerBackgroundStyle"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
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
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
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
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
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
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">模糊效果</div>
          <div class="sub-label">控制 Apple 风格歌词背后的模糊玻璃效果展示</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.lyricsBlurEnabled" />
      </div>
    </n-card>

    <!-- ==================== 4. AMLL 设置 ==================== -->
    <div class="section-group-title" style="margin-top: 16px;">AMLL 设置</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsSpringEnabled' }"
      data-setting-key="playback.lyricsSpringEnabled"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">弹簧动效</div>
          <div class="sub-label">控制 Apple 风格歌词的弹簧滚动与缩放动效</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.lyricsSpringEnabled" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsAlignPosition' }"
      data-setting-key="playback.lyricsAlignPosition"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">当前歌词垂直位置</div>
          <div class="sub-label">调整播放页中当前高亮歌词行的垂直位置，50% 为居中</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; min-width: 220px">
          <n-slider
            v-model:value="settingsStore.playback.lyricsAlignPosition"
            :min="0"
            :max="100"
            :step="1"
            :tooltip="false"
            style="width: 160px"
          />
          <span class="time-text">{{ settingsStore.playback.lyricsAlignPosition }}%</span>
        </div>
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.amllHidePassedLines' }"
      data-setting-key="playback.amllHidePassedLines"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">隐藏已播放歌词</div>
          <div class="sub-label">播放过的歌词行将自动隐藏，只显示当前及后续歌词</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.amllHidePassedLines" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.amllWordFadeWidth' }"
      data-setting-key="playback.amllWordFadeWidth"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">逐字歌词渐变宽度</div>
          <div class="sub-label">控制逐字高亮时的颜色渐变过渡宽度，0 为几乎无渐变，1 为全宽渐变</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; min-width: 220px">
          <n-slider
            v-model:value="amllWordFadeWidth"
            :min="0"
            :max="1"
            :step="0.05"
            :tooltip="false"
            style="width: 160px"
          />
          <span class="time-text">{{ amllWordFadeWidth.toFixed(2) }}</span>
        </div>
      </div>
    </n-card>

    <!-- ==================== 5. 歌词排除 ==================== -->
    <div class="section-group-title" style="margin-top: 16px;">歌词排除</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsExcludeTTML' }"
      data-setting-key="playback.lyricsExcludeTTML"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">排除 TTML 歌词</div>
          <div class="sub-label">过滤掉 TTML 格式的歌词，使用其他格式替代</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.lyricsExcludeTTML" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsExcludeLocal' }"
      data-setting-key="playback.lyricsExcludeLocal"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">排除本地音乐歌词</div>
          <div class="sub-label">过滤掉本地音乐内嵌的歌词，优先使用在线歌词</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.lyricsExcludeLocal" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsExcludeKeywords' }"
      data-setting-key="playback.lyricsExcludeKeywords"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">元数据关键词过滤</div>
          <div class="sub-label">匹配歌词元数据冒号前的内容（如 [ti:纯音乐]），多个关键词用逗号分隔</div>
        </div>
        <n-input
          v-model:value="settingsStore.playback.lyricsExcludeKeywords"
          placeholder="纯音乐, instrumental"
          style="width: 280px"
        />
      </div>
    </n-card>

    <!-- ==================== 6. 桌面歌词 ==================== -->
    <div class="section-group-title" style="margin-top: 16px;">桌面歌词</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.desktopLyricsLocked' }"
      data-setting-key="playback.desktopLyricsLocked"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
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
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
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
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
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
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
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
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
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
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">普通歌词颜色</div>
          <div class="sub-label">未播放歌词的颜色</div>
        </div>
        <div style="width: 120px; flex: 0 0 120px; display: inline-flex; align-items: center;">
          <n-color-picker
            v-model:value="settingsStore.playback.desktopLyricsColor"
            :show-alpha="true"
            :modes="['hex']"
          />
        </div>
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.desktopLyricsActiveColor' }"
      data-setting-key="playback.desktopLyricsActiveColor"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">高亮歌词颜色</div>
          <div class="sub-label">当前播放歌词的颜色</div>
        </div>
        <div style="width: 120px; flex: 0 0 120px; display: inline-flex; align-items: center;">
          <n-color-picker
            v-model:value="settingsStore.playback.desktopLyricsActiveColor"
            :show-alpha="true"
            :modes="['hex']"
          />
        </div>
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.desktopLyricsForceDuet' }"
      data-setting-key="playback.desktopLyricsForceDuet"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">强制对唱模式</div>
          <div class="sub-label">强制开启左右交替的对唱展示效果</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.desktopLyricsForceDuet" />
      </div>
    </n-card>

    <!-- ==================== 7. 歌词源设置 ==================== -->
    <div class="section-group-title" style="margin-top: 16px;">歌词源设置</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.lyricsPriority' }"
      data-setting-key="playback.lyricsPriority"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">歌词格式优先级</div>
          <div class="sub-label">选择优先使用的歌词格式，按顺序尝试获取</div>
        </div>
        <n-select
          v-model:value="settingsStore.playback.lyricsPriority"
          :options="[
            { label: 'TTML 格式（推荐）', value: 'ttml' },
            { label: '逐字歌词', value: 'crlyric' },
            { label: '普通歌词', value: 'lyric' }
          ]"
          multiple
          style="width: 220px"
        />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.ttmlMirrorUrl' }"
      data-setting-key="playback.ttmlMirrorUrl"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: props.settingItemBgColor, borderColor: props.settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">TTML 歌词镜像站</div>
          <div class="sub-label">自定义 TTML 格式歌词的获取地址</div>
        </div>
        <n-input
          v-model:value="settingsStore.playback.ttmlMirrorUrl"
          placeholder="https://amlldb.bikonoo.com/ncm-lyrics"
          style="width: 300px"
        />
      </div>
    </n-card>
  </div>
</template>

<style scoped lang="scss">
/**
 * 歌词预览卡片样式
 */
.lyrics-preview-card {
  margin-bottom: 16px;
  overflow: hidden;
}

.preview-header {
  font-size: 13px;
  font-weight: 600;
  color: var(--n-text-color-3);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 6px;

  &::before {
    content: '';
    display: inline-block;
    width: 3px;
    height: 14px;
    background: var(--n-color-target, var(--primary-color, #2C8EFD));
    border-radius: 2px;
  }
}

/**
 * 预览舞台——透明背景，展示歌词效果
 */
.preview-stage {
  --preview-active-color: var(--n-text-color, #333);
  --preview-dim-color: var(--n-text-color-3, #999);
  --preview-passed-color: var(--n-text-color-disabled, #ccc);

  border-radius: 8px;
  padding: 12px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: hidden;
}

/**
 * 每行歌词的包装
 */
.preview-line-wrapper {
  padding: 4px 0;
}

/**
 * 歌词主行
 */
.preview-line {
  font-size: var(--preview-font-size, 28px);
  font-weight: 600;
  color: var(--preview-dim-color);
  line-height: 1.5;
  transition: all 0.3s ease;
  white-space: nowrap;

  /* 已播放行 */
  &--passed {
    color: var(--preview-passed-color);
    opacity: 0.6;
  }

  /* 当前高亮行 */
  &--active {
    color: var(--preview-active-color);
    font-weight: 700;
  }
}

/**
 * 翻译行样式
 */
.preview-translation {
  font-size: var(--preview-translation-size, 16px);
  color: var(--n-text-color-3, #999);
  line-height: 1.4;
  padding-left: 4px;
  margin-top: 2px;
  transition: all 0.3s ease;
}

/**
 * 音译行样式
 */
.preview-transliteration {
  font-size: var(--preview-translation-size, 16px);
  color: var(--n-text-color-disabled, #bbb);
  font-style: italic;
  line-height: 1.4;
  padding-left: 4px;
  margin-top: 1px;
  transition: all 0.3s ease;
}
</style>
