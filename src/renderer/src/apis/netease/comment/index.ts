import request from '../../../utils/request'

// 评论用户信息结构
export interface CommentUser {
  userId: number
  nickname: string
  avatarUrl: string
}

// 被回复的评论结构
export interface CommentBeReplied {
  beRepliedCommentId: number
  content: string
  user: CommentUser
}

// 单条评论结构
export interface CommentItem {
  commentId: number
  content: string
  time: number
  likedCount: number
  liked?: boolean
  user: CommentUser
  beReplied?: CommentBeReplied[]
}

// 新版评论接口 data 字段结构
export interface NewCommentData {
  comments: CommentItem[]
  totalCount: number
  hasMore: boolean
  cursor?: string | number
}

// 新版评论接口完整返回结构
export interface NewCommentResponse {
  code: number
  data: NewCommentData
  message?: string
}

// /comment/new 接口参数
export interface FetchNewCommentsParams {
  id: string | number
  type: number
  pageNo?: number
  pageSize?: number
  sortType?: 1 | 2 | 3
  cursor?: string | number
}

/**
 * 调用新版评论接口 /comment/new
 * @param params 查询参数（资源 id、类型与分页信息）
 */
export function fetchNewComments(
  params: FetchNewCommentsParams
): Promise<NewCommentResponse> {
  const { id, type, pageNo = 1, pageSize = 20, sortType = 1, cursor } = params

  // 构造请求查询参数
  const query: Record<string, string | number> = {
    id,
    type,
    pageNo,
    pageSize,
    sortType
  }

  // 当按时间排序且非第一页时，需要传入上一条评论的 time 作为游标
  if (sortType === 3 && pageNo > 1 && cursor !== undefined) {
    query.cursor = cursor
  }

  return request<NewCommentResponse>('/comment/new', query)
}

