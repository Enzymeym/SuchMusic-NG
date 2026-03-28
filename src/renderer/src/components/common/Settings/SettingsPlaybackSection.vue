<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NSwitch, NSlider, NButton } from 'naive-ui'
import { useSettingsStore } from '../../../stores/settingsStore'

// 使用设置仓库，驱动播放设置选项
const settingsStore = useSettingsStore()

const props = defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  // 当前高亮的设置项 key
  highlightKey?: string | null
}>()

// 压限强度显示值（0-100）
const limiterStrengthPercent = computed({
  get: () => Math.round(settingsStore.playback.limiterStrength * 100),
  set: (val: number) => {
    const normalized = Math.min(Math.max(val, 0), 100) / 100
    settingsStore.playback.limiterStrength = normalized
  }
})

// 均衡器频段元数据（10 段）
const eqBands = [
  { key: '31', label: '超低频', freqLabel: '31Hz', index: 0 },
  { key: '62', label: '低频', freqLabel: '62Hz', index: 1 },
  { key: '125', label: '低频', freqLabel: '125Hz', index: 2 },
  { key: '250', label: '低中频', freqLabel: '250Hz', index: 3 },
  { key: '500', label: '中频', freqLabel: '500Hz', index: 4 },
  { key: '1k', label: '中频', freqLabel: '1kHz', index: 5 },
  { key: '2k', label: '高中频', freqLabel: '2kHz', index: 6 },
  { key: '4k', label: '高中频', freqLabel: '4kHz', index: 7 },
  { key: '8k', label: '高频', freqLabel: '8kHz', index: 8 },
  { key: '16k', label: '超高频', freqLabel: '16kHz', index: 9 }
]

// 预设曲线（示例）：每个包含 10 段增益值（单位 dB）
const eqPresets = [
  {
    id: 'flat',
    name: '平坦',
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  {
    id: 'pop',
    name: '流行',
    gains: [2, 3, 3, 1, -1, -1, 2, 3, 3, 2]
  },
  {
    id: 'rock',
    name: '摇滚',
    gains: [3, 4, 2, 0, -1, -1, 1, 3, 4, 3]
  },
  {
    id: 'vocal',
    name: '人声',
    gains: [-2, -1, 0, 2, 3, 3, 2, 0, -1, -2]
  },
  {
    id: 'bass',
    name: '低音增强',
    gains: [5, 4, 3, 1, 0, -1, -2, -3, -4, -5]
  }
]

// 为每个 EQ 频段创建双向绑定的计算属性
const eqBandValues = eqBands.map((band) =>
  computed({
    get: () => settingsStore.playback.eqGains[band.index] ?? 0,
    set: (val: number) => {
      const clamped = Math.min(Math.max(val, -12), 12)
      const next = [...settingsStore.playback.eqGains]
      next[band.index] = clamped
      settingsStore.playback.eqGains = next
      // 手动调整时标记为自定义预设
      settingsStore.playback.eqPreset = 'custom'
    }
  })
)

// 应用选中的 EQ 预设
const applyEqPreset = (id: string) => {
  const preset = eqPresets.find((p) => p.id === id)
  if (!preset) return

  // 启用均衡器并写入预设增益
  settingsStore.playback.eqEnabled = true
  settingsStore.playback.eqGains = [...preset.gains]
  settingsStore.playback.eqPreset = id
}
</script>

<template>
  <div class="settings-content">
    <div class="section-group-title">播放行为</div>

    <n-card
      class="setting-item"
      :class="{
        'setting-item--highlight':
          props.highlightKey === 'playback.autoHideCursorWhenControlsHidden'
      }"
      data-setting-key="playback.autoHideCursorWhenControlsHidden"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">全屏播放时自动隐藏鼠标指针</div>
          <div class="sub-label">播放页底栏隐藏时自动隐藏鼠标指针，移动鼠标后重新显示</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.autoHideCursorWhenControlsHidden" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.limiterStrength' }"
      data-setting-key="playback.limiterStrength"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">音频压限器</div>
          <div class="sub-label">限制瞬时峰值，减少大音量下的爆音和破音</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; min-width: 220px">
          <n-slider
            v-model:value="limiterStrengthPercent"
            :min="0"
            :max="100"
            :step="5"
            :tooltip="false"
            style="width: 160px"
          />
          <span class="time-text">{{ limiterStrengthPercent }}%</span>
        </div>
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.eq' }"
      data-setting-key="playback.eq"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row" style="flex-direction: column; align-items: flex-start; gap: 12px">
        <div class="setting-label">
          <div class="main-label">音频均衡器</div>
          <div class="sub-label">调节不同频段的增益，优化整体音色</div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
          <n-switch v-model:value="settingsStore.playback.eqEnabled" />
          <span class="time-text">{{
            settingsStore.playback.eqEnabled ? '已启用' : '已关闭'
          }}</span>
        </div>
        <div
          style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 4px"
        >
          <span class="time-text" style="min-width: 40px">预设</span>
          <div style="display: flex; flex-wrap: wrap; gap: 6px">
            <n-button
              v-for="preset in eqPresets"
              :key="preset.id"
              size="tiny"
              quaternary
              :type="settingsStore.playback.eqPreset === preset.id ? 'primary' : 'default'"
              @click="applyEqPreset(preset.id)"
            >
              {{ preset.name }}
            </n-button>
            <n-button
              size="tiny"
              quaternary
              :type="settingsStore.playback.eqPreset === 'custom' ? 'primary' : 'default'"
              disabled
            >
              自定义
            </n-button>
          </div>
        </div>
        <div
          v-if="settingsStore.playback.eqEnabled"
          style="display: flex; flex-wrap: wrap; gap: 16px; width: 100%; margin-top: 4px"
        >
          <div
            v-for="(band, idx) in eqBands"
            :key="band.key"
            style="
              display: flex;
              flex-direction: column;
              align-items: flex-start;
              width: 180px;
              gap: 4px;
            "
          >
            <div
              style="display: flex; justify-content: space-between; width: 100%; font-size: 12px"
            >
              <span>{{ band.label }}</span>
              <span>{{ band.freqLabel }}</span>
            </div>
            <n-slider
              :value="eqBandValues[idx].value"
              :min="-12"
              :max="12"
              :step="1"
              :tooltip="false"
              style="width: 100%"
              @update:value="(val) => (eqBandValues[idx].value = val)"
            />
            <div class="time-text">{{ eqBandValues[idx].value }} dB</div>
          </div>
        </div>
      </div>
    </n-card>
  </div>
</template>
