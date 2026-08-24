<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { NCard, NSwitch, NSlider, NSelect, NButton, NButtonGroup, NAlert, NSpace, NInputNumber } from 'naive-ui'
import { useSettingsStore } from '../../../stores/settingsStore'
import SettingsMorphaeumSection from './SettingsMorphaeumSection.vue'
import {
  AudioOutputModeManager,
  cleanRustError,
  isWindowsPlatform,
  type AudioOutputMode,
  type AudioDevice
} from '../../../utils/audioOutputModeManager'

// 使用设置仓库，驱动播放设置选项
const settingsStore = useSettingsStore()

// 音量增强显示值（100-300，对应 1.0x-3.0x）
const volumeBoostPercent = computed({
  get: () => Math.round(settingsStore.playback.volumeBoost * 100),
  set: (val: number) => {
    const normalized = Math.min(Math.max(val, 100), 300) / 100
    settingsStore.playback.volumeBoost = normalized
  }
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

/// 平台是否支持 Windows 音频后端（WASAPI）
const showWasapiControls = computed(() => isWindowsPlatform())

/// 当前引擎描述
const engineDescription = computed(() => {
  switch (settingsStore.playback.audioOutputMode) {
    case 'webaudio':
      return 'Web Audio API（浏览器内置）'
    case 'wasapi-exclusive':
      return 'Windows 音频会话 API（独占）'
    case 'wasapi-shared':
      return 'Windows 音频会话 API（共享）'
    default:
      return 'Web Audio API（浏览器内置）'
  }
})

/// 基础输出模式（Web Audio / Windows 音频会话 API），独占作为独立开关
type BaseOutputMode = 'webaudio' | 'wasapi'
const selectedBaseMode = computed<BaseOutputMode>({
  get: () => {
    const mode = settingsStore.playback.audioOutputMode
    if (mode === 'webaudio') return 'webaudio'
    return 'wasapi'
  },
  set: (val: BaseOutputMode) => {
    if (val === 'webaudio') {
      applyOutputMode('webaudio')
    } else {
      // 切换到 Windows 音频会话 API 时，根据独占开关决定模式
      const targetMode = wasapiExclusiveEnabled.value ? 'wasapi-exclusive' : 'wasapi-shared'
      applyOutputMode(targetMode, settingsStore.playback.audioOutputDeviceId)
    }
  }
})

/// WASAPI 独占模式开关
const wasapiExclusiveEnabled = computed<boolean>({
  get: () => settingsStore.playback.audioOutputMode === 'wasapi-exclusive',
  set: (val: boolean) => {
    const targetMode = val ? 'wasapi-exclusive' : 'wasapi-shared'
    applyOutputMode(targetMode, settingsStore.playback.audioOutputDeviceId)
  }
})

/// WASAPI 是否可用（默认 false，需通过 probe 确认）
const wasapiAvailable = ref(false)

/// WASAPI 不可用原因
const wasapiUnavailableReason = ref('正在检测...')

/// 模式切换错误（临时错误，不影响 WASAPI 可用性判断）
const modeSwitchError = ref('')

/// 当前选中的输出设备名称（用于显示）
const selectedDeviceId = computed({
  get: () =>
    settingsStore.playback.audioOutputDeviceId ||
    audioDevices.value.find((d) => d.isDefault)?.id ||
    '',
  set: (val: string) => {
    selectDevice(val)
  }
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
    modeSwitchError.value = '' // 刷新设备时清除错误
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
  // Web Audio 模式（跨平台，无需设备初始化）
  if (mode === 'webaudio') {
    modeSwitching.value = true
    try {
      const result = await outputManager.switchMode('webaudio')
      if (result.success) {
        settingsStore.playback.audioOutputMode = 'webaudio'
        modeSwitchError.value = ''
      }
    } catch (err) {
      modeSwitchError.value = cleanRustError(String(err))
    } finally {
      modeSwitching.value = false
    }
    return
  }

  // WASAPI 模式需要先确认可用
  if (!wasapiAvailable.value) {
    return
  }

  modeSwitching.value = true
  try {
    const result = await outputManager.switchMode(mode, {
      sampleRate: 44100,
      channels: 2,
      deviceId: deviceId || settingsStore.playback.audioOutputDeviceId || undefined
    })

    if (result.success) {
      settingsStore.playback.audioOutputMode = mode
      modeSwitchError.value = ''
      // 同步引擎使用的实际设备信息到 store
      const engDevices = await outputManager.enumerateDevices()
      const actualDevice = engDevices.find(
        (d) => d.id === settingsStore.playback.audioOutputDeviceId
      )
      if (!actualDevice && engDevices.length > 0) {
        // 未指定设备时，引擎使用了默认设备，同步其名称
        const defaultDev = engDevices.find((d) => d.isDefault) || engDevices[0]
        settingsStore.playback.audioOutputDeviceId = defaultDev.id
        settingsStore.playback.audioOutputDeviceName = defaultDev.name
      }
    } else {
      console.warn('[Settings] 模式切换失败:', result.error)
      // 不将 wasapiAvailable 置为 false — 枚举成功就说明 WASAPI 可用
      // 仅记录本次切换的错误，让用户可以选择其他设备重试
      modeSwitchError.value = result.error || '未知'
      // 回退到 Web Audio
      settingsStore.playback.audioOutputMode = 'webaudio'
    }
  } catch (err) {
    const msg = cleanRustError(String(err))
    console.warn('[Settings] 模式切换异常:', msg)
    modeSwitchError.value = msg
    settingsStore.playback.audioOutputMode = 'webaudio'
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
  const device = audioDevices.value.find((d) => d.id === deviceId)
  const deviceName = device?.name ?? '默认设备'
  settingsStore.playback.audioOutputDeviceId = deviceId
  settingsStore.playback.audioOutputDeviceName = deviceName
  modeSwitchError.value = '' // 清除之前的切换错误

  // 如果在 WASAPI 模式下，重新应用
  if (settingsStore.playback.audioOutputMode !== 'webaudio') {
    applyOutputMode(settingsStore.playback.audioOutputMode, deviceId)
  }
}

/// 组件挂载时刷新设备列表
onMounted(async () => {
  if (showWasapiControls.value) {
    // 先探测 WASAPI 是否可用（仅 Windows 平台）
    const probe = await outputManager.probeWasapiAvailability()
    wasapiAvailable.value = probe.available
    if (!probe.available) {
      wasapiUnavailableReason.value = probe.reason
    }
  }
  refreshDevices()
})

const props = defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  // 当前高亮的设置项 key
  highlightKey?: string | null
}>()

// 任务栏对齐方式：居中时才显示「预留小组件入口」开关
const taskbarAlign = ref<'center' | 'left'>('center')
onMounted(() => {
  // 先查询当前对齐方式，再监听变化
  window.electron.ipcRenderer.invoke('taskbar-control:get-align').then((align: 'center' | 'left') => {
    if (align) taskbarAlign.value = align
  })
  window.electron.ipcRenderer.on('taskbar-control:set-align', (_, align: 'center' | 'left') => {
    if (align) taskbarAlign.value = align
  })
})
</script>

<template>
  <div class="settings-content">
    <div class="section-group-title">音频输出</div>

    <!-- Windows 音频会话 API 不可用提示（仅在 Windows 平台且设备枚举失败时显示） -->
    <n-alert
      v-if="showWasapiControls && !wasapiAvailable"
      type="warning"
      title="Windows 音频会话 API 不可用"
      style="margin-bottom: 12px"
    >
      Windows 音频会话 API 音频输出功能当前不可用。原因：{{ wasapiUnavailableReason }}
    </n-alert>

    <!-- 模式切换失败提示（允许用户选择其他设备重试） -->
    <n-alert
      v-if="modeSwitchError"
      type="warning"
      title="Windows 音频会话 API 切换失败"
      style="margin-bottom: 12px"
    >
      当前设备初始化失败：{{
        modeSwitchError
      }}。请尝试在下方的「输出设备」中选择其他设备后重新切换模式。
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
            <strong>Web Audio</strong> 使用浏览器内置引擎，跨平台兼容；
            <strong>Windows 音频会话 API</strong> 可提供更低延迟和独占模式，适合 USB DAC
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
          <n-button-group>
            <n-button
              :type="selectedBaseMode === 'webaudio' ? 'primary' : 'default'"
              :loading="modeSwitching && selectedBaseMode !== 'webaudio'"
              @click="selectedBaseMode = 'webaudio'"
            >
              Web Audio
            </n-button>
            <n-button
              v-if="showWasapiControls"
              :type="selectedBaseMode === 'wasapi' ? 'primary' : 'default'"
              :loading="modeSwitching && selectedBaseMode !== 'wasapi'"
              :disabled="!wasapiAvailable"
              @click="selectedBaseMode = 'wasapi'"
            >
              Windows 音频会话 API
            </n-button>
          </n-button-group>
          <template v-if="showWasapiControls && selectedBaseMode === 'wasapi' && wasapiAvailable">
            <div
              style="
                display: flex;
                align-items: center;
                gap: 6px;
                margin-left: 8px;
                padding-left: 12px;
                border-left: 1px solid var(--n-border-color);
              "
            >
              <span style="font-size: 13px; white-space: nowrap">独占模式</span>
              <n-switch
                v-model:value="wasapiExclusiveEnabled"
                :loading="modeSwitching"
                size="small"
              />
            </div>
          </template>
        </div>
        <div class="time-text">当前引擎：{{ engineDescription }}</div>
      </div>
    </n-card>

    <!-- 设备选择 (始终显示) -->
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
          <div class="main-label">输出设备</div>
          <div class="sub-label">
            选择 Windows 音频会话 API 输出目标设备。支持 USB DAC、HDMI 音频、内置声卡等。
            独占模式下该设备将被独占，其他应用无法使用。
          </div>
        </div>
        <n-space align="center" style="width: 100%">
          <n-select
            v-model:value="selectedDeviceId"
            :loading="devicesLoading"
            :options="
              audioDevices.map((d) => ({
                label: `${d.name}${d.isDefault ? ' (默认)' : ''}`,
                value: d.id
              }))
            "
            style="flex: 1; max-width: 400px"
            placeholder="选择音频输出设备..."
          />
          <n-button size="small" :loading="devicesLoading" @click="refreshDevices"> 刷新 </n-button>
        </n-space>
        <div class="time-text">
          {{
            audioDevices.length > 0 ? `已发现 ${audioDevices.length} 个音频设备` : '正在搜索设备...'
          }}
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
        'setting-item--highlight': props.highlightKey === 'playback.autoHidePlayerPageFooter'
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
      :class="{ 'setting-item--highlight': props.highlightKey === 'playback.volumeBoost' }"
      data-setting-key="playback.volumeBoost"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">音量增强</div>
          <div class="sub-label">提升整体输出增益，解决部分音源在 100% 音量下仍然偏小的问题。</div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; min-width: 220px">
          <n-slider
            v-model:value="volumeBoostPercent"
            :min="100"
            :max="300"
            :step="10"
            :tooltip="false"
            style="width: 160px"
          />
          <span class="time-text">{{ volumeBoostPercent }}%</span>
        </div>
      </div>
    </n-card>

    <div class="section-group-title">任务栏播控</div>

    <n-card
      class="setting-item"
      :class="{
        'setting-item--highlight': props.highlightKey === 'playback.taskbarControlEnabled'
      }"
      data-setting-key="playback.taskbarControlEnabled"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">启用任务栏播控</div>
          <div class="sub-label">在任务栏边缘显示歌曲信息与播放控制按钮</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.taskbarControlEnabled" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :class="{
        'setting-item--highlight': props.highlightKey === 'playback.taskbarControlWidthMode'
      }"
      data-setting-key="playback.taskbarControlWidthMode"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">宽度模式</div>
          <div class="sub-label">自适应：按封面与歌曲信息自动调整宽度；自定义：使用固定宽度</div>
        </div>
        <n-select
          v-model:value="settingsStore.playback.taskbarControlWidthMode"
          :options="[
            { label: '自适应', value: 'auto' },
            { label: '自定义', value: 'custom' }
          ]"
          style="width: 120px"
        />
      </div>
    </n-card>

    <n-card
      v-if="settingsStore.playback.taskbarControlWidthMode === 'custom'"
      class="setting-item"
      :class="{
        'setting-item--highlight': props.highlightKey === 'playback.taskbarControlCustomWidth'
      }"
      data-setting-key="playback.taskbarControlCustomWidth"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">自定义宽度</div>
          <div class="sub-label">任务栏播控窗口的固定宽度（像素）</div>
        </div>
        <n-input-number
          v-model:value="settingsStore.playback.taskbarControlCustomWidth"
          :min="200"
          :max="1200"
          :step="20"
          style="width: 120px"
        />
      </div>
    </n-card>

    <!-- 居中对齐时显示：预留 Windows 小组件入口 -->
    <n-card
      v-if="taskbarAlign === 'center'"
      class="setting-item"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">预留小组件入口</div>
          <div class="sub-label">将窗口向右偏移，为 Windows 小组件按钮留出空间</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.taskbarControlWidgetOffset" />
      </div>
    </n-card>

    <!-- 位置偏移：手动微调窗口水平位置 -->
    <n-card
      class="setting-item"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">位置偏移</div>
          <div class="sub-label">手动调整窗口水平位置（正数右移，负数左移，单位像素）</div>
        </div>
        <n-input-number
          v-model:value="settingsStore.playback.taskbarControlOffsetX"
          :min="-200"
          :max="200"
          :step="5"
          style="width: 120px"
        />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">显示封面</div>
          <div class="sub-label">在播控中显示当前歌曲封面</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.taskbarControlShowCover" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">显示标题</div>
          <div class="sub-label">在播控中显示当前歌曲标题</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.taskbarControlShowTitle" />
      </div>
    </n-card>

    <n-card
      class="setting-item"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">显示歌手</div>
          <div class="sub-label">在播控中显示当前歌曲歌手</div>
        </div>
        <n-switch v-model:value="settingsStore.playback.taskbarControlShowArtist" />
      </div>
    </n-card>

    <!-- Morphaeum（变形实验室）：智能过渡与音量平衡 -->
    <settings-morphaeum-section
      :setting-item-bg-color="props.settingItemBgColor"
      :setting-item-border-color="props.settingItemBorderColor"
      :highlight-key="props.highlightKey"
    />
  </div>
</template>

<style lang="scss" scoped>
/* settings-modal.scss 已由 SettingsModal.vue 全局导入，此处无需重复导入 */
</style>
