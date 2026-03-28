import request from '../../../utils/request'

export interface SearchSuggestResult {
  result: {
    albums?: any[]
    artists?: any[]
    songs?: any[]
    playlists?: any[]
    order?: string[]
  }
  code: number
}

/**
 * 搜索建议
 * @param keywords 关键词
 * @param type 'mobile' | 'web'
 */
export function searchSuggest(keywords: string, type: 'mobile' | 'web' = 'web') {
  return request<SearchSuggestResult>('/search/suggest', {
    keywords,
    type
  })
}
