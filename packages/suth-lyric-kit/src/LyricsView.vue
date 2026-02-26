<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import type { ParsedLyrics, LyricWord } from './parser'

const props = withDefaults(
  defineProps<{
    lyrics: ParsedLyrics | null
    currentTime: number
    fontSize?: number
    lineGap?: number
    letterSpacing?: number
    enableBlur?: boolean
    enableSpring?: boolean
    activeColor?: string
  }>(),
  {
    fontSize: 26,
    lineGap: 24,
    letterSpacing: 0,
    enableBlur: true,
    enableSpring: true,
    activeColor: '#ffffff'
  }
)

const emit = defineEmits<{
  (e: 'seek', time: number): void
}>()

// Smooth time system
const smoothTime = ref(props.currentTime)
let lastSysTime = 0
let timeRafId = 0

const updateSmoothTime = () => {
  const now = performance.now()
  const delta = (now - lastSysTime) / 1000

  // Interpolate only if the gap is reasonable (playing)
  // If delta > 0.5s, assume paused or lag, snap to props to avoid runaway
  if (delta < 0.5) {
    smoothTime.value = props.currentTime + delta
  } else {
    smoothTime.value = props.currentTime
  }

  timeRafId = requestAnimationFrame(updateSmoothTime)
}

onMounted(() => {
  lastSysTime = performance.now()
  timeRafId = requestAnimationFrame(updateSmoothTime)
})

onUnmounted(() => {
  cancelAnimationFrame(timeRafId)
})

// Sync base time
watch(
  () => props.currentTime,
  (newVal) => {
    lastSysTime = performance.now()
    // Correction: if smoothTime drifted too far (seek), snap it
    if (Math.abs(smoothTime.value - newVal) > 0.1) {
      smoothTime.value = newVal
    }
  }
)

const targetScrollTop = ref(0)
const containerRef = ref<HTMLElement | null>(null)
const activeIndex = ref(-1)
const lineTranslateYs = ref<number[]>([])
const lineVelocities = ref<number[]>([])
const lineScales = ref<number[]>([]) // New state for smoothing scale
let animationFrameId: number | null = null
const isUserScrolling = ref(false)
const isSnapping = ref(false) // Flag for snap transition

const validLines = computed(() => {
  if (!props.lyrics) return []
  return props.lyrics.lines.filter((line) => {
    const hasText = line.text && line.text.trim().length > 0
    const hasWords = line.words && line.words.length > 0
    return hasText || hasWords
  })
})

// Find active line efficiently
watch(
  () => props.currentTime,
  (newTime) => {
    if (!props.lyrics) return

    // Simple linear search optimized for forward playback
    const lines = validLines.value
    let index = -1

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line && newTime >= line.time) {
        index = i
      } else {
        break
      }
    }

    if (index !== activeIndex.value) {
      const prevIndex = activeIndex.value
      activeIndex.value = index
      if (!isUserScrolling.value) {
        // If jump is large (> 2 lines) or initial load, snap immediately to avoid slow spring travel
        const shouldSnap = prevIndex === -1 || Math.abs(index - prevIndex) > 2

        if (shouldSnap && prevIndex !== -1) {
          // Trigger fade out -> snap -> fade in sequence
          isSnapping.value = true

          // Brief delay to let fade-out happen visually if we wanted, but for instant response we snap logic immediately
          // and let CSS handle the opacity transition.
          // Actually, to make it look like "Fade Out -> Move -> Fade In", we need a sequence.
          // But doing it purely async might delay lyrics update.
          // Better approach: Set flag, let CSS hide content, update position, then unset flag.

          // Since we want instant update of position but visual fade effect:
          // 1. Set isSnapping = true (CSS adds opacity 0, blur 10px)
          // 2. Update scroll position immediately (in scrollToActive)
          // 3. Wait a small frame, then set isSnapping = false (CSS transitions back to normal)

          scrollToActive(true)

          // Use a double RAF or small timeout to ensure DOM painted the "hidden" state with new position
          // before revealing it again.
          setTimeout(() => {
            isSnapping.value = false
          }, 100)
        } else {
          scrollToActive(shouldSnap)
        }
      }
      startSpringAnimation()
    }
  }
)

