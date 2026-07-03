<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  NModal,
  NCard,
  NTabs,
  NTabPane,
  NSwitch,
  NSlider,
  NInputNumber,
  NButton,
  NSpace,
  NText,
  NIcon,
  NTooltip,
  NInput,
  NSelect,
  NScrollbar,
  NTag,
  NPopconfirm,
  useThemeVars
} from 'naive-ui'
import { useAudioEngine } from '../../composables/useAudioEngine'

const themeVars = useThemeVars()

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
}>()

const audioEngine = useAudioEngine() as any

const showModal = computed({
  get: () => props.show,
  set: (val) => emit('update:show', val)
})

const activeTab = ref('eq')

// EQ 频段标签
const eqBandLabels = [
  '31Hz',
  '62Hz',
  '125Hz',
  '250Hz',
  '500Hz',
  '1kHz',
  '2kHz',
  '4kHz',
  '8kHz',
  '16kHz'
]

// 压缩器参数范围
const compressorRanges = {
  threshold: { min: -60, max: 0, step: 1 },
  ratio: { min: 1, max: 20, step: 0.5 },
  attack: { min: 0.1, max: 100, step: 0.1 },
  release: { min: 10, max: 1000, step: 1 },
  knee: { min: 0, max: 20, step: 0.5 }
}

// 限制器参数范围
const limiterRanges = {
  ceiling: { min: -3, max: 0, step: 0.1 },
  release: { min: 10, max: 500, step: 1 }
}

// 等响度参数范围
const loudnessRanges = {
  compensation: { min: 0, max: 1, step: 0.01 },
  referenceLoudness: { min: -40, max: -10, step: 1 }
}

/**
 * 等响度补偿方向选项
 */
const loudnessDirectionOptions = [
  { label: '双向补偿', value: 'both' },
  { label: '补偿低频', value: 'low' },
  { label: '补偿高频', value: 'high' }
]

/**
 * 虚拟低频参数范围
 */
const virtualBassRanges = {
  intensity: { min: 0, max: 100, step: 1 },
  crossoverFreq: { min: 40, max: 300, step: 1 }
}

/**
 * 爆音抑制（软限幅器）参数范围
 */
const softClipperRanges = {
  threshold: { min: 0.5, max: 5.0, step: 0.1 },
  makeupGain: { min: 0, max: 6, step: 0.1 }
}

// 预设选项
const presetOptions = computed(() => {
  return audioEngine.presets.value.map((p) => ({
    label: p.name,
    value: p.id
  }))
})

// 预设下拉值
const selectedPresetId = ref('flat')
watch(
  () => audioEngine.currentPresetId.value,
  (val) => {
    selectedPresetId.value = val
  }
)

// 保存预设对话框
const showSavePresetDialog = ref(false)
const newPresetName = ref('')

// EQ 频段选择
const selectedEqBand = ref(0)

// 增益减少量可视化
const gainReductionStyle = (gr: number) => {
  const absGr = Math.abs(gr)
  const percentage = Math.min((absGr / 12) * 100, 100)
  return {
    width: `${percentage}%`,
    backgroundColor: gr < -1 ? '#f0a0a0' : '#a0c0a0'
  }
}

const formatDb = (val: number) => {
  if (val === 0) return '0 dB'
  return `${val > 0 ? '+' : ''}${val.toFixed(1)} dB`
}

/**
 * 处理预设变更
 * @param presetId - 预设 ID
 */
const handlePresetChange = async (presetId: string) => {
  await audioEngine.applyPreset(presetId)
  selectedPresetId.value = presetId
}

const handleSavePreset = () => {
  if (!newPresetName.value.trim()) return
  audioEngine.saveCurrentAsPreset(newPresetName.value.trim())
  newPresetName.value = ''
  showSavePresetDialog.value = false
}

const handleDeletePreset = (presetId: string) => {
  audioEngine.deletePreset(presetId)
}

/**
 * 处理重置为默认设置
 */
const handleReset = async () => {
  await audioEngine.resetToDefault()
}

onMounted(() => {
  audioEngine.initialize()
})

onUnmounted(() => {
  audioEngine.destroy()
})
</script>

<script lang="ts">
export default {
  name: 'SoundEffectsModal'
}
</script>

