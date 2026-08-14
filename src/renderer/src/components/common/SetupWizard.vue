<script setup lang="ts">
/**
 * 首次设置向导组件（Naive UI 版本）
 * 在应用首次启动时引导用户完成初始配置：
 * 隐私声明 → 欢迎页 → 主题色 → 音频引擎
 */
import { ref, computed, onMounted, watch } from 'vue'
import {
  NButton,
  NIcon,
  NCard,
  NText,
  NSpace,
  NButtonGroup,
  NSelect,
  NColorPicker,
  NScrollbar,
  useThemeVars
} from 'naive-ui'
import { useSetupWizardStore } from '../../stores/setupWizardStore'
import { setPrimaryColor } from '../../themes'
import { THEME_COLOR_PRESETS } from '../../types/onboarding'
import { type AudioOutputMode, getAvailableOutputModes } from '../../utils/audioOutputModeManager'
import LegalTexts from './LegalTexts.vue'
import appIcon from '../../assets/icon.png'

const wizardStore = useSetupWizardStore()
const themeVars = useThemeVars()

// ===== 本地状态 =====

const slideDirection = ref(1)
const localAudioMode = ref<AudioOutputMode>(wizardStore.audioOutputMode)
const localAudioDeviceId = ref(wizardStore.audioOutputDeviceId)
const audioDevices = ref<{ id: string; name: string; isDefault: boolean }[]>([])
const devicesLoading = ref(false)

const engineModeLabels: Record<AudioOutputMode, string> = {
  webaudio: 'Web Audio',
  'wasapi-shared': 'WASAPI（共享）',
  'wasapi-exclusive': 'WASAPI（独占）'
}

const engineModeDescriptions: Record<AudioOutputMode, string> = {
  webaudio: '浏览器内置引擎，跨平台兼容性最佳，适合日常使用',
  'wasapi-shared': '低延迟共享模式，与其他应用共用音频设备',
  'wasapi-exclusive': '独占音频设备，最低延迟，适合 Hi-Fi 播放'
}

// ===== 步骤计算 =====

const isCustomTheme = computed(() => wizardStore.selectedThemePreset === 'custom')

/** 下拉菜单颜色选项 */
const colorSelectOptions = computed(() => {
  const presets = THEME_COLOR_PRESETS.map((p) => ({
    label: p.label,
    value: p.value
  }))
  presets.push({ label: '自定义', value: 'custom' })
  return presets
})
const currentStepId = computed(() => wizardStore.currentStep?.id || '')
const isPrivacyStep = computed(() => currentStepId.value === 'privacy')
const isWelcomeStep = computed(() => currentStepId.value === 'welcome')
const isThemeStep = computed(() => currentStepId.value === 'theme')
const isAudioEngineStep = computed(() => currentStepId.value === 'audio-engine')
const availableModes = computed(() => getAvailableOutputModes())

// ===== 步骤切换 =====

const handleNext = (): void => {
  if (currentStepId.value === 'audio-engine') {
    wizardStore.setAudioOutputMode(localAudioMode.value)
    wizardStore.setAudioOutputDeviceId(localAudioDeviceId.value)
  }
  slideDirection.value = 1
  wizardStore.next()
}

const handlePrev = (): void => {
  slideDirection.value = -1
  wizardStore.prev()
}

const handleComplete = (): void => {
  wizardStore.complete()
}

const handleSkip = (): void => {
  wizardStore.skip()
}

const handleSkipCurrentStep = (): void => {
  wizardStore.skipCurrentStep()
}

const goToStep = (index: number): void => {
  // 隐私政策步骤必须通过"同意并继续"进入后续流程，禁止通过指示点跳转跳过
  if (isPrivacyStep.value) return
  if (index < wizardStore.currentStepIndex) {
    slideDirection.value = -1
  } else if (index > wizardStore.currentStepIndex) {
    slideDirection.value = 1
  }
  wizardStore.goTo(index)
}

// ===== 隐私政策与在线服务声明 =====

/** 同意并继续：进入下一步 */
const handleAgree = (): void => {
  slideDirection.value = 1
  wizardStore.next()
}

/** 不同意：退出应用 */
const handleDisagree = (): void => {
  if (window.electron?.ipcRenderer) {
    window.electron.ipcRenderer.send('winAction', { type: 'close' })
  } else {
    // 非 Electron 环境（如浏览器调试）无法退出，回退为跳过向导
    wizardStore.skip()
  }
}

// ===== 主题色处理 =====

const selectThemePreset = (presetValue: string): void => {
  wizardStore.setThemePreset(presetValue)
  setPrimaryColor(wizardStore.activeColor)
}

const handleCustomColorChange = (color: string): void => {
  wizardStore.setCustomThemeColor(color)
  setPrimaryColor(color)
}

// ===== 音频引擎处理 =====

