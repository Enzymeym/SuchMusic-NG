<script setup lang="ts">
import { h, ref, watch, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { MenuOption, NTooltip, useThemeVars } from 'naive-ui'
import SidebarNavigation from '../common/SidebarNavigation.vue'
import { hexToRgba } from '../../utils/color'

const props = defineProps<{ collapsed: boolean }>()
const emit = defineEmits<{ (e: 'update:collapsed', value: boolean): void }>()

const router = useRouter()
const route = useRoute()
const themeVars = useThemeVars()

// 将十六进制主色转换为带透明度的 rgba，用于选中态背景
const primaryColorHex = computed(() => themeVars.value.primaryColor || '#2C8EFD')
const activeBgColor = computed(() => hexToRgba(primaryColorHex.value, 0.15))
const activeBgColorDark = computed(() => hexToRgba(primaryColorHex.value, 0.25))

const toggleCollapse = () => {
  emit('update:collapsed', !props.collapsed)
}

// Helper to render icon
const renderIcon = (iconClass: string) => {
  return () => h('i', { class: iconClass, style: 'font-size: 18px;' })
}

const activeKey = ref<string>('home')

// Sync activeKey with route
watch(
  () => route.path,
  (newPath) => {
    if (newPath === '/') activeKey.value = 'home'
    else if (newPath === '/statistics') activeKey.value = 'statistics'
    else if (newPath === '/playlist') activeKey.value = 'favorites'
    else if (newPath === '/song') activeKey.value = 'song'
    else if (newPath === '/recent') activeKey.value = 'recent'
    else if (newPath === '/singer') activeKey.value = 'singer'
    else if (newPath === '/album') activeKey.value = 'album'
  },
  { immediate: true }
)

// Handle menu selection
watch(activeKey, (newKey) => {
  if (newKey === 'home') router.push('/')
  else if (newKey === 'statistics') router.push('/statistics')
  else if (newKey === 'favorites') router.push('/playlist')
  else if (newKey === 'song') router.push('/song')
  else if (newKey === 'recent') router.push('/recent')
  else if (newKey === 'singer') router.push('/singer')
    else if (newKey === 'album') router.push('/album')
})

const menuOptions: MenuOption[] = [
  {
    label: '首页',
    key: 'home',
    icon: renderIcon('mgc_home_3_line')
  },
  {
    label: '歌曲',
    key: 'song',
    icon: renderIcon('mgc_music_3_line')
  },
  {
    label: '歌单',
    key: 'favorites',
    icon: renderIcon('mgc_star_line')
  },
  {
    label: '歌手',
    key: 'singer',
    icon: renderIcon('mgc_user_3_line')
  },
  {
    label: '专辑',
    key: 'album',
    icon: renderIcon('mgc_album_line')
  },
  {
    label: '最近',
    key: 'recent',
    icon: renderIcon('mgc_history_line')
  },
  {
    label: '统计',
    key: 'statistics',
    icon: renderIcon('mgc_chart_bar_line')
  },
]
</script>

<template>
  <div class="sidebar-container" :class="{ 'is-collapsed': collapsed }">
    <transition name="sidebar-fade">
      <div v-if="!collapsed" class="full-menu" key="full">
        <!-- Logo Area -->
        <div class="logo-area">
          <img src="../../assets/icon.png" alt="Logo" class="logo-img" />
          <span class="logo-text">
            Such
          </span>
        </div>

        <!-- Main Navigation -->
        <div class="nav-scroll">
          <SidebarNavigation :options="menuOptions" v-model:value="activeKey" />
        </div>

        <!-- Float Collapse Button -->
        <div class="float-collapse-btn" @click="toggleCollapse">
          <i class="mgc_left_line"></i>
        </div>
      </div>

      <div v-else class="collapsed-menu" key="collapsed">
        <!-- Collapsed Capsule Tab -->
        <div class="capsule-wrapper">
          <div class="hover-trigger"></div>
          <div class="drag-area">
            <transition name="fade">
              <div class="mini-logo" v-if="collapsed">
                <img src="../../assets/icon.png" alt="Logo" class="mini-logo-img" />
              </div>
            </transition>
          </div>

          <!-- Vertical Line Indicator -->
          <div class="collapse-indicator"></div>

          <div class="capsule-container">
            <div class="capsule-tab">
              <!-- Expand Button -->
              <div class="capsule-item" @click="toggleCollapse">
                <i class="mgc_menu_line" style="font-size: 20px"></i>
              </div>
              <div class="capsule-divider"></div>
              <!-- Menu Items -->
              <n-tooltip v-for="item in menuOptions" :key="item.key" placement="right">
                <template #trigger>
                  <div class="capsule-item" :class="{ active: activeKey === item.key }"
                    @click="activeKey = item.key as string">
                    <component :is="item.icon" />
                  </div>
                </template>
                {{ item.label }}
              </n-tooltip>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.sidebar-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  /* For float collapse button positioning */
}