<template>
  <n-modal v-model:show="showModal" :mask-closable="true">
    <n-card
      class="sound-effects-modal"
      :bordered="false"
      role="dialog"
      aria-modal="true"
      :style="{
        width: '820px',
        maxWidth: '90vw',
        backgroundColor: themeVars.modalColor
      }"
      content-style="padding: 0;"
    >
      <template #header>
        <div class="modal-header">
          <span class="modal-title">音效调节</span>
          <div class="modal-close-btn" @click="showModal = false">
            <n-icon size="18"><i class="mgc_close_line"></i></n-icon>
          </div>
        </div>
      </template>

      <n-scrollbar class="modal-scroll" style="max-height: 520px">
        <div class="modal-content-inner">
          <n-tabs v-model:value="activeTab" placement="left" type="line" animated>
            <!-- EQ 均衡器 -->
            <n-tab-pane name="eq" tab="均衡器">
              <div class="tab-content">
                <!-- EQ 总开关和预设 -->
                <n-card class="control-card" size="small" :bordered="true">
                  <div class="eq-header">
                    <div class="switch-row">
                      <span class="switch-label">启用均衡器</span>
                      <n-switch
                        v-model:value="audioEngine.eqEnabled.value"
                        @update:value="audioEngine.setEqEnabled"
                      />
                    </div>
                    <div class="preset-row">
                      <n-select
                        v-model:value="selectedPresetId"
                        :options="presetOptions"
                        placeholder="选择预设"
                        style="width: 140px"
                        size="small"
                        @update:value="handlePresetChange"
                      />
                      <n-tooltip trigger="hover">
                        <template #trigger>
                          <n-button size="small" quaternary circle @click="showSavePresetDialog = true">
                            <template #icon>
                              <n-icon><i class="mgc_save_2_line"></i></n-icon>
                            </template>
                          </n-button>
                        </template>
                        保存当前设置为预设
                      </n-tooltip>
                      <n-tooltip trigger="hover">
                        <template #trigger>
                          <n-button size="small" quaternary circle @click="handleReset">
                            <template #icon>
                              <n-icon><i class="mgc_refresh_2_line"></i></n-icon>
                            </template>
                          </n-button>
                        </template>
                        重置为默认设置
                      </n-tooltip>
                    </div>
                  </div>
                </n-card>

                <!-- EQ 频段滑块 -->
                <n-card
                  v-if="audioEngine.eqEnabled.value"
                  class="control-card"
                  size="small"
                  :bordered="true"
                  title="频段调节"
                >
                  <div class="eq-bands-container">
                    <div class="eq-band-selector">
                      <span class="band-label">频段</span>
                      <n-select
                        v-model:value="selectedEqBand"
                        :options="eqBandLabels.map((l, i) => ({ label: l, value: i }))"
                        style="width: 100px"
                      />
                    </div>

                    <div class="eq-band-controls" v-if="audioEngine.eqBands.value[selectedEqBand]">
                      <div class="band-detail">
                        <span class="band-freq">{{ eqBandLabels[selectedEqBand] }}</span>
                      </div>
                      <div class="eq-slider-group">
                        <div class="eq-slider-item">
                          <span class="slider-label">Pre Gain</span>
                          <n-slider
                            :value="audioEngine.eqBands.value[selectedEqBand]?.preGain ?? 0"
                            :min="-12"
                            :max="12"
                            :step="0.5"
                            :tooltip="false"
                            @update:value="(v) => audioEngine.setEqBand(selectedEqBand, { preGain: v })"
                          />
                          <span class="slider-value"
                            >{{
                              (audioEngine.eqBands.value[selectedEqBand]?.preGain ?? 0).toFixed(1)
                            }}
                            dB</span
                          >
                        </div>
                        <div class="eq-slider-item">
                          <span class="slider-label">Post Gain</span>
                          <n-slider
                            :value="audioEngine.eqBands.value[selectedEqBand]?.postGain ?? 0"
                            :min="-12"
                            :max="12"
                            :step="0.5"
                            :tooltip="false"
                            @update:value="
                              (v) => audioEngine.setEqBand(selectedEqBand, { postGain: v })
                            "
                          />
                          <span class="slider-value"
                            >{{
                              (audioEngine.eqBands.value[selectedEqBand]?.postGain ?? 0).toFixed(1)
                            }}
                            dB</span
                          >
                        </div>
                        <div class="eq-slider-item">
                          <span class="slider-label">Pre Q</span>
                          <n-slider
                            :value="audioEngine.eqBands.value[selectedEqBand]?.preQ ?? 1"
                            :min="0.5"
                            :max="12"
                            :step="0.1"
                            :tooltip="false"
                            @update:value="(v) => audioEngine.setEqBand(selectedEqBand, { preQ: v })"
                          />
                          <span class="slider-value">{{
                            (audioEngine.eqBands.value[selectedEqBand]?.preQ ?? 1).toFixed(1)
                          }}</span>
                        </div>
                        <div class="eq-slider-item">
                          <span class="slider-label">Post Q</span>
                          <n-slider
                            :value="audioEngine.eqBands.value[selectedEqBand]?.postQ ?? 1"
                            :min="0.5"
                            :max="12"
                            :step="0.1"
                            :tooltip="false"
                            @update:value="(v) => audioEngine.setEqBand(selectedEqBand, { postQ: v })"
                          />
                          <span class="slider-value">{{
                            (audioEngine.eqBands.value[selectedEqBand]?.postQ ?? 1).toFixed(1)
                          }}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </n-card>

                <!-- 快速增益预设 -->
                <n-card
                  v-if="audioEngine.eqEnabled.value"
                  class="control-card"
                  size="small"
                  :bordered="true"
                  title="快速增益调节"
                >
                  <div class="quick-gains">
                    <div class="quick-gains-grid">
                      <div v-for="(label, idx) in eqBandLabels" :key="idx" class="quick-gain-item">
                        <span class="quick-gain-label">{{ label }}</span>
                        <n-slider
                          :value="audioEngine.eqBands.value[idx]?.preGain ?? 0"
                          :min="-12"
                          :max="12"
                          :step="1"
                          :tooltip="false"
                          vertical
                          :reverse="true"
                          style="height: 80px"
                          @update:value="(v) => audioEngine.setEqBand(idx, { preGain: v })"
                        />
                        <span class="quick-gain-value">{{
                          (audioEngine.eqBands.value[idx]?.preGain ?? 0).toFixed(0)
                        }}</span>
                      </div>
                    </div>
                  </div>
                </n-card>

                <div v-else class="disabled-hint">
                  <n-text depth="3">均衡器已关闭</n-text>
                </div>
              </div>
            </n-tab-pane>

            <!-- 压缩器 -->
            <n-tab-pane name="compressor" tab="压缩器">
              <div class="tab-content">
                <!-- 压缩器总开关 -->
                <n-card class="control-card" size="small" :bordered="true">
                  <div class="eq-header">
                    <div class="switch-row">
                      <span class="switch-label">启用压缩器</span>
                      <n-switch
                        v-model:value="audioEngine.compressorEnabled.value"
                        @update:value="audioEngine.setCompressorEnabled"
                      />
                    </div>
                    <div class="gain-reduction">
                      <span class="gain-label">增益减少</span>
                      <div class="gain-bar">
                        <div
                          class="gain-fill"
                          :style="gainReductionStyle(audioEngine.compressorGR.value)"
                        ></div>
                      </div>
                      <span class="gain-value">{{ formatDb(audioEngine.compressorGR.value) }}</span>
                    </div>
                  </div>
                </n-card>

                <n-card
                  v-if="audioEngine.compressorEnabled.value"
                  class="control-card"
                  size="small"
                  :bordered="true"
                  title="参数调节"
                >
                  <div class="param-grid">
                    <!-- 阈值 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">阈值 (Threshold)</span>
                        <n-input-number
                          :value="audioEngine.compressor.value.threshold"
                          :min="compressorRanges.threshold.min"
                          :max="compressorRanges.threshold.max"
                          :step="compressorRanges.threshold.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setCompressorParams({ threshold: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.compressor.value.threshold"
                        :min="compressorRanges.threshold.min"
                        :max="compressorRanges.threshold.max"
                        :step="compressorRanges.threshold.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setCompressorParams({ threshold: v })"
                      />
                      <div class="param-range">
                        <span>{{ compressorRanges.threshold.min }} dB</span>
                        <span>{{ compressorRanges.threshold.max }} dB</span>
                      </div>
                    </div>

                    <!-- 压缩比 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">压缩比 (Ratio)</span>
                        <n-input-number
                          :value="audioEngine.compressor.value.ratio"
                          :min="compressorRanges.ratio.min"
                          :max="compressorRanges.ratio.max"
                          :step="compressorRanges.ratio.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setCompressorParams({ ratio: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.compressor.value.ratio"
                        :min="compressorRanges.ratio.min"
                        :max="compressorRanges.ratio.max"
                        :step="compressorRanges.ratio.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setCompressorParams({ ratio: v })"
                      />
                      <div class="param-range">
                        <span>{{ compressorRanges.ratio.min }}:1</span>
                        <span>{{ compressorRanges.ratio.max }}:1</span>
                      </div>
                    </div>

                    <!-- 攻击时间 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">攻击时间 (Attack)</span>
                        <n-input-number
                          :value="audioEngine.compressor.value.attack"
                          :min="compressorRanges.attack.min"
                          :max="compressorRanges.attack.max"
                          :step="compressorRanges.attack.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setCompressorParams({ attack: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.compressor.value.attack"
                        :min="compressorRanges.attack.min"
                        :max="compressorRanges.attack.max"
                        :step="compressorRanges.attack.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setCompressorParams({ attack: v })"
                      />
                      <div class="param-range">
                        <span>{{ compressorRanges.attack.min }} ms</span>
                        <span>{{ compressorRanges.attack.max }} ms</span>
                      </div>
                    </div>

                    <!-- 释放时间 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">释放时间 (Release)</span>
                        <n-input-number
                          :value="audioEngine.compressor.value.release"
                          :min="compressorRanges.release.min"
                          :max="compressorRanges.release.max"
                          :step="compressorRanges.release.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setCompressorParams({ release: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.compressor.value.release"
                        :min="compressorRanges.release.min"
                        :max="compressorRanges.release.max"
                        :step="compressorRanges.release.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setCompressorParams({ release: v })"
                      />
                      <div class="param-range">
                        <span>{{ compressorRanges.release.min }} ms</span>
                        <span>{{ compressorRanges.release.max }} ms</span>
                      </div>
                    </div>

                    <!-- 拐点软度 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">拐点软度 (Knee)</span>
                        <n-input-number
                          :value="audioEngine.compressor.value.knee"
                          :min="compressorRanges.knee.min"
                          :max="compressorRanges.knee.max"
                          :step="compressorRanges.knee.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setCompressorParams({ knee: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.compressor.value.knee"
                        :min="compressorRanges.knee.min"
                        :max="compressorRanges.knee.max"
                        :step="compressorRanges.knee.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setCompressorParams({ knee: v })"
                      />
                      <div class="param-range">
                        <span>{{ compressorRanges.knee.min }} dB</span>
                        <span>{{ compressorRanges.knee.max }} dB</span>
                      </div>
                    </div>
                  </div>
                </n-card>

                <div v-else class="disabled-hint">
                  <n-text depth="3">压缩器已关闭</n-text>
                </div>
              </div>
            </n-tab-pane>

            <!-- 限制器 -->
            <n-tab-pane name="limiter" tab="限制器">
              <div class="tab-content">
                <!-- 限制器总开关 -->
                <n-card class="control-card" size="small" :bordered="true">
                  <div class="eq-header">
                    <div class="switch-row">
                      <span class="switch-label">启用限制器</span>
                      <n-switch
                        v-model:value="audioEngine.limiterEnabled.value"
                        @update:value="audioEngine.setLimiterEnabled"
                      />
                    </div>
                    <div class="gain-reduction">
                      <span class="gain-label">增益减少</span>
                      <div class="gain-bar">
                        <div
                          class="gain-fill"
                          :style="gainReductionStyle(audioEngine.limiterGR.value)"
                        ></div>
                      </div>
                      <span class="gain-value">{{ formatDb(audioEngine.limiterGR.value) }}</span>
                    </div>
                  </div>
                </n-card>

                <n-card
                  v-if="audioEngine.limiterEnabled.value"
                  class="control-card"
                  size="small"
                  :bordered="true"
                  title="参数调节"
                >
                  <div class="param-grid">
                    <!-- 天花板 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">天花板 (Ceiling)</span>
                        <n-input-number
                          :value="audioEngine.limiter.value.ceiling"
                          :min="limiterRanges.ceiling.min"
                          :max="limiterRanges.ceiling.max"
                          :step="limiterRanges.ceiling.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setLimiterParams({ ceiling: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.limiter.value.ceiling"
                        :min="limiterRanges.ceiling.min"
                        :max="limiterRanges.ceiling.max"
                        :step="limiterRanges.ceiling.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setLimiterParams({ ceiling: v })"
                      />
                      <div class="param-range">
                        <span>{{ limiterRanges.ceiling.min }} dB</span>
                        <span>{{ limiterRanges.ceiling.max }} dB</span>
                      </div>
                    </div>

                    <!-- 释放时间 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">释放时间 (Release)</span>
                        <n-input-number
                          :value="audioEngine.limiter.value.release"
                          :min="limiterRanges.release.min"
                          :max="limiterRanges.release.max"
                          :step="limiterRanges.release.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setLimiterParams({ release: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.limiter.value.release"
                        :min="limiterRanges.release.min"
                        :max="limiterRanges.release.max"
                        :step="limiterRanges.release.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setLimiterParams({ release: v })"
                      />
                      <div class="param-range">
                        <span>{{ limiterRanges.release.min }} ms</span>
                        <span>{{ limiterRanges.release.max }} ms</span>
                      </div>
                    </div>
                  </div>
                </n-card>

                <div v-else class="disabled-hint">
                  <n-text depth="3">限制器已关闭</n-text>
                </div>
              </div>
            </n-tab-pane>

            <!-- 等响度 -->
            <n-tab-pane name="loudness" tab="等响度">
              <div class="tab-content">
                <!-- 等响度总开关 -->
                <n-card class="control-card" size="small" :bordered="true">
                  <div class="eq-header">
                    <div class="switch-row">
                      <span class="switch-label">启用等响度补偿</span>
                      <n-switch
                        :value="audioEngine.loudness.value.enabled"
                        @update:value="(v: any) => audioEngine.setLoudnessParams({ enabled: v })"
                      />
                    </div>
                  </div>
                </n-card>

                <n-card
                  v-if="audioEngine.loudness.value.enabled"
                  class="control-card"
                  size="small"
                  :bordered="true"
                  title="参数调节"
                >
                  <div class="loudness-info">
                    <n-text depth="3" style="font-size: 12px">
                      等响度补偿基于弗莱彻-曼森曲线，在不同音量下保持听感一致。
                    </n-text>
                  </div>

                  <div class="param-grid">
                    <!-- 补偿强度 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">补偿强度 (Compensation)</span>
                        <n-input-number
                          :value="audioEngine.loudness.value.compensation"
                          :min="loudnessRanges.compensation.min"
                          :max="loudnessRanges.compensation.max"
                          :step="loudnessRanges.compensation.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setLoudnessParams({ compensation: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.loudness.value.compensation"
                        :min="loudnessRanges.compensation.min"
                        :max="loudnessRanges.compensation.max"
                        :step="loudnessRanges.compensation.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setLoudnessParams({ compensation: v })"
                      />
                      <div class="param-range">
                        <span>{{ (loudnessRanges.compensation.min * 100).toFixed(0) }}%</span>
                        <span>{{ (loudnessRanges.compensation.max * 100).toFixed(0) }}%</span>
                      </div>
                    </div>

                    <!-- 参考响度 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">参考响度 (Reference Loudness)</span>
                        <n-input-number
                          :value="audioEngine.loudness.value.referenceLoudness"
                          :min="loudnessRanges.referenceLoudness.min"
                          :max="loudnessRanges.referenceLoudness.max"
                          :step="loudnessRanges.referenceLoudness.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setLoudnessParams({ referenceLoudness: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.loudness.value.referenceLoudness"
                        :min="loudnessRanges.referenceLoudness.min"
                        :max="loudnessRanges.referenceLoudness.max"
                        :step="loudnessRanges.referenceLoudness.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setLoudnessParams({ referenceLoudness: v })"
                      />
                      <div class="param-range">
                        <span>{{ loudnessRanges.referenceLoudness.min }} LUFS</span>
                        <span>{{ loudnessRanges.referenceLoudness.max }} LUFS</span>
                      </div>
                    </div>

                    <!-- 补偿方向 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">补偿方向</span>
                      </div>
                      <n-select
                        :value="audioEngine.loudness.value.direction"
                        :options="loudnessDirectionOptions"
                        size="small"
                        style="width: 100%"
                        @update:value="(v: any) => audioEngine.setLoudnessParams({ direction: v })"
                      />
                      <div class="param-range">
                        <span>双向补偿同时提升低频和高频</span>
                      </div>
                    </div>
                  </div>
                </n-card>

                <div v-else class="disabled-hint">
                  <n-text depth="3">等响度补偿已关闭</n-text>
                </div>
              </div>
            </n-tab-pane>

            <!-- 虚拟低频 -->
            <n-tab-pane name="virtualBass" tab="虚拟低频">
              <div class="tab-content">
                <!-- 虚拟低频总开关 -->
                <n-card class="control-card" size="small" :bordered="true">
                  <div class="eq-header">
                    <div class="switch-row">
                      <span class="switch-label">启用虚拟低频</span>
                      <n-switch
                        :value="audioEngine.virtualBass.value.enabled"
                        @update:value="(v: any) => audioEngine.setVirtualBassParams({ enabled: v })"
                      />
                    </div>
                  </div>
                </n-card>

                <n-card
                  v-if="audioEngine.virtualBass.value.enabled"
                  class="control-card"
                  size="small"
                  :bordered="true"
                  title="参数调节"
                >
                  <div class="loudness-info">
                    <n-text depth="3" style="font-size: 12px">
                      基于心理声学「基音缺失」原理，通过生成谐波让小型扬声器也能感知到低频，适合笔记本、手机等设备。
                    </n-text>
                  </div>

                  <div class="param-grid">
                    <!-- 力度 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">力度 (Intensity)</span>
                        <n-input-number
                          :value="audioEngine.virtualBass.value.intensity"
                          :min="virtualBassRanges.intensity.min"
                          :max="virtualBassRanges.intensity.max"
                          :step="virtualBassRanges.intensity.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setVirtualBassParams({ intensity: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.virtualBass.value.intensity"
                        :min="virtualBassRanges.intensity.min"
                        :max="virtualBassRanges.intensity.max"
                        :step="virtualBassRanges.intensity.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setVirtualBassParams({ intensity: v })"
                      />
                      <div class="param-range">
                        <span>{{ virtualBassRanges.intensity.min }}</span>
                        <span>{{ virtualBassRanges.intensity.max }}</span>
                      </div>
                    </div>

                    <!-- 分频点 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">分频点 (Crossover)</span>
                        <n-input-number
                          :value="audioEngine.virtualBass.value.crossoverFreq"
                          :min="virtualBassRanges.crossoverFreq.min"
                          :max="virtualBassRanges.crossoverFreq.max"
                          :step="virtualBassRanges.crossoverFreq.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setVirtualBassParams({ crossoverFreq: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.virtualBass.value.crossoverFreq"
                        :min="virtualBassRanges.crossoverFreq.min"
                        :max="virtualBassRanges.crossoverFreq.max"
                        :step="virtualBassRanges.crossoverFreq.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setVirtualBassParams({ crossoverFreq: v })"
                      />
                      <div class="param-range">
                        <span>{{ virtualBassRanges.crossoverFreq.min }} Hz</span>
                        <span>{{ virtualBassRanges.crossoverFreq.max }} Hz</span>
                      </div>
                    </div>
                  </div>
                </n-card>

                <div v-else class="disabled-hint">
                  <n-text depth="3">虚拟低频已关闭</n-text>
                </div>
              </div>
            </n-tab-pane>

            <!-- 爆音抑制 -->
            <n-tab-pane name="softClipper" tab="爆音抑制">
              <div class="tab-content">
                <!-- 爆音抑制总开关 -->
                <n-card class="control-card" size="small" :bordered="true">
                  <div class="eq-header">
                    <div class="switch-row">
                      <span class="switch-label">启用爆音抑制</span>
                      <n-switch
                        :value="audioEngine.softClipper.value.enabled"
                        @update:value="(v: any) => audioEngine.setSoftClipperParams({ enabled: v })"
                      />
                    </div>
                  </div>
                </n-card>

                <n-card
                  v-if="audioEngine.softClipper.value.enabled"
                  class="control-card"
                  size="small"
                  :bordered="true"
                  title="参数调节"
                >
                  <div class="loudness-info">
                    <n-text depth="3" style="font-size: 12px">
                      使用 tanh 软限幅曲线防止数字削波（Clipping），在保持动态范围的同时减少大音量下的爆音和破音。
                    </n-text>
                  </div>

                  <div class="param-grid">
                    <!-- 阈值强度 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">阈值强度 (Threshold)</span>
                        <n-input-number
                          :value="audioEngine.softClipper.value.threshold"
                          :min="softClipperRanges.threshold.min"
                          :max="softClipperRanges.threshold.max"
                          :step="softClipperRanges.threshold.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setSoftClipperParams({ threshold: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.softClipper.value.threshold"
                        :min="softClipperRanges.threshold.min"
                        :max="softClipperRanges.threshold.max"
                        :step="softClipperRanges.threshold.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setSoftClipperParams({ threshold: v })"
                      />
                      <div class="param-range">
                        <span>{{ softClipperRanges.threshold.min }}（硬限幅）</span>
                        <span>{{ softClipperRanges.threshold.max }}（软限幅）</span>
                      </div>
                    </div>

                    <!-- 补偿增益 -->
                    <div class="param-item">
                      <div class="param-header">
                        <span class="param-label">补偿增益 (Makeup Gain)</span>
                        <n-input-number
                          :value="audioEngine.softClipper.value.makeupGain"
                          :min="softClipperRanges.makeupGain.min"
                          :max="softClipperRanges.makeupGain.max"
                          :step="softClipperRanges.makeupGain.step"
                          size="small"
                          style="width: 90px"
                          @update:value="(v: any) => audioEngine.setSoftClipperParams({ makeupGain: v })"
                        />
                      </div>
                      <n-slider
                        :value="audioEngine.softClipper.value.makeupGain"
                        :min="softClipperRanges.makeupGain.min"
                        :max="softClipperRanges.makeupGain.max"
                        :step="softClipperRanges.makeupGain.step"
                        :tooltip="false"
                        @update:value="(v: any) => audioEngine.setSoftClipperParams({ makeupGain: v })"
                      />
                      <div class="param-range">
                        <span>{{ softClipperRanges.makeupGain.min }} dB</span>
                        <span>{{ softClipperRanges.makeupGain.max }} dB</span>
                      </div>
                    </div>
                  </div>
                </n-card>

                <div v-else class="disabled-hint">
                  <n-text depth="3">爆音抑制已关闭</n-text>
                </div>
              </div>
            </n-tab-pane>

            <!-- 预设管理 -->
            <n-tab-pane name="presets" tab="预设">
              <div class="tab-content">
                <n-card class="control-card" size="small" :bordered="true">
                  <div class="presets-header">
                    <div class="presets-title">
                      <n-icon size="16"><i class="mgc_list_check_line"></i></n-icon>
                      <n-text strong>预设列表</n-text>
                    </div>
                    <n-button size="small" type="primary" @click="showSavePresetDialog = true">
                      <template #icon>
                        <n-icon><i class="mgc_add_line"></i></n-icon>
                      </template>
                      新建预设
                    </n-button>
                  </div>
                </n-card>

                <div class="presets-grid">
                  <div
                    v-for="preset in audioEngine.presets.value"
                    :key="preset.id"
                    class="preset-card"
                    :class="{
                      'preset-card--active': preset.id === audioEngine.currentPresetId.value
                    }"
                    @click="handlePresetChange(preset.id)"
                  >
                    <div class="preset-card-content">
                      <div class="preset-icon">
                        <n-icon size="20">
                          <i
                            :class="
                              preset.id === audioEngine.currentPresetId.value
                                ? 'mgc_check_circle_line'
                                : 'mgc_music_2_line'
                            "
                          ></i>
                        </n-icon>
                      </div>
                      <div class="preset-info">
                        <span class="preset-name">{{ preset.name }}</span>
                        <n-tag
                          size="tiny"
                          :type="audioEngine.isBuiltinPreset(preset.id) ? 'success' : 'default'"
                          :bordered="false"
                        >
                          {{ audioEngine.isBuiltinPreset(preset.id) ? '内置' : '自定义' }}
                        </n-tag>
                      </div>
                    </div>
                    <div
                      class="preset-actions"
                      v-if="!audioEngine.isBuiltinPreset(preset.id)"
                      @click.stop
                    >
                      <n-popconfirm
                        positive-text="删除"
                        negative-text="取消"
                        @positive-click="handleDeletePreset(preset.id)"
                      >
                        <template #trigger>
                          <n-button size="tiny" quaternary circle>
                            <template #icon>
                              <n-icon><i class="mgc_delete_line"></i></n-icon>
                            </template>
                          </n-button>
                        </template>
                        确定要删除预设 "{{ preset.name }}" 吗？
                      </n-popconfirm>
                    </div>
                  </div>
                </div>
              </div>
            </n-tab-pane>
          </n-tabs>
        </div>
      </n-scrollbar>

    </n-card>
  </n-modal>

  <!-- 保存预设对话框 -->
  <n-modal v-model:show="showSavePresetDialog">
    <n-card style="width: 400px" title="保存预设" :bordered="false" role="dialog" aria-modal="true">
      <n-input
        v-model:value="newPresetName"
        placeholder="输入预设名称"
        @keyup.enter="handleSavePreset"
      />
      <template #footer>
        <n-space justify="end">
          <n-button @click="showSavePresetDialog = false">取消</n-button>
          <n-button type="primary" @click="handleSavePreset" :disabled="!newPresetName.trim()">
            保存
          </n-button>
        </n-space>
      </template>
    </n-card>
  </n-modal>
