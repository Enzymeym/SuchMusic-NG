<script setup lang="ts">
/**
 * 首次设置向导组件（Naive UI 版本）
 * 在应用首次启动时引导用户完成初始配置：
 * 主题色 → 音效 → 本地音乐导入 → 完成
 */
import { ref, computed } from 'vue'
import {
  NButton,
  NInput,
  NIcon,
  NSwitch,
  NCard,
  NText,
  NSpace,
  NScrollbar,
  NAlert,
  useMessage
} from 'naive-ui'
import { useSetupWizardStore } from '../../stores/setupWizardStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useLocalMusicStore } from '../../stores/localMusicStore'
import { setPrimaryColor } from '../../themes'
import { THEME_COLOR_PRESETS, EQ_PRESETS } from '../../types/onboarding'

const wizardStore = useSetupWizardStore()
const settingsStore = useSettingsStore()
const localMusicStore = useLocalMusicStore()
const message = useMessage()

// ===== 本地状态 =====

/** 自定义颜色输入值 */
const customColorInput = ref(wizardStore.customThemeColor)

/** 本地音乐扫描目录列表 */
const selectedDirs = ref<string[]>([])

/** 本地音乐扫描中 */
const scanningLocal = ref(false)

/** 本地音乐扫描结果统计 */
const scanResult = ref<{ count: number } | null>(null)

// ===== 步骤计算 =====

/** 当前步骤是否为自定义颜色模式 */
const isCustomTheme = computed(() => wizardStore.selectedThemePreset === 'custom')

// ===== 步骤切换 =====

const handleNext = (): void => {
  wizardStore.next()
}

const handlePrev = (): void => {
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

// ===== 主题色处理 =====

const selectThemePreset = (presetValue: string): void => {
  wizardStore.setThemePreset(presetValue)
  customColorInput.value = wizardStore.customThemeColor
  setPrimaryColor(wizardStore.activeColor)
}

const handleCustomColorChange = (): void => {
  const color = customColorInput.value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    wizardStore.setCustomThemeColor(color)
    setPrimaryColor(color)
  }
}

// ===== 音效处理 =====

const selectEqPreset = (presetValue: string): void => {
  wizardStore.setEqPreset(presetValue)
}

// ===== 本地音乐处理 =====

const handleSelectMusicFolder = async (): Promise<void> => {
  if (!window.electron?.ipcRenderer) return
  try {
    const result = (await window.electron.ipcRenderer.invoke('local-music:choose-scan-dirs')) as {
      canceled: boolean
      dirs: string[]
    }
    if (result.canceled || !Array.isArray(result.dirs) || !result.dirs.length) return
    const merged = new Set([...selectedDirs.value, ...result.dirs])
    selectedDirs.value = Array.from(merged)
  } catch (err) {
    console.error('选择文件夹失败', err)
    message.error('选择文件夹失败，请重试')
  }
}

const removeDir = (dir: string): void => {
  selectedDirs.value = selectedDirs.value.filter((d) => d !== dir)
}

const handleScanLocalMusic = async (): Promise<void> => {
  if (selectedDirs.value.length === 0) {
    message.warning('请先选择音乐文件夹')
    return
  }
  scanningLocal.value = true
  scanResult.value = null
  try {
    settingsStore.local.scanDirs = [...selectedDirs.value]
    await localMusicStore.scanMusic()
    scanResult.value = { count: localMusicStore.songs.length }
  } catch (err) {
    console.error('扫描本地音乐失败', err)
    message.error('扫描失败，请检查文件夹权限')
  } finally {
    scanningLocal.value = false
  }
}

// ===== 完成步骤辅助 =====

const getPresetLabel = (value: string): string => {
  if (value === 'custom') return '自定义'
  return THEME_COLOR_PRESETS.find((p) => p.value === value)?.label || value
}

const getEqLabel = (value: string): string => {
  return EQ_PRESETS.find((p) => p.value === value)?.label || value
}
</script>

