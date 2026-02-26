<script setup lang="ts">
import { h, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { MenuOption, NTag } from 'naive-ui'
import SidebarNavigation from '../common/SidebarNavigation.vue'

const router = useRouter()
const route = useRoute()

// Helper to render icon
const renderIcon = (iconClass: string) => {
  return () => h('i', { class: iconClass, style: 'font-size: 18px;' })
}

const activeKey = ref<string>('discover')

// Sync activeKey with route
watch(
  () => route.path,
  (newPath) => {
    if (newPath === '/') activeKey.value = 'discover'
    else if (newPath === '/playlist') activeKey.value = 'favorites'
    else if (newPath === '/local') activeKey.value = 'local'
    else if (newPath === '/recent') activeKey.value = 'recent'
  },
  { immediate: true }
)

// Handle menu selection
watch(activeKey, (newKey) => {
  if (newKey === 'discover') router.push('/')
  else if (newKey === 'favorites') router.push('/playlist')
  else if (newKey === 'local') router.push('/local')
  else if (newKey === 'recent') router.push('/recent')
})

const menuOptions: MenuOption[] = [
  {
    label: '首页',
    key: 'discover',
    icon: renderIcon('mgc_music_2_line')
  },
  {
    label: '歌单',
    key: 'favorites',
    icon: renderIcon('mgc_star_line')
  },
  {
    label: '本地',
    key: 'local',
    icon: renderIcon('mgc_folder_2_line')
  },
  {
    label: '最近',
    key: 'recent',
    icon: renderIcon('mgc_history_line')
  }
]

// 预留歌单数据结构，后续可接入真实数据源
</script>

<template>
  <div class="sidebar-container">
    <!-- Logo Area -->
    <div class="logo-area">
      <img src="../../assets/icon.png" alt="Logo" class="logo-img" />
      <span class="logo-text">
        Such
        <n-tag type="info" size="small" round>
          Next Gen
        </n-tag>
      </span>
    </div>

    <!-- Main Navigation -->
    <div class="nav-scroll">
      <SidebarNavigation :options="menuOptions" v-model:value="activeKey" />
    </div>
  </div>
</template>

<style scoped>
.sidebar-container {
  display: flex;
  flex-direction: column;
  height: 100%;
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

.nav-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0 3px;
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
