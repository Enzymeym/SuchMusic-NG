<template>
  <div
    class="taskbar-control-container"
    :class="{ hovered: isHovered }"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <div class="drag-region"></div>

    <div
      class="content"
      :class="{ 'nowrap': true }"
      @mousedown="handleMouseDown"
      @mousemove="handleMouseMove"
      @mouseup="handleMouseUp"
    >
      <!-- 封面 -->
      <img
        v-if="showCover"
        class="cover"
        :src="info.cover || defaultCover"
        alt=""
        draggable="false"
      />

      <!-- 歌曲信息 / 悬停进度区（交叉淡入淡出） -->
      <div class="song-info">
        <div class="song-text" :class="{ hidden: isHovered }">
          <!-- 歌词切换上/下滑动动画：按当前歌词行索引 key，out-in 交叉过渡 -->
          <div class="lyric-clip">
            <Transition :name="slideDir === 'down' ? 'lyric-down' : 'lyric-up'" mode="out-in">
              <div :key="currentLineId" class="lyric-line">
                <div v-if="showTitle" class="title">
                  <!-- 有歌词：Apple Music 式逐字平滑渐变扫过 -->
                  <template v-if="currentLine && currentLine.words && currentLine.words.length">
                    <span
                      v-for="(w, wi) in currentLine.words"
                      :key="wi"
                      class="word"
                      :style="{ '--p': wordPercent(w) }"
                      >{{ w.word }}</span
                    >
                  </template>
                  <!-- 无歌词：回退显示歌名 -->
                  <span v-else>{{ info.title || '未在播放' }}</span>
                </div>
                <div v-if="showArtist" class="artist">{{ artistText }}</div>
              </div>
            </Transition>
          </div>
        </div>

        <div class="progress-wrap" :class="{ visible: isHovered }">
          <span class="time">{{ currentTimeText }}</span>
          <n-slider
            class="progress-slider"
            v-model:value="sliderValue"
            size="small"
            :min="0"
            :max="1"
            :step="0.0001"
            :tooltip="false"
            @update:value="onSeekUpdate"
            @dragstart="dragging = true"
            @dragend="dragging = false"
          />
          <span class="time">{{ totalTimeText }}</span>
        </div>
      </div>

      <!-- 控制按钮（悬停时淡入） -->
      <div class="controls" :class="{ visible: isHovered }">
        <button class="control-btn" title="上一曲" @click.stop="handleControl('prev')">
          <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
        </button>
        <button
          class="control-btn main-btn"
          :title="isPlaying ? '暂停' : '播放'"
          @click.stop="handleControl('toggle')"
        >
          <svg v-if="isPlaying" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
          <svg v-else viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        </button>
        <button class="control-btn" title="下一曲" @click.stop="handleControl('next')">
          <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" /></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { NSlider } from 'naive-ui'
import defaultCover from '@renderer/assets/default-cover.png'

const info = ref<{ title: string; artist: string; cover: string }>({
  title: '',
  artist: '',
  cover: ''
})
const isPlaying = ref(false)
const isHovered = ref(false)
const positionMs = ref(0)
const durationMs = ref(0)
const sliderValue = ref(0)
const dragging = ref(false)
const lyrics = ref<any[]>([])
const widthMode = ref<'auto' | 'custom'>('auto')

/** 平滑时钟：以最近一次同步的位置为基准，按播放状态逐帧推进，实现平滑逐字扫过 */
const clockNow = ref(0)
let lastTs = 0
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const showCover = ref(true)
const showTitle = ref(true)
const showArtist = ref(true)

