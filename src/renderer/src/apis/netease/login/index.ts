import request from '../../../utils/request'

/**
 * 二维码 key 响应
 */
export interface QrKeyResponse {
  code: number
  data: {
    code: number
    unikey: string
  }
}

/**
 * 二维码生成响应
 */
export interface QrCodeResponse {
  code: number
  data: {
    qrurl: string
    qrimg: string
  }
}

/**
 * 二维码状态检查响应
 */
export interface QrCheckResponse {
  code: number
  message: string
  cookie?: string
  avatarUrl?: string
  nickname?: string
}

/**
 * 用户账户信息
 */
export interface UserAccount {
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
  viptypeVersion: number
  anonimousUser: boolean
}

/**
 * 用户资料信息
 */
export interface UserProfile {
  userId: number
  userType: number
  nickname: string
  avatarUrl: string
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
  description: string
  detailDescription: string
  defaultAvatar: boolean
  expertTags: string[] | null
  experts: Record<string, string> | null
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
  avatarDetail: unknown | null
  anchor: boolean
}

/**
 * 登录状态响应
 */
export interface LoginStatusResponse {
  data: {
    code: number
    account: UserAccount
    profile: UserProfile
  }
}

/**
 * 用户信息
 */
export interface UserInfo {
  userId: number
  nickname: string
  avatarUrl: string
  backgroundUrl: string
  signature: string
  gender: number
  vipType: number
  createTime: number
}

/**
 * 获取二维码 key
 * @returns key 字符串
 */
export async function getQrKey(): Promise<string | null> {
  try {
    const timestamp = Date.now()
    const data = await request<QrKeyResponse>('/login/qr/key', { timestamp })
    if (data.code === 200 && data.data.unikey) {
      return data.data.unikey
    }
    return null
  } catch (error) {
    console.error('[Login] 获取二维码 key 失败', error)
    return null
  }
}

/**
 * 生成二维码
 * @param key 二维码 key
 * @returns 二维码图片 base64 和 qrurl
 */
export async function createQrCode(key: string): Promise<{ qrurl: string; qrimg: string } | null> {
  try {
    const timestamp = Date.now()
    const data = await request<QrCodeResponse>('/login/qr/create', {
      key,
      qrimg: true,
      timestamp
    })
    if (data.code === 200 && data.data.qrimg) {
      return {
        qrurl: data.data.qrurl,
        qrimg: data.data.qrimg
      }
    }
    return null
  } catch (error) {
    console.error('[Login] 生成二维码失败', error)
    return null
  }
}

/**
 * 检查二维码扫码状态
 * @param key 二维码 key
 * @returns 状态码和 cookie（登录成功时）
 */
export async function checkQrStatus(key: string): Promise<QrCheckResponse | null> {
  try {
    const timestamp = Date.now()
    const data = await request<QrCheckResponse>('/login/qr/check', {
      key,
      timestamp
    })
    return data
  } catch (error) {
    console.error('[Login] 检查二维码状态失败', error)
    return null
  }
}

/**
 * 获取登录状态
 * @param cookie 可选的 cookie 字符串
 * @returns 登录状态响应
 */
export async function getLoginStatus(cookie?: string): Promise<LoginStatusResponse | null> {
  try {
    const params: Record<string, unknown> = {}
    if (cookie) {
      params.cookie = cookie
    }
    const data = await request<LoginStatusResponse>('/login/status', params)
    // 打印响应用于调试
    console.log('[Login] 登录状态响应:', JSON.stringify(data, null, 2))
    console.log('[Login] data 类型:', typeof data)
    console.log('[Login] data 的 keys:', data ? Object.keys(data) : 'null')
    console.log('[Login] data.data:', data?.data)
    console.log('[Login] data.data?.code:', data?.data?.code)
    console.log('[Login] data.data?.profile:', data?.data?.profile ? '存在' : '不存在')
    // 判断 data.data.code 和 data.data.profile
    if (data && data.data && data.data.code === 200 && data.data.profile) {
      console.log('[Login] 判断通过，返回数据')
      return data
    }
    console.log('[Login] 判断失败，返回 null')
    return null
  } catch (error) {
    console.error('[Login] 获取登录状态失败', error)
    return null
  }
}

/**
 * 退出登录
 * @returns 是否成功
 */
export async function logout(): Promise<boolean> {
  try {
    const data = await request<{ code: number }>('/logout')
    return data.code === 200
  } catch (error) {
    console.error('[Login] 退出登录失败', error)
    return false
  }
}

/**
 * 从登录状态响应中提取用户信息
 * @param response 登录状态响应
 * @returns 用户信息
 */
export function extractUserInfo(response: LoginStatusResponse): UserInfo | null {
  if (!response.data || !response.data.profile) {
    return null
  }
  const { profile } = response.data
  return {
    userId: profile.userId,
    nickname: profile.nickname,
    avatarUrl: profile.avatarUrl,
    backgroundUrl: profile.backgroundUrl,
    signature: profile.signature,
    gender: profile.gender,
    vipType: profile.vipType,
    createTime: profile.createTime
  }
}