<template>
  <Teleport to="body">
    <Transition name="wizard-fade">
      <div v-if="wizardStore.isActive" class="setup-wizard-overlay">
        <div class="wizard-backdrop"></div>

        <n-card class="wizard-card" :bordered="false" content-style="display: flex; flex-direction: column; flex: 1; padding: 0; overflow: hidden;">
          <!-- 顶部步骤条 -->
          <div class="wizard-steps-header">
            <div
              v-for="(step, idx) in wizardStore.steps"
              :key="step.id"
              class="wizard-step-item"
              :class="{
                active: idx === wizardStore.currentStepIndex,
                completed: idx < wizardStore.currentStepIndex
              }"
            >
              <div class="step-bullet" :class="{ active: idx === wizardStore.currentStepIndex, completed: idx < wizardStore.currentStepIndex }">
                <n-icon v-if="idx < wizardStore.currentStepIndex" size="14">
                  <i class="mgc_check_line"></i>
                </n-icon>
                <span v-else class="step-num">{{ idx + 1 }}</span>
              </div>
              <n-text depth="3" class="step-label" :class="{ active: idx === wizardStore.currentStepIndex }">
                {{ step.title }}
              </n-text>
            </div>
          </div>

          <!-- 内容区域 -->
          <n-scrollbar style="flex: 1; min-height: 280px;">
            <div class="wizard-content">
              <!-- 步骤1：选择主题色 -->
              <div v-if="wizardStore.currentStep?.id === 'theme'" class="step-body">
                <div class="step-header">
                  <div class="step-icon-bg" style="background: linear-gradient(135deg, #667eea, #764ba2)">
                    <n-icon size="28" color="#fff"><i class="mgc_palette_line"></i></n-icon>
                  </div>
                  <h2 class="step-title">选择主题色</h2>
                  <n-text depth="3">挑选你喜欢的颜色，打造专属的音乐空间</n-text>
                </div>

                <!-- 预设色板 -->
                <div class="color-grid">
                  <div
                    v-for="preset in THEME_COLOR_PRESETS"
                    :key="preset.value"
                    class="color-item"
                    :class="{ selected: wizardStore.selectedThemePreset === preset.value }"
                    @click="selectThemePreset(preset.value)"
                  >
                    <div class="color-dot" :style="{ background: preset.color }">
                      <n-icon v-if="wizardStore.selectedThemePreset === preset.value" size="16" color="#fff">
                        <i class="mgc_check_line"></i>
                      </n-icon>
                    </div>
                    <n-text depth="3" class="color-name" :class="{ selected: wizardStore.selectedThemePreset === preset.value }">
                      {{ preset.label }}
                    </n-text>
                  </div>

                  <!-- 自定义颜色 -->
                  <div
                    class="color-item"
                    :class="{ selected: isCustomTheme }"
                    @click="selectThemePreset('custom')"
                  >
                    <div class="color-dot custom-dot" :style="{ background: wizardStore.customThemeColor }">
                      <n-icon v-if="isCustomTheme" size="16" color="#fff"><i class="mgc_check_line"></i></n-icon>
                    </div>
                    <n-text depth="3" class="color-name" :class="{ selected: isCustomTheme }">自定义</n-text>
                  </div>
                </div>

                <!-- 自定义颜色输入 -->
                <transition name="slide-down">
                  <n-space v-if="isCustomTheme" justify="center" align="center" :size="12">
                    <div class="color-preview-block" :style="{ background: wizardStore.customThemeColor }"></div>
                    <n-input
                      v-model:value="customColorInput"
                      placeholder="#2C8EFD"
                      maxlength="7"
                      style="width: 180px"
                      @blur="handleCustomColorChange"
                      @keydown.enter="handleCustomColorChange"
                    />
                  </n-space>
                </transition>

                <!-- 实时预览条 -->
                <div class="theme-preview-bar" :style="{ background: wizardStore.activeColor }">
                  <n-text style="color: #fff; font-weight: 500;">预览效果</n-text>
                </div>
              </div>

              <!-- 步骤2：音效设置 -->
              <div v-else-if="wizardStore.currentStep?.id === 'sound'" class="step-body">
                <div class="step-header">
                  <div class="step-icon-bg" style="background: linear-gradient(135deg, #f093fb, #f5576c)">
                    <n-icon size="28" color="#fff"><i class="mgc_equalizer_line"></i></n-icon>
                  </div>
                  <h2 class="step-title">音效设置</h2>
                  <n-text depth="3">选择适合的均衡器预设，优化听感体验</n-text>
                </div>

                <!-- EQ 开关行 -->
                <div class="setting-row">
                  <n-text strong>启用均衡器</n-text>
                  <n-switch v-model:value="wizardStore.eqEnabled" />
                </div>

                <!-- EQ 预设选择 -->
                <transition name="slide-down">
                  <div v-if="wizardStore.eqEnabled" class="eq-cards">
                    <n-card
                      v-for="preset in EQ_PRESETS"
                      :key="preset.value"
                      size="small"
                      :bordered="true"
                      class="eq-card"
                      :class="{ selected: wizardStore.selectedEqPreset === preset.value }"
                      :style="wizardStore.selectedEqPreset === preset.value
                        ? { borderColor: 'var(--n-primary-color)', background: 'var(--n-primary-color-suppl)' }
                        : {}"
                      @click="selectEqPreset(preset.value)"
                    >
                      <n-space justify="space-between" align="center">
                        <n-text strong>{{ preset.label }}</n-text>
                        <n-icon v-if="wizardStore.selectedEqPreset === preset.value" color="var(--n-primary-color)" size="18">
                          <i class="mgc_check_circle_fill"></i>
                        </n-icon>
                      </n-space>
                      <n-text depth="3" style="font-size: 12px; line-height: 1.4;">{{ preset.description }}</n-text>
                    </n-card>
                  </div>
                </transition>

                <!-- 可视化开关行 -->
                <div class="setting-row">
                  <div>
                    <n-text strong>音频可视化</n-text>
                    <br>
                    <n-text depth="3" style="font-size: 12px;">播放时在背景中显示动态频谱效果</n-text>
                  </div>
                  <n-switch v-model:value="wizardStore.visualizerEnabled" />
                </div>
              </div>

              <!-- 步骤3：导入本地音乐 -->
              <div v-else-if="wizardStore.currentStep?.id === 'local-music'" class="step-body">
                <div class="step-header">
                  <div class="step-icon-bg" style="background: linear-gradient(135deg, #4facfe, #00f2fe)">
                    <n-icon size="28" color="#fff"><i class="mgc_folder_2_line"></i></n-icon>
                  </div>
                  <h2 class="step-title">导入本地音乐</h2>
                  <n-text depth="3">选择音乐文件夹，将本地歌曲加入曲库</n-text>
                </div>

                <!-- 已选目录列表 -->
                <n-space v-if="selectedDirs.length > 0" vertical :size="6">
                  <div v-for="dir in selectedDirs" :key="dir" class="dir-row">
                    <n-icon size="18" color="#e6a23c"><i class="mgc_folder_fill"></i></n-icon>
                    <n-text class="dir-path-text">{{ dir }}</n-text>
                    <n-button text size="tiny" type="error" @click="removeDir(dir)">
                      <template #icon><n-icon><i class="mgc_close_line"></i></n-icon></template>
                    </n-button>
                  </div>
                </n-space>

                <!-- 空状态 -->
                <div v-else class="empty-hint">
                  <n-icon size="44" depth="3"><i class="mgc_folder_open_line"></i></n-icon>
                  <n-text depth="3">尚未选择任何文件夹</n-text>
                </div>

                <!-- 操作按钮 -->
                <n-space justify="center" :size="12">
                  <n-button dashed @click="handleSelectMusicFolder">
                    <template #icon><n-icon><i class="mgc_folder_add_line"></i></n-icon></template>
                    选择音乐文件夹
                  </n-button>
                  <n-button
                    v-if="selectedDirs.length > 0"
                    type="primary"
                    :loading="scanningLocal"
                    @click="handleScanLocalMusic"
                  >
                    {{ scanningLocal ? '扫描中...' : '开始扫描' }}
                  </n-button>
                </n-space>

                <!-- 扫描结果 -->
                <transition name="slide-down">
                  <n-alert v-if="scanResult" type="success" :bordered="false">
                    <template #icon><n-icon><i class="mgc_check_circle_fill"></i></n-icon></template>
                    已扫描到 <strong>{{ scanResult.count }}</strong> 首本地歌曲
                  </n-alert>
                </transition>

                <n-text depth="3" style="text-align: center; font-size: 12px;">
                  你也可以稍后在「设置 → 本地」中添加音乐文件夹
                </n-text>
              </div>

              <!-- 步骤4：准备就绪 -->
              <div v-else-if="wizardStore.currentStep?.id === 'done'" class="step-body">
                <div class="step-header">
                  <div class="done-icon-bg">
                    <n-icon size="36" color="#fff"><i class="mgc_celebrate_line"></i></n-icon>
                  </div>
                  <h2 class="step-title">一切就绪！</h2>
                  <n-text depth="3">以下是你的初始配置，随时可在设置中调整</n-text>
                </div>

                <!-- 设置摘要 -->
                <n-space vertical :size="6">
                  <div class="summary-row">
                    <div class="summary-dot" :style="{ background: wizardStore.activeColor }"></div>
                    <div>
                      <n-text depth="3" style="font-size: 12px; display: block;">主题色</n-text>
                      <n-text strong>{{ getPresetLabel(wizardStore.selectedThemePreset) }}</n-text>
                    </div>
                  </div>

                  <div class="summary-row">
                    <n-icon size="20" color="var(--n-primary-color)"><i class="mgc_equalizer_line"></i></n-icon>
                    <div>
                      <n-text depth="3" style="font-size: 12px; display: block;">均衡器</n-text>
                      <n-text strong>{{ wizardStore.eqEnabled ? getEqLabel(wizardStore.selectedEqPreset) : '未启用' }}</n-text>
                    </div>
                  </div>

                  <div class="summary-row">
                    <n-icon size="20" color="var(--n-primary-color)"><i class="mgc_live_line"></i></n-icon>
                    <div>
                      <n-text depth="3" style="font-size: 12px; display: block;">音频可视化</n-text>
                      <n-text strong>{{ wizardStore.visualizerEnabled ? '已启用' : '未启用' }}</n-text>
                    </div>
                  </div>

                  <div v-if="scanResult" class="summary-row">
                    <n-icon size="20" color="var(--n-primary-color)"><i class="mgc_folder_fill"></i></n-icon>
                    <div>
                      <n-text depth="3" style="font-size: 12px; display: block;">本地音乐</n-text>
                      <n-text strong>{{ scanResult.count }} 首歌曲</n-text>
                    </div>
                  </div>

                </n-space>

                <n-text depth="2" style="text-align: center; margin-top: 8px;">
                  开始探索 Such Music，发现更多好音乐吧
                </n-text>
              </div>
            </div>
          </n-scrollbar>

          <!-- 底部导航栏 -->
          <div class="wizard-footer">
            <n-space>
              <n-button
                v-if="wizardStore.currentStep?.skippable"
                text
                size="small"
                @click="handleSkipCurrentStep"
              >
                跳过此步
              </n-button>
              <n-button text size="small" depth="3" @click="handleSkip">
                跳过全部设置
              </n-button>
            </n-space>

            <n-space>
              <n-button
                v-if="wizardStore.currentStepIndex > 0"
                @click="handlePrev"
              >
                上一步
              </n-button>
              <n-button
                v-if="!wizardStore.isLastStep"
                type="primary"
                @click="handleNext"
              >
                下一步
              </n-button>
              <n-button
                v-else
                type="primary"
                @click="handleComplete"
                :style="{ background: 'linear-gradient(135deg, #667eea, #764ba2)', border: 'none' }"
              >
                <template #icon><n-icon><i class="mgc_rocket_line"></i></n-icon></template>
                开始使用
              </n-button>
            </n-space>
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

