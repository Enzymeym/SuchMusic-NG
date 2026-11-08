import { defineStore } from 'pinia'
import { ref } from 'vue'

const STORAGE_KEY = 'search-history'
/** 最多保留的历史条数（超出后丢弃最旧的） */
const MAX_ITEMS = 12

export interface SearchHistoryItem {
  /** 关键词原文（按输入时的形态保存，展示用） */
  keyword: string
  /** 最近一次搜索时间戳 */
  at: number
}

/**
 * 搜索历史：只记关键词，不区分来源（本地 / 网易云 / QQ / 插件共用一份）。
 * 与项目其他小配置一致，直接落 localStorage，不经过主进程。
 */
export const useSearchHistoryStore = defineStore('searchHistory', () => {
  const items = ref<SearchHistoryItem[]>([])

  const save = (): void => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items.value))
    } catch (e) {
      console.error('[SearchHistory] 保存搜索历史失败:', e)
    }
  }

  const load = (): void => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      items.value = parsed
        .map((item: unknown): SearchHistoryItem | null => {
          // 兼容早期可能写入的纯字符串数组
          if (typeof item === 'string') return { keyword: item, at: 0 }
          if (item && typeof item === 'object') {
            const { keyword, at } = item as Partial<SearchHistoryItem>
            if (typeof keyword === 'string' && keyword.trim()) {
              return { keyword, at: typeof at === 'number' ? at : 0 }
            }
          }
          return null
        })
        .filter((item): item is SearchHistoryItem => item !== null)
        .slice(0, MAX_ITEMS)
    } catch (e) {
      console.error('[SearchHistory] 读取搜索历史失败:', e)
    }
  }

  /** 记录一次搜索：去重后置顶，超出上限丢弃最旧 */
  const add = (keyword: string): void => {
    const text = keyword.trim()
    if (!text) return
    const lower = text.toLowerCase()
    items.value = [
      { keyword: text, at: Date.now() },
      ...items.value.filter((item) => item.keyword.toLowerCase() !== lower)
    ].slice(0, MAX_ITEMS)
    save()
  }

  /** 删除单条历史（按关键词原文匹配，大小写不敏感） */
  const remove = (keyword: string): void => {
    const lower = keyword.trim().toLowerCase()
    items.value = items.value.filter((item) => item.keyword.toLowerCase() !== lower)
    save()
  }

  const clear = (): void => {
    items.value = []
    save()
  }

  load()

  return { items, add, remove, clear, load }
})
