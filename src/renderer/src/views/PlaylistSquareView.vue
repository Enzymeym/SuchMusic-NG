<script setup lang="ts">
import { onMounted, onUnmounted, ref, nextTick } from 'vue'
import {
  NGrid,
  NGridItem,
  NIcon,
  NScrollbar,
  NButton,
  NModal,
  NTabs,
  NTabPane,
  NTag,
  NSpin
} from 'naive-ui'
import { useRouter } from 'vue-router'
import defaultCover from '@renderer/assets/icon.png'
import {
  fetchTopPlaylists,
  fetchPlaylistCategories,
  type TopPlaylistItem,
  type PlaylistCategory
} from '../apis/netease/playlist/top-playlist'

const router = useRouter()
const playlists = ref<
  Array<{
    id: number
    title: string
    cover: string
    playCount: string
  }>
>([])
const loading = ref(false)
const loadingMore = ref(false)
const hasMore = ref(true)
const offset = ref(0)
const limit = 30
const selectedCategory = ref('全部')
const showCategoryModal = ref(false)
const categoryGroups = ref<{ name: string; items: PlaylistCategory[] }[]>([])
const loadTrigger = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

const goBack = () => router.back()

const formatPlayCount = (count: number): string => {
  if (!Number.isFinite(count)) return '0'
  if (count >= 100000000) return `${(count / 100000000).toFixed(1)}亿`
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return String(count)
}

const loadCategories = async () => {
  const res = await fetchPlaylistCategories()
  if (res) {
    const groups: { [key: string]: PlaylistCategory[] } = {}

    // Initialize groups based on res.categories
    Object.keys(res.categories).forEach((key) => {
      groups[res.categories[key]] = []
    })

    res.sub.forEach((cat) => {
      const groupName = res.categories[String(cat.category)]
      if (groups[groupName]) {
        groups[groupName].push(cat)
      }
    })

    categoryGroups.value = Object.keys(groups).map((name) => ({
      name,
      items: groups[name]
    }))
  }
}

const loadPlaylists = async (isLoadMore = false) => {
  if (loading.value || (isLoadMore && loadingMore.value)) return
  
  if (!isLoadMore) {
    loading.value = true
    offset.value = 0
    hasMore.value = true
  } else {
    loadingMore.value = true
  }

  try {
    const list = await fetchTopPlaylists(selectedCategory.value, limit, offset.value)
    
    if (list.length < limit) {
      hasMore.value = false
    }

    const formattedList = list.map((item: TopPlaylistItem) => ({
      id: item.id,
      title: item.name,
      cover: item.coverImgUrl || defaultCover,
      playCount: formatPlayCount(item.playCount)
    }))

    if (isLoadMore) {
      playlists.value.push(...formattedList)
    } else {
      playlists.value = formattedList
    }

    offset.value += list.length
  } finally {
    loading.value = false
    loadingMore.value = false
    
    // Re-observe trigger if needed
    if (!isLoadMore) {
      nextTick(() => {
        if (loadTrigger.value && observer) {
          observer.disconnect()
          observer.observe(loadTrigger.value)
        }
      })
    }
  }
}

const selectCategory = (cat: string) => {
  selectedCategory.value = cat
  showCategoryModal.value = false
  loadPlaylists()
}

onMounted(async () => {
  await loadCategories()
  await loadPlaylists()
  
  observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && hasMore.value && !loading.value && !loadingMore.value) {
      loadPlaylists(true)
    }
  }, { rootMargin: '200px' })
  
  if (loadTrigger.value) {
    observer.observe(loadTrigger.value)
  }
})

