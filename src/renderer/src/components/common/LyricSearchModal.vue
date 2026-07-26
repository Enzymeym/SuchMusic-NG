<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  NModal,
  NCard,
  NSpin,
  NEmpty,
  NList,
  NListItem,
  NButton,
  NIcon,
  NScrollbar,
  NCheckbox,
  useThemeVars,
  useMessage
} from 'naive-ui'

type LyricSource = 'netease' | 'qq'

interface LyricSearchResult {
  id: number
  name: string
  artists: string
  album?: string
  coverUrl?: string
  source: LyricSource
  mid?: string
}

interface LyricsResult {
  lyrics: string
  translatedLyrics: string
  romanLyrics: string
  wySongId?: string
  coverUrl?: string
  applyCover?: boolean
  applySongInfo?: boolean
  source?: LyricSource
  mid?: string
  name?: string
  artists?: string
  album?: string
}

const props = defineProps<{
  show: boolean
  title: string
  artist: string
  currentCover?: string
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'select', result: LyricsResult): void
}>()

const themeVars = useThemeVars()
const message = useMessage()

const showModal = computed({
  get: () => props.show,
  set: (val) => emit('update:show', val)
})

const results = ref<LyricSearchResult[]>([])
const loading = ref(false)
const selectingId = ref<string | null>(null)
const applyCover = ref(!props.currentCover)
const applySongInfo = ref(true)

const searchKeyword = computed(() => {
  if (!props.title) return ''
  return props.artist ? `${props.title} ${props.artist}` : props.title
})

async function fetchSearchResults(): Promise<void> {
  if (!props.title) {
    results.value = []
    return
  }
  loading.value = true
  results.value = []
  try {
    const list = (await window.electron.ipcRenderer.invoke(
      'lyric:search',
      props.title,
      props.artist
    )) as LyricSearchResult[]
    results.value = list || []
  } catch (e) {
    console.warn('[LyricSearchModal] Failed to search lyrics:', e)
    results.value = []
  } finally {
    loading.value = false
  }
}

async function handleSelect(item: LyricSearchResult, index: number): Promise<void> {
  const itemKey = `${item.source}-${item.id}`
  if (selectingId.value === itemKey) return
  selectingId.value = itemKey
  try {
    const result =
      item.source === 'qq'
        ? ((await window.electron.ipcRenderer.invoke(
            'lyric:fetch-qq',
            item.mid || ''
          )) as LyricsResult | null)
        : ((await window.electron.ipcRenderer.invoke(
            'lyric:fetch-wy',
            String(item.id)
          )) as LyricsResult | null)

    if (!result || (!result.lyrics && !result.translatedLyrics)) {
      message.warning(`第 ${index + 1} 项没有可用的歌词`)
      return
    }
    if (item.source !== 'qq') {
      result.wySongId = String(item.id)
    }
    result.source = item.source
    result.mid = item.mid
    result.coverUrl = item.coverUrl
    result.applyCover = applyCover.value
    result.applySongInfo = applySongInfo.value
    result.name = item.name
    result.artists = item.artists
    result.album = item.album
    // 将用户选择写入缓存，便于后续自动匹配优先使用
    try {
      await window.electron.ipcRenderer.invoke(
        'lyric:cache-result',
        props.title,
        props.artist,
        result
      )
    } catch (cacheErr) {
      console.warn('[LyricSearchModal] Failed to cache selected lyrics:', cacheErr)
    }
    emit('select', result)
    showModal.value = false
    message.success('已应用所选歌词')
  } catch (e) {
    console.warn('[LyricSearchModal] Failed to fetch selected lyrics:', e)
    message.error('获取歌词失败，请重试')
  } finally {
    selectingId.value = null
  }
}

watch(
  () => props.show,
  (val) => {
    if (val) {
      applyCover.value = !props.currentCover
      applySongInfo.value = true
      fetchSearchResults()
    } else {
      results.value = []
      selectingId.value = null
    }
  }
)
</script>

