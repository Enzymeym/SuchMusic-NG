<template>
  <div 
    class="desktop-lyric-container" 
    :class="{ 'is-locked': isLocked }"
    :style="containerStyle"
  >
    <div class="drag-region"></div>
    <div class="content">
      <transition-group name="lyric-scroll" tag="div" class="lyric-wrapper">
        <div 
          v-if="currentLine" 
          :key="currentLine.startTime" 
          class="lyric-line current" 
          :style="currentLineStyle"
        >
          <div class="lyric-content">
            {{ currentLine.words.map(w => w.word).join('') }}
          </div>
          <div 
            v-if="currentLine.translatedLyric" 
            class="lyric-translation"
            :style="currentTranslationStyle"
          >
            {{ currentLine.translatedLyric }}
          </div>
        </div>
        <div 
          v-else-if="lyrics.length === 0" 
          key="placeholder" 
          class="lyric-line placeholder" 
          :style="currentLineStyle"
        >
          Wait for music...
        </div>
        
        <div 
          v-if="nextLine && showNextLine" 
          :key="nextLine.startTime" 
          class="lyric-line next" 
          :style="nextLineStyle"
        >
          <div class="lyric-content">
            {{ nextLine.words.map(w => w.word).join('') }}
          </div>
          <div 
            v-if="nextLine.translatedLyric" 
            class="lyric-translation"
            :style="nextTranslationStyle"
          >
            {{ nextLine.translatedLyric }}
          </div>
        </div>
      </transition-group>
    </div>

    <div class="controls">
      <div class="info-bar">
        <div class="song-title">{{ songInfo.title }}</div>
        <div class="song-artist">{{ songInfo.artist }}</div>
      </div>
      <div class="top-bar">
        <button class="control-btn" @click="handleControl('lock-toggle')" :title="isLocked ? 'Unlock' : 'Lock'">
          <svg v-if="isLocked" viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3 3.1-3 1.71 0 3.1 1.29 3.1 3v2z"/></svg>
          <svg v-else viewBox="0 0 24 24"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1v2h-1c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM8.9 6c0-1.71 1.39-3 3.1-3s3.1 1.29 3.1 3v2H8.9V6zM18 20H6V10h12v10z"/></svg>
        </button>
        <button class="control-btn" @click="handleControl('close')" title="Close">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      <div class="control-bar-wrapper">
        <div class="control-bar">
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
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { LyricLine } from '@applemusic-like-lyrics/lyric'

const lyrics = ref<LyricLine[]>([])
const currentTime = ref(0)
const currentIndex = ref(-1)

const songInfo = ref({
  title: '',
  artist: ''
})

// Settings
const fontSize = ref(24)
const fontColor = ref('#ffffff')
const highlightColor = ref('#18a058') // Naive UI primary green
const showNextLine = ref(true)
const opacity = ref(1.0)
const isPlaying = ref(false)
const align = ref<'left' | 'center' | 'right'>('center')
const fontFamily = ref('Microsoft YaHei UI')
const isLocked = ref(false)
const forceDuet = ref(false)

// IPC listeners
onMounted(() => {
  // Force transparent background via style injection to override global styles
  const style = document.createElement('style')
  style.id = 'desktop-lyric-style'
  style.innerHTML = `
    html, body, #app { background-color: transparent !important; }
    html[data-theme='dark'] body { background-color: transparent !important; }
  `
  document.head.appendChild(style)

  // Remove theme attribute to prevent global styles interference
  document.documentElement.removeAttribute('data-theme')

  window.electron.ipcRenderer.on('desktop-lyric:set-lyrics', (_, data: LyricLine[]) => {
    lyrics.value = data
    currentIndex.value = -1
  })

  window.electron.ipcRenderer.on('desktop-lyric:time-update', (_, time: number) => {
    currentTime.value = time * 1000 // Convert to ms if needed, assume input is seconds
    updateIndex()
  })

  window.electron.ipcRenderer.on('desktop-lyric:set-settings', (_, settings: any) => {
    if (settings.fontSize) fontSize.value = settings.fontSize
    if (settings.fontColor) fontColor.value = settings.fontColor
    if (settings.highlightColor) highlightColor.value = settings.highlightColor
    if (settings.showNextLine !== undefined) showNextLine.value = settings.showNextLine
    if (settings.opacity) opacity.value = settings.opacity
    if (settings.align) align.value = settings.align
    if (settings.font) fontFamily.value = settings.font
    if (settings.locked !== undefined) isLocked.value = settings.locked
    if (settings.forceDuet !== undefined) forceDuet.value = settings.forceDuet
  })
  
  window.electron.ipcRenderer.on('desktop-lyric:set-playing', (_, playing: boolean) => {
    isPlaying.value = playing
  })

  window.electron.ipcRenderer.on('desktop-lyric:set-info', (_, info: { title: string, artist: string }) => {
    songInfo.value = info
  })
  
  // Notify main process that we are ready to receive data
  window.electron.ipcRenderer.invoke('desktop-lyric:ready')

  // Set up drag events
  window.addEventListener('mousedown', handleMouseDown)
  window.addEventListener('mousemove', handleMouseMove)
  window.addEventListener('mouseup', handleMouseUp)
})

