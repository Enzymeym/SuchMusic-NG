<script setup lang="ts">
import { computed, watch, nextTick, ref } from 'vue'
import type { LyricLine as CoreLyricLine } from '@applemusic-like-lyrics/core'
import { LyricsView, parseLyrics } from 'suth-lyric-kit'
import AMLLLyricPlayer from '../AMLL/LyricPlayer.vue'
import type { LyricPlayerRef } from '../AMLL/LyricPlayer.vue'
import { parseLyricsToCore } from '../../../utils/lyric/lyricParser'
import { useSettingsStore } from '../../../stores/settingsStore'
import { usePlayerStore } from '../../../stores/playerStore'
import { audioEngine } from '../../../audio/audio-engine'

const settingsStore = useSettingsStore()
const playerStore = usePlayerStore()

const props = defineProps({
  mode: {
    type: String as () => 'apple' | 'suth',
    default: 'suth'
  },
  lyrics: {
    type: [String, Array, Object],
    description: '歌词数据，apple模式为数组，suth模式为字符串或解析后的对象',
    default: () => []
  },
  translatedLyrics: {
    type: String,
    description: '翻译歌词文本',
    default: ''
  },
  currentTime: {
    type: Number,
    default: 0
  },
  fontSize: {
    type: Number,
    default: 32
  },
  lineGap: {
    type: Number,
    default: 12
  },
  activeLineColor: {
    type: String,
    default: '#fff'
  },
  loading: {
    type: Boolean,
    default: false
  }
})

const suthLyrics = computed(() => {
  if (props.mode === 'suth') {
    if (typeof props.lyrics === 'string') {
      const parsed = parseLyrics(props.lyrics)
      if (props.translatedLyrics && parsed.lines.length > 0) {
        try {
          const translatedParsed = parseLyrics(props.translatedLyrics)
          const maxLen = Math.min(parsed.lines.length, translatedParsed.lines.length)
          for (let i = 0; i < maxLen; i++) {
            const translatedText = translatedParsed.lines[i]!.text
            if (translatedText) {
              parsed.lines[i] = { ...parsed.lines[i], translation: translatedText }
            }
          }
        } catch {
          // ignore
        }
      }
      return parsed
    }
    if (typeof props.lyrics === 'object' && !Array.isArray(props.lyrics)) {
      return props.lyrics as any
    }
  }
  return null
})

const appleLyrics = computed<CoreLyricLine[]>(() => {
  if (props.mode === 'apple') {
    if (Array.isArray(props.lyrics)) {
      return props.lyrics
    }
    if (typeof props.lyrics === 'string') {
      const translatedContent = props.translatedLyrics || playerStore.currentSong?.translatedLyrics || ''
      return parseLyricsToCore(props.lyrics, translatedContent)
    }
  }
  return []
})

const currentTimeMs = computed(() => Math.round(props.currentTime * 1000))

const hasLyrics = computed(() => {
  if (!props.lyrics) return false
  if (typeof props.lyrics === 'string') return props.lyrics.trim().length > 0
  if (Array.isArray(props.lyrics)) return props.lyrics.length > 0
  return true
})

const showLoading = computed(() => props.loading && !hasLyrics.value)

const enableBlur = computed(() => settingsStore.playback.lyricsBlurEnabled)

const enableSpring = computed(() => settingsStore.playback.lyricsSpringEnabled)

const hidePassedLines = computed(() => settingsStore.playback.amllHidePassedLines)

const wordFadeWidth = computed(() => settingsStore.playback.amllWordFadeWidth)

const handleLineClick = (event: any) => {
  const rawLine =
    event && event.line && typeof event.line.getLine === 'function'
      ? event.line.getLine()
      : event &&
          event.detail &&
          event.detail.line &&
          typeof event.detail.line.getLine === 'function'
        ? event.detail.line.getLine()
        : null

  const startTime = rawLine && typeof rawLine.startTime === 'number' ? rawLine.startTime : null
  if (startTime == null || startTime < 0) return

  const targetMs = Math.round(startTime)

  audioEngine.seek(targetMs)
  playerStore.setPosition(targetMs)

  if (!playerStore.isPlaying) {
    void audioEngine.resume()
    playerStore.setPlaying(true)
  }
}

/**
 * AMLL 播放器实例引用
 */
const lyricPlayerRef = ref<LyricPlayerRef>()