onUnmounted(() => {
  if (observer) observer.disconnect()
})
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <div class="header-left">
        <n-button text @click="goBack">
          <template #icon>
            <n-icon><i class="mgc_arrow_left_line"></i></n-icon>
          </template>
          返回
        </n-button>
        <h2 class="page-title">歌单广场</h2>
      </div>

      <n-button secondary round @click="showCategoryModal = true">
        {{ selectedCategory }}
        <template #icon>
          <n-icon><i class="mgc_filter_line"></i></n-icon>
        </template>
      </n-button>

      <n-modal v-model:show="showCategoryModal" preset="card" class="category-modal">
        <template #header>
          <div style="display: flex; align-items: center; gap: 8px;">
            选择分类
            <n-tag
              round
              :bordered="false"
              clickable
              :type="selectedCategory === '全部' ? 'primary' : 'default'"
              @click="selectCategory('全部')"
              class="category-tag"
            >
              全部歌单
            </n-tag>
          </div>
        </template>

        <div class="category-panel">

          <n-tabs type="segment" animated>
            <n-tab-pane
              v-for="group in categoryGroups"
              :key="group.name"
              :name="group.name"
              :tab="group.name"
            >
              <div class="group-items">
                <n-tag
                  v-for="cat in group.items"
                  :key="cat.name"
                  round
                  :bordered="false"
                  clickable
                  :type="selectedCategory === cat.name ? 'primary' : 'default'"
                  @click="selectCategory(cat.name)"
                  class="category-tag"
                >
                  {{ cat.name }}
                  <span v-if="cat.hot" class="hot-indicator mgc_fire_line"></span>
                </n-tag>
              </div>
            </n-tab-pane>
          </n-tabs>
        </div>
      </n-modal>
    </div>

    <n-scrollbar content-style="padding: 0 24px 24px;">
      <div v-if="loading" class="loading-container">
        <n-spin size="large" />
      </div>
      <div v-else>
        <n-grid x-gap="16" y-gap="24" cols="2 s:3 m:4 l:5 xl:6 2xl:8" responsive="screen">
          <n-grid-item v-for="item in playlists" :key="item.id">
            <div class="playlist-card">
              <div class="cover-wrapper">
                <img :src="item.cover" class="playlist-cover" />
                <div class="play-count">
                  <n-icon><i class="mgc_play_line"></i></n-icon> {{ item.playCount }}
                </div>
                <div class="play-overlay">
                  <n-icon size="40" color="white"><i class="mgc_play_circle_line"></i></n-icon>
                </div>
              </div>
              <div class="playlist-title">{{ item.title }}</div>
            </div>
          </n-grid-item>
        </n-grid>
        <div ref="loadTrigger" class="load-trigger">
          <n-spin v-if="loadingMore" size="small" />
          <span v-else-if="!hasMore" class="no-more">没有更多了</span>
        </div>
      </div>
    </n-scrollbar>
  </div>
</template>

<style scoped>
.page-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.page-header {
  padding: 16px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}
.page-title {
  margin: 0;
  font-size: 24px;
  font-weight: bold;
}

.category-panel {
  padding: 0;
}
.all-category-wrapper {
  margin-bottom: 16px;
}
.group-items {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-top: 16px;
}
.category-tag {
  cursor: pointer;

  display: flex;
  align-items: center;
  line-height: 32px;
  font-size: 13px;
}
.hot-indicator {
  font-size: 14px;
  color: rgb(216, 102, 102);
  margin-left: 2px;
}

.loading-container {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 200px;
}

/* Reuse styles from HomeView */
.playlist-card {
  cursor: pointer;
}
.cover-wrapper {
  position: relative;
  width: 100%;
  padding-bottom: 100%;
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 8px;
}
.playlist-cover {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s;
}
.playlist-card:hover .playlist-cover {
  transform: scale(1.05);
}
.play-count {
  position: absolute;
  top: 8px;
  right: 8px;
  background-color: rgba(0, 0, 0, 0.5);
  color: white;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 2px;
}
.play-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.3s;
}
.playlist-card:hover .play-overlay {
  opacity: 1;
}
.playlist-title { font-size: 14px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

.load-trigger {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 60px;
  color: #888;
  font-size: 13px;
  margin-top: 16px;
}
</style>

<style>
.category-modal {
  width: 600px;
  max-width: 90vw;
}
</style>
