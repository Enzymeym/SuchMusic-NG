<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import { NLayout, NLayoutSider, NLayoutHeader, NLayoutContent, NLayoutFooter } from 'naive-ui'
import { usePlayerStore } from '../stores/playerStore'
import { throttle } from '../utils/performance'

const AppSidebar = defineAsyncComponent(() => import('../components/layout/AppSidebar.vue'))
const AppHeader = defineAsyncComponent(() => import('../components/layout/AppHeader.vue'))
const PlayerBar = defineAsyncComponent(() => import('../components/layout/PlayerBar.vue'))

const route = useRoute()
const player = usePlayerStore()

const immersiveRoutes = ['playlist-detail']

const isImmersive = computed(() => {
  return immersiveRoutes.includes(route.name as string)
})

const collapsed = ref(false)
let wasSmall = false // 记录上一次是否为小窗口状态

const handleResize = () => {
  // 播放页显示时，完全忽略 resize 事件，不要记录任何东西
  if (player.isPlayerPageShown) {
    return
  }

  const isSmall = window.innerWidth < 850 // 判断当前是否为小窗口（阈值850px）

  if (isSmall && !wasSmall) {
    collapsed.value = true // 从大窗口变为小窗口时，自动折叠菜单
  } else if (!isSmall && wasSmall) {
    collapsed.value = false // 从小窗口变为大窗口时，自动展开菜单
  }
  wasSmall = isSmall
}

// 监听播放页状态变化
watch(() => player.isPlayerPageShown, (isShown) => {
  if (isShown) {
    // 播放页打开时，不改变 collapsed 状态
  } else {
    // 播放页关闭时，重新评估是否需要折叠
    // 确保我们使用当前最新的窗口宽度
    // 增加一点延迟确保 DOM 和样式已经恢复
    setTimeout(() => {
      const isSmall = window.innerWidth < 850
      if (isSmall && !collapsed.value) {
        collapsed.value = true
      } else if (!isSmall && collapsed.value) {
        collapsed.value = false
      }
      wasSmall = isSmall
    }, 200) // 200ms 的延迟足以跳过 Vue 过渡动画的影响
  }
})

onMounted(() => {
  wasSmall = window.innerWidth < 850
  if (wasSmall) {
    collapsed.value = true // 初始化时如果是小窗口，则直接折叠
  }
  window.addEventListener('resize', throttle(handleResize, 200))
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
})
</script>

<template>
  <n-layout class="main-layout" content-style="display: flex; flex-direction: column; height: 100%;">
    <!-- Main Content Area (Sidebar + Header/Content) -->
    <n-layout has-sider class="middle-layout" :style="collapsed ? 'position: relative;' : ''">
        <n-layout-sider
        width="240"
        :bordered="!collapsed"
        collapse-mode="width"
        :collapsed-width="0"
        :native-scrollbar="false"
        class="sidebar"
        :style="[
          { backgroundColor: collapsed ? 'transparent' : '', overflow: 'visible', zIndex: 100 },
          { opacity: player.isPlayerPageShown ? 0 : 1, pointerEvents: player.isPlayerPageShown ? 'none' : 'auto', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }
        ]"
        :collapsed="collapsed"
      >
        <AppSidebar :collapsed="collapsed" @update:collapsed="collapsed = $event" />
      </n-layout-sider>

      <n-layout class="content-layout" content-style="display: flex; flex-direction: column; height: 100%; position: relative;">
        <n-layout-header class="header" :style="[
          { position: 'absolute', top: 0, left: collapsed ? '52px' : 0, right: 0, zIndex: 10, width: collapsed ? 'calc(100% - 52px)' : '100%' },
          { opacity: player.isPlayerPageShown ? 0 : 1, pointerEvents: player.isPlayerPageShown ? 'none' : 'auto', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }
        ]">
          <AppHeader />
        </n-layout-header>

        <n-layout-content
          content-style="padding: 0; height: 100%; box-sizing: border-box; display: flex; flex-direction: column;"
          class="main-content"
        >
          <div class="content-container" :class="{ 'immersive-container': isImmersive }">
            <router-view v-slot="{ Component, route }">
              <transition name="fade-slide" mode="out-in">
                <keep-alive :include="['statistics', 'local', 'playlist', 'recent', 'playlist-square', 'toplist', 'singer', 'album']">
                  <component :is="Component" :key="route.fullPath" />
                </keep-alive>
              </transition>
            </router-view>

          </div>
        </n-layout-content>
      </n-layout>
    </n-layout>

    <!-- Bottom Player Bar (Full Width) -->
    <n-layout-footer bordered height="80" class="footer">
      <PlayerBar />
    </n-layout-footer>
  </n-layout>