</template>

<style lang="scss" scoped>
.sound-effects-modal {
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .modal-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--n-text-color);
    }

    .modal-close-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      cursor: pointer;
      color: var(--n-text-color-2);
      transition: all 0.2s;

      &:hover {
        background: var(--n-close-color-hover, rgba(128, 128, 128, 0.15));
        color: var(--n-text-color);
      }
    }
  }
}

.modal-scroll {
  :deep(.n-scrollbar-rail) {
    right: 2px;
    width: 4px;
  }

  :deep(.n-scrollbar-rail__scrollbar) {
    width: 4px;
    border-radius: 2px;
    background-color: rgba(128, 128, 128, 0.25);
  }
}

.modal-content-inner {
  padding: 8px 16px 16px;

  // 侧边 Tab 布局
  :deep(.n-tabs) {
    min-height: 420px;

    .n-tabs-nav {
      width: 110px;
      min-width: 110px;
      padding-top: 8px;

      .n-tabs-nav--left & {
        margin-right: 0;
      }

      .n-tabs-tab {
        padding: 10px 14px;
        margin: 2px 4px;
        border-radius: 8px;
        font-size: 13px;
        justify-content: flex-start;
        transition: all 0.2s;

        &:hover {
          background: var(--n-tab-color, rgba(128, 128, 128, 0.08));
        }

        &.n-tabs-tab--active {
          background: var(--primary-color-opacity-1, rgba(24, 160, 88, 0.08));
          color: var(--primary-color);
          font-weight: 500;
        }
      }

      .n-tabs-bar {
        display: none;
      }
    }

    .n-tabs-pane-wrapper {
      padding-left: 8px;
    }
  }
}