watch(
  validLines,
  (lines) => {
    if (lines.length > 0) {
      lineTranslateYs.value = lines.map(() => 0)
      lineVelocities.value = lines.map(() => 0)
      targetScrollTop.value = 0
    } else {
      lineTranslateYs.value = []
      lineVelocities.value = []
    }
  },
  { immediate: true }
)

const scrollToActive = (snap = false) => {
  if (!containerRef.value || activeIndex.value === -1) return

  const activeEl = containerRef.value.children[activeIndex.value] as HTMLElement
  if (activeEl) {
    const container = containerRef.value
    const containerHeight = container.clientHeight
    const elementTop = activeEl.offsetTop
    const elementHeight = activeEl.clientHeight

    // Calculate the scroll position needed to position this element at 20% height
    // containerHeight * 0.2 is the visual top position we want for the active line center
    // However, since we are moving the WHOLE container via translateY on each line relative to its flow position,
    // we actually just want to shift everything so the active line is at the target position.

    // Current approach: We calculate a single global targetScrollTop, but we apply it via independent springs.
    // To ensure consistent spacing, all lines must eventually settle to exactly `element.offsetTop - targetScrollTop`.
    // If we use the same targetScrollTop for everyone, their relative positions (determined by CSS layout flow) remain intact.

    const targetScroll = elementTop - containerHeight * 0.2 + elementHeight / 2

    // Update target for all lines
    targetScrollTop.value = targetScroll

    if (snap && validLines.value) {
      lineTranslateYs.value = validLines.value.map(() => targetScroll)
      lineVelocities.value = validLines.value.map(() => 0)
    }

    startSpringAnimation()
  }
}

let userScrollTimeout: ReturnType<typeof setTimeout> | null = null

const handleWheel = (e: WheelEvent) => {
  if (!containerRef.value) return

  // Set flag to pause auto-scrolling
  isUserScrolling.value = true

  // Update scroll target based on wheel delta
  // Clamp to prevent scrolling too far (basic limits)
  // Max scroll: approximately total height (we can refine this if needed)
  const maxScroll = containerRef.value.scrollHeight - containerRef.value.clientHeight / 2
  const newScroll = targetScrollTop.value + e.deltaY

  targetScrollTop.value = Math.max(0, Math.min(newScroll, maxScroll))

  // Start animation to smooth out the wheel input
  startSpringAnimation()

  // Reset timer
  if (userScrollTimeout) {
    clearTimeout(userScrollTimeout)
  }

  // Resume auto-scroll after 3 seconds of inactivity
  userScrollTimeout = setTimeout(() => {
    isUserScrolling.value = false
    // Trigger animation to restore scales (active line scale up)
    startSpringAnimation()
    // Do not force scroll back immediately.
    // Wait for the next active line update to trigger scrollToActive naturally.
  }, 3000)
}

// 监听 isSnapping 变化，用于控制容器的整体透明度和模糊
// 我们将通过修改 lyrics-scroll 的样式来实现，或者给它加个 class

