import { ref, computed, watch } from 'vue'
import { usePlayerStore } from '../../../stores/playerStore'
import { fetchNewComments, type CommentItem } from '../../../apis/netease/comment'

/**
 * 评论相关的组合式函数
 * 处理评论获取、加载更多等功能
 */
export function usePlayerComments() {
  const player = usePlayerStore()

  // 是否为网易云歌曲（兼容 netease 和 wy 标识）
  const isNeteaseSong = computed(() => {
    const s = player.currentSong?.source
    return s === 'netease' || s === 'wy'
  })

  // 当前网易云歌曲的原始 ID（优先使用 sourceSongId）
  const neteaseSongId = computed(() => player.currentSong?.sourceSongId ?? player.currentSong?.id)

  // 评论抽屉显示状态
  const showCommentsDrawer = ref(false)

  // 评论数据与状态
  const comments = ref<CommentItem[]>([])
  const commentsTotal = ref(0)
  const commentsHasMore = ref(false)
  const commentsLoading = ref(false)
  const commentsError = ref<string | null>(null)
  const commentsPageNo = ref(1)
  const commentsPageSize = 20
  const commentsSortType = ref<1 | 2 | 3>(1)
  const commentsCursor = ref<string | null>(null)

  /**
   * 重置当前评论状态
   */
  const resetCommentsState = () => {
    comments.value = []
    commentsTotal.value = 0
    commentsHasMore.value = false
    commentsLoading.value = false
    commentsError.value = null
    commentsPageNo.value = 1
    commentsCursor.value = null
  }

  /**
   * 格式化评论时间
   * @param time 时间戳
   * @returns 格式化后的时间字符串
   */
  const formatCommentTime = (time: number): string => {
    if (!time) return ''
    const d = new Date(time)
    const y = d.getFullYear()
    const m = `${d.getMonth() + 1}`.padStart(2, '0')
    const day = `${d.getDate()}`.padStart(2, '0')
    const hh = `${d.getHours()}`.padStart(2, '0')
    const mm = `${d.getMinutes()}`.padStart(2, '0')
    return `${y}-${m}-${day} ${hh}:${mm}`
  }

  /**
   * 从网易云拉取评论列表
   * @param reset 是否重置评论列表
   */
  const loadComments = async (reset: boolean = false): Promise<void> => {
    if (!isNeteaseSong.value || !neteaseSongId.value) return

    if (reset) {
      commentsPageNo.value = 1
      commentsCursor.value = null
      comments.value = []
    }

    commentsLoading.value = true
    commentsError.value = null

    try {
      const res = await fetchNewComments({
        id: neteaseSongId.value,
        type: 0,
        pageNo: commentsPageNo.value,
        pageSize: commentsPageSize,
        sortType: commentsSortType.value,
        cursor:
          commentsSortType.value === 3 && commentsPageNo.value > 1
            ? commentsCursor.value || undefined
            : undefined
      })

      if (!res || res.code !== 200 || !res.data) {
        commentsError.value = res?.message || '获取评论失败'
        return
      }

      const data = res.data
      const list = Array.isArray(data.comments) ? data.comments : []

      if (reset) {
        comments.value = list
      } else {
        comments.value = [...comments.value, ...list]
      }

      commentsTotal.value = data.totalCount ?? list.length
      commentsHasMore.value = !!data.hasMore
      if (data.cursor !== undefined && data.cursor !== null) {
        commentsCursor.value = String(data.cursor)
      }
    } catch (e: any) {
      console.error('fetch comments failed', e)
      commentsError.value = e?.message || '获取评论失败'
    } finally {
      commentsLoading.value = false
    }
  }

  /**
   * 加载更多评论
   */
  const handleLoadMoreComments = async (): Promise<void> => {
    if (!commentsHasMore.value || commentsLoading.value) return
    commentsPageNo.value += 1
    await loadComments(false)
  }

  /**
   * 打开评论抽屉（非网易云歌曲时不响应）
   */
  const openComments = (): void => {
    if (!isNeteaseSong.value) return
    showCommentsDrawer.value = true
    if (!commentsLoading.value && comments.value.length === 0) {
      void loadComments(true)
    }
  }

  // 当当前播放歌曲变化时，自动刷新评论（仅网易云歌曲）
  watch(
    () => player.currentSong?.id,
    () => {
      resetCommentsState()
      if (isNeteaseSong.value && neteaseSongId.value) {
        void loadComments(true)
      }
    }
  )

  return {
    isNeteaseSong,
    showCommentsDrawer,
    comments,
    commentsTotal,
    commentsHasMore,
    commentsLoading,
    commentsError,
    formatCommentTime,
    handleLoadMoreComments,
    openComments
  }
}