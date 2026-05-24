<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import defaultCover from '../../assets/default-cover.png'

/**
 * 懒加载图片组件的属性定义
 */
const props = withDefaults(
  defineProps<{
    /** 图片资源地址 */
    src: string
    /** 图片 alt 文本 */
    alt?: string
    /** 加载前的占位图，默认使用 default-cover.png */
    placeholder?: string
    /** 加载失败时的回退图，默认使用 default-cover.png */
    fallback?: string
    /** 根元素外边距，用于提前触发加载（像素） */
    rootMargin?: string
    /** 是否启用懒加载，默认启用 */
    lazy?: boolean
    /** 图片的 CSS class */
    imgClass?: string
  }>(),
  {
    alt: '',
    placeholder: () => defaultCover,
    fallback: () => defaultCover,
    rootMargin: '200px',
    lazy: true,
    imgClass: ''
  }
)

/** 当前实际显示的图片地址 */
const currentSrc = ref(props.lazy ? props.placeholder : props.src)
/** 是否已进入视口 */
const isInView = ref(!props.lazy)
/** 是否正在加载 */
const isLoading = ref(false)
/** 是否加载失败 */
const hasError = ref(false)
/** IntersectionObserver 实例 */
let observer: IntersectionObserver | null = null
/** 图片 DOM 引用 */
const imgRef = ref<HTMLElement | null>(null)

/**
 * 开始加载目标图片
 */
function loadImage(): void {
  if (isLoading.value || isInView.value) return
  isLoading.value = true

  const img = new Image()
  img.onload = () => {
    currentSrc.value = props.src
    isInView.value = true
    isLoading.value = false
  }
  img.onerror = () => {
    currentSrc.value = props.fallback
    hasError.value = true
    isLoading.value = false
  }
  img.src = props.src
}

/**
 * 设置 IntersectionObserver 监听元素可见性
 */
function setupObserver(): void {
  if (!props.lazy) return

  observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          loadImage()
          if (observer) {
            observer.unobserve(entry.target)
          }
        }
      })
    },
    { rootMargin: props.rootMargin }
  )

  if (imgRef.value) {
    observer.observe(imgRef.value)
  }
}

/**
 * 销毁观察器，释放资源
 */
function cleanupObserver(): void {
  if (observer) {
    observer.disconnect()
    observer = null
  }
}

onMounted(() => {
  setupObserver()
})

onUnmounted(() => {
  cleanupObserver()
})

watch(
  () => props.src,
  (newSrc) => {
    if (newSrc && isInView.value) {
      currentSrc.value = newSrc
    }
  }
)
</script>

<template>
  <div ref="imgRef" class="lazy-image-wrapper">
    <img
      :src="currentSrc"
      :alt="alt"
      :class="['lazy-image', imgClass, { 'lazy-image--loading': isLoading, 'lazy-image--error': hasError }]"
      loading="lazy"
      decoding="async"
    />
    <div v-if="isLoading" class="lazy-image__placeholder" />
  </div>
</template>

<style scoped>
.lazy-image-wrapper {
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 100%;
}

.lazy-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: opacity 0.3s ease;
}

.lazy-image--loading {
  opacity: 0.6;
  filter: blur(8px);
}

.lazy-image--error {
  opacity: 0.8;
}

.lazy-image__placeholder {
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, #ececec 8%, #f5f5f5 18%, #ececec 33%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  border-radius: inherit;
}

@keyframes shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}
</style>