/* ===== 向导卡片 ===== */
.wizard-card {
  width: 680px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 64px);
}

/* ===== 顶部步骤条 ===== */
.wizard-steps-header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 32px 0;
  flex-shrink: 0;
}

.wizard-step-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex: 1;
  position: relative;
  max-width: 120px;
}

/* 连接线 */
.wizard-step-item:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 13px;
  left: calc(50% + 14px);
  width: calc(100% + 8px - 28px);
  height: 2px;
  background: var(--n-border-color);
  transition: background 0.3s;
}

.wizard-step-item.completed::after {
  background: var(--n-primary-color);
}

.step-bullet {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--n-action-color);
  border: 2px solid var(--n-border-color);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--n-text-color-3);
  transition: all 0.3s;
}

.step-bullet.active {
  background: var(--n-primary-color);
  border-color: var(--n-primary-color);
  color: #fff;
  box-shadow: 0 2px 8px rgba(44, 142, 253, 0.25);
}

.step-bullet.completed {
  background: var(--n-primary-color);
  border-color: var(--n-primary-color);
  color: #fff;
}

.step-num {
  font-size: 12px;
  font-weight: 700;
}

.step-label {
  font-size: 11px;
  white-space: nowrap;
  text-align: center;
}

.step-label.active {
  font-weight: 600;
  color: var(--n-text-color) !important;
}