// 为每一行计算弹簧位置：新激活行会“带动”上下行逐个到位
const startSpringAnimation = () => {
  const lines = validLines.value
  if (!lines.length) return

  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }

  // Ensure arrays are initialized
  if (lineTranslateYs.value.length !== lines.length) {
    // Initialize with current target to avoid jump on first load
    lineTranslateYs.value = lines.map(() => targetScrollTop.value)
  }
  if (lineVelocities.value.length !== lines.length) {
    lineVelocities.value = lines.map(() => 0)
  }
  // Initialize scales if needed
  if (lineScales.value.length !== lines.length) {
    lineScales.value = lines.map((_, i) => (i === activeIndex.value ? 1.05 : 1))
  }

  const animate = () => {
    // If user is scrolling, disable smooth spring physics and update immediately
    if (isUserScrolling.value) {
      const target = targetScrollTop.value
      lineTranslateYs.value = lines.map(() => target)
      lineVelocities.value = lines.map(() => 0)
      // Reset scales to 1.0 for cleaner view during scroll
      lineScales.value = lines.map(() => 1.0)
      animationFrameId = null
      return
    }

    let stillAnimating = false
    const currentYs = [...lineTranslateYs.value]
    const velocities = [...lineVelocities.value]
    const currentScales = [...lineScales.value]
    const target = targetScrollTop.value

    for (let i = 0; i < lines.length; i++) {
      // 1. Position Spring Logic
      let displacement = 0
      const currentY = currentYs[i] ?? 0

      if (!props.enableSpring) {
        // Instant snap if spring is disabled
        currentYs[i] = target
        velocities[i] = 0
        displacement = 0
      } else {
        // Different spring parameters based on distance from active line
        const distance = i - activeIndex.value // Signed distance: negative = past (above), positive = future (below)
        const absDistance = Math.abs(distance)

        let k, c

        if (distance <= 0) {
          // Past lines (above active): Stiff, overdamped to prevent bounce
          k = 180 + absDistance * 10 // Very stiff
          c = 26 // Overdamped
        } else {
          // Future lines (below active): Looser, underdamped for trailing effect
          const baseStiffness = 100
          const stiffnessDrop = Math.min(absDistance * 15, 80)
          k = Math.max(baseStiffness - stiffnessDrop, 10)
          c = 16
        }

        // Calculate target position displacement
        displacement = currentY - target
        const springForce = -k * displacement
        const m = 1
        const currentVelocity = velocities[i] ?? 0
        const dampingForce = -c * currentVelocity
        const acceleration = (springForce + dampingForce) / m

        const dt = 0.016
        velocities[i] = currentVelocity + acceleration * dt
        currentYs[i] = currentY + velocities[i] * dt
      }

      // 2. Scale Smoothing Logic
      // Determine target scale based on active index
      let targetScale = 1.0
      if (isUserScrolling.value) {
        targetScale = 1.0 // Reset scale when scrolling
      } else if (i === activeIndex.value) {
        targetScale = 1.1 // Active line larger
      } else {
        // Neighbors get slightly smaller based on distance
        // Flatten the curve: use same scale for all non-active lines or very gentle drop
        // User requested removing semi-circle layout -> vertical layout
        // So we keep scale constant for all inactive lines
        targetScale = 1.0
      }

      // Linear Interpolation (Lerp) for smooth scale transition
      // Factor 0.1 gives a nice smooth drift
      const currentScale = currentScales[i] ?? 1
      const scaleDiff = targetScale - currentScale
      if (Math.abs(scaleDiff) > 0.001) {
        currentScales[i] = currentScale + scaleDiff * 0.15
        stillAnimating = true
      } else {
        currentScales[i] = targetScale
      }

      // Check if position needs more animation
      if (Math.abs(velocities[i]) > 0.1 || Math.abs(displacement) > 0.5) {
        stillAnimating = true
      } else {
        currentYs[i] = target
        velocities[i] = 0
      }
    }

    lineTranslateYs.value = currentYs
    lineVelocities.value = velocities
    lineScales.value = currentScales

    if (stillAnimating) {
      animationFrameId = requestAnimationFrame(animate)
    } else {
      animationFrameId = null
    }
  }

  animationFrameId = requestAnimationFrame(animate)
}

const getLineStyle = (index: number) => {
  if (lineTranslateYs.value.length <= index) return {}

  const translateY = -(lineTranslateYs.value[index] ?? 0)

  // If user is scrolling, disable opacity/blur effects for readability
  if (isUserScrolling.value) {
    const scale = lineScales.value[index] ?? 1
    return {
      transform: `translateY(${translateY}px) scale(${scale})`,
      opacity: 1,
      filter: 'none',
      transition: 'transform 0s, opacity 0.3s ease, filter 0.3s ease', // Allow smooth opacity/blur transition
      fontSize: `${props.fontSize}px`,
      marginBottom: `${props.lineGap}px`,
      letterSpacing: `${props.letterSpacing}px`
    }
  }

  // Use the smoothed scale from state, fallback to 1 if not ready
  const scale = lineScales.value[index] ?? 1

  // Progressive opacity and blur based on distance from active line
  const active = activeIndex.value
  const distance = Math.abs(index - active)

  // Opacity: Active=1, neighbors fade out
  // dist 1: ~0.7
  // dist 2: ~0.5
  // dist 3: ~0.3
  // dist 4+: ~0.1
  let opacity = Math.max(0.1, 1 - distance * 0.1)

  // Blur: Active=0, neighbors get blurrier
  let blur = 0
  if (props.enableBlur) {
    blur = Math.min(distance * 2.5, 24)
  }

  return {
    transform: `translateY(${translateY}px) translateX(2px) scale(${scale})`,
    opacity: opacity,
    filter: blur > 0 ? `blur(${blur}px)` : 'none',
    fontSize: `${props.fontSize}px`,
    marginBottom: `${props.lineGap}px`,
    letterSpacing: `${props.letterSpacing}px`
  }
}

