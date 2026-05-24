import request from '../../../utils/request'

/**
 * 用户详情响应
 */
export interface UserDetailResponse {
  code: number
  account: {
    id: number
    userName: string
    type: number
    status: number
    whitelistAuthority: number
    createTime: number
    tokenVersion: number
    ban: number
    baoyueVersion: number
    donateVersion: number
    vipType: number
    anonimousUser: boolean
    paidFee: boolean
  }
  profile: {
    userId: number
    userType: number
    nickname: string
    avatarImgId: number
    avatarUrl: string
    backgroundImgId: number
    backgroundUrl: string
    signature: string
    createTime: number
    userName: string
    accountType: number
    shortUserName: string
    birthday: number
    authority: number
    gender: number
    accountStatus: number
    province: number
    city: number
    authStatus: number
    description: string | null
    detailDescription: string | null
    defaultAvatar: boolean
    expertTags: string[] | null
    experts: any | null
    djStatus: number
    locationStatus: number
    vipType: number
    followed: boolean
    mutual: boolean
    authenticated: boolean
    lastLoginTime: number
    lastLoginIP: string
    remarkName: string | null
    viptypeVersion: number
    authenticationTypes: number
    avatarDetail: any | null
    anchor: boolean
  }
}

/**
 * 获取用户详情
 * @param uid 用户ID
 * @param cookie 可选的cookie字符串
 * @returns 用户详情响应
 */
export async function fetchUserDetail(uid: number, cookie?: string): Promise<UserDetailResponse | null> {
  try {
    const params: Record<string, unknown> = { uid }
    if (cookie) {
      params.cookie = cookie
    }
    const data = await request<UserDetailResponse>('/user/detail', params)
    if (data.code === 200) {
      return data
    }
    return null
  } catch (error) {
    console.error('[UserDetail] 获取用户详情失败', error)
    return null
  }
}