</template>

<style scoped>
.main-layout {
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}

.middle-layout {
  flex: 1;
  background-color: #F6F6F6 !important;
  overflow: hidden; /* Ensure scroll stays within content */
  z-index: 1;
}

/* 深色模式下 middle-layout 使用与 body 相同的背景色 */
html[data-theme='dark'] .middle-layout {
  background-color: #101014 !important;
}

.sidebar {
  contain: layout style;
  height: 100%;
}

.content-layout {
  display: flex;
  background-color: transparent;
  flex-direction: column;
  height: 100%;
}

/* 深色模式下 content-layout 使用与 body 相同的背景色 */
html[data-theme='dark'] .content-layout {
  background-color: transparent !important;
}

html[data-theme='dark'] .header {
  /* background-color: #101014 !important; */
  /* 让 header 在深色模式下也保持透明，依靠 AppHeader 内部的 is-transparent 控制 */
  background: transparent !important;
}

.header {
  height: 64px;
  z-index: 100; /* 提高层级，浮动在内容之上 */
  background: transparent;
  position: absolute; /* 绝对定位 */
  top: 0;
  left: 0;
  width: 100%;
}

.main-content {
  flex: 1;
  background: transparent;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding-top: 64px; /* 为 Header 留出空间 */
}

/* 针对歌单详情页（或其他全屏沉浸页）去除顶部 padding */
/* 需要一种方式让 main-content 知道当前是不是沉浸页 */
/* 暂时通过在路由组件内部处理，或者这里用 :has() 选择器（如果支持） */
/* 或者简单粗暴一点，让所有页面的 padding-top 都由 header 自身占位？不，那样 header 不能浮动 */
/* 正确做法是：默认 padding-top: 64px; */
/* 但对于 PlaylistDetailView，我们需要它顶到最上面 */

/* 修正方案： */
/* .main-content 不设 padding-top，而是让普通页面的容器自己加 padding-top */
/* 或者让 AppHeader 不再 absolute，而是普通流，除了特定页面 absolute */
/* 鉴于我们想做沉浸式，absolute 是必须的。 */
/* 所以普通页面需要自己加 padding-top: 64px; */

.main-content {
  flex: 1;
  background: transparent;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding-top: 0;
}

.content-container {
  contain: layout style paint;
  max-width: 1600px;
  margin: 0 auto;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  /* 默认情况下，为所有页面添加顶部内边距，避让悬浮的 Header */
  padding-top: 60px;
}

/* 沉浸式页面容器：去除顶部内边距，内容直接顶到顶部，且去除最大宽度限制 */
.immersive-container {
  padding-top: 0 !important;
  max-width: none !important; /* 让沉浸式页面占满全屏宽度 */
}

.footer {
  background-color: #fff;
  border: none;
  z-index: 100; /* Raise above middle-layout so progress bar overflow is visible */
  flex-shrink: 0; /* Prevent shrinking */
  position: relative;
}

/* Page Transition Animation */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.fade-slide-enter-from {
  opacity: 0;
  transform: translateX(10px);
}

.fade-slide-leave-to {
  opacity: 0;
  transform: translateX(-10px);
}
</style>
