<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NGrid, NGridItem, NIcon, NScrollbar, NButton } from 'naive-ui'
import { useRouter } from 'vue-router'
import defaultCover from '@renderer/assets/icon.png'
import { fetchToplists, type ToplistItem } from '../apis/netease/playlist/toplist'

const router = useRouter()
const toplists = ref<
  Array<{
    id: number
    name: string
    cover: string
    playCount: string
    updateFrequency: string
  }>
>([])

const goBack = () => router.back()

const formatPlayCount = (count: number): string => {
  if (!Number.isFinite(count)) return '0'
  if (count >= 100000000) return `${(count / 100000000).toFixed(1)}亿`
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return String(count)
}

onMounted(async () => {
  const list = await fetchToplists()
  toplists.value = list.map((item: ToplistItem) => ({
    id: item.id,
    name: item.name,
    cover: item.coverImgUrl || defaultCover,
    playCount: formatPlayCount(item.playCount),
    updateFrequency: item.updateFrequency ?? ''
  }))
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
      <n-grid x-gap="16" y-gap="24" cols="2 s:3 m:4 l:5 xl:6 2xl:8" responsive="screen">
        <n-grid-item v-for="item in toplists" :key="item.id">
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