/* ===== 内容区域 ===== */
.wizard-content {
  padding: 24px 40px 8px;
}

.step-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.step-header {
  text-align: center;
  margin-bottom: 2px;
}

.step-icon-bg {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 10px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.1);
}

.done-icon-bg {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  background: linear-gradient(135deg, #667eea, #764ba2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 10px;
  box-shadow: 0 6px 24px rgba(102, 126, 234, 0.3);
}

.step-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--n-text-color);
  margin: 0 0 4px;
}

/* ===== 主题色 ===== */
.color-grid {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}

.color-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 10px;
  transition: background 0.2s;
}

.color-item:hover {
  background: var(--n-action-color-hover);
}

.color-item.selected {
  background: var(--n-primary-color-suppl);
}

.color-dot {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
  transition: transform 0.2s, box-shadow 0.2s;
}

.color-item:hover .color-dot {
  transform: scale(1.06);
}

.color-item.selected .color-dot {
  box-shadow: 0 0 0 3px var(--n-color), 0 0 0 5px var(--n-primary-color);
}

.custom-dot {
  background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red) !important;
}

.color-name {
  font-size: 11px !important;
}

.color-name.selected {
  color: var(--n-primary-color) !important;
  font-weight: 600;
}

.color-preview-block {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  border: 2px solid var(--n-border-color);
  flex-shrink: 0;
}

