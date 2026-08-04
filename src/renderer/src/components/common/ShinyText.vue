<script setup lang="ts">
/**
 * ShinyText - 闪光文字效果组件
 * 灵感来源: https://vue-bits.dev/text-animations/shiny-text
 * 使用纯 CSS 实现，无需 motion-v 依赖
 */
interface ShinyTextProps {
  /** 显示的文字 */
  text: string
  /** 基础颜色 */
  color?: string
  /** 高光颜色 */
  shineColor?: string
  /** 单次动画周期时长（秒） */
  speed?: number
  /** 周期之间的暂停时长（秒） */
  delay?: number
  /** 渐变角度（度） */
  spread?: number
  /** 是否往返播放 */
  yoyo?: boolean
  /** 悬停时暂停 */
  pauseOnHover?: boolean
  /** 光泽移动方向 */
  direction?: 'left' | 'right'
  /** 禁用闪光效果 */
  disabled?: boolean
}

const props = withDefaults(defineProps<ShinyTextProps>(), {
  color: '#b5b5b5',
  shineColor: '#ffffff',
  speed: 2,
  delay: 0,
  spread: 120,
  yoyo: false,
  pauseOnHover: false,
  direction: 'left',
  disabled: false
})
</script>

<template>
  <span
    class="shiny-text"
    :class="{
      disabled: props.disabled,
      'pause-on-hover': props.pauseOnHover,
      yoyo: props.yoyo,
      'dir-right': props.direction === 'right'
    }"
    :style="{
      '--shiny-color': props.color,
      '--shiny-shine-color': props.shineColor,
      '--shiny-spread': props.spread + 'deg',
      '--shiny-duration': props.speed + 's',
      '--shiny-delay': props.delay + 's'
    }"
  >
    <slot name="prefix" />
    {{ props.text }}
  </span>
</template>

<style scoped>
.shiny-text {
  display: inline-block;
  background-image: linear-gradient(
    var(--shiny-spread),
    var(--shiny-color) 0%,
    var(--shiny-color) 35%,
    var(--shiny-shine-color) 50%,
    var(--shiny-color) 65%,
    var(--shiny-color) 100%
  );
  background-size: 200% auto;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: shiny-text-sweep var(--shiny-duration) linear infinite;
  animation-delay: var(--shiny-delay);

  /* 前缀图标（如 slot="prefix"）继承闪光效果 */
  :deep(i) {
    -webkit-text-fill-color: transparent;
    color: transparent;
    margin-right: 6px;
  }
}

/* 光泽从右向左扫过 (direction: left) */
@keyframes shiny-text-sweep {
  0% {
    background-position: 150% center;
  }
  100% {
    background-position: -50% center;
  }
}

/* direction: right — 反向播放 */
.shiny-text.dir-right {
  animation-direction: reverse;
}

/* yoyo 模式：往返 */
.shiny-text.yoyo {
  animation-direction: alternate;
}

/* 禁用状态：静态显示基础颜色 */
.shiny-text.disabled {
  background-image: none;
  -webkit-text-fill-color: var(--shiny-color);
  color: var(--shiny-color);
  animation: none;
}

/* 悬停暂停 */
.shiny-text.pause-on-hover:hover {
  animation-play-state: paused;
}
</style>
