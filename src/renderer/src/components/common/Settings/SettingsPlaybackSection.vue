<script setup lang="ts">
import { computed, watch, ref, onMounted } from 'vue'
import { NCard, NSwitch, NSlider, NSelect, NButton, NAlert, NSpace, NProgress } from 'naive-ui'
import { useSettingsStore } from '../../../stores/settingsStore'
import { usePlayerStore } from '../../../stores/playerStore'
import { useAudioEngine } from '../../../composables/useAudioEngine'
import { AudioOutputModeManager, type AudioOutputMode, type AudioDevice } from '../../../utils/audioOutputModeManager'
import { useFfmpegInstaller } from '../../../composables/useFfmpegInstaller'

// 使用设置仓库，驱动播放设置选项
const settingsStore = useSettingsStore()
const playerStore = usePlayerStore()
const audioEngine = useAudioEngine()

// 过渡时长显示值（秒）
const transitionDurationSeconds = computed({
  get: () => playerStore.transitionDuration / 1000,
  set: (val: number) => {
    const durationMs = val * 1000
    playerStore.setTransitionDuration(durationMs)
  }
})

// 过渡效果类型选项
const transitionTypeOptions = [
  { label: '智能过渡', value: 'smart' },
  { label: '交叉淡入淡出', value: 'crossfade' },
  { label: '普通淡入淡出', value: 'fade' }
];

