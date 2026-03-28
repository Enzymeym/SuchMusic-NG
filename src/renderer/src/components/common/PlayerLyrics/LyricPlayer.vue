<script setup lang="ts">
import { computed } from 'vue'
import { parseYrc, parseQrc, parseTTML, decryptQrcHex } from '@applemusic-like-lyrics/lyric'
import type { LyricLine as CoreLyricLine, LyricWord as CoreLyricWord } from '@applemusic-like-lyrics/core'
import { LyricsView, parseLyrics } from 'suth-lyric-kit'
import AMLLLyricPlayer from '../AMLL/LyricPlayer.vue'
import { parseLrc as parseBetterLrc } from '../../../utils/lyric/ParseLrc'
import { useSettingsStore } from '../../../stores/settingsStore'
import { usePlayerStore } from '../../../stores/playerStore'
import { webAudioEngine } from '../../../audio/audio-engine'

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
  }
})

const suthLyrics = computed(() => {
  if (props.mode === 'suth') {
    if (typeof props.lyrics === 'string') {
      return parseLyrics(props.lyrics)
    }
    // If it's already an object (ParsedLyrics), return it
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
      const lrc = props.lyrics.trim()
      // 使用 any 避免直接耦合 amll-lyric 的类型定义
      let lines: any[] = []

      try {
        // TTML
        if (lrc.includes('<tt') && lrc.includes('xmlns="http://www.w3.org/ns/ttml"')) {
          lines = parseTTML(lrc).lines
        }
        // QRC (Hex)
        else if (/^[0-9a-fA-F]+$/.test(lrc) && lrc.length > 100) {
          try {
            const decrypted = decryptQrcHex(lrc)
            lines = parseQrc(decrypted)
          } catch {
            // ignore
          }
        }
        // QRC (XML)
        else if (lrc.startsWith('<?xml') && lrc.includes('<Qrc')) {
          lines = parseQrc(lrc)
        }
        // YRC (Guess by content)
        else if (/\(\d+,\d+\)/.test(lrc)) {
          lines = parseYrc(lrc)
        }
        // 其他情况回退为 LRC，使用自定义解析器
        else {
          lines = parseBetterLrc(lrc)
        }
        // 将 amll-lyric 的行结构转换到 core 定义的行结构
        return lines.map((line) => ({
          words: line.words.map(
            (w): CoreLyricWord => ({
              word: w.word,
              romanWord: w.romanWord ?? '',
              startTime: w.startTime,
              endTime: w.endTime,
              obscene: false // 默认按非敏感词处理
            })
          ),
          startTime: line.startTime,
          endTime: line.endTime,
          translatedLyric: line.translatedLyric ?? '',
          romanLyric: line.romanLyric ?? '',
          isBG: line.isBG ?? false,
          isDuet: line.isDuet ?? false
        }))
      } catch (e) {
        console.error('Lyric parse failed:', e)
        return []
      }
    }
  }
  return []
})

const currentTimeMs = computed(() => Math.round(props.currentTime * 1000))

const enableBlur = computed(() => settingsStore.playback.lyricsBlurEnabled)

const enableSpring = computed(() => settingsStore.playback.lyricsSpringEnabled)

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

  webAudioEngine.seek(targetMs)
  playerStore.setPosition(targetMs)

  if (!playerStore.isPlaying) {
    void webAudioEngine.resume()
    playerStore.setPlaying(true)
  }
}
</script>

<template>
  <div class="lyric-player-container lyric-am">
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
      class="am-lyric"
      :style="{
        '--amll-lp-color': '--player-accent-color'
      }"
      @line-click="handleLineClick"
    />
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
    div {
      div[class^='_interludeDots'] {
        display: flex;
      }
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

  /* 对常见的“当前高亮行”类名应用颜色高亮（优先使用播放页主题色） */
  :deep(.am-lyric .current),
  :deep(.am-lyric .is-current),
  :deep(.am-lyric .active),
  :deep(.am-lyric .is-active),
  :deep(.am-lyric .lyric-line.current),
  :deep(.am-lyric .lyric-line.is-current) {
    /* 直接使用播放页主题色作为高亮颜色，若没有则退回本地变量 */
    color: var(--player-accent-color, var(--amll-lp-color, rgba(255, 255, 255, 0.95)));
    /* 轻微发光，增强辨识度 */
    text-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
    /* 告诉浏览器该元素可能会变化，优化渲染 */
    will-change: transform, opacity, color;
  }

  /* 只对主歌词文本（非翻译/音译）启用混合，匹配带有 lang 属性的主元素 */
  :deep(.am-lyric [lang]) {
    /* 默认保持正常，但在高亮时会被上面的规则覆盖 */
    -webkit-font-smoothing: antialiased;
  }

  :deep(.am-lyric div[class*='lyricMainLine'] span) {
    text-align: start;
  }

  :lang(ja) {
    font-family: var(--ja-font-family);
  }
  :lang(en) {
    font-family: var(--en-font-family);
  }
  :lang(ko) {
    font-family: var(--ko-font-family);
  }
}

.lyric-loading {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  /* 加载中文本颜色，跟随播放页主题或本地变量 */
  color: var(--player-accent-color, var(--amll-lp-color, #efefef));
  font-size: 22px;
}
</style>
