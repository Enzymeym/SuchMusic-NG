<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NSwitch, NSelect, NSlider, NAlert, NButton, NProgress, useMessage } from 'naive-ui'
import { useSettingsStore } from '../../../stores/settingsStore'
import { usePlayerStore } from '../../../stores/playerStore'
import { useVolumeBalanceStore } from '../../../stores/volumeBalanceStore'
import { useLocalMusicStore } from '../../../stores/localMusicStore'

// 使用设置仓库，驱动播放设置选项
const settingsStore = useSettingsStore()
const playerStore = usePlayerStore()
const volumeBalance = useVolumeBalanceStore()
const localMusicStore = useLocalMusicStore()
const message = useMessage()

// 过渡效果类型选项（两首歌之间统一为同时淡入淡出的交叉淡化）
const transitionTypeOptions = [
  { label: '智能过渡', value: 'smart' },
  { label: '交叉淡入淡出', value: 'crossfade' }
]

// 音量平衡：最大增益范围选项
const gainRangeOptions = [
  { label: '6 dB（温和）', value: 6 },
  { label: '12 dB（标准）', value: 12 },
  { label: '18 dB（激进）', value: 18 }
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

// 分析进度百分比
const analyzePercent = computed(() => {
  const total = volumeBalance.progress.total
  if (!total) return 0
  return Math.round((volumeBalance.progress.done / total) * 100)
})

// 需衰减最多的前 8 首（增益为负，升序）
const topAttenuated = computed(() => {
  const entries: { name: string; artist: string; gainDb: number }[] = []
  for (const song of localSongsWithPath.value) {
    const r = song.filePath ? volumeBalance.results[song.filePath] : undefined
    if (r && r.gainDb < 0) {
      entries.push({
        name: song.name || '',
        artist: song.ar?.[0]?.name || '',
        gainDb: r.gainDb
      })
    }
  }
  entries.sort((a, b) => a.gainDb - b.gainDb)
  return entries.slice(0, 8)
})

const startAnalyze = async () => {
  const result = await volumeBalance.analyzeLocalSongs(localSongsWithPath.value)
  if (!result) return
  if (result.canceled) {
    message.info(`已取消分析，完成 ${result.done} 首`)
  } else if (result.done > 0) {
    message.success(`分析完成：${result.done} 首成功${result.failed ? `，${result.failed} 首失败` : ''}`)
  }
}

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
            @update:value="playerStore.setTransitionEnabled($event)"
          />
          <span class="time-text">{{ playerStore.transitionEnabled ? '已启用' : '已关闭' }}</span>
        </div>
        <div v-if="playerStore.transitionEnabled" style="width: 100%">
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
      <div class="setting-row" style="flex-direction: column; align-items: flex-start; gap: 12px">
        <div class="setting-label">
          <div class="main-label">音量平衡（本地分析）</div>
          <div class="sub-label">
            基于 EBU R128 标准分析本地音乐响度（LUFS），播放时自动对响度过大的歌曲应用衰减增益，
            将每首歌平衡到目标响度，提升连续播放的听感一致性
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
          <n-switch
            v-model:value="volumeBalance.enabled"
            @update:value="volumeBalance.setEnabled($event)"
          />
          <span class="time-text">{{ volumeBalance.enabled ? '已启用' : '已关闭' }}</span>
        </div>
        <template v-if="volumeBalance.enabled">
          <div class="setting-row">
            <div class="setting-label">
              <div class="main-label">目标响度</div>
              <div class="sub-label">分析后的歌曲将被归一化到该响度（LUFS）</div>
            </div>
            <div style="display: flex; align-items: center; gap: 10px">
              <n-slider
                v-model:value="volumeBalance.targetLufs"
                :min="-23"
                :max="-11"
                :step="1"
                style="width: 180px"
                @update:value="volumeBalance.setTargetLufs($event)"
              />
              <span class="time-text" style="min-width: 62px; margin-right: 0">
                {{ volumeBalance.targetLufs }} LUFS
              </span>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-label">
              <div class="main-label">最大增益范围</div>
              <div class="sub-label">限制补偿幅度，避免对极安静歌曲过度放大</div>
            </div>
            <n-select
              v-model:value="volumeBalance.maxGainDb"
              :options="gainRangeOptions"
              style="width: 180px"
              @update:value="volumeBalance.setMaxGainDb($event)"
            />
          </div>

          <!-- 分析区域 -->
          <div class="volume-balance-analyze">
            <div class="time-text">已分析 {{ analyzedCount }} 首 / 共 {{ totalLocalCount }} 首</div>
            <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px">
              <n-button
                size="small"
                type="primary"
                :disabled="volumeBalance.analyzing || allAnalyzed || totalLocalCount === 0"
                @click="startAnalyze"
              >
                {{ volumeBalance.analyzing ? '分析中...' : allAnalyzed ? '已全部分析' : '开始分析' }}
              </n-button>
              <n-button v-if="volumeBalance.analyzing" size="small" @click="volumeBalance.cancel()">
                取消
              </n-button>
              <n-button
                size="small"
                :disabled="volumeBalance.analyzing || analyzedCount === 0"
                @click="volumeBalance.clearResults()"
              >
                清除结果
              </n-button>
            </div>
            <div v-if="volumeBalance.analyzing" style="margin-top: 10px">
              <n-progress
                type="line"
                :percentage="analyzePercent"
                :show-indicator="true"
                :height="6"
              />
              <div class="time-text" style="margin-top: 6px">
                {{ volumeBalance.progress.done }} / {{ volumeBalance.progress.total }} ·
                {{ volumeBalance.progress.currentName }}
              </div>
            </div>
          </div>

          <!-- 结果预览：需衰减最多的歌曲 -->
          <div v-if="topAttenuated.length" class="volume-balance-results">
            <div class="time-text" style="margin-bottom: 6px">需衰减最多的歌曲</div>
            <div class="volume-balance-result-list">
              <div
                v-for="(item, idx) in topAttenuated"
                :key="item.name + item.artist + idx"
                class="volume-balance-result-item"
              >
                <span class="volume-balance-result-name">
                  {{ item.name }}<template v-if="item.artist"> - {{ item.artist }}</template>
                </span>
                <span class="volume-balance-result-gain">{{ item.gainDb.toFixed(1) }} dB</span>
              </div>
            </div>
          </div>
        </template>
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

/* 音量平衡：结果预览列表 */
.volume-balance-results {
  width: 100%;
  margin-top: 4px;
}

.volume-balance-result-list {
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--settings-border-color, rgba(128, 128, 128, 0.2));
  border-radius: 8px;
  padding: 4px 8px;
}

.volume-balance-result-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  font-size: 12px;
}

.volume-balance-result-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--settings-subtext-color);
}

.volume-balance-result-gain {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  color: #d03050;
}
</style>
