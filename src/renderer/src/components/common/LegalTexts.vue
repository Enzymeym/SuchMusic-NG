<script setup lang="ts">
/**
 * 法律文本展示组件
 * 渲染"用户协议与隐私政策"与"在线服务声明"两个章节
 * 用于首次开屏引导与设置"关于"页，由父组件控制滚动容器
 */
import { USER_AGREEMENT_TEXT, ONLINE_SERVICE_DECLARATION } from '../../constants/legalTexts'
</script>

<template>
  <div class="legal-section">
    <div class="legal-section-title">用户协议与隐私政策</div>
    <div class="legal-text">{{ USER_AGREEMENT_TEXT }}</div>
  </div>
  <div class="legal-section">
    <div class="legal-section-title">在线服务声明</div>
    <div class="legal-text">{{ ONLINE_SERVICE_DECLARATION }}</div>
  </div>
</template>

<style scoped>
.legal-section {
  background: var(--n-action-color);
  border-radius: 10px;
  padding: 12px 14px;
}

.legal-section + .legal-section {
  margin-top: 12px;
}

.legal-section-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 8px;
}

.legal-text {
  font-size: 12px;
  line-height: 1.75;
  color: var(--n-text-color-3, rgba(128, 128, 128, 1));
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