const selectAudioMode = (mode: AudioOutputMode): void => {
  localAudioMode.value = mode
  if (mode === 'webaudio') {
    localAudioDeviceId.value = ''
  }
  refreshAudioDevices()
}

const refreshAudioDevices = async (): Promise<void> => {
  if (localAudioMode.value === 'webaudio') {
    audioDevices.value = []
    return
  }
  devicesLoading.value = true
  try {
    const api = localAudioMode.value.startsWith('wasapi')
      ? (window as any).api?.wasapi
      : null
    if (!api?.enumerateDevices) {
      audioDevices.value = []
      return
    }
    const result = await api.enumerateDevices()
    if (result?.success && Array.isArray(result.devices)) {
      audioDevices.value = result.devices.map((d: any) => ({
        id: d.id || d.deviceId || '',
        name: d.name || '未知设备',
        isDefault: d.isDefault ?? false
      }))

      // 若未选择设备，自动选中系统默认设备（或首个可用设备）
      if (!localAudioDeviceId.value) {
        const defaultDevice = audioDevices.value.find((d) => d.isDefault) || audioDevices.value[0]
        if (defaultDevice) {
          localAudioDeviceId.value = defaultDevice.id
        }
      }
    }
  } catch {
    // 静默处理
  } finally {
    devicesLoading.value = false
  }
}

// 进入音频引擎页时自动加载设备
watch(isAudioEngineStep, (isActive) => {
  if (isActive) refreshAudioDevices()
})

onMounted(() => {
  if (isAudioEngineStep.value) {
    refreshAudioDevices()
  }
})

const getDotStyle = (idx: number): Record<string, string> => {
  const isActive = idx === wizardStore.currentStepIndex
  const isCompleted = idx < wizardStore.currentStepIndex
  if (isActive) {
    return { backgroundColor: themeVars.value.primaryColor, opacity: '1' }
  }
  if (isCompleted) {
    return { backgroundColor: themeVars.value.primaryColor, opacity: '0.5' }
  }
  return {}
}
</script>