onUnmounted(() => {
  window.electron.ipcRenderer.removeAllListeners('desktop-lyric:set-lyrics')
  window.electron.ipcRenderer.removeAllListeners('desktop-lyric:time-update')
  window.electron.ipcRenderer.removeAllListeners('desktop-lyric:set-settings')
  window.electron.ipcRenderer.removeAllListeners('desktop-lyric:set-playing')
  window.electron.ipcRenderer.removeAllListeners('desktop-lyric:set-info')

  window.removeEventListener('mousedown', handleMouseDown)
  window.removeEventListener('mousemove', handleMouseMove)
  window.removeEventListener('mouseup', handleMouseUp)
})

// Custom Drag Logic
let isDragging = false
let startX = 0
let startY = 0

const handleMouseDown = (e: MouseEvent) => {
  // Ignore if locked
  if (isLocked.value) return
  
  // Ignore if clicking on buttons
  const target = e.target as HTMLElement
  if (target.closest('.control-btn') || target.closest('.no-drag')) return

  isDragging = true
  startX = e.screenX
  startY = e.screenY
}

const handleMouseMove = (e: MouseEvent) => {
  if (!isDragging) return
  
  const deltaX = e.screenX - startX
  const deltaY = e.screenY - startY
  
  if (deltaX !== 0 || deltaY !== 0) {
    window.electron.ipcRenderer.send('desktop-lyric:move', { x: deltaX, y: deltaY })
    startX = e.screenX
    startY = e.screenY
  }
}

const handleMouseUp = () => {
  isDragging = false
}