// Word level active check
const getWordContainerStyle = (
  word: LyricWord,
  index: number,
  wordIndex?: number,
  lineLength?: number
) => {
  // Base style object
  const style: any = {
    display: 'inline-block',
    // Default transition for non-active states (smooth recovery/entry)
    transition: 'all 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)'
  }

  // Spacing logic: if current word is English/Number and not the last word, add space
  if (lineLength && wordIndex !== undefined && wordIndex < lineLength - 1) {
    const currentIsEn = /^[a-zA-Z0-9]+$/.test(word.text)
    // We can't easily check the next word here without passing it, but strictly checking current is usually enough
    // or we assume spacing is handled by a separate spacer element.
    // But based on previous context, we add margin.
    if (currentIsEn) {
      style.marginRight = '0.3em'
    }
  }

  if (index !== activeIndex.value) {
    const isPast = index < activeIndex.value
    return {
      ...style,
      opacity: isPast ? 0.5 : 0.5,
      filter: 'blur(0px)',
      transform: 'translateY(0)',
      color: 'rgba(255, 255, 255, 0.4)',
      textShadow: 'none'
    }
  }

  // Active line logic
  const currentTime = smoothTime.value
  const startTime = word.startTime
  const duration = word.duration || 0
  const endTime = startTime + duration

  // Calculate progress 0 to 1
  let progress = 0
  if (currentTime >= startTime && currentTime <= endTime) {
    progress = (currentTime - startTime) / (duration || 1)
  } else if (currentTime > endTime) {
    progress = 1
  } else {
    // Not started yet
    return {
      ...style,
      opacity: 0.5,
      filter: 'none',
      transform: 'translateY(0)',
      color: 'rgba(255, 255, 255, 0.4)',
      textShadow: 'none'
    }
  }

  // Smooth progress if needed, but linear is usually fine for karaoke
  // Clamp
  progress = Math.max(0, Math.min(1, progress))

  const isPast = currentTime > endTime

  if (isPast) {
    return {
      ...style,
      // Critical: active word uses background-clip: text with transparent color.
      // When switching to past, we must restore color instantly or the text will be invisible
      // while transitioning from transparent to white if the background is removed instantly.
      transition:
        'transform 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.6s ease, filter 0.6s ease, color 0s, -webkit-text-fill-color 0s',
      color: props.activeColor || '#fff',
      WebkitTextFillColor: props.activeColor || '#fff',
      backgroundImage: 'none',
      opacity: 1,
      filter: 'none',
      transform: 'translateY(-2px)', // Stay lifted
      textShadow: '0 0 10px rgba(255,255,255,0.4)'
    }
  }

  // Active word styling
  // We want background position from 100% (Gray/Transparent) to 0% (White)
  const bgPos = (1 - progress) * 100

  // Long word effect (> 0.5s)
  const isLongWord = (word.duration || 0) > 0.5
  let shadowBlur = 0
  let shadowAlpha = 0
  // Base lift from 0 to -2px
  let translateY = -2 * progress

  if (isLongWord) {
    // Progressive glow: Start from 0 to match "Not started" state
    // Use ease-out curve for more impactful glow at the start
    // 0 -> 30px
    const easeProgress = 1 - Math.pow(1 - progress, 3) // Cubic ease out
    shadowBlur = easeProgress * 20
    // 0 -> 0.7
    shadowAlpha = easeProgress * 0.7

    // For long words, we use MASK to achieve the gradient effect over the split characters.
    // Background-clip: text fails on containers with inline-block children (invisible text).
    // Mask works on the whole container rendering.

    // Mask Gradient: Black = Visible (Opacity 1), Transparent/Grey = Faded (Opacity 0.4)
    // We want the "Past" part to be fully visible (Black), "Future" part to be dimmed.
    const maskGradient = 'linear-gradient(to right, black 45%, rgba(0,0,0,0.4) 55%)'

    Object.assign(style, {
      // Transition settings
      transition:
        'color 0.3s ease, opacity 0.3s ease, filter 0.3s ease, transform 0s, text-shadow 0s, -webkit-mask-position 0s, mask-position 0s',

      // Base appearance
      color: props.activeColor || '#fff', // Solid white base
      textShadow: `0 0 ${shadowBlur}px rgba(255,255,255,${shadowAlpha})`,
      transform: `translateY(${translateY}px)`,

      // Fix for "Rectangular Boundary" (Shadow clipping):
      // The mask clips the text-shadow at the element's border box.
      // We add large padding to expand the box, allowing the shadow to spread.
      // Negative margin maintains the original layout flow.
      padding: '20px',
      margin: '-20px',
      // Ensure z-index is higher so the glow renders over neighbors if needed
      position: 'relative',
      zIndex: 1,

      // Mask settings for Karaoke Gradient
      maskImage: maskGradient,
      WebkitMaskImage: maskGradient,
      maskRepeat: 'no-repeat',
      WebkitMaskRepeat: 'no-repeat',

      // Crucial: Set mask origin to border-box to cover the padded area.
      // This ensures the mask (and thus the shadow) is drawn over the padding.
      // Note: This might introduce a slight progress offset due to width change,
      // but it's acceptable to avoid clipping artifacts.
      maskOrigin: 'border-box',
      WebkitMaskOrigin: 'border-box',
      maskSize: '220% 500%',
      WebkitMaskSize: '220% 500%',
      maskPosition: `${bgPos}% 50%`,
      WebkitMaskPosition: `${bgPos}% 50%`
    })
  } else {
    // Standard karaoke gradient for normal words
    const activeColor = props.activeColor || '#fff'
    Object.assign(style, {
      transition: 'opacity 0.3s ease, filter 0.3s ease, transform 0s, background-position 0s', // Keep smooth entry, instant gradient
      backgroundImage: `linear-gradient(to right, ${activeColor} 45%, rgba(255,255,255,0.4) 55%)`,
      backgroundSize: '220% 100%',
      backgroundPosition: `${bgPos}% 0`,
      backgroundRepeat: 'no-repeat',
      backgroundClip: 'text',
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
      color: 'transparent',
      textShadow: 'none',
      transform: `translateY(${translateY}px)`
    })
  }

  return style
}

