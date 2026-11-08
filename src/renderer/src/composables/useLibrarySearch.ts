/**
 * 统一的本地搜索：防抖 + 输入法守卫 + 记忆化索引。
 *
 * 三处曾经各写一遍的过滤（全局搜索页、本地歌曲页、顶栏联想）现在都走这里，
 * 行为差异（有的匹配专辑、有的不匹配文件名）随之消失。
 */
import { computed, ref, type Ref } from 'vue'
import { debounce } from '../utils/performance'
import { getSearchIndex, type SearchableSong, type SearchField } from '../utils/librarySearch'

export interface UseLibrarySearchOptions<T extends SearchableSong> {
  /** 数据源（通常传 store.songs，数组引用变化会自动重建索引） */
  source: () => T[]
  /** 防抖时长，默认 200ms */
  delay?: number
  /** 结果上限，默认 200 条 */
  limit?: number
  /** 字段限定（UI 上的「搜索范围」下拉） */
  field?: Ref<SearchField>
}

export function useLibrarySearch<T extends SearchableSong>(options: UseLibrarySearchOptions<T>) {
  const delay = options.delay ?? 200
  const limit = options.limit ?? 200

  /** 输入框里的原始值 */
  const keyword = ref('')
  /** 已生效的关键词（防抖后） */
  const activeKeyword = ref('')
  /** 是否还在等防抖触发 */
  const pending = ref(false)
  /** 是否处于中文输入法合成期 */
  const composing = ref(false)

  const index = computed(() => getSearchIndex(options.source()))
  const field = computed<SearchField>(() => options.field?.value ?? 'any')

  const result = computed(() => index.value.search(activeKeyword.value, { limit, field: field.value }))
  const results = computed(() => result.value.items)
  const total = computed(() => result.value.total)
  const truncated = computed(() => result.value.truncated)
  const hasQuery = computed(() => activeKeyword.value.trim().length > 0)

  const commit = debounce((value: string) => {
    activeKeyword.value = value
    pending.value = false
  }, delay)

  /** 输入变化（模板上直接绑 @update:value / @input） */
  function update(value: string): void {
    keyword.value = value ?? ''
    // 合成期不触发：否则打「zhoujielun」会逐字母闪结果
    if (composing.value) return
    if (!keyword.value.trim()) {
      commit.cancel()
      activeKeyword.value = ''
      pending.value = false
      return
    }
    pending.value = true
    commit(keyword.value)
  }

  function onCompositionStart(): void {
    composing.value = true
  }

  /**
   * 合成结束。
   *
   * 模板上常写成 `@compositionend="onCompositionEnd"`，此时拿到的是 DOM
   * `CompositionEvent` 而不是字符串 —— 必须容忍，否则会把事件对象当成
   * 关键词塞进搜索框（表现为「打完中文就没结果」）。
   */
  function onCompositionEnd(payload?: unknown): void {
    composing.value = false
    update(typeof payload === 'string' ? payload : keyword.value)
  }

  /** 立即应用（回车提交时用，跳过防抖） */
  function submit(value?: string): void {
    const next = value ?? keyword.value
    commit.cancel()
    keyword.value = next
    activeKeyword.value = next
    pending.value = false
  }

  function reset(): void {
    commit.cancel()
    keyword.value = ''
    activeKeyword.value = ''
    pending.value = false
  }

  return {
    keyword,
    activeKeyword,
    pending,
    composing,
    results,
    total,
    truncated,
    hasQuery,
    update,
    submit,
    reset,
    onCompositionStart,
    onCompositionEnd
  }
}
