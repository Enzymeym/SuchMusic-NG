<script setup lang="ts">
import { onMounted, ref } from 'vue'
const appName = ref('Such PC')

//当前窗口尺寸的类型
const sizeType = ref<'max' | 'min'>('min')
onMounted(() => {
  window.electron.ipcRenderer.on('winSizeChange', (_, type) => {
    sizeType.value = type.size
  })
})

const handleClick = (type: 'hide' | 'min' | 'max' | 'close'): void => {
  window.electron.ipcRenderer.send('winAction', { type })
}
</script>

<template>
  <div class="titlebar">
    <div class="titlebar-content">
      <div class="titlebar-left">
        <img src="../assets/icon.png" alt="" height="24" />
        <n-text class="titlebar-title">{{ appName }}
          <span style="color: #2c8efd; font-weight: 600">Next Gen</span>
        </n-text>
      </div>
      <div class="right">
        <div class="btn-item" @click="handleClick('hide')">隐藏</div>
        <div v-if="sizeType === 'min'" class="btn-item" @click="handleClick('max')">放大</div>
        <div v-if="sizeType === 'max'" class="btn-item" @click="handleClick('min')">缩小</div>
        <div class="btn-item" @click="handleClick('close')">关闭</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  padding: 14px 16px;
  width: 100%;
  display: flex;
  align-items: center;
  app-region: drag;
}

.titlebar-content {
  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.titlebar-left {
  height: 100%;
  display: flex;
  gap: 12px;
  align-items: center;
}

.titlebar-title {
  font-size: 17px;
  font-weight: 600;
}

.right {
  display: flex;
  justify-content: right;
  -webkit-app-region: no-drag;
  gap: 10px;
}

.btn-item {
  cursor: pointer;
}
</style>