/**
 * 当启用隐藏已播放歌词时，清洗已播放行的翻译和音译
 * 触发时机：hidePassedLines 切换、歌词数据变更（切歌/切换 AMLL 模式）
 * 通过直接调用 AMLL 播放器的 setLyricLines 实现
 */
watch([hidePassedLines, appleLyrics], ([enabled]) => {
  if (!enabled) return
  nextTick(() => {
    const playerRef = lyricPlayerRef.value?.lyricPlayer
    if (!playerRef?.value) return
    const lines = appleLyrics.value
    if (!lines.length) return
    const now = currentTimeMs.value
    const cleaned = lines.map((line, i) => {
      const endTime = lines[i + 1]?.startTime ?? line.endTime
      if (endTime <= now) {
        return { ...line, translatedLyric: '', romanLyric: '' }
      }
      return line
    })
    playerRef.value.setLyricLines(cleaned)
  })
})
</script>

<template>
  <div class="lyric-player-container lyric-am">
    <div v-if="showLoading" class="lyric-loading">
      <span>正在加载歌词...</span>
    </div>
    <template v-else>
      <LyricsView
        v-if="mode === 'suth'"
        :lyrics="suthLyrics"
        :current-time="currentTime"
        :font-size="fontSize"
        :line-gap="lineGap"
        :active-line-color="activeLineColor"
      />
      <AMLLLyricPlayer
        v-else
        ref="lyricPlayerRef"
        :lyric-lines="appleLyrics"
        :current-time="currentTimeMs"
        :playing="true"
        :enable-blur="enableBlur"
        :enable-spring="enableSpring"
        :hide-passed-lines="hidePassedLines"
        :word-fade-width="wordFadeWidth"
        class="am-lyric"
        :style="{
          '--amll-lp-color': 'var(--player-accent-color, rgba(255, 255, 255, 0.95))'
        }"
        @line-click="handleLineClick"
      />
    </template>
  </div>
</template>

<style scoped lang="scss">
.lyric-player-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.lyric-am {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  isolation: isolate;
  filter: drop-shadow(0px 4px 6px rgba(0, 0, 0, 0.2));
  mask: linear-gradient(
    180deg,
    hsla(0, 0%, 100%, 0) 0,
    hsla(0, 0%, 100%, 0.6) 5%,
    #fff 10%,
    #fff 75%,
    hsla(0, 0%, 100%, 0.6) 85%,
    hsla(0, 0%, 100%, 0)
  );

  :deep(.am-lyric) {
    width: 100%;
    height: 100%;
    position: absolute;
    left: 0;
    top: 0;
    padding-left: var(--amll-lyric-left-padding, 10px);
    padding-right: 80px;
    div[class^='_interludeDots'] {
      display: flex;
      color: var(--player-accent-color, rgba(255, 255, 255, 0.95));
    }
    @media (max-width: 990px) {
      padding: 0;
      margin-left: 0;
      .amll-lyric-player {
        > div {
          padding-left: 20px;
          padding-right: 20px;
        }
      }
    }
    ._lyricLine_ut4sn_6 {
      color: var(--player-accent-color, var(--amll-lp-color, rgba(255, 255, 255, 0.95)));
    }
  }

  &.align-right {
    :deep(.am-lyric) {
      padding-left: 80px;
      padding-right: var(--amll-lyric-right-padding, 10px);

      @media (max-width: 990px) {
        padding: 0;
        margin-right: -20px;
      }
      @media (max-width: 500px) {
        margin-right: 0;
      }
    }
  }
  &.pure {
    &:not(.duet) {
      text-align: center;

      :deep(.am-lyric) div {
        transform-origin: center;
      }
    }

    :deep(.am-lyric) {
      margin: 0;
      padding: 0 80px;
    }
  }

  :deep(.am-lyric .current),
  :deep(.am-lyric .is-current),
  :deep(.am-lyric .active),
  :deep(.am-lyric .is-active),
  :deep(.am-lyric .lyric-line.current),
  :deep(.am-lyric .lyric-line.is-current) {
    color: var(--player-accent-color, var(--amll-lp-color, rgba(255, 255, 255, 0.95)));
    text-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
    will-change: transform, opacity, color;
  }

  :deep(.am-lyric [lang]) {
    -webkit-font-smoothing: antialiased;
  }

  :deep(.am-lyric div[class*='lyricMainLine'] span) {
    text-align: start;
  }
}

.lyric-loading {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  color: var(--player-accent-color, var(--amll-lp-color, #efefef));
  font-size: 22px;
}
</style>
