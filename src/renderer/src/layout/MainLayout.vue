<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { NLayout, NLayoutSider, NLayoutHeader, NLayoutContent, NLayoutFooter } from 'naive-ui'
import { usePlayerStore } from '../stores/playerStore'
import { throttle } from '../utils/performance'
import AppSidebar from '../components/layout/AppSidebar.vue'
import AppHeader from '../components/layout/AppHeader.vue'
import PlayerBar from '../components/layout/PlayerBar.vue'

const route = useRoute()
const player = usePlayerStore()

const immersiveRoutes = ['playlist-detail']

const isImmersive = computed(() => {
  return immersiveRoutes.includes(route.name as string)
})

const collapsed = ref(false)
let wasSmall = false // 记录上一次是否为小窗口状态
let wasPlayerPageShown = false // 记录侧边栏收起前播放页是否打开

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

// 持有 throttle 包装引用，确保 add/removeEventListener 使用同一函数（避免监听器泄漏）
const onWindowResize = throttle(handleResize, 200)

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

// 监听侧边栏折叠状态，收起时销毁播放页实例，展开时重新创建
watch(collapsed, (isCollapsed) => {
  if (isCollapsed) {
    // 收起时记录当前播放页状态并关闭
    wasPlayerPageShown = player.isPlayerPageShown
    if (wasPlayerPageShown) {
      player.setPlayerPageShown(false)
    }
  } else {
    // 展开时恢复播放页
    if (wasPlayerPageShown) {
      wasPlayerPageShown = false
      player.setPlayerPageShown(true)
    }
  }
})

// 内容区 padding：统一 60px 避让 header
const contentContainerRef = ref<HTMLElement>()

onMounted(() => {
  wasSmall = window.innerWidth < 850
  if (wasSmall) {
    collapsed.value = true
  }
  window.addEventListener('resize', throttle(handleResize, 200))
  if (contentContainerRef.value) {
    contentContainerRef.value.style.paddingTop = '60px'
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
})
</script>

<template>

  <n-layout class="main-layout" content-style="display: flex; flex-direction: column; height: 100%;">
    <!-- Main Content Area (Sidebar + Header/Content) -->
    <n-layout has-sider class="middle-layout" :style="collapsed ? 'position: relative;' : ''">
      <n-layout-sider width="240" :bordered="!collapsed" collapse-mode="width" :collapsed-width="0"
        :native-scrollbar="false" class="sidebar" :style="[
          { backgroundColor: collapsed ? 'transparent' : '', overflow: 'visible', zIndex: 100 },
          { opacity: player.isPlayerPageShown ? 0 : 1, pointerEvents: player.isPlayerPageShown ? 'none' : 'auto', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }
        ]" :collapsed="collapsed">
        <AppSidebar :collapsed="collapsed" @update:collapsed="collapsed = $event" />
      </n-layout-sider>

      <n-layout class="content-layout"
        content-style="display: flex; flex-direction: column; height: 100%; position: relative;">
        <n-layout-header class="header" :style="[
          { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1000, width: '100%', backgroundColor: 'transparent' },
          { opacity: player.isPlayerPageShown ? 0 : 1, pointerEvents: player.isPlayerPageShown ? 'none' : 'auto', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }
        ]">
          <AppHeader :collapsed="collapsed" />
        </n-layout-header>

        <n-layout-content
          content-style="padding: 0; height: 100%; box-sizing: border-box; display: flex; flex-direction: column;"
          class="main-content">
          <div ref="contentContainerRef" class="content-container" :class="{ 'immersive-container': isImmersive }">
            <router-view v-slot="{ Component, route }">
              <PageTransition>
                <keep-alive
                  :include="['home', 'statistics', 'local', 'playlist', 'recent', 'singer', 'album']"
                  :max="5">
                  <component :is="Component" :key="route.fullPath" />
                </keep-alive>
              </PageTransition>
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
  overflow: hidden;
  /* Ensure scroll stays within content */
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
  z-index: 100;
  /* 提高层级，浮动在内容之上 */
  background: transparent !important;
  position: absolute;
  /* 绝对定位 */
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
  /* 为 Header 留出空间 */
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
  max-width: 1600px;
  margin: 0 auto;
  width: 100%;
  height: 100%;
  padding-top: 0px !important;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
}

/* 沉浸式页面容器：去除顶部内边距，内容直接顶到顶部，且去除最大宽度限制 */
.immersive-container {
  max-width: none !important;
  /* 让沉浸式页面占满全屏宽度 */
  padding-top: 0 !important;
}

.footer {
  background-color: #fff;
  border: none;
  z-index: 100;
  /* Raise above middle-layout so progress bar overflow is visible */
  flex-shrink: 0;
  /* Prevent shrinking */
  position: relative;
}
</style>