.tab-content {
  padding: 4px 0;
  min-height: 380px;
}

.control-card {
  margin-bottom: 12px;
  border-radius: 10px;

  &:last-child {
    margin-bottom: 0;
  }

  :deep(.n-card-header) {
    padding-bottom: 8px;
  }

  :deep(.n-card__content) {
    padding-top: 8px;
  }
}

.eq-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;

  .switch-row {
    display: flex;
    align-items: center;
    gap: 12px;

    .switch-label {
      font-size: 14px;
      color: var(--n-text-color);
    }
  }

  .preset-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .gain-reduction {
    display: flex;
    align-items: center;
    gap: 8px;

    .gain-label {
      font-size: 12px;
      color: var(--n-text-color-3);
    }

    .gain-bar {
      width: 100px;
      height: 8px;
      background: var(--n-border-color);
      border-radius: 4px;
      overflow: hidden;

      .gain-fill {
        height: 100%;
        transition:
          width 0.1s,
          background-color 0.1s;
      }
    }

    .gain-value {
      font-size: 12px;
      color: var(--n-text-color-2);
      min-width: 60px;
    }
  }
}

.disabled-hint {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 200px;
}

.eq-band-selector {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;

  .band-label {
    font-size: 14px;
    color: var(--n-text-color);
  }
}

