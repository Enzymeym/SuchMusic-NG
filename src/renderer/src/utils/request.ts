import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios'

// 基础 URL
// 开发环境下使用 Vite 代理避免 CORS，生产环境直接请求
const BASE_URL = import.meta.env.DEV ? '/api' : 'https://api.enzymeym.top'

// 创建 axios 实例
const service: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 30000, // 请求超时时间，增加到 30 秒
  headers: {
    'Content-Type': 'application/json;charset=utf-8'
  },
  // 允许跨域携带 cookie
  withCredentials: true
})

// 请求缓存
const cache: Record<string, { data: any; timestamp: number }> = {}
// 缓存有效期（毫秒）
const CACHE_DURATION = 5 * 60 * 1000 // 5分钟

// 正在进行的请求
const pendingRequests: Record<string, Promise<any>> = {}

// 生成请求 key
const generateRequestKey = (url: string, params?: any, method: string = 'GET'): string => {
  const paramsStr = params ? JSON.stringify(params) : ''
  return `${method.toUpperCase()}_${url}_${paramsStr}`
}

// 请求拦截器
service.interceptors.request.use(
  (config) => {
    // 可以在这里添加 token 等
    // const token = localStorage.getItem('token')
    // if (token) {
    //   config.headers['Authorization'] = `Bearer ${token}`
    // }
    
    // 如果是 GET 请求且有参数，处理参数（可选）
    return config
  },
  (error) => {
    console.error('Request error:', error)
    return Promise.reject(error)
  }
)

// 响应拦截器
service.interceptors.response.use(
  (response: AxiosResponse) => {
    // 这里可以根据后端约定的状态码进行统一处理
    // 例如 Netease API 通常返回 code: 200 表示成功
    const res = response.data
    
    // 如果是直接返回数据的接口，可能需要根据具体情况调整判断逻辑
    // 这里假设标准返回结构 { code: 200, data: ... }
    // 如果接口返回非 200，视为错误
    // 注意：二维码登录接口返回的状态码都是正常的业务状态：
    // 800: 二维码过期, 801: 等待扫码, 802: 待确认, 803: 授权登录成功
    const qrStatusCodes = [800, 801, 802, 803]
    if (res.code && res.code !== 200 && !qrStatusCodes.includes(res.code)) {
      // 可以在这里统一处理错误提示
      console.error(`API Error: ${res.code} - ${res.message || 'Unknown error'}`)
      return Promise.reject(new Error(res.message || 'Error'))
    } else {
      return res
    }
  },
  (error) => {
    console.error('Response error:', error)
    // 可以在这里处理 HTTP 状态码错误，如 401, 403, 500 等
    return Promise.reject(error)
  }
)

/**
 * 封装的请求方法
 * 支持 request('/top/artist', { limit: 10 }) 形式调用
 */
const request = <T = any>(url: string, params?: any, config?: AxiosRequestConfig): Promise<T> => {
  // 判断请求方法，默认为 GET
  const method = config?.method || 'GET'
  
  const reqConfig: AxiosRequestConfig = {
    url,
    method,
    ...config
  }
  
  if (method.toUpperCase() === 'GET') {
    reqConfig.params = params
  } else {
    reqConfig.data = params
  }
  
  // 生成请求 key
  const requestKey = generateRequestKey(url, method.toUpperCase() === 'GET' ? params : undefined, method)
  
  // 检查是否有缓存（仅对 GET 请求）
  if (method.toUpperCase() === 'GET') {
    const cachedItem = cache[requestKey]
    if (cachedItem) {
      const now = Date.now()
      if (now - cachedItem.timestamp < CACHE_DURATION) {
        console.log('Using cached data for:', url)
        return Promise.resolve(cachedItem.data as T)
      } else {
        // 缓存过期，删除
        delete cache[requestKey]
      }
    }
  }
  
  // 检查是否有正在进行的相同请求
  if (pendingRequests[requestKey]) {
    console.log('Using pending request for:', url)
    return pendingRequests[requestKey] as Promise<T>
  }
  
  // 创建新请求
  const requestPromise = service(reqConfig).then((response) => {
    // 缓存 GET 请求的响应
    if (method.toUpperCase() === 'GET') {
      cache[requestKey] = {
        data: response,
        timestamp: Date.now()
      }
    }
    return response
  }).finally(() => {
    // 移除正在进行的请求
    delete pendingRequests[requestKey]
  })
  
  // 保存正在进行的请求
  pendingRequests[requestKey] = requestPromise
  
  return requestPromise as Promise<T>
}

// 清除缓存
const clearCache = (url?: string) => {
  if (url) {
    // 清除指定 URL 的缓存
    Object.keys(cache).forEach(key => {
      if (key.includes(url)) {
        delete cache[key]
      }
    })
  } else {
    // 清除所有缓存
    Object.keys(cache).forEach(key => {
      delete cache[key]
    })
  }
}

// 导出原始 axios 实例以便特殊需求使用
export { service, clearCache }

export default request
