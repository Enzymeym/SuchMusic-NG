<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { NGrid, NGridItem, NIcon, NScrollbar, NButton, NSpin } from 'naive-ui'
import { useRouter } from 'vue-router'
import defaultCover from '@renderer/assets/icon.png'
import { fetchToplists, type ToplistItem } from '../apis/netease/playlist/toplist'

const router = useRouter()
const allToplists = ref<ToplistItem[]>([])
const displayToplists = ref<
  Array<{
    id: number
    name: string
    cover: string
    playCount: string
    updateFrequency: string
  }>
>([])
const offset = ref(0)
const limit = 20
const hasMore = ref(true)
const loading = ref(false)
const loadTrigger = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

const goBack = () => router.back()

const formatPlayCount = (count: number): string => {
  if (!Number.isFinite(count)) return '0'
  if (count >= 100000000) return `${(count / 100000000).toFixed(1)}亿`
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return String(count)
}

const loadMore = () => {
  if (!hasMore.value) return
  
  const nextBatch = allToplists.value.slice(offset.value, offset.value + limit)
  if (nextBatch.length === 0) {
    hasMore.value = false
    return
  }
  
  const formatted = nextBatch.map((item: ToplistItem) => ({
    id: item.id,
    name: item.name,
    cover: item.coverImgUrl || defaultCover,
    playCount: formatPlayCount(item.playCount),
    updateFrequency: item.updateFrequency ?? ''
  }))
  
  displayToplists.value.push(...formatted)
  offset.value += nextBatch.length
  
  if (offset.value >= allToplists.value.length) {
    hasMore.value = false
  }
}

onMounted(async () => {
  loading.value = true
  const list = await fetchToplists()
  allToplists.value = list
  loading.value = false
  
  loadMore()
  
  observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && hasMore.value) {
      loadMore()
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
      <n-button text @click="goBack">
        <template #icon>
          <n-icon><i class="mgc_arrow_left_line"></i></n-icon>
        </template>
        返回
      </n-button>
      <h2 class="page-title">排行榜</h2>
    </div>
    
    <n-scrollbar content-style="padding: 0 24px 24px;">
      <div v-if="loading" class="loading-container">
        <n-spin size="large" />
      </div>
      <div v-else>
        <n-grid x-gap="16" y-gap="24" cols="2 s:3 m:4 l:5 xl:6 2xl:8" responsive="screen">
          <n-grid-item v-for="item in displayToplists" :key="item.id">
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
              <div class="playlist-title">{{ item.name }}</div>
              <div v-if="item.updateFrequency" class="toplist-sub">
                {{ item.updateFrequency }}
              </div>
            </div>
          </n-grid-item>
        </n-grid>
        
        <div ref="loadTrigger" class="load-trigger">
          <span v-if="hasMore" style="opacity: 0.5;">加载中...</span>
          <span v-else class="no-more">没有更多了</span>
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
  gap: 16px;
}
.page-title {
  margin: 0;
  font-size: 24px;
  font-weight: bold;
}

.loading-container {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 200px;
}

.load-trigger {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 60px;
  color: #888;
  font-size: 13px;
  margin-top: 16px;
}

/* Reuse styles from HomeView */
.playlist-card { cursor: pointer; }
.cover-wrapper { position: relative; width: 100%; padding-bottom: 100%; border-radius: 12px; overflow: hidden; margin-bottom: 8px; }
.playlist-cover { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s; }
.playlist-card:hover .playlist-cover { transform: scale(1.05); }
.play-count { position: absolute; top: 8px; right: 8px; background-color: rgba(0, 0, 0, 0.5); color: white; font-size: 10px; padding: 2px 6px; border-radius: 10px; display: flex; align-items: center; gap: 2px; }
.play-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.3); display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.3s; }
.playlist-card:hover .play-overlay { opacity: 1; }
.playlist-title { font-size: 14px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.toplist-sub { font-size: 12px; color: #888; margin-top: 4px; }
</style>