<template>
  <n-modal v-model:show="showModal" :mask-closable="true">
    <n-card
      class="lyric-search-modal"
      :bordered="false"
      role="dialog"
      aria-modal="true"
      :style="{
        width: '560px',
        maxWidth: '90vw',
        backgroundColor: themeVars.modalColor
      }"
      content-style="padding: 0;"
    >
      <template #header>
        <div class="modal-header">
          <div class="modal-title">
            <n-icon size="18"><i class="mgc_search_2_line"></i></n-icon>
            <span>选择网络歌词</span>
          </div>
          <div class="modal-close-btn" @click="showModal = false">
            <n-icon size="18"><i class="mgc_close_line"></i></n-icon>
          </div>
        </div>
      </template>

      <div class="modal-subtitle">
        <span v-if="searchKeyword">搜索：{{ searchKeyword }}</span>
        <span v-else>暂无歌曲信息</span>
      </div>

      <n-scrollbar class="modal-scroll" style="max-height: 50vh">
        <n-spin :show="loading" description="正在搜索...">
          <div class="results-container">
            <n-list v-if="results.length > 0" hoverable clickable>
              <n-list-item
                v-for="(item, index) in results"
                :key="`${item.source}-${item.id}`"
                class="result-item"
                :class="{ selecting: selectingId === `${item.source}-${item.id}` }"
                @click="handleSelect(item, index)"
              >
                <div class="result-content">
                  <img
                    v-if="item.coverUrl"
                    :src="item.coverUrl"
                    class="result-cover"
                    loading="lazy"
                    alt=""
                  />
                  <div v-else class="result-index">{{ index + 1 }}</div>
                  <div class="result-info">
                    <div class="result-name-line">
                      <div class="result-name">{{ item.name }}</div>
                      <span
                        class="result-source"
                        :class="item.source === 'qq' ? 'source-qq' : 'source-netease'"
                      >
                        {{ item.source === 'qq' ? 'QQ' : '网易云' }}
                      </span>
                    </div>
                    <div class="result-artists">{{ item.artists || '未知歌手' }}</div>
                  </div>
                  <n-button
                    v-if="selectingId !== `${item.source}-${item.id}`"
                    size="tiny"
                    quaternary
                    class="result-action"
                  >
                    选择
                  </n-button>
                  <n-spin v-else :size="16" />
                </div>
              </n-list-item>
            </n-list>

            <n-empty v-else-if="!loading" description="未找到相关歌词" class="empty-state">
              <template #icon>
                <n-icon size="48"><i class="mgc_search_close_line"></i></n-icon>
              </template>
            </n-empty>
          </div>
        </n-spin>
      </n-scrollbar>

      <div class="modal-footer">
        <n-checkbox v-model:checked="applySongInfo">同时应用歌曲信息</n-checkbox>
        <n-checkbox v-model:checked="applyCover">同时应用封面</n-checkbox>
      </div>
    </n-card>
  </n-modal>
</template>

<style lang="scss" scoped>
.lyric-search-modal {
  .modal-footer {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 20px 16px;
    border-top: 1px solid var(--n-border-color);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .modal-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 16px;
      font-weight: 600;
      color: var(--n-text-color);
    }

    .modal-close-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      cursor: pointer;
      color: var(--n-text-color-2);
      transition: all 0.2s;

      &:hover {
        background: var(--n-close-color-hover, rgba(128, 128, 128, 0.15));
        color: var(--n-text-color);
      }
    }
  }

  .modal-subtitle {
    padding: 0 20px 12px;
    font-size: 13px;
    color: var(--n-text-color-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .modal-scroll {
    :deep(.n-scrollbar-rail) {
      right: 2px;
      width: 4px;
    }

    :deep(.n-scrollbar-rail__scrollbar) {
      width: 4px;
      border-radius: 2px;
      background-color: rgba(128, 128, 128, 0.25);
    }
  }

  .results-container {
    padding: 0 16px 16px;
    min-height: 200px;
  }

  .result-item {
    transition: all 0.2s ease;

    &.selecting {
      opacity: 0.7;
      pointer-events: none;
    }

    :deep(.n-list-item__main) {
      width: 100%;
    }
  }

  .result-content {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;

    .result-cover {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      object-fit: cover;
    }

    .result-index {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background: var(--n-border-color);
      color: var(--n-text-color-2);
      font-size: 12px;
      font-weight: 600;
    }

    .result-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;

      .result-name-line {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .result-name {
        font-size: 14px;
        font-weight: 500;
        color: var(--n-text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }

      .result-source {
        flex-shrink: 0;
        font-size: 10px;
        padding: 1px 5px;
        border-radius: 4px;
        font-weight: 600;

        &.source-netease {
          color: #c62828;
          background: rgba(198, 40, 40, 0.12);
        }

        &.source-qq {
          color: #1565c0;
          background: rgba(21, 101, 192, 0.12);
        }
      }

      .result-artists {
        font-size: 12px;
        color: var(--n-text-color-3);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }

    .result-action {
      flex-shrink: 0;
      opacity: 0;
      transition: opacity 0.2s;
    }
  }

  .result-item:hover .result-action {
    opacity: 1;
  }

  .empty-state {
    padding: 40px 0;
  }
}
</style>