const updateIndex = () => {
  if (!lyrics.value.length) return
  
  // Find current line based on time
  // Simple search for now, can be optimized
  const time = currentTime.value
  let idx = lyrics.value.findIndex(line => line.startTime <= time && line.endTime >= time)
  
  if (idx === -1) {
    // If not in a specific range, find the last one that started
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

// Styles
const containerStyle = computed(() => ({
  opacity: opacity.value
}))

const currentLineStyle = computed(() => {
  // Check if force duet mode is enabled or if the line is explicitly marked as duet
  // In force duet mode: current line aligns left, next line aligns right (or vice versa based on index/bg status)
  // Let's implement a simple force duet: current line LEFT, next line RIGHT
  
  let alignStyle = ''
  let textAlign = ''
  
  if (forceDuet.value) {
    // Force Duet: Current line LEFT
    alignStyle = 'flex-start'
    textAlign = 'left'
  } else {
    // Standard logic
    const isDuet = currentLine.value?.isDuet
    if (isDuet && currentLine.value?.isBG) {
      alignStyle = 'flex-end'
      textAlign = 'right'
    } else {
      alignStyle = align.value === 'center' ? 'center' : align.value === 'right' ? 'flex-end' : 'flex-start'
      textAlign = align.value
    }
  }
    
  return {
    fontSize: `${fontSize.value}px`,
    color: highlightColor.value,
    fontWeight: 'bold',
    textShadow: '0 2px 4px rgba(0,0,0,0.5)',
    textAlign: textAlign as any,
    fontFamily: fontFamily.value,
    display: 'flex',
    flexDirection: 'column',
    alignItems: alignStyle,
    justifyContent: 'center',
    width: '100%',
    padding: '0 20px',
    boxSizing: 'border-box' as 'border-box'
  } as any
})

const currentTranslationStyle = computed(() => {
  let textAlign = ''
  if (forceDuet.value) {
    textAlign = 'left'
  } else {
    const isDuet = currentLine.value?.isDuet
    textAlign = (isDuet && currentLine.value?.isBG) ? 'right' : align.value
  }
  
  return {
    fontSize: `${fontSize.value * 0.6}px`,
    color: highlightColor.value,
    opacity: 0.8,
    marginTop: '4px',
    fontWeight: 'normal',
    fontFamily: fontFamily.value,
    textAlign: textAlign as any,
  }
})

const nextLineStyle = computed(() => {
  let alignStyle = ''
  let textAlign = ''
  
  if (forceDuet.value) {
    // Force Duet: Next line RIGHT
    alignStyle = 'flex-end'
    textAlign = 'right'
  } else {
    // Standard logic
    const isDuet = nextLine.value?.isDuet
    if (isDuet && nextLine.value?.isBG) {
      alignStyle = 'flex-end'
      textAlign = 'right'
    } else {
      alignStyle = align.value === 'center' ? 'center' : align.value === 'right' ? 'flex-end' : 'flex-start'
      textAlign = align.value
    }
  }

  return {
    fontSize: `${fontSize.value * 0.8}px`,
    color: fontColor.value,
    marginTop: '4px',
    opacity: 0.8,
    textShadow: '0 1px 2px rgba(0,0,0,0.5)',
    textAlign: textAlign as any,
    fontFamily: fontFamily.value,
    display: 'flex',
    flexDirection: 'column',
    alignItems: alignStyle,
    justifyContent: 'center',
    width: '100%',
    padding: '0 20px',
    boxSizing: 'border-box' as 'border-box'
  } as any
})

const nextTranslationStyle = computed(() => {
  let textAlign = ''
  if (forceDuet.value) {
    textAlign = 'right'
  } else {
    const isDuet = nextLine.value?.isDuet
    textAlign = (isDuet && nextLine.value?.isBG) ? 'right' : align.value
  }
  
  return {
    fontSize: `${fontSize.value * 0.5}px`,
    color: fontColor.value,
    opacity: 0.6,
    marginTop: '2px',
    fontWeight: 'normal',
    fontFamily: fontFamily.value,
    textAlign: textAlign as any,
  }
})

const handleControl = (action: string) => {
  if (action === 'close') {
    window.electron.ipcRenderer.invoke('desktop-lyric:close')
  } else if (action === 'lock-toggle') {
    window.electron.ipcRenderer.send('desktop-lyric:control', 'toggle-lock')
    // Optimistically update local state for immediate feedback
    isLocked.value = !isLocked.value
  } else if (action === 'toggle') {
    // Explicitly handle toggle to ensure immediate UI update
    // But still send command to main process
    window.electron.ipcRenderer.send('desktop-lyric:control', 'toggle')
    // Don't optimistically update isPlaying because it relies on player state which comes back via IPC
  } else {
    window.electron.ipcRenderer.send('desktop-lyric:control', action)
  }
}
</script>

<style scoped>
.desktop-lyric-container {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background-color: transparent; /* Changed from transparent to a tiny bit of opacity to capture hover events */
  background-color: rgba(0, 0, 0, 0.01); 
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  user-select: none;
  transition: background-color 0.3s;
  /* Make the whole container draggable by default */
  /* -webkit-app-region: drag; */ /* Disabled CSS drag to allow hover events */
}

/* When locked, no drag allowed */
.desktop-lyric-container.is-locked {
  /* -webkit-app-region: no-drag; */
  /* Visual cue that it's locked when hovered (though background change still happens) */
}

.content {
  position: relative;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 20px;
  pointer-events: none; /* Let clicks pass through to drag region */
  width: 100%;
}

.controls {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none; 
  z-index: 30;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 10px;
  opacity: 0;
  transition: opacity 0.3s;
  /* Controls container itself shouldn't block drag, but its children might need no-drag */
  /* -webkit-app-region: drag; */ /* Disabled CSS drag to allow hover events */
}

/* 
   We use a separate ::before element for the gradient mask to ensure it only appears on hover
   and doesn't interfere with the layout.
*/
.desktop-lyric-container::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 60px; /* Adjust height to cover title/controls area */
  background: linear-gradient(to bottom, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 100%);
  opacity: 0;
  transition: opacity 0.3s;
  pointer-events: none;
  z-index: 25; /* Between content (20) and controls (30) */
  border-top-left-radius: 12px;
  border-top-right-radius: 12px;
}

/* 
  Make the entire top area (title, controls) trigger the hover effect 
  by ensuring the container captures mouse events even if background is transparent 
*/
.desktop-lyric-container {
  /* ... existing styles ... */
  /* Ensure mouse events are captured */
  pointer-events: auto;
}

.desktop-lyric-container:hover::before {
  opacity: 1;
}

.desktop-lyric-container:hover {
  background-color: rgba(0, 0, 0, 0.562);
  border-radius: 12px;
}

.desktop-lyric-container:hover .controls {
  opacity: 1;
}

/* Ensure buttons are clickable and NOT draggable */
.control-bar {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  z-index: 100; /* Ensure controls are on top */
}

.control-bar-wrapper {
  position: absolute;
  top: 10px;
  left: 0;
  width: 100%;
  display: flex;
  justify-content: center;
  pointer-events: none;
  z-index: 100;
}

.top-bar {
  position: absolute;
  top: 10px;
  right: 10px;
  gap: 8px;
  display: flex;
  justify-content: flex-end;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  z-index: 100;
}

.info-bar {
  position: absolute;
  top: 10px;
  left: 14px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  pointer-events: none;
  text-align: left;
  max-width: 40%;
}

.song-title {
  font-size: 14px;
  font-weight: bold;
  color: rgba(255, 255, 255, 0.95);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
}

.song-artist {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
}

.lock-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 8px;
  color: rgba(255, 255, 255, 0.6);
}

