<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NSwitch, NSelect, NSlider, NAlert } from 'naive-ui'
import { useSettingsStore } from '../../../stores/settingsStore'
import { usePlayerStore } from '../../../stores/playerStore'
import { useVolumeBalanceStore } from '../../../stores/volumeBalanceStore'
import { useLocalMusicStore } from '../../../stores/localMusicStore'
import { isWebAudioMode } from '../../../utils/audioOutputModeManager'

// 使用设置仓库，驱动播放设置选项
const settingsStore = useSettingsStore()
const playerStore = usePlayerStore()
const volumeBalance = useVolumeBalanceStore()
const localMusicStore = useLocalMusicStore()

/**
 * 智能过渡是否可用：仅 Web Audio 输出支持。
 * WASAPI 输出没有双音源交叉淡化能力，切歌一律硬切，因此这里禁用开关并给出说明，
 * 避免用户开了开关却完全听不到过渡（也避免误以为功能失效）。
 */
const transitionAvailable = computed(() => isWebAudioMode())

// 过渡效果类型选项（两首歌之间统一为同时淡入淡出的交叉淡化）
const transitionTypeOptions = [
  { label: '智能过渡', value: 'smart' },
  { label: '交叉淡入淡出', value: 'crossfade' }
]

// 淡变曲线选项
const curveOptions = [
  { label: '等功率（推荐）', value: 'equalPower' },
  { label: '线性', value: 'linear' }
]

// 本地歌曲（含有效本地文件路径，排除在线 URL）
const localSongsWithPath = computed(() =>
  localMusicStore.songs.filter((s) => s.filePath && !/^https?:\/\//.test(s.filePath))
)
const totalLocalCount = computed(() => localSongsWithPath.value.length)
const analyzedCount = computed(
  () => localSongsWithPath.value.filter((s) => s.filePath && volumeBalance.results[s.filePath]).length
)
const allAnalyzed = computed(
  () => totalLocalCount.value > 0 && analyzedCount.value >= totalLocalCount.value
)

/**
 * 后台分析状态文案：音量平衡已改为全自动（新增歌曲与历史未分析歌曲都由后台补齐），
 * 因此这里只作为进度提示，不再提供任何手动操作入口。
 */
const analyzeStatus = computed(() => {
  if (volumeBalance.analyzing) {
    const { done, total } = volumeBalance.progress
    return `后台分析中 ${done} / ${total} 首，不影响正常播放`
  }
  if (totalLocalCount.value === 0) return '音乐库暂无本地歌曲'
  if (allAnalyzed.value) return `已分析全部 ${totalLocalCount.value} 首`
  return `已分析 ${analyzedCount.value} / ${totalLocalCount.value} 首，剩余歌曲会在后台自动分析`
})

// 当前输出模式是否支持完整智能过渡（仅 Web Audio 支持交叉淡化/智能过渡）
const isFullTransitionSupported = computed(
  () => settingsStore.playback.audioOutputMode === 'webaudio'
)

const props = defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  // 当前高亮的设置项 key
  highlightKey?: string | null
}>()
</script>

