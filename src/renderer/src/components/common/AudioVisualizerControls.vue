<script setup lang="ts">
/**
 * 音频可视化控制面板组件
 * 提供可视化大小和强度的调节控件
 */
import { computed } from 'vue'
import { NSwitch, NSlider, NDivider } from 'naive-ui'
import { useSettingsStore } from '../../stores/settingsStore'

const settingsStore = useSettingsStore()

/** 播放页设置快捷访问 */
const playback = computed(() => settingsStore.playback)

/**
 * 设置可视化启用状态
 * @param value - 是否启用
 */
function setEnabled(value: boolean): void {
  playback.value.visualizerEnabled = value
}

/**
 * 设置可视化大小
 * @param size - 大小倍率
 */
function setSize(size: number): void {
  playback.value.visualizerSize = size
}

/**
 * 设置显示强度
 * @param intensity - 强度倍率
 */
function setIntensity(intensity: number): void {
  playback.value.visualizerIntensity = intensity
}
</script>

<template>
  <div class="visualizer-controls">
    <!-- 启用开关 -->
    <div class="control-row">
      <div class="control-label">
        <i class="mgc_eye_line control-icon"></i>
        <span>启用可视化</span>
      </div>
      <NSwitch
        :value="playback.visualizerEnabled"
        @update:value="setEnabled"
        size="small"
      />
    </div>

    <NDivider style="margin: 8px 0" />

    <!-- 显示大小 -->
    <div class="control-section">
      <div class="control-label">
        <i class="mgc_fullscreen_line control-icon"></i>
        <span>显示大小: {{ playback.visualizerSize.toFixed(1) }}x</span>
      </div>
      <NSlider
        :value="playback.visualizerSize"
        :min="0.5"
        :max="2.0"
        :step="0.1"
        :tooltip="false"
        @update:value="setSize"
      />
    </div>

    <NDivider style="margin: 8px 0" />

    <!-- 显示强度 -->
    <div class="control-section">
      <div class="control-label">
        <i class="mgc_flash_line control-icon"></i>
        <span>显示强度: {{ playback.visualizerIntensity.toFixed(1) }}x</span>
      </div>
      <NSlider
        :value="playback.visualizerIntensity"
        :min="0.3"
        :max="1.5"
        :step="0.1"
        :tooltip="false"
        @update:value="setIntensity"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.visualizer-controls {
  width: 260px;
  padding: 4px 0;
  user-select: none;
}

.control-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
}

.control-section {
  padding: 6px 12px;
}

.control-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--n-text-color, #333);
  margin-bottom: 8px;

  .control-icon {
    font-size: 15px;
    opacity: 0.7;
  }
}
</style>