// New function for character styling within long words
const getCharStyle = (word: LyricWord, charIndex: number, totalChars: number) => {
  const currentTime = smoothTime.value
  const startTime = word.startTime
  const duration = word.duration || 0
  const endTime = startTime + duration

  if (currentTime < startTime) return { display: 'inline-block', whiteSpace: 'pre' } // Not started

  // If finished, reset scale to 1 with smooth transition
  if (currentTime > endTime) {
    return {
      display: 'inline-block',
      transform: 'scale(1)',
      transformOrigin: 'bottom center',
      transition: 'transform 0.5s ease',
      whiteSpace: 'pre'
    }
  }

  let progress = (currentTime - startTime) / duration
  progress = Math.max(0, Math.min(1, progress))

  const activeCharIndex = progress * totalChars
  const dist = activeCharIndex - charIndex

  let scale = 1

  if (dist > 0) {
    const charProgress = Math.min(1, dist) // 0 to 1
    scale = 1 + 0.25 * charProgress // Max 1.25
  }

  return {
    display: 'inline-block',
    transform: `scale(${scale})`,
    transformOrigin: 'bottom center',
    transition: 'transform 0.1s linear',
    whiteSpace: 'pre'
  }
}
</script>

<template>
  <div class="lyrics-view">
    <div
      class="lyrics-scroll"
      :class="{ snapping: isSnapping }"
      ref="containerRef"
      @wheel.prevent="handleWheel"
      :style="{ '--active-color': activeColor || '#fff' }"
    >
      <div v-if="validLines.length === 0" class="no-lyrics">
        <div class="placeholder-icon">♫</div>
        <div class="placeholder-text">暂无歌词</div>
      </div>

      <div
        v-for="(line, index) in validLines"
        :key="index"
        class="lyric-line"
        :class="{ active: index === activeIndex, past: index < activeIndex }"
        @click="$emit('seek', line.time)"
        :style="getLineStyle(index)"
      >
        <template v-if="line.words && line.words.length > 0">
          <span
            v-for="(word, wIndex) in line.words"
            :key="wIndex"
            class="lyric-word"
            :style="getWordContainerStyle(word, index, wIndex, line.words.length)"
          >
            <!-- Split text into chars for long words to allow sequential animation -->
            <template v-if="word.duration > 0.5">
              <span
                v-for="(char, cIdx) in word.text"
                :key="cIdx"
                class="lyric-char"
                :style="getCharStyle(word, cIdx, word.text.length)"
                >{{ char }}</span
              >
            </template>
            <template v-else>
              {{ word.text }}
            </template>
          </span>
        </template>
        <template v-else>
          {{ line.text || ' ' }}
        </template>
        <div v-if="line.translation" class="lyric-translation">{{ line.translation }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lyrics-view {
  width: 100%;
  height: 87%;
  overflow: hidden;
  position: relative;
  mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 85%, transparent 100%);
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    black 15%,
    black 85%,
    transparent 100%
  );
  top: 14%;
}