// 压限强度显示值（0-100）
const limiterStrengthPercent = computed({
  get: () => Math.round(settingsStore.playback.limiterStrength * 100),
  set: (val: number) => {
    const normalized = Math.min(Math.max(val, 0), 100) / 100
    settingsStore.playback.limiterStrength = normalized
    // 同步到 Rust 引擎
    updateLimiterFromSettings()
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

// 为每个 EQ 频段创建双向绑定的计算属性
const eqBandValues = eqBands.map((band) =>
  computed({
    get: () => settingsStore.playback.eqGains[band.index] ?? 0,
    set: (val: number) => {
      const clamped = Math.min(Math.max(val, -12), 12)
      const next = [...settingsStore.playback.eqGains]
      next[band.index] = clamped
      settingsStore.playback.eqGains = next
      // 同步到 Rust 引擎
      updateEqFromSettings()
    }
  })
)

// 同步 EQ 设置到 Rust 引擎
function updateEqFromSettings() {
  if (!audioEngine.state.isInitialized) return
  
  // 设置 EQ 启用状态
  audioEngine.setEqEnabled(settingsStore.playback.eqEnabled)
  
  // 设置 EQ 增益
  if (settingsStore.playback.eqEnabled) {
    audioEngine.setEqGains(settingsStore.playback.eqGains)
  }
}

// 同步限制器设置到 Rust 引擎
function updateLimiterFromSettings() {
  if (!audioEngine.state.isInitialized) return
  
  // 根据压限强度调整限制器参数
  const strength = settingsStore.playback.limiterStrength
  if (strength > 0) {
    audioEngine.setLimiterEnabled(true)
    // 根据强度调整天花板（强度越高，天花板越低，限制越强）
    const ceiling = -0.3 - (strength * 2.7) // 0% -> -0.3dB, 100% -> -3dB
    audioEngine.setLimiterParams({
      ceiling: Math.max(ceiling, -3),
      release: 50
    })
  } else {
    audioEngine.setLimiterEnabled(false)
  }
}

// 监听设置变化并同步到 Rust 引擎
watch(() => settingsStore.playback.eqEnabled, () => {
  updateEqFromSettings()
})

watch(() => settingsStore.playback.limiterStrength, () => {
  updateLimiterFromSettings()
})

// ======== 音频输出设备管理 ========

/// 输出模式管理器实例
const outputManager = new AudioOutputModeManager()

/// 可用音频设备列表
const audioDevices = ref<AudioDevice[]>([])

/// 设备列表加载状态
const devicesLoading = ref(false)

/// 模式切换状态
const modeSwitching = ref(false)

/// 当前引擎描述
const engineDescription = ref('Web Audio API (默认)')

/// WASAPI 是否可用（默认 false，需通过 probe 确认）
const wasapiAvailable = ref(false)

/// WASAPI 不可用原因
const wasapiUnavailableReason = ref('正在检测...')

/// 输出模式选项（根据 WASAPI 可用性动态过滤）
const outputModeOptions = computed(() => {
  const options = [
    { label: '默认 (WebAudio)', value: 'webaudio' as AudioOutputMode },
  ];
  if (wasapiAvailable.value) {
    options.push(
      { label: 'WASAPI 共享模式', value: 'wasapi-shared' as AudioOutputMode },
      { label: 'WASAPI 独占模式', value: 'wasapi-exclusive' as AudioOutputMode },
    );
  }
  return options;
})

/// 当前选中的输出模式（双向绑定到 store）
const selectedOutputMode = computed<AudioOutputMode>({
  get: () => settingsStore.playback.audioOutputMode,
  set: (val: AudioOutputMode) => {
    applyOutputMode(val, settingsStore.playback.audioOutputDeviceId)
  }
})

/// 当前选中的输出设备名称（用于显示）
const selectedDeviceName = computed({
  get: () => {
    if (settingsStore.playback.audioOutputDeviceName) {
      return settingsStore.playback.audioOutputDeviceName
    }
    return '默认设备'
  },
  set: (_val: string) => {} // 只读显示，通过设备选择列表修改
})

/// 刷新设备列表
/**
 * 枚举系统中所有活动的音频输出设备
 */
async function refreshDevices() {
  devicesLoading.value = true
  try {
    const devices = await outputManager.enumerateDevices()
    audioDevices.value = devices
  } catch (err) {
    // 静默处理，不影响主流程
  } finally {
    devicesLoading.value = false
  }
}

/// 应用输出模式切换
/**
 * 切换到指定的音频输出模式并更新引擎
 * @param mode 目标输出模式
 * @param deviceId 目标设备 ID（WASAPI 模式使用）
 */
async function applyOutputMode(mode: AudioOutputMode, deviceId?: string) {
  // 非 WebAudio 模式需要先确认 WASAPI 可用
  if (mode !== 'webaudio' && !wasapiAvailable.value) {
    return
  }

  modeSwitching.value = true
  try {
    const result = await outputManager.switchMode(mode, {
      sampleRate: 44100,
      channels: 2,
      deviceId: deviceId || settingsStore.playback.audioOutputDeviceId || undefined,
    })

    if (result.success) {
      settingsStore.playback.audioOutputMode = mode
      engineDescription.value = outputManager.getEngineDescription()
      wasapiAvailable.value = true
    } else {
      console.warn('[Settings] 模式切换失败:', result.error)
      wasapiUnavailableReason.value = result.error || '未知'
      // 回退到 WebAudio
      settingsStore.playback.audioOutputMode = 'webaudio'
      engineDescription.value = 'Web Audio API (默认)'
      wasapiAvailable.value = false
    }
  } catch (err) {
    const msg = String(err)
    console.warn('[Settings] 模式切换异常:', msg)
    wasapiUnavailableReason.value = msg
    settingsStore.playback.audioOutputMode = 'webaudio'
    engineDescription.value = 'Web Audio API (默认)'
    wasapiAvailable.value = false
  } finally {
    modeSwitching.value = false
  }
}

/// 选择设备
/**
 * 用户选择音频输出设备后的处理
 * @param deviceId 设备 ID
 */
function selectDevice(deviceId: string) {
  const device = audioDevices.value.find(d => d.id === deviceId)
  const deviceName = device?.name ?? '默认设备'
  settingsStore.playback.audioOutputDeviceId = deviceId
  settingsStore.playback.audioOutputDeviceName = deviceName

  // 如果在 WASAPI 模式下，重新应用
  if (settingsStore.playback.audioOutputMode !== 'webaudio') {
    applyOutputMode(settingsStore.playback.audioOutputMode, deviceId)
  }
}

// ======== FFmpeg 解码器安装管理 ========

/// FFmpeg 安装器实例
const ffmpegInstaller = useFfmpegInstaller()

/// 组件挂载时刷新设备列表
onMounted(async () => {
  // 先探测 WASAPI 是否可用
  const probe = await outputManager.probeWasapiAvailability()
  wasapiAvailable.value = probe.available
  if (!probe.available) {
    wasapiUnavailableReason.value = probe.reason
  }
  refreshDevices()
  // 检查 FFmpeg 安装状态
  ffmpegInstaller.checkStatus()
})

const props = defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  // 当前高亮的设置项 key
  highlightKey?: string | null
}>()
</script>

<template>
  <div class="settings-content">
    <div class="section-group-title">音频输出</div>

    <!-- FFmpeg 解码器状态 -->
    <n-card
      class="setting-item"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row" style="flex-direction: column; align-items: flex-start; gap: 12px">
        <div class="setting-label">
          <div class="main-label">FFmpeg 解码器</div>
          <div class="sub-label">
            FFmpeg 用于解码 DSD/DSF/DFF/WavPack/APE 等特殊音频格式。
            状态：<strong>{{ ffmpegInstaller.isInstalled.value ? '✅ 已安装' : '❌ 未安装' }}</strong>
          </div>
        </div>

        <!-- 未安装时显示下载按钮 -->
        <template v-if="!ffmpegInstaller.isInstalled.value">
          <n-space v-if="!ffmpegInstaller.isInstalling.value" align="center">
            <n-button
              type="primary"
              size="small"
              :loading="ffmpegInstaller.isChecking.value"
              @click="ffmpegInstaller.startInstallation()"
            >
              自动下载安装 FFmpeg
            </n-button>
            <span class="time-text" v-if="ffmpegInstaller.missingDlls.value.length > 0">
              缺失: {{ ffmpegInstaller.missingDlls.value.join(', ') }}
            </span>
          </n-space>

          <!-- 安装进度 -->
          <div v-if="ffmpegInstaller.isInstalling.value" style="width: 100%">
            <n-progress
              type="line"
              :percentage="ffmpegInstaller.progress.value.percent"
              :indicator-placement="'inside'"
              :height="24"
              :status="ffmpegInstaller.progress.value.status === 'error' ? 'error' : 'default'"
            />
            <div class="time-text" style="margin-top: 8px">
              {{
                ffmpegInstaller.progress.value.status === 'downloading'
                  ? `下载中: ${ffmpegInstaller.formatBytes(ffmpegInstaller.progress.value.downloadedBytes)} / ${ffmpegInstaller.formatBytes(ffmpegInstaller.progress.value.totalBytes)} (${ffmpegInstaller.formatSpeed(ffmpegInstaller.progress.value.speedBps)})`
                  : ffmpegInstaller.progress.value.status === 'extracting'
                    ? '正在解压安装...'
                    : ffmpegInstaller.progress.value.status === 'ready'
                      ? '安装完成！'
                      : ''
              }}
              <template v-if="ffmpegInstaller.progress.value.status === 'downloading' && ffmpegInstaller.progress.value.estimatedSeconds > 0">
                · 预计剩余: {{ ffmpegInstaller.formatEta(ffmpegInstaller.progress.value.estimatedSeconds) }}
              </template>
            </div>
          </div>

          <!-- 错误信息 -->
          <n-alert
            v-if="ffmpegInstaller.error.value"
            type="error"
            :title="ffmpegInstaller.error.value"
            style="width: 100%"
          />
        </template>

        <!-- 已安装时显示 DLL 列表 -->
        <div
          v-if="ffmpegInstaller.isInstalled.value && ffmpegInstaller.dllsFound.value.length > 0"
          class="time-text"
        >
          已加载: {{ ffmpegInstaller.dllsFound.value.join(', ') }}
        </div>
      </div>
    </n-card>

    <!-- WASAPI 不可用提示 -->
    <n-alert
      v-if="!wasapiAvailable"
      type="info"
      title="WASAPI 不可用"
      style="margin-bottom: 12px"
    >
      WASAPI 音频输出功能当前不可用。原因：{{ wasapiUnavailableReason }}
    </n-alert>

    <!-- 输出模式选择 -->
    <n-card
      class="setting-item"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row" style="flex-direction: column; align-items: flex-start; gap: 12px">
        <div class="setting-label">
          <div class="main-label">音频输出模式</div>
          <div class="sub-label">
            选择音频输出引擎。
            <strong>WebAudio</strong> 兼容性最好；
            <strong>WASAPI 独占</strong> 可绕过系统混音器实现最低延迟和 bit-perfect 输出，适合 USB DAC
          </div>
        </div>
        <n-select
          v-model:value="selectedOutputMode"
          :options="outputModeOptions"
          :loading="modeSwitching"
          style="width: 260px"
        />
        <div class="time-text">
          当前引擎：{{ engineDescription }}
        </div>
      </div>
    </n-card>

    <!-- 设备选择 (WASAPI 模式下显示) -->
    <n-card
      v-if="settingsStore.playback.audioOutputMode !== 'webaudio'"
      class="setting-item"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row" style="flex-direction: column; align-items: flex-start; gap: 12px">
        <div class="setting-label">
          <div class="main-label">输出设备</div>
          <div class="sub-label">
            选择 WASAPI 输出目标设备。支持 USB DAC、HDMI 音频、内置声卡等。
            独占模式下该设备将被独占，其他应用无法使用。
          </div>
        </div>
        <n-space align="center" style="width: 100%">
          <n-select
            v-model:value="selectedDeviceName"
            :loading="devicesLoading"
            :options="audioDevices.map(d => ({
              label: `${d.name}${d.isDefault ? ' (默认)' : ''}`,
              value: d.id
            }))"
            style="flex: 1; max-width: 400px"
            placeholder="选择音频输出设备..."
            @update:value="(val: string) => selectDevice(val)"
          />
          <n-button
            size="small"
            :loading="devicesLoading"
            @click="refreshDevices"
          >
            刷新
          </n-button>
        </n-space>
        <div class="time-text">
          {{ audioDevices.length > 0
            ? `已发现 ${audioDevices.length} 个音频设备`
            : '正在搜索设备...' }}
        </div>
      </div>
    </n-card>

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
      :class="{
        'setting-item--highlight':
          props.highlightKey === 'playback.autoHidePlayerPageFooter'
      }"
      data-setting-key="playback.autoHidePlayerPageFooter"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">播放页底栏自动隐藏</div>
          <div class="sub-label">播放页底栏在无操作时自动隐藏，移动鼠标后重新显示</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.autoHidePlayerPageFooter" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.visualizerEnabled' }"
      data-setting-key="playback.visualizerEnabled"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">音频可视化</div>
          <div class="sub-label">在播放页底栏显示实时频谱柱状图动画</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.visualizerEnabled" />
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

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.transition' }"
      data-setting-key="playback.transition"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row" style="flex-direction: column; align-items: flex-start; gap: 12px">
        <div class="setting-label">
          <div class="main-label">智能过渡</div>
          <div class="sub-label">实现歌曲之间的无缝衔接，提升播放体验</div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
          <n-switch v-model:value="playerStore.transitionEnabled" @update:value="playerStore.setTransitionEnabled($event)" />
          <span class="time-text">{{
            playerStore.transitionEnabled ? '已启用' : '已关闭'
          }}</span>
        </div>
        <div v-if="playerStore.transitionEnabled" style="width: 100%">
          <div class="setting-row" style="margin-bottom: 8px">
            <div class="setting-label">
              <div class="main-label">过渡时长</div>
              <div class="sub-label">调整歌曲切换时的过渡时间</div>
            </div>
            <div style="display: flex; align-items: center; gap: 12px; min-width: 220px">
              <n-slider
                v-model:value="transitionDurationSeconds"
                :min="0.5"
                :max="10"
                :step="0.5"
                :tooltip="false"
                style="width: 160px"
              />
              <span class="time-text">{{ transitionDurationSeconds }} 秒</span>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-label">
              <div class="main-label">过渡效果</div>
              <div class="sub-label">选择不同的过渡效果类型</div>
            </div>
            <n-select
              v-model:value="playerStore.transitionType"
              :options="transitionTypeOptions"
              style="width: 180px"
              @update:value="playerStore.setTransitionType($event)"
            />
          </div>
        </div>
      </div>
    </n-card>
  </div>
</template>

<style lang="scss" scoped>
/* settings-modal.scss 已由 SettingsModal.vue 全局导入，此处无需重复导入 */
</style>
