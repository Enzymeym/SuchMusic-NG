<script setup lang="ts">
import { onMounted, onUnmounted, h } from 'vue'
import { NButton, useNotification } from 'naive-ui'

const notification = useNotification()

/**
 * 处理插件更新通知
 * 监听主进程 plugin:notice IPC 事件，使用 NaiveUI Notification 展示
 * @param _event IPC 事件对象（不使用）
 * @param data 插件通知数据，包含 pluginName、type、data 字段
 */
function handlePluginNotice(_event: any, data: any): void {
  // 处理插件 notify 消息
  if (data.type === 'notify') {
    const { pluginName, message, notifyType } = data
    const method = notifyType === 'success' ? 'success'
      : notifyType === 'error' ? 'error'
      : notifyType === 'warning' ? 'warning'
      : 'info'
    notification[method]({
      title: pluginName || '插件通知',
      content: message,
      duration: 4000
    })
    return
  }

  if (data.type !== 'update') return

  const { pluginName, data: updateData } = data
  const updateUrl = updateData.url
  const body = updateData.content || ''

  const n = notification.info({
    title: `插件更新: ${pluginName}`,
    content: () => body,
    duration: 10000,
    closable: true,
    action: () =>
      h('div', { style: { display: 'flex', gap: '8px' } }, [
        h(
          NButton,
          {
            type: 'primary',
            size: 'small',
            onClick: async () => {
              n.destroy()
              try {
                const result = await window.electron.ipcRenderer.invoke(
                  'plugin:execute-hot-update',
                  pluginName,
                  updateUrl
                )
                if (result?.success) {
                  notification.success({
                    title: '更新完成',
                    content: `插件 ${pluginName} 已成功热更新`,
                    duration: 3000
                  })
                } else if (result?.error) {
                  notification.error({
                    title: '更新失败',
                    content: result.error,
                    duration: 5000
                  })
                }
              } catch (err: any) {
                notification.error({
                  title: '更新失败',
                  content: err.message || '未知错误',
                  duration: 5000
                })
              }
            }
          },
          { default: () => '立即更新' }
        ),
        h(
          NButton,
          {
            size: 'small',
            onClick: () => n.destroy()
          },
          { default: () => '忽略' }
        )
      ])
  })
}

onMounted(() => {
  if (window.electron?.ipcRenderer) {
    window.electron.ipcRenderer.on('plugin:notice', handlePluginNotice)
  }
})

onUnmounted(() => {
  if (window.electron?.ipcRenderer) {
    window.electron.ipcRenderer.removeAllListeners('plugin:notice')
  }
})
</script>

<template>
  <div />
</template>
