import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  getLoginStatus,
  logout as logoutApi,
  extractUserInfo,
  type UserInfo
} from '../apis/netease/login'

const STORAGE_KEY = 'netease-user-cookie'

/**
 * 用户状态管理 Store
 * 管理网易云账户的登录状态、用户信息和 cookie
 */
export const useUserStore = defineStore('user', () => {
  // --- State ---
  /**
   * 是否已登录
   */
  const isLoggedIn = ref(false)

  /**
   * 用户 cookie，用于请求需要登录的接口
   */
  const cookie = ref<string>('')

  /**
   * 用户信息
   */
  const userInfo = ref<UserInfo | null>(null)

  /**
   * 登录时间戳
   */
  const loginTime = ref<number>(0)

  /**
   * 是否正在加载中
   */
  const loading = ref(false)

  // --- Getters ---
  /**
   * 获取用户头像 URL
   */
  const avatarUrl = computed(() => {
    return userInfo.value?.avatarUrl || ''
  })

  /**
   * 获取用户昵称
   */
  const nickname = computed(() => {
    return userInfo.value?.nickname || ''
  })

  /**
   * 获取用户 ID
   */
  const userId = computed(() => {
    return userInfo.value?.userId || 0
  })

  // --- Actions ---
  /**
   * 登录
   * @param userCookie 从登录响应中获取的 cookie 字符串
   * @returns 是否登录成功
   */
  async function login(userCookie: string): Promise<boolean> {
    if (!userCookie) {
      console.error('[UserStore] 登录失败: cookie 为空')
      return false
    }

    loading.value = true
    try {
      // 使用 cookie 获取登录状态
      const status = await getLoginStatus(userCookie)
      console.log('[UserStore] 登录状态:', status)
      
      if (!status) {
        console.error('[UserStore] 登录失败: 获取登录状态返回 null')
        return false
      }
      
      if (!status.data || !status.data.profile) {
        console.error('[UserStore] 登录失败: status.data 或 status.data.profile 为空')
        return false
      }

      // 提取用户信息
      const info = extractUserInfo(status)
      if (!info) {
        console.error('[UserStore] 登录失败: 提取用户信息失败')
        return false
      }

      // 更新状态
      cookie.value = userCookie
      userInfo.value = info
      isLoggedIn.value = true
      loginTime.value = Date.now()

      // 持久化到 localStorage
      localStorage.setItem(STORAGE_KEY, userCookie)

      console.log('[UserStore] 登录成功:', info)
      return true
    } catch (error) {
      console.error('[UserStore] 登录失败', error)
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 退出登录
   * @returns 是否退出成功
   */
  async function logout(): Promise<boolean> {
    loading.value = true
    try {
      // 调用退出登录接口
      await logoutApi()

      // 清除状态
      cookie.value = ''
      userInfo.value = null
      isLoggedIn.value = false
      loginTime.value = 0

      // 清除 localStorage
      localStorage.removeItem(STORAGE_KEY)

      return true
    } catch (error) {
      console.error('[UserStore] 退出登录失败', error)
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 初始化登录状态
   * 从 localStorage 恢复 cookie 并验证登录状态
   * @returns 是否已登录
   */
  async function initLoginState(): Promise<boolean> {
    const storedCookie = localStorage.getItem(STORAGE_KEY)
    if (!storedCookie) {
      return false
    }

    loading.value = true
    try {
      // 验证 cookie 是否有效
      const status = await getLoginStatus(storedCookie)
      if (!status || !status.data || !status.data.profile) {
        // cookie 已过期或无效，清除存储
        localStorage.removeItem(STORAGE_KEY)
        return false
      }

      // 提取用户信息
      const info = extractUserInfo(status)
      if (!info) {
        localStorage.removeItem(STORAGE_KEY)
        return false
      }

      // 恢复状态
      cookie.value = storedCookie
      userInfo.value = info
      isLoggedIn.value = true
      loginTime.value = Date.now()

      return true
    } catch (error) {
      console.error('[UserStore] 初始化登录状态失败', error)
      localStorage.removeItem(STORAGE_KEY)
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 刷新用户信息
   * @returns 是否刷新成功
   */
  async function refreshUserInfo(): Promise<boolean> {
    if (!isLoggedIn.value || !cookie.value) {
      return false
    }

    try {
      const status = await getLoginStatus(cookie.value)
      if (!status || !status.data || !status.data.profile) {
        return false
      }

      const info = extractUserInfo(status)
      if (info) {
        userInfo.value = info
        return true
      }
      return false
    } catch (error) {
      console.error('[UserStore] 刷新用户信息失败', error)
      return false
    }
  }

  /**
   * 获取用于 API 请求的 cookie 参数
   * @returns cookie 字符串或 undefined
   */
  function getCookieForRequest(): string | undefined {
    return cookie.value || undefined
  }

  return {
    // State
    isLoggedIn,
    cookie,
    userInfo,
    loginTime,
    loading,
    // Getters
    avatarUrl,
    nickname,
    userId,
    // Actions
    login,
    logout,
    initLoginState,
    refreshUserInfo,
    getCookieForRequest
  }
})