<template>
  <Teleport to="body">
    <Transition name="wizard-fade">
      <div v-if="wizardStore.isActive" class="setup-wizard-overlay">
        <div class="wizard-backdrop"></div>

        <n-card class="wizard-card" :bordered="false"
          content-style="display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0;">
          <!-- 类轮播图指示点 -->
          <div class="wizard-dots-header">
            <div class="wizard-dots" :style="{ '--wizard-dot-hover-color': themeVars.primaryColor }">
              <span v-for="(_, idx) in wizardStore.steps" :key="idx" class="wizard-dot"
                :class="{ active: idx === wizardStore.currentStepIndex, completed: idx < wizardStore.currentStepIndex }"
                :style="getDotStyle(idx)"
                @click="goToStep(idx)"></span>
            </div>
          </div>

          <!-- 内容区域 -->
          <div style="flex: 1; min-height: 0; overflow: visible; display: flex; flex-direction: column;">
            <Transition :name="slideDirection === 1 ? 'step-slide-forward' : 'step-slide-backward'" mode="out-in">
              <div class="wizard-content" :key="wizardStore.currentStep?.id">

                <!-- ==================== 隐私政策与在线服务声明 ==================== -->
                <div v-if="isPrivacyStep" class="step-body step-body-left">
                  <div class="step-title-container">
                    <div class="step-title-row step-title-row-left">
                      <n-icon size="24" :color="themeVars.primaryColor">
                        <i class="mgc_shield_line"></i>
                      </n-icon>
                      <n-text class="step-title-text">{{ wizardStore.currentStep?.title }}</n-text>
                    </div>
                    <n-text depth="3" class="step-subtitle-text step-subtitle-text-left">{{
                      wizardStore.currentStep?.subtitle }}</n-text>
                  </div>

                  <n-scrollbar class="legal-scroll">
                    <LegalTexts />
                  </n-scrollbar>

                  <div class="privacy-actions">
                    <n-button size="large" secondary @click="handleDisagree">
                      不同意并退出
                    </n-button>
                    <n-button size="large" type="primary" icon-placement="right" @click="handleAgree">
                      同意并继续
                      <template #icon>
                        <i class="mgc_right_line"></i>
                      </template>
                    </n-button>
                  </div>
                </div>

                <!-- ==================== 欢迎页 ==================== -->
                <div v-else-if="isWelcomeStep" class="step-body welcome-body">
                  <img :src="appIcon" alt="Such Logo" class="welcome-logo" />
                  <div class="welcome-text">
                    <n-text tag="h2" class="welcome-title">欢迎使用 Such Music</n-text>
                    <n-text depth="2" class="welcome-desc">
                      下面将进行一些基础设置
                    </n-text>
                  </div>
                  <n-button icon-placement="right"  type="primary" size="large" @click="handleNext" class="welcome-next-btn">
                    下一步
                    <template #icon>
                      <i class="mgc_right_line"></i>
                    </template>
                  </n-button>
                </div>

                <!-- ==================== 主题色 ==================== -->
                <div v-else-if="isThemeStep" class="step-body step-body-left">
                  <div class="step-title-container">
                  <div class="step-title-row step-title-row-left">
                    <n-icon size="24" :color="themeVars.primaryColor">
                      <i class="mgc_palette_line"></i>
                    </n-icon>
                    <n-text class="step-title-text">{{ wizardStore.currentStep?.title }}</n-text>
                  </div>
                  <n-text depth="3" class="step-subtitle-text step-subtitle-text-left">{{
                    wizardStore.currentStep?.subtitle }}</n-text>
                  </div>
                  <!-- 预设色下拉选择 -->
                  <n-select v-model:value="wizardStore.selectedThemePreset" :options="colorSelectOptions"
                    placeholder="选择预设主题色" style="max-width: 320px" :to="false" :consistent-menu-width="false"
                    @update:value="selectThemePreset" />

                  <!-- 自定义颜色选择器 -->
                  <div v-if="isCustomTheme" class="custom-color-row">
                    <n-color-picker
                      :value="wizardStore.customThemeColor"
                      :modes="['hex']"
                      :show-alpha="false"
                      size="small"
                      style="width: 120px"
                      @update:value="handleCustomColorChange"
                    />
                    <n-text depth="3" style="font-size: 13px;">{{ wizardStore.customThemeColor }}</n-text>
                  </div>

                  <!-- 实时预览条 -->
                  <div class="theme-preview-bar" :style="{ backgroundColor: wizardStore.activeColor }">
                    <n-text style="color: #fff; font-weight: 500;">预览效果</n-text>
                  </div>
                </div>

                <!-- ==================== 音频引擎 ==================== -->
                <div v-else-if="isAudioEngineStep" class="step-body step-body-left">
                  <div class="step-title-container">
                    <div class="step-title-row step-title-row-left">
                      <n-icon size="24" :color="themeVars.primaryColor">
                        <i class="mgc_speaker_line"></i>
                      </n-icon>
                      <n-text class="step-title-text">{{ wizardStore.currentStep?.title }}</n-text>
                    </div>
                    <n-text depth="3" class="step-subtitle-text step-subtitle-text-left">{{
                      wizardStore.currentStep?.subtitle }}</n-text>
                  </div>


                  <div class="engine-mode-group">
                    <n-text strong style="margin-bottom: 8px; display: block;">音频输出模式</n-text>
                    <n-button-group>
                      <n-button v-for="mode in availableModes" :key="mode"
                        :type="localAudioMode === mode ? 'primary' : 'default'" size="small"
                        @click="selectAudioMode(mode)">
                        {{ engineModeLabels[mode] }}
                      </n-button>
                    </n-button-group>
                    <n-text depth="3" class="engine-desc">
                      {{ engineModeDescriptions[localAudioMode] }}
                    </n-text>
                  </div>

                  <div v-if="localAudioMode !== 'webaudio'" class="engine-device-group">
                    <n-text strong style="margin-bottom: 8px; display: block;">输出设备</n-text>
                    <n-space align="center" style="width: 100%">
                      <n-select v-model:value="localAudioDeviceId" :loading="devicesLoading" :options="audioDevices.map(d => ({
                        label: `${d.name}${d.isDefault ? ' (默认)' : ''}`,
                        value: d.id
                      }))" style="flex: 1; max-width: 400px" placeholder="选择音频输出设备..." :to="false"
                        :consistent-menu-width="false" />
                    </n-space>
                    <n-text depth="3" class="engine-desc">
                      {{ audioDevices.length > 0 ? `已发现 ${audioDevices.length} 个音频设备` : '正在搜索设备...' }}
                    </n-text>
                  </div>
                </div>

                <!-- 底部导航 -->
                <div v-if="!isWelcomeStep && !isPrivacyStep" class="wizard-nav">
                  <n-space>
                    <n-button v-if="wizardStore.currentStep?.skippable" text size="small"
                      @click="handleSkipCurrentStep">
                      跳过此步
                    </n-button>
                    <n-button text size="small" depth="3" @click="handleSkip">
                      跳过全部设置
                    </n-button>
                  </n-space>

                  <n-space>
                    <n-button v-if="wizardStore.currentStepIndex > 0 && !isWelcomeStep" @click="handlePrev">
                      上一步
                    </n-button>
                    <n-button v-if="!wizardStore.isLastStep" type="primary" @click="handleNext">
                      下一步
                    </n-button>
                    <n-button v-else type="primary" @click="handleComplete">
                      <template #icon><n-icon><i class="mgc_rocket_line"></i></n-icon></template>
                      开始使用
                    </n-button>
                  </n-space>
                </div>
              </div>
            </Transition>
          </div>
        </n-card>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ===== 覆盖层 ===== */
