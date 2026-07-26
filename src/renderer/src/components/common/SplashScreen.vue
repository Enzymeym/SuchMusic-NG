<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import iconSrc from '../../assets/icon.png'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'fadeOutComplete'): void
}>()

const show = ref(false)

onMounted(() => {
  // 下一帧触发淡入动画
  requestAnimationFrame(() => {
    show.value = true
  })
})

watch(
  () => props.visible,
  (val) => {
    if (!val) {
      show.value = false
      setTimeout(() => {
        emit('fadeOutComplete')
      }, 500)
    }
  }
)
</script>

<template>
  <Transition name="splash">
    <div v-if="show" class="splash-screen">
      <img :src="iconSrc" class="splash-icon" alt="Such Music" />
    </div>
  </Transition>
</template>

<style scoped>
.splash-screen {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--splash-bg, #101014);
}

.splash-icon {
  width: 96px;
  height: 96px;
  border-radius: 20px;
  object-fit: contain;
  -webkit-user-drag: none;
  user-select: none;
}

.splash-enter-active {
  transition: opacity 0.4s ease;
}

.splash-leave-active {
  transition: opacity 0.5s ease;
}

.splash-enter-from,
.splash-leave-to {
  opacity: 0;
}
</style>
