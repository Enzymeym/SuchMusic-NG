<template>
  <div 
    class="taskbar-lyric-container" 
    :style="containerStyle"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <div class="drag-region"></div>
    
    <div class="content" :class="{ 'is-hovering': isHovering }">
      <div v-if="currentLine" class="lyric-line current" :style="currentLineStyle">
        {{ currentLine.words.map(w => w.word).join('') }}
      </div>
      <div v-else-if="lyrics.length === 0" class="lyric-line placeholder" :style="currentLineStyle">
        Wait for music...
      </div>
      
      <div v-if="nextLine && showNextLine" class="lyric-line next" :style="nextLineStyle">
        {{ nextLine.words.map(w => w.word).join('') }}
      </div>
    </div>

    <!-- Controls (Only visible on hover) -->
    <div class="controls" :class="{ 'visible': isHovering }">
      <button class="control-btn" @click="handleControl('prev')" title="Previous">
        <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
      </button>
      <button class="control-btn main-btn" @click="handleControl('toggle')" :title="isPlaying ? 'Pause' : 'Play'">
        <svg v-if="isPlaying" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        <svg v-else viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <button class="control-btn" @click="handleControl('next')" title="Next">
        <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
      </button>
      <button class="control-btn" @click="handleControl('close')" title="Close">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { LyricLine } from '@applemusic-like-lyrics/lyric'

const lyrics = ref<LyricLine[]>([])
const currentTime = ref(0)
const currentIndex = ref(-1)
const isHovering = ref(false)
const isPlaying = ref(false)

// Settings
const fontSize = ref(16)
const fontColor = ref('#ffffff')
const highlightColor = ref('#18a058')
const showNextLine = ref(false) // Default single line for taskbar
const fontFamily = ref('Microsoft YaHei UI')

// Styles
const containerStyle = computed(() => ({
  fontFamily: fontFamily.value
}))

const currentLineStyle = computed(() => ({
  fontSize: `${fontSize.value}px`,
  color: highlightColor.value,
  fontWeight: 'bold',
  textShadow: '0 1px 2px rgba(0,0,0,0.8)'
}))

const nextLineStyle = computed(() => ({
  fontSize: `${fontSize.value * 0.9}px`,
  color: fontColor.value,
  opacity: 0.8,
  textShadow: '0 1px 2px rgba(0,0,0,0.8)'
}))

const currentLine = computed(() => {
  if (currentIndex.value === -1 || !lyrics.value.length) return null
  return lyrics.value[currentIndex.value]
})

const nextLine = computed(() => {
  if (currentIndex.value === -1 || !lyrics.value.length) return null
  if (currentIndex.value + 1 < lyrics.value.length) {
    return lyrics.value[currentIndex.value + 1]
  }
  return null
})

const updateIndex = () => {
  if (!lyrics.value.length) return
  const time = currentTime.value
  let idx = lyrics.value.findIndex(line => line.startTime <= time && line.endTime >= time)
  
  if (idx === -1) {
    for (let i = lyrics.value.length - 1; i >= 0; i--) {
      if (lyrics.value[i].startTime <= time) {
        idx = i
        break
      }
    }
  }
  
  if (idx !== -1) {
    currentIndex.value = idx
  }
}

// Event Handlers
const handleMouseEnter = () => {
  isHovering.value = true
  // window.electron.ipcRenderer.send('taskbar-lyric:hover', true)
}

const handleMouseLeave = () => {
  isHovering.value = false
  // window.electron.ipcRenderer.send('taskbar-lyric:hover', false)
}

const handleControl = (action: string) => {
  if (action === 'close') {
    window.electron.ipcRenderer.invoke('taskbar-lyric:close')
  } else {
    window.electron.ipcRenderer.send('taskbar-lyric:control', action)
  }
}

// Custom Drag Logic (Horizontal only)
let isDragging = false
let startX = 0

const handleMouseDown = (e: MouseEvent) => {
  const target = e.target as HTMLElement
  if (target.closest('.control-btn')) return

  isDragging = true
  startX = e.screenX
}

const handleMouseMove = (e: MouseEvent) => {
  if (!isDragging) return
  
  const deltaX = e.screenX - startX
  if (deltaX !== 0) {
    window.electron.ipcRenderer.send('taskbar-lyric:move', { x: deltaX, y: 0 })
    startX = e.screenX
  }
}

const handleMouseUp = () => {
  isDragging = false
}

// Lifecycle
onMounted(() => {
  // Transparent background
  const style = document.createElement('style')
  style.id = 'taskbar-lyric-style'
  style.innerHTML = `
    html, body, #app { background-color: transparent !important; overflow: hidden; }
    html[data-theme='dark'] body { background-color: transparent !important; }
  `
  document.head.appendChild(style)
  document.documentElement.removeAttribute('data-theme')

  // Listeners
  window.electron.ipcRenderer.on('taskbar-lyric:set-lyrics', (_, data: LyricLine[]) => {
    lyrics.value = data
    currentIndex.value = -1
  })

  window.electron.ipcRenderer.on('taskbar-lyric:time-update', (_, time: number) => {
    currentTime.value = time * 1000
    updateIndex()
  })

  window.electron.ipcRenderer.on('taskbar-lyric:set-playing', (_, playing: boolean) => {
    isPlaying.value = playing
  })
  
  window.electron.ipcRenderer.on('taskbar-lyric:set-settings', (_, settings: any) => {
    if (settings.fontSize) fontSize.value = settings.fontSize
    if (settings.fontColor) fontColor.value = settings.fontColor
    if (settings.highlightColor) highlightColor.value = settings.highlightColor
    if (settings.font) fontFamily.value = settings.font
  })

  window.addEventListener('mousedown', handleMouseDown)
  window.addEventListener('mousemove', handleMouseMove)
  window.addEventListener('mouseup', handleMouseUp)
  
  // Ready
  window.electron.ipcRenderer.invoke('taskbar-lyric:ready')
})

onUnmounted(() => {
  window.electron.ipcRenderer.removeAllListeners('taskbar-lyric:set-lyrics')
  window.electron.ipcRenderer.removeAllListeners('taskbar-lyric:time-update')
  window.electron.ipcRenderer.removeAllListeners('taskbar-lyric:set-playing')
  window.electron.ipcRenderer.removeAllListeners('taskbar-lyric:set-settings')
  
  window.removeEventListener('mousedown', handleMouseDown)
  window.removeEventListener('mousemove', handleMouseMove)
  window.removeEventListener('mouseup', handleMouseUp)
})
</script>

<style scoped>
.taskbar-lyric-container {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: flex-start; /* Align left as per requirement */
  padding-left: 10px;
  position: relative;
  user-select: none;
  background-color: rgba(0, 0, 0, 0.01); /* Hit target */
  transition: background-color 0.2s;
}

.taskbar-lyric-container:hover {
  background-color: rgba(0, 0, 0, 0.3); /* Semi-transparent bg on hover */
}

.content {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  white-space: nowrap;
  overflow: hidden;
  width: 100%;
  pointer-events: none;
}

.lyric-line {
  transition: all 0.2s;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.controls {
  position: absolute;
  right: 10px;
  display: flex;
  gap: 8px;
  opacity: 0;
  transition: opacity 0.2s;
  pointer-events: auto;
}

.controls.visible {
  opacity: 1;
}

.control-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.9);
  transition: all 0.2s;
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.3);
}

.control-btn svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
}
</style>