.lyrics-scroll {
  height: 100%;
  overflow-y: hidden;
  padding: 20vh 14px;
  /* Changed from 50vh to 20vh for 20% initial position */
  box-sizing: border-box;
  scrollbar-width: none;
  /* Firefox */
  text-align: left;
  /* Apple Music aligns left usually, or center? Let's go with Left for modern feel */
  display: flex;
  flex-direction: column;
  align-items: start;
  /* Center lines horizontally */

  transition:
    opacity 0.3s ease,
    filter 0.3s ease;
}

.lyrics-scroll.snapping {
  opacity: 0;
  filter: blur(10px);
  transition: none; /* Instant fade out */
}

.lyrics-scroll::-webkit-scrollbar {
  display: none;
}

.lyric-line {
  width: 100%;
  max-width: 600px;
  /* Limit width */
  padding: 16px 18px;
  /* Inner padding */
  box-sizing: border-box;
  font-size: 26px;
  /* Slightly smaller base size */
  font-weight: 700;
  line-height: 1.4;
  /* Slightly increased line height */
  margin-bottom: 24px;
  /* Increased spacing */
  color: rgba(255, 255, 255, 0.4);
  white-space: pre-wrap;
  /* Allow wrapping */
  word-wrap: break-word;
  /* Break long words if needed */

  filter: blur(2px);
  opacity: 0.5;
  /* transform-origin: center center; */
  /* Revert to left for left alignment scaling */
  transform-origin: left center;
  will-change: transform, opacity, filter;
  /* Remove transition for transform since we control it with JS now */
  transition:
    color 0.5s cubic-bezier(0.23, 1, 0.32, 1),
    filter 0.5s cubic-bezier(0.23, 1, 0.32, 1),
    text-shadow 0.5s cubic-bezier(0.23, 1, 0.32, 1),
    opacity 0.5s cubic-bezier(0.23, 1, 0.32, 1);

  cursor: pointer;
}

.lyric-line:hover {
  filter: blur(0px);
  background: rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  opacity: 0.8;
}

.lyric-line.active {
  color: var(--active-color, #fff);
  /* font-size removed to match base size, using scale for emphasis */
  font-weight: 700;
  opacity: 1;
  filter: blur(0px);
  transform: translateX(-2px);
  text-shadow: 0 0 20px rgba(255, 255, 255, 0.4);
}

.lyric-line.past {
  opacity: 0.5;
  filter: blur(2px);
}

.lyric-translation {
  font-size: 1rem;
  color: inherit; /* Inherit from line color (rgba(255, 255, 255, 0.4)) */
  opacity: 0.5; /* Match word opacity */
  font-weight: 400;
  margin-top: 4px;
  line-height: 1.4;
}

.lyric-line.active .lyric-translation {
  color: rgba(255, 255, 255, 0.9);
  opacity: 1;
}

.lyric-word {
  transition:
    text-shadow 0.5s ease-out,
    transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1);
  will-change: transform, text-shadow, color;
  /* Allow word to affect layout but transform doesn't break flow if inline-block */
  vertical-align: middle;
}

.no-lyrics {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: rgba(255, 255, 255, 0.3);
}

.placeholder-icon {
  font-size: 64px;
  margin-bottom: 20px;
}

/* Responsive */
@media (max-width: 768px) {
  .lyric-line {
    font-size: 24px;
  }
}
</style>
