<script setup lang="ts">
/**
 * 插件通知气泡
 *
 * 只负责「插件主动 notify」与「发现新版本」两类用户可见提示。
 * v2 不再支持热更新（插件脚本需下载后重新导入覆盖），因此这里不提供一键更新按钮。
 */
import { onMounted, onUnmounted } from 'vue'
import { useNotification } from 'naive-ui'
import type { PluginNotice } from '../../../../shared/plugin/types'

const notification = useNotification()
let off: (() => void) | null = null

function handleNotice(data: PluginNotice): void {
  if (data.type === 'notify') {
    const method =
      data.notifyType === 'success'
        ? 'success'
        : data.notifyType === 'error'
          ? 'error'
          : data.notifyType === 'warning'
            ? 'warning'
            : 'info'
    notification[method]({
      title: data.pluginName || '插件通知',
      content: data.message || '',
      duration: 4000
    })
    return
  }

  if (data.type === 'updateAlert') {
    notification.info({
      title: `插件更新：${data.pluginName || data.pluginId}`,
      content: data.message || '发现新版本，请下载新脚本后在设置页重新导入覆盖',
      duration: 8000,
      closable: true
    })
  }
}

onMounted(() => {
  off = window.api.plugins.onNotice(handleNotice)
})

onUnmounted(() => {
  off?.()
  off = null
})
</script>

<template>
  <div />
</template>