/** 当前已播出时间 / 总时长文本 */
const formatMs = (ms: number): string => {
  if (!ms || ms < 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
const currentTimeText = computed(() => formatMs(positionMs.value))
const totalTimeText = computed(() => formatMs(durationMs.value))

/** 当前播放到的歌词行（按 startTime 就近取值，使用平滑时钟） */
const currentLine = computed<any | null>(() => {
  const t = clockNow.value
  let cur: any | null = null
  for (const line of lyrics.value) {
    if (line.startTime <= t) cur = line
    else break
  }
  return cur
})

/** 当前歌词行索引（用作歌词切换动画的 key，仅在索引变化时触发滑动） */
const currentLineId = computed(() => {
  const t = clockNow.value
  for (let i = lyrics.value.length - 1; i >= 0; i--) {
    if (lyrics.value[i].startTime <= t) return i
  }
  return -1
})

/** 歌词滑动方向：切到更旧的一行（回看/倒退）向下滑，否则向上滑 */
const slideDir = ref<'up' | 'down'>('up')

watch(currentLineId, (n, o) => {
  if (o !== undefined && o >= 0 && n >= 0) {
    slideDir.value = n < o ? 'down' : 'up'
  } else {
    slideDir.value = 'up'
  }
})

/** 单个字的演唱进度（0~1）：以该字的时间窗 [startTime, endTime] 平滑推进，并加速 */
const wordPercent = (w: any): number => {
  const s = w?.startTime ?? 0
  const e = w?.endTime ?? s
  const base = clamp01((clockNow.value - s) / Math.max(1, e - s))
  return clamp01(base * 1.6)
}

/** 歌手区域：优先显示当前行翻译；无翻译则显示「歌名 - 歌手」；无歌词时显示歌手 */
const artistText = computed(() => {
  if (currentLine.value) {
    return (
      (currentLine.value.translatedLyric || '').trim() ||
      (info.value.title && info.value.artist
        ? `${info.value.title} - ${info.value.artist}`
        : info.value.artist || ' ')
    )
  }
  return info.value.artist || ' '
})

const handleControl = (action: string) => {
  window.electron.ipcRenderer.send('taskbar-control:control', action)
}

/** 拖动进度条 → 通知主窗口 seek */
const onSeekUpdate = (val: number) => {
  if (!durationMs.value || durationMs.value <= 0) return
  const target = val * durationMs.value
  window.electron.ipcRenderer.send('taskbar-control:control', {
    action: 'seek',
    positionMs: target
  })
}

// 水平拖动（仅横向移动窗口）
let isDragging = false
let startX = 0
let rafId = 0

const handleMouseDown = (e: MouseEvent) => {
  const target = e.target as HTMLElement
  if (target.closest('.control-btn') || target.closest('.progress-wrap')) return
  isDragging = true
  startX = e.screenX
}

const handleMouseMove = (e: MouseEvent) => {
  if (!isDragging) return
  const deltaX = e.screenX - startX
  if (deltaX !== 0) {
    window.electron.ipcRenderer.send('taskbar-control:move', { x: deltaX, y: 0 })
    startX = e.screenX
  }
}

const handleMouseUp = () => {
  isDragging = false
}

onMounted(() => {
  // 透明背景
  const style = document.createElement('style')
  style.id = 'taskbar-control-style'
  style.innerHTML = `
    html, body, #app { background-color: transparent !important; overflow: hidden; }
    html[data-theme='dark'] body { background-color: transparent !important; }
  `
  document.head.appendChild(style)
  document.documentElement.removeAttribute('data-theme')

  window.electron.ipcRenderer.on('taskbar-control:set-info', (_, data: any) => {
    info.value = { title: '', artist: '', cover: '', ...(data || {}) }
    // 歌曲信息变更视为歌曲切换/更新，重置平滑时钟到当前位置，避免残留旧歌进度
    clockNow.value = positionMs.value
    lastTs = performance.now()
  })

  window.electron.ipcRenderer.on('taskbar-control:set-playing', (_, playing: boolean) => {
    isPlaying.value = playing
    // 从暂停切回播放时，仅当本地时钟落后于权威位置才对齐，避免把已推进的
    // 时钟强行拉回旧值（首次启动 play 信号与进度轮询交错时容易把歌词钉死）
    if (playing && Math.abs(clockNow.value - positionMs.value) > 1200) {
      clockNow.value = positionMs.value
      lastTs = performance.now()
    }
  })

  window.electron.ipcRenderer.on('taskbar-control:set-lyrics', (_, lines: any[]) => {
    lyrics.value = Array.isArray(lines) ? lines : []
    // 歌词切换后平滑时钟以当前进度为基准重新对齐
    clockNow.value = positionMs.value
    lastTs = performance.now()
  })

  window.electron.ipcRenderer.on(
    'taskbar-control:set-progress',
    (_, data: { positionMs: number; durationMs: number }) => {
      if (typeof data?.durationMs === 'number' && data.durationMs > 0) {
        durationMs.value = data.durationMs
      }
      if (typeof data?.positionMs === 'number') {
        const newPos = data.positionMs
        const prev = positionMs.value
        positionMs.value = newPos
        // 播放中本地 rAF 时钟以实际节拍自由推进；只有当进度出现明显跳变
        // （seek / 切歌 / 首次同步）时才重对齐基准，避免把正常推进的时钟拉回旧值
        // 导致歌词被"钉死"（卡死）。平滑推进（每 250ms 增量正常）则不干预。
        const drift = Math.abs(clockNow.value - newPos)
        const jump = Math.abs(newPos - prev) > 1200 || (prev > 0 && newPos < prev)
        if (!isPlaying.value || drift > 1500 || jump) {
          clockNow.value = newPos
          lastTs = performance.now()
        }
      }
      // 拖拽中不覆盖用户正在拖动的滑块位置
      if (!dragging.value && durationMs.value > 0) {
        sliderValue.value = Math.min(1, Math.max(0, positionMs.value / durationMs.value))
      }
    }
  )

  window.electron.ipcRenderer.on('taskbar-control:set-settings', (_, settings: any) => {
    if (settings.widthMode) widthMode.value = settings.widthMode
    if (typeof settings.showCover === 'boolean') showCover.value = settings.showCover
    if (typeof settings.showTitle === 'boolean') showTitle.value = settings.showTitle
    if (typeof settings.showArtist === 'boolean') showArtist.value = settings.showArtist
  })

  window.addEventListener('mousemove', handleMouseMove)
  window.addEventListener('mouseup', handleMouseUp)

  // 平滑时钟：仅在播放时逐帧推进 clockNow，让逐字渐变自然扫过。
  // 未播放时完全取消 rAF 循环，杜绝空闲时的 60fps 空转导致的卡顿/高占用。
  const tick = (ts: number) => {
    if (!isPlaying.value) {
      rafId = 0
      return
    }
    clockNow.value += ts - lastTs
    lastTs = ts
    rafId = requestAnimationFrame(tick)
  }

  const ensureClock = () => {
    // 播放中则保证循环在跑；暂停时若还在跑则立即停止，避免空转
    if (isPlaying.value) {
      if (!rafId) {
        lastTs = performance.now()
        rafId = requestAnimationFrame(tick)
      }
    } else if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  }

  // 播放状态变化驱动时钟启停：播放则启动逐帧推进，暂停/结束则停止（消除空闲空转）
  watch(isPlaying, () => ensureClock())

  ensureClock()

  window.electron.ipcRenderer.invoke('taskbar-control:ready')
})

onUnmounted(() => {
  cancelAnimationFrame(rafId)
  window.electron.ipcRenderer.removeAllListeners('taskbar-control:set-info')
  window.electron.ipcRenderer.removeAllListeners('taskbar-control:set-playing')
  window.electron.ipcRenderer.removeAllListeners('taskbar-control:set-lyrics')
  window.electron.ipcRenderer.removeAllListeners('taskbar-control:set-progress')
  window.electron.ipcRenderer.removeAllListeners('taskbar-control:set-settings')
  window.removeEventListener('mousemove', handleMouseMove)
  window.removeEventListener('mouseup', handleMouseUp)
})
</script>

<style scoped>
.taskbar-control-container {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0 10px;
  position: relative;
  user-select: none;
  background-color: transparent;
  border-radius: 8px;
  box-sizing: border-box;
  transition: background-color 0.35s ease;
}

/* 悬停时黑底淡入 */
.taskbar-control-container.hovered {
  background-color: rgba(20, 20, 20, 0.55);
}

.drag-region {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.content {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  white-space: nowrap;
  cursor: grab;
}

.content:active {
  cursor: grabbing;
}

.cover {
  width: 38px;
  height: 38px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
  pointer-events: none;
}

.song-info {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  line-height: 1.2;
}

/* 歌曲信息（默认可见，悬停时淡出） */
.song-text {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  justify-content: center;
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.song-text.hidden {
  opacity: 0;
  transform: translateY(-50%) scale(0.92);
  pointer-events: none;
}

/* 歌词切换动画：固定高度的裁剪窗口，滑动时上下内容被隐藏 */
.lyric-clip {
  height: 42px;
  overflow: hidden;
  display: flex;
  align-items: center;
}

.lyric-line {
  width: 100%;
}

/* 向上滑动（默认）：新行从下方进入，旧行向上离开 */
.lyric-up-enter-from {
  opacity: 0;
  transform: translateY(16px);
}
.lyric-up-enter-active {
  transition: transform 0.3s ease, opacity 0.3s ease;
}
.lyric-up-enter-to {
  opacity: 1;
  transform: translateY(0);
}
.lyric-up-leave-from {
  opacity: 1;
  transform: translateY(0);
}
.lyric-up-leave-active {
  transition: transform 0.22s ease, opacity 0.22s ease;
}
.lyric-up-leave-to {
  opacity: 0;
  transform: translateY(-14px);
}

/* 向下滑动（回看/倒退）：新行从上方滑入，旧行向下离开 */
.lyric-down-enter-from {
  opacity: 0;
  transform: translateY(-16px);
}
.lyric-down-enter-active {
  transition: transform 0.3s ease, opacity 0.3s ease;
}
.lyric-down-enter-to {
  opacity: 1;
  transform: translateY(0);
}
.lyric-down-leave-from {
  opacity: 1;
  transform: translateY(0);
}
.lyric-down-leave-active {
  transition: transform 0.22s ease, opacity 0.22s ease;
}
.lyric-down-leave-to {
  opacity: 0;
  transform: translateY(14px);
}

.title {
  font-size: 15px;
  font-weight: 600;
  color: #ffffff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 逐字左→右渐变扫过：唱过的部分按 --p 填充为白色，未唱部分保持较淡的白色过渡 */
.word {
  color: transparent;
  background-image: linear-gradient(
    90deg,
    #ffffff calc(var(--p, 0) * 100%),
    rgba(255, 255, 255, 0.6) calc(var(--p, 0) * 100%)
  );
  -webkit-background-clip: text;
  background-clip: text;
}

.artist {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.75);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 悬停进度区（默认隐藏，悬停时淡入） */
.progress-wrap {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease;
}

.progress-wrap.visible {
  opacity: 1;
  pointer-events: auto;
}

.time {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.85);
  min-width: 30px;
  text-align: center;
  flex-shrink: 0;
}

.progress-slider {
  flex: 1;
}

.progress-slider :deep(.n-slider-rail) {
  height: 3px;
  border-radius: 2px;
}

.progress-slider :deep(.n-slider-fill) {
  border-radius: 2px;
}

.progress-slider :deep(.n-slider-handle) {
  width: 12px;
  height: 12px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 4px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease;
}

.controls.visible {
  opacity: 1;
  pointer-events: auto;
}

.control-btn {
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.92);
  transition: all 0.15s;
  padding: 0;
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.28);
}

.control-btn.main-btn {
  background: rgba(255, 255, 255, 0.22);
}

.control-btn svg {
  width: 15px;
  height: 15px;
  fill: currentColor;
}
</style>