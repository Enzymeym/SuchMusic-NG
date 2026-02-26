<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { NInput, NIcon, NButton, NDivider, useDialog } from 'naive-ui'
import SettingsModal from '../common/SettingsModal.vue'
import { useSettingsStore } from '../../stores/settingsStore'

const router = useRouter()
const route = useRoute()
const settingsStore = useSettingsStore()
const dialog = useDialog()
const searchText = ref('')
const sizeType = ref<'max' | 'min'>('min')
const showSettings = ref(false)
const settingsSection = ref('general')
const settingsHighlightKey = ref<string | null>(null)

onMounted(() => {
  if (window.electron && window.electron.ipcRenderer) {
    window.electron.ipcRenderer.on('winSizeChange', (_, type) => {
      sizeType.value = type.size
    })
  }

  const handleOpenSettings = (event: Event) => {
    const detail = (event as CustomEvent<{ section?: string; settingKey?: string }>).detail || {}
    settingsSection.value = detail.section || 'general'
    settingsHighlightKey.value = detail.settingKey ?? null
    showSettings.value = true
  }

  window.addEventListener('open-settings', handleOpenSettings as EventListener)

  onBeforeUnmount(() => {
    window.removeEventListener('open-settings', handleOpenSettings as EventListener)
  })
})

const handleWindowAction = (type: 'hide' | 'min' | 'max' | 'close') => {
  if (window.electron && window.electron.ipcRenderer) {
    if (type === 'close') {
      const { closeAction, remindOnClose } = settingsStore.general

      const performClose = () => {
        if (closeAction === 'minimize') {
          window.electron.ipcRenderer.send('winAction', { type: 'hide' })
        } else {
          window.electron.ipcRenderer.send('winAction', { type: 'close' })
        }
      }

      if (remindOnClose) {
        dialog.warning({
          title: '关闭提示',
          content: '确定要关闭应用吗？',
          positiveText: closeAction === 'minimize' ? '最小化到托盘' : '退出应用',
          negativeText: '取消',
          onPositiveClick: () => {
            performClose()
          }
        })
        return
      }

      performClose()
      return
    }
    window.electron.ipcRenderer.send('winAction', { type })
  }
}

const goBack = () => {
  // Implement router back
  history.back()
}

const goForward = () => {
  // Implement router forward
  history.forward()
}

const handleSearch = () => {
  if (searchText.value.trim()) {
    router.push({ name: 'search', query: { q: searchText.value } })
  }
}

// 检查是否需要透明背景
const isTransparent = computed(() => {
  // 歌单详情页使用透明背景
  return route.name === 'playlist-detail'
})
</script>

<template>
  <div class="app-header" :class="{ 'is-transparent': isTransparent }">
    <div class="left-controls">
      <div style="display: flex; align-items: center; gap: 6px;">
        <n-button circle strong secondary size="large" @click="goBack" class="nav-btn">
          <template #icon><n-icon style="transform: scale(1.25);"><i class="mgc_left_line"></i></n-icon></template>
        </n-button>
        <n-button circle strong secondary size="large" @click="goForward" class="nav-btn">
          <template #icon><n-icon style="transform: scale(1.25);"><i class="mgc_right_line"></i></n-icon></template>
        </n-button>
      </div>

      <n-input v-model:value="searchText" placeholder="搜索音乐..." class="search-bar" @keydown.enter="handleSearch">
        <template #prefix>
          <n-icon><i class="mgc_search_line"></i></n-icon>
        </template>
      </n-input>
    </div>

    <div class="right-controls">

      <n-button circle strong secondary size="large" class="action-btn" @click="showSettings = true">
        <template #icon><n-icon><i class="mgc_settings_3_line"></i></n-icon></template>
      </n-button>
      <n-divider vertical />
      <div class="window-controls">
        <n-button circle strong secondary size="large" @click="handleWindowAction('hide')" class="nav-btn">
          <template #icon><n-icon><i class="mgc_minimize_line"></i></n-icon></template>
        </n-button>
        <n-button circle strong secondary size="large" @click="handleWindowAction(sizeType === 'max' ? 'min' : 'max')"
          class="nav-btn">
          <template #icon><n-icon><i
                :class="sizeType === 'max' ? 'mgc_restore_line' : 'mgc_square_line'"></i></n-icon></template>
        </n-button>
        <n-button circle strong secondary size="large" @click="handleWindowAction('close')" class="nav-btn">
          <template #icon><n-icon><i class="mgc_close_line"></i></n-icon></template>
        </n-button>
      </div>
    </div>
    <SettingsModal
      v-model:show="showSettings"
      :initial-section="settingsSection"
      :initial-highlight-key="settingsHighlightKey"
    />
  </div>
