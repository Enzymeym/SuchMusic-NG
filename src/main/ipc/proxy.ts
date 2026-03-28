import { ipcMain } from 'electron'
import axios from 'axios'

export function registerProxyHandlers() {
  ipcMain.handle('proxy:request', async (_, { url, method = 'GET', params, data, headers, responseType }) => {
    try {
      const response = await axios({
        url,
        method,
        params,
        data,
        headers,
        responseType,
        // 忽略 SSL 证书错误（如果需要）
        // httpsAgent: new https.Agent({ rejectUnauthorized: false })
      })
      return {
        success: true,
        data: response.data,
        status: response.status,
        headers: response.headers
      }
    } catch (error: any) {
      console.error('Proxy request failed:', error.message)
      return {
        success: false,
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      }
    }
  })
}