.eq-band-controls {
  margin-bottom: 16px;

  .band-detail {
    margin-bottom: 12px;

    .band-freq {
      font-size: 16px;
      font-weight: 600;
      color: var(--primary-color);
    }
  }

  .eq-slider-group {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
  }

  .eq-slider-item {
    display: flex;
    flex-direction: column;
    gap: 4px;

    .slider-label {
      font-size: 12px;
      color: var(--n-text-color-2);
    }

    .slider-value {
      font-size: 12px;
      color: var(--n-text-color-3);
      text-align: right;
    }
  }
}

.quick-gains {
  .quick-gains-grid {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }

  .quick-gain-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;

    .quick-gain-label {
      font-size: 10px;
      color: var(--n-text-color-3);
    }

    .quick-gain-value {
      font-size: 11px;
      color: var(--n-text-color-2);
    }
  }
}

.param-grid {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.param-item {
  .param-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;

    .param-label {
      font-size: 13px;
      color: var(--n-text-color);
    }
  }

  .param-range {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--n-text-color-3);
    margin-top: 4px;
  }
}

.loudness-info {
  margin-bottom: 16px;
  padding: 12px;
  background: var(--n-border-color);
  border-radius: 6px;
}

.presets-header {
  display: flex;
  justify-content: space-between;
  align-items: center;

  .presets-title {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--n-text-color);
  }
}

.presets-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.preset-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px;
  background: var(--n-card-color);
  border: 1px solid var(--n-border-color);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    background: var(--n-hover-color);
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  }

  &--active {
    background: var(--primary-color-opacity-1, rgba(24, 160, 88, 0.08));
    border-color: var(--primary-color);
    box-shadow: 0 2px 8px var(--primary-color-opacity-2, rgba(24, 160, 88, 0.15));

    .preset-icon {
      color: var(--primary-color);
      background: var(--primary-color-opacity-1, rgba(24, 160, 88, 0.12));
    }
  }

  .preset-card-content {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .preset-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: var(--n-border-color);
    color: var(--n-text-color-3);
    transition: all 0.2s;
  }

  .preset-info {
    display: flex;
    flex-direction: column;
    gap: 4px;

    .preset-name {
      font-size: 14px;
      font-weight: 500;
      line-height: 1.2;
      color: var(--n-text-color);
    }
  }

  .preset-actions {
    opacity: 0;
    transition: opacity 0.2s;
  }

  &:hover .preset-actions {
    opacity: 1;
  }
}
</style>