.theme-preview-bar {
  margin-top: 4px;
  padding: 8px 16px;
  border-radius: 10px;
  text-align: center;
  transition: background 0.3s;
  opacity: 0.9;
}

/* ===== 音效 ===== */
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--n-action-color);
  border-radius: 10px;
}

.eq-cards {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.eq-card {
  cursor: pointer;
  transition: all 0.2s;
}

.eq-card:hover {
  border-color: var(--n-primary-color) !important;
}

/* ===== 本地音乐 ===== */
.dir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--n-action-color);
  border-radius: 8px;
}

.dir-path-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 24px;
}

/* ===== 摘要行 ===== */
.summary-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--n-action-color);
  border-radius: 10px;
}

.summary-dot {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  flex-shrink: 0;
}

/* ===== 底部导航 ===== */
.wizard-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 32px 22px;
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

/* ===== 响应式 ===== */
@media (max-width: 720px) {
  .wizard-card {
    max-width: calc(100vw - 24px);
  }
  .wizard-steps-header {
    padding: 18px 16px 0;
    gap: 2px;
  }
  .step-label {
    font-size: 10px !important;
  }
  .step-bullet {
    width: 22px;
    height: 22px;
  }
  .wizard-content {
    padding: 18px 20px 8px;
  }
  .wizard-footer {
    padding: 10px 16px 16px;
    flex-direction: column;
    gap: 8px;
  }
  .eq-cards {
    grid-template-columns: 1fr;
  }
  .step-title {
    font-size: 17px;
  }
}
</style>