.lock-indicator svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.control-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 50%;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.9);
  transition: all 0.2s;
  backdrop-filter: blur(4px);
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.25);
  transform: scale(1.1);
}

.control-btn:active {
  transform: scale(0.95);
}

.control-btn svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.control-btn.main-btn {
  width: 40px;
  height: 40px;
  background: rgba(255, 255, 255, 0.2);
}

.control-btn.main-btn svg {
  width: 20px;
  height: 20px;
}

.lyric-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  position: relative;
  height: 120px; /* Base height */
  justify-content: center;
  transition: height 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
}

.desktop-lyric-container:hover .lyric-wrapper {
  /* When controls are visible (on hover), lyrics might need to shrink or stay same */
  height: 120px;
}

/* When NOT hovering (controls hidden), expand lyrics area to fill more space */
.desktop-lyric-container:not(:hover) .lyric-wrapper {
  height: 140px; /* Expand slightly to use the space left by hidden controls */
}

.lyric-line {
  white-space: pre-wrap;
  transition: all 0.5s cubic-bezier(0.25, 0.8, 0.25, 1);
  position: absolute; /* Absolute positioning for smooth transitions */
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
}

/* 
  Transition Logic:
  - Current line moves up and fades out/shrinks
  - Next line moves up and becomes current
  - New next line appears from bottom
*/

/* Elements entering (new next line) */
.lyric-scroll-enter-from {
  opacity: 0;
  transform: translateY(20px);
}

/* Elements leaving (old current line) */
.lyric-scroll-leave-to {
  opacity: 0;
  transform: translateY(-20px) scale(0.9);
}

/* Active state for smooth movement */
.lyric-scroll-enter-active,
.lyric-scroll-leave-active,
.lyric-scroll-move {
  transition: all 0.5s cubic-bezier(0.25, 0.8, 0.25, 1);
}

/* Ensure leaving items are taken out of flow correctly if needed, 
   but with absolute positioning they overlap naturally */
.lyric-scroll-leave-active {
  position: absolute;
}

/* Specific positioning overrides based on class (handled by Vue transition classes mostly) */
.lyric-line.current {
  top: 25%; /* Adjust vertical center */
  transition: top 0.3s cubic-bezier(0.25, 0.8, 0.25, 1), opacity 0.5s, transform 0.5s;
}

/* Adjust position when container is not hovered (controls hidden) */
.desktop-lyric-container:not(:hover) .lyric-line.current {
  top: 30%; /* Move down slightly to center in the expanded area */
}

.lyric-line.next {
  top: 70%; /* Adjust vertical position */
  transition: top 0.3s cubic-bezier(0.25, 0.8, 0.25, 1), opacity 0.5s, transform 0.5s;
}

/* Adjust position when container is not hovered (controls hidden) */
.desktop-lyric-container:not(:hover) .lyric-line.next {
  top: 75%; /* Move down slightly */
}

.lyric-line.placeholder {
  top: 40%;
  transition: top 0.3s cubic-bezier(0.25, 0.8, 0.25, 1), opacity 0.5s, transform 0.5s;
}

.desktop-lyric-container:not(:hover) .lyric-line.placeholder {
  top: 45%;
}
</style>
