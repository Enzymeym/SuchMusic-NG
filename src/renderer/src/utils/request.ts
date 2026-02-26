import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios'

// 基础 URL
const BASE_URL = 'https://api.enzymeym.top'

// 创建 axios 实例
const service: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 15000, // 请求超时时间
  headers: {
    'Content-Type': 'application/json;charset=utf-8'
  },
  // 允许跨域携带 cookie
  withCredentials: true
})

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
    if (res.code && res.code !== 200) {
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
  
  return service(reqConfig) as Promise<T>
}

// 导出原始 axios 实例以便特殊需求使用
export { service }

export default request