.setup-wizard-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.wizard-fade-enter-active,
.wizard-fade-leave-active {
  transition: opacity 0.4s ease;
}

.wizard-fade-enter-from,
.wizard-fade-leave-to {
  opacity: 0;
}

.wizard-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.wizard-card {
  width: 680px;
  max-width: calc(100vw - 48px);
  height: 560px;
  max-height: calc(100vh - 64px);
  /* 固定卡片高度下让内容区 flex:1 生效，防止内容撑破卡片 */
  display: flex;
  flex-direction: column;
}

/* ===== 轮播图指示点 ===== */
.wizard-dots-header {
  padding: 20px 32px 0;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
}

.wizard-dots {
  display: flex;
  gap: 8px;
}

.wizard-dot {
  width: 20px;
  height: 6px;
  border-radius: 3px;
  background: var(--n-border-color);
  cursor: pointer;
  transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.wizard-dot:hover {
  background: var(--wizard-dot-hover-color, #2C8EFD);
  opacity: 0.7;
}

.wizard-dot.active {
  width: 32px;
  border-radius: 3px;
  cursor: default;
}

.wizard-dot.completed {
  /* 背景色由内联样式根据主题主色控制 */
}

/* ===== 内容区域 ===== */
.wizard-content {
  padding: 20px 40px 20px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.step-title-container {
  display: flex;
  flex-direction: column;
  align-items: start;
}

.step-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  flex: 1;
  min-height: 0;
}

/* 非欢迎页统一居左 */
.step-body-left {
  align-items: flex-start;
}

/* ===== 通用步骤标题 ===== */
.step-title-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.step-title-row-left {
  justify-content: flex-start;
}

.step-title-text {
  font-size: 20px;
  font-weight: 700;
}

.step-subtitle-text {
  text-align: center;
  font-size: 13px;
}

.step-subtitle-text-left {
  text-align: left;
}

/* ===== 欢迎页 ===== */
.welcome-body {
  align-items: center;
  justify-content: center;
  padding-top: 10px;
  padding-bottom: 20px;
}

.welcome-logo {
  width: 80px;
  height: 80px;
  border-radius: 18px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.welcome-text {
  text-align: center;
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: -24px;
}

.welcome-title {
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 8px;
}

.welcome-desc {
  font-size: 15px;
  transform: translateY(-25%);
  line-height: 1.7;
}

.welcome-next-btn {
  margin-top: 8px;
  min-width: 160px;
}

/* ===== 主题色 ===== */
.custom-color-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.theme-preview-bar {
  margin-top: 4px;
  padding: 8px 16px;
  border-radius: 10px;
  text-align: center;
  transition: background 0.3s;
  opacity: 0.9;
}

/* ===== 隐私政策与在线服务声明 ===== */
.legal-scroll {
  flex: 1;
  min-height: 0;
  padding: 2px 4px;
}

.privacy-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  flex-shrink: 0;
}

/* ===== 音频引擎 ===== */
.engine-mode-group {
  padding: 12px 14px;
  background: var(--n-action-color);
  border-radius: 10px;
  width: 100%;
}

.engine-desc {
  font-size: 12px;
  display: block;
  margin-top: 8px;
}

.engine-device-group {
  padding: 12px 14px;
  background: var(--n-action-color);
  border-radius: 10px;
  width: 100%;
}

/* ===== 底部导航 ===== */
.wizard-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 16px 10px;
  margin-top: 12px;
  border-top: 1px solid var(--n-border-color);
  flex-shrink: 0;
}

/* ===== 过渡动画 ===== */
.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 0.3s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.step-slide-forward-enter-active,
.step-slide-forward-leave-active,
.step-slide-backward-enter-active,
.step-slide-backward-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.step-slide-forward-enter-from {
  opacity: 0;
  transform: translateX(40px);
}

.step-slide-forward-leave-to {
  opacity: 0;
  transform: translateX(-40px);
}

.step-slide-backward-enter-from {
  opacity: 0;
  transform: translateX(-40px);
}

.step-slide-backward-leave-to {
  opacity: 0;
  transform: translateX(40px);
}

/* ===== 响应式 ===== */
@media (max-width: 720px) {
  .wizard-card {
    max-width: calc(100vw - 24px);
    height: auto;
    min-height: 420px;
    max-height: calc(100vh - 48px);
  }

  .wizard-dots-header {
    padding: 16px 16px 0;
  }

  .wizard-content {
    padding: 16px 20px 8px;
  }

  .wizard-nav {
    padding: 10px 0 0;
    flex-direction: column;
    gap: 8px;
  }

  .welcome-title {
    font-size: 22px;
  }

  .welcome-logo {
    width: 64px;
    height: 64px;
  }
}
</style>