</template>

<style scoped>
.app-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  height: 60px;
  padding: 0 24px 0 20px;
  -webkit-app-region: drag;
  /* Draggable */
  transition: background-color 0.3s;
  background-color: transparent; /* 容器默认背景透明 */
  position: relative;
  z-index: 1;
}

/* 仅在沉浸式模式下（透明背景），子元素应用毛玻璃样式 */
.is-transparent .left-controls .nav-btn,
.is-transparent .search-bar,
.is-transparent .right-controls .action-btn,
.is-transparent .window-controls .nav-btn {
  background-color: rgba(255, 255, 255, 0.4);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  transition: all 0.3s ease;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

/* 深色模式下的沉浸式样式 */
html[data-theme='dark'] .is-transparent .left-controls .nav-btn,
html[data-theme='dark'] .is-transparent .search-bar,
html[data-theme='dark'] .is-transparent .right-controls .action-btn,
html[data-theme='dark'] .is-transparent .window-controls .nav-btn {
  background-color: rgba(0, 0, 0, 0.3);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

/* 非沉浸式（普通模式）下，AppHeader 应该有背景，子元素恢复默认 */
/* 这里我们为普通模式添加一个背景色，通常跟随主题 */
:not(.is-transparent).app-header {
  background-color: transparent; /* 或者 var(--n-color-modal) 如果需要不透明 */
  /* 如果普通页面也希望是透明背景，那么就不需要改动 */
  /* 但用户说“没有自动更改样式”，说明普通页面不应该是毛玻璃子元素 */
}

/* 普通模式下，子元素不需要额外背景（使用 Naive UI 默认） */
/* 但是如果用户想要普通模式下按钮也有背景，可以取消下面这段，或者调整 */
:not(.is-transparent) .left-controls .nav-btn,
:not(.is-transparent) .right-controls .action-btn,
:not(.is-transparent) .window-controls .nav-btn {
  /* background-color: transparent; */
  /* backdrop-filter: none; */
  /* box-shadow: none; */
  /* border: none; */
  
  /* 如果用户反馈“没有背景色”，可能是指之前的按钮是有默认背景的（比如 secondary 样式） */
  /* Naive UI 的 button secondary 默认是带灰色背景的 */
  /* 我们在这里不覆盖，让 Naive UI 自己的样式生效 */
}

:not(.is-transparent) .search-bar {
  /* 搜索框在普通模式下可能需要一个背景，比如浅灰色 */
  background-color: rgba(0, 0, 0, 0.05);
  backdrop-filter: none;
  box-shadow: none;
  border: 1px solid transparent; /* 保持高度一致 */
}
html[data-theme='dark'] :not(.is-transparent) .search-bar {
  background-color: rgba(255, 255, 255, 0.1);
}

.left-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  -webkit-app-region: no-drag;
}

.nav-btn {
  border: none;
}

.search-bar {
  width: 240px;
  border: none;
  border-radius: 20000px;
  height: 38px;
  background-color: transparent !important; /* 让 n-input 自身透明，样式加在外层 */
}

/* 强制覆盖 naive-ui 默认背景 */
/* 仅在沉浸式模式下生效 */
.is-transparent .search-bar :deep(.n-input),
.is-transparent .search-bar :deep(.n-input .n-input-wrapper),
.is-transparent .search-bar :deep(.n-input__border),
.is-transparent .search-bar :deep(.n-input__state-border),
.is-transparent .search-bar :deep(.n-input--state-focused),
.is-transparent .search-bar :deep(.n-input:hover),
.is-transparent .search-bar :deep(.n-input:focus) {
  background-color: transparent !important;
  box-shadow: none !important; /* 移除 naive-ui 默认阴影 */
  border: none !important;
  --n-color: transparent !important;
  --n-color-focus: transparent !important;
  --n-border: none !important;
  --n-border-hover: none !important;
  --n-border-focus: none !important;
  --n-box-shadow-focus: none !important;
}

/* 普通模式下，搜索框恢复默认样式 */
/* 注意：我们在 .search-bar 外层加了背景色，所以这里其实不需要做什么，只要不强制 transparent 即可 */
/* 但是因为上面的 CSS 规则优先级很高，我们需要显式重置 */

/* 重置普通模式下的输入框样式 */
:not(.is-transparent) .search-bar :deep(.n-input),
:not(.is-transparent) .search-bar :deep(.n-input .n-input-wrapper) {
  /* background-color: transparent !important; */ 
  /* 移除强制透明，让 Naive UI 默认背景生效，或者我们自己指定一个背景 */
  /* 如果我们想让 search-bar 容器负责背景，那么这里确实应该透明 */
  /* 如果 search-bar 容器背景没显示出来，可能是 z-index 或者被覆盖 */
  background-color: transparent !important; 
  border: none !important;
  box-shadow: none !important;
  
  /* 恢复文字颜色为 Naive UI 默认变量（或者不设置，让它自然继承） */
  /* 这里为了保险，还是设置一下 */
  --n-text-color: var(--n-text-color);
  --n-placeholder-color: var(--n-placeholder-color);
  --n-icon-color: var(--n-icon-color);
  --n-caret-color: var(--n-caret-color);
}

/* 确保在普通模式下，.search-bar 容器本身有背景 */
:not(.is-transparent) .search-bar {
  /* 搜索框在普通模式下可能需要一个背景，比如浅灰色 */
  background-color: rgba(0, 0, 0, 0.06) !important; /* 加深一点，确保可见 */
  backdrop-filter: none;
  box-shadow: none;
  border: 1px solid transparent; 
}

html[data-theme='dark'] :not(.is-transparent) .search-bar {
  background-color: rgba(255, 255, 255, 0.12) !important;
}

html[data-theme='dark'] :not(.is-transparent) .search-bar :deep(.n-input),
html[data-theme='dark'] :not(.is-transparent) .search-bar :deep(.n-input .n-input-wrapper) {
  /* 同样不需要做太多，只要文字颜色对就行 */
}

:not(.is-transparent) .search-bar :deep(.n-input__border),
:not(.is-transparent) .search-bar :deep(.n-input__state-border) {
  border: none !important;
  box-shadow: none !important;
}

/* 确保输入文字和图标颜色正确 */
.search-bar :deep(.n-input__input-el),
.search-bar :deep(.n-icon),
.search-bar :deep(.n-input__placeholder) {
  /* color: inherit !important; */
  /* 不要强制 inherit，让 Naive UI 的变量生效，或者我们上面覆盖的变量生效 */
}

.right-controls {
  display: flex;
  align-items: center;

  -webkit-app-region: no-drag;
}

.user-profile {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.username {
  font-size: 14px;
  font-weight: 500;
}

.vip-badge {
  font-size: 10px;
  background-color: #333;
  color: #fff;
  padding: 1px 4px;
  border-radius: 4px;
}

.window-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.win-btn {
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.win-btn:hover {
  background-color: rgba(0, 0, 0, 0.1);
}

.win-btn.close:hover {
  background-color: #e81123;
  color: white;
}
</style>