<template>
  <div class="settings-content">
    <div class="section-group-title">Morphaeum</div>

    <!-- Morphaeum 功能说明 -->
    <n-card
      class="setting-item morphaeum-intro"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="morphaeum-intro-desc">
        <p>Morphaeum 是 Such Music 高级实验项目，探索前沿音频处理技术，提升播放体验。</p>
      </div>
    </n-card>

    <div class="section-group-title">智能过渡</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'morphaeum.transition' }"
      data-setting-key="morphaeum.transition"
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
          <div class="sub-label">
            Morph
            引擎在歌曲播放到尾声时实时分析音频波形，自动寻找最佳过渡点，实现两首歌之间近乎无缝的衔接，提升连续播放体验
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
          <n-switch
            v-model:value="playerStore.transitionEnabled"
            :disabled="!transitionAvailable"
            @update:value="playerStore.setTransitionEnabled($event)"
          />
          <span class="time-text">
            {{ !transitionAvailable ? '不支持' : playerStore.transitionEnabled ? '已启用' : '已关闭' }}
          </span>
        </div>
        <n-alert v-if="!transitionAvailable" type="info" :bordered="false" style="width: 100%">
          当前为 WASAPI 输出模式，音频引擎不支持双音源交叉淡化，切歌会直接硬切。
          如需智能过渡，请在「播放设置 → 音频输出模式」中切换为 Web Audio。
        </n-alert>
        <div v-if="transitionAvailable && playerStore.transitionEnabled" style="width: 100%">
          <div class="setting-row">
            <div class="setting-label">
              <div class="main-label">过渡效果</div>
              <div class="sub-label">两首歌曲之间同时淡入和淡出（交叉淡化）</div>
            </div>
            <n-select
              v-model:value="playerStore.transitionType"
              :options="transitionTypeOptions"
              style="width: 180px"
              @update:value="playerStore.setTransitionType($event)"
            />
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <div class="main-label">过渡时长</div>
              <div class="sub-label">两首歌交叉淡化的重合时长，越长衔接越舒缓</div>
            </div>
            <div style="display: flex; align-items: center; gap: 10px">
              <n-slider
                :value="playerStore.transitionDuration"
                :min="1000"
                :max="8000"
                :step="500"
                style="width: 180px"
                @update:value="playerStore.setTransitionDuration($event)"
              />
              <span class="time-text" style="min-width: 46px; margin-right: 0">
                {{ (playerStore.transitionDuration / 1000).toFixed(1) }}s
              </span>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <div class="main-label">淡变曲线</div>
              <div class="sub-label">
                等功率曲线保持过渡期音量恒定，消除线性曲线在中段的音量凹陷
              </div>
            </div>
            <n-select
              v-model:value="playerStore.transitionCurve"
              :options="curveOptions"
              style="width: 180px"
              @update:value="playerStore.setTransitionCurve($event)"
            />
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <div class="main-label">节奏与乐句对齐</div>
              <div class="sub-label">
                把过渡点吸附到歌曲的小节 / 乐句重拍，使两首歌节拍对齐、切入点更准
              </div>
            </div>
            <n-switch
              v-model:value="playerStore.transitionBeatAlign"
              @update:value="playerStore.setTransitionBeatAlign($event)"
            />
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <div class="main-label">低频避让（bass swap）</div>
              <div class="sub-label">
                过渡时先撤出当前曲低频、再引入下一曲低频，避免两首歌低频叠加浑浊
              </div>
            </div>
            <n-switch
              v-model:value="playerStore.transitionBassSwap"
              @update:value="playerStore.setTransitionBassSwap($event)"
            />
          </div>

          <!-- WASAPI 模式限制提示 -->
          <n-alert v-if="!isFullTransitionSupported" type="info" style="margin-top: 12px">
            当前为 Windows 音频会话 API 输出模式，智能过渡将使用顺序淡入淡出
            （先淡出当前曲，再淡入下一曲）。完整的「智能过渡 / 交叉淡化」效果需切换到
            <strong>Web Audio</strong> 模式。
          </n-alert>
        </div>
      </div>
    </n-card>

    <div class="section-group-title">音量平衡</div>

    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'morphaeum.volumeBalance' }"
      data-setting-key="morphaeum.volumeBalance"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">音量平衡</div>
          <div class="sub-label">
            基于 EBU R128 在后台自动分析本地音乐响度，播放时对响度过大的歌曲自动衰减，
            让连续播放的音量更一致。打开后无需手动操作，新增歌曲会自动加入分析队列。
          </div>
        </div>
        <n-switch
          v-model:value="volumeBalance.enabled"
          @update:value="volumeBalance.setEnabled($event)"
        />
      </div>
      <div v-if="volumeBalance.enabled" class="volume-balance-status time-text">
        {{ analyzeStatus }}
      </div>
    </n-card>
  </div>
</template>

<style lang="scss" scoped>
/* Morphaeum 介绍卡片 */
.morphaeum-intro {
  margin-bottom: 16px;
}

.morphaeum-intro-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.morphaeum-intro-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: linear-gradient(135deg, rgba(88, 86, 214, 0.15), rgba(230, 55, 87, 0.15));
  color: var(--settings-section-primary-color);
  font-size: 16px;
}

.morphaeum-intro-title {
  font-size: 14px;
  font-weight: 600;
}

.morphaeum-intro-desc {
  font-size: 12px;
  line-height: 1.7;
  color: var(--settings-subtext-color);
  margin: 0;
}

.morphaeum-intro-desc p {
  margin: 0 0 6px;
}

.morphaeum-intro-desc p:last-child {
  margin-bottom: 0;
}

.morphaeum-intro-tip {
  opacity: 0.75;
}

/* 音量平衡：后台分析进度提示（只读文案，不提供操作） */
.volume-balance-status {
  margin-top: 8px;
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}
</style>