.full-menu {
  width: 240px;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.collapsed-menu {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.sidebar-fade-enter-active,
.sidebar-fade-leave-active {
  transition: opacity 0.2s ease;
  position: absolute;
  top: 0;
  left: 0;
}

.sidebar-fade-enter-from,
.sidebar-fade-leave-to {
  opacity: 0;
}

.logo-area {
  padding: 21px 22px 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  -webkit-app-region: drag;
  /* Make draggable */
}

.logo-img {
  width: 32px;
  height: 32px;
}

.logo-text {
  font-size: 20px;
  font-weight: bold;
  display: flex;
  align-items: center;
  gap: 8px;
}

.collapse-btn {
  -webkit-app-region: no-drag;
}

.nav-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0 3px;
}

/* Float Collapse Button */
.float-collapse-btn {
  position: fixed;
  /* 使用 fixed 定位脱离侧边栏局部流，直接相对视口定位 */
  top: calc(50vh - 40px);
  /* 屏幕正中央，减去底部播放器一半的高度以达到视觉居中 */
  left: 240px;
  /* 展开状态下侧边栏的宽度 */
  /* transform: translateY(-50%) 会使其基于自身高度居中 */
  transform: translate(-50%, -50%);
  width: 24px;
  height: 48px;
  background-color: var(--n-color);
  border: 1px solid var(--n-border-color);
  border-radius: 12px;
  /* 修改为小胶囊形状 */
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--n-text-color-3);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
  transition: all 0.2s;
  z-index: 1000;
  /* 提高层级确保不被遮挡 */
  -webkit-app-region: no-drag;
}

.float-collapse-btn:hover {
  background-color: var(--n-action-color-hover);
  color: var(--n-primary-color);
  transform: translate(-50%, -50%) scale(1.05);
}

html[data-theme='dark'] .float-collapse-btn {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

/* Capsule Tab Styles */
.capsule-wrapper {
  position: fixed;
  top: 0;
  left: 0;
  width: 80px;
  height: 100vh;
  z-index: 100;
  pointer-events: none;
}

.hover-trigger {
  position: absolute;
  top: 0;
  left: 0;
  /* 加宽热区：覆盖到胶囊滑出后的主体位置，避免鼠标从热区移到胶囊的
     过渡区间触发 :hover 丢失导致胶囊反复展开/收回的闪烁 */
  width: 64px;
  height: 100vh;
  pointer-events: auto;
}

.capsule-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  pointer-events: none;
  /* Changed from auto to none */
}

.drag-area {
  position: absolute;
  top: 11px;
  left: 0;
  width: 100%;
  height: 60px;
  /* 匹配 header 的高度 */
  -webkit-app-region: drag;
  z-index: 10;
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mini-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  transition: all 0.3s ease;
}

.mini-logo-img {
  width: 32px;
  height: 32px;
  opacity: 0.9;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Vertical Line Indicator */
.collapse-indicator {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 48px;
  background-color: rgba(0, 0, 0, 0.2);
  /* 加深浅色模式下的灰色 */
  border-radius: 0 4px 4px 0;
  opacity: 0.8;
  transition:
    opacity 0.3s ease,
    transform 0.3s ease,
    background-color 0.3s ease;
  pointer-events: none;
  z-index: 999;
}

html[data-theme='dark'] .collapse-indicator {
  background-color: rgba(255, 255, 255, 0.2);
}

.capsule-wrapper:hover .collapse-indicator {
  opacity: 0;
  transform: translateY(-50%) translateX(-4px);
}

.capsule-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  background-color: var(--n-color);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-radius: 32px;
  padding: 8px 0;
  gap: 12px;
  box-shadow: 4px 4px 12px rgba(0, 0, 0, 0.05);
  width: 56px;
  border: 1px solid var(--n-border-color);
  z-index: 1;
  pointer-events: auto;
  /* 隐藏在左侧，等待悬停时出现 */
  transform: translateY(-40px) translateX(-60px);
  transition:
    transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1),
    opacity 0.3s ease,
    /* 收起时延迟隐藏，避免鼠标短暂脱离触发区导致胶囊闪灭 */
    visibility 0s linear 0.3s;
  opacity: 0;
  visibility: hidden;
}

.capsule-wrapper:hover .capsule-tab {
  /* 悬停时往右移出一点，留出边距 */
  transform: translateY(-40px) translateX(12px);
  opacity: 1;
  visibility: visible;
  transition:
    transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1),
    opacity 0.3s ease,
    visibility 0s;
}

html[data-theme='dark'] .capsule-tab {
  background-color: var(--n-color);
  border: 1px solid var(--n-border-color);
  box-shadow: 4px 4px 12px rgba(0, 0, 0, 0.2);
}

.capsule-item {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--n-text-color-3);
  transition: all 0.2s;
  -webkit-app-region: no-drag;
}

.capsule-item:hover {
  background-color: var(--n-action-color-hover);
  color: var(--n-text-color-1);
}

.capsule-item.active {
  background-color: v-bind('activeBgColor');
  color: v-bind('themeVars.primaryColor');
  box-shadow: none;
  /* 移除额外阴影，保持扁平 */
}

html[data-theme='dark'] .capsule-item.active {
  background-color: v-bind('activeBgColorDark');
  color: v-bind('themeVars.primaryColor');
  box-shadow: none;
}

.capsule-divider {
  width: 32px;
  height: 1px;
  background-color: var(--n-border-color);
  margin: 0;
}

.playlists-section {
  margin-top: 12px;
  padding: 0 12px;
}

.playlist-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  cursor: pointer;
  border-radius: 8px;
  transition: background-color 0.2s;
}

.playlist-item:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

.playlist-item.active {
  background-color: #e0e0e0;
  font-weight: 500;
}

.playlist-cover {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  object-fit: cover;
}

.playlist-name {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Custom scrollbar for webkit */
.nav-scroll::-webkit-scrollbar {
  width: 4px;
}

.nav-scroll::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 2px;
}
</style>
