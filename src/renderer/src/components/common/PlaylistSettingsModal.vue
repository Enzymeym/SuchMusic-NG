<template>
  <n-modal
    :show="show"
    @update:show="$emit('update:show', $event)"
    preset="dialog"
    title="歌单设置"
    style="width: 400px"
  >
    <div class="settings-content">
      <!-- 布局风格设置 -->
      <div class="setting-item">
        <div class="setting-label">布局风格</div>
        <div class="setting-control">
          <n-radio-group :value="layoutStyle" @update:value="$emit('update:layoutStyle', $event)">
            <n-radio-button value="classic" label="经典 (网易云)" />
            <n-radio-button value="modern" label="现代 (沉浸式)" />
          </n-radio-group>
        </div>
        <div class="setting-desc">
          {{ layoutStyle === 'classic' ? '经典的三栏布局，信息清晰直观' : '沉浸式大背景，强调视觉体验' }}
        </div>
      </div>

      <n-divider />

      <!-- 这里可以预留其他设置，例如是否公开、是否允许评论等 -->
      <div class="setting-item">
        <div class="setting-label">隐私设置</div>
        <div class="setting-control">
          <n-switch :default-value="true" disabled>
            <template #checked>仅自己可见</template>
            <template #unchecked>公开</template>
          </n-switch>
        </div>
        <div class="setting-desc">暂不支持修改隐私设置</div>
      </div>
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import { NModal, NRadioGroup, NRadioButton, NDivider, NSwitch } from 'naive-ui'

defineProps<{
  show: boolean
  layoutStyle: 'classic' | 'modern'
}>()

defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'update:layoutStyle', value: 'classic' | 'modern'): void
}>()
</script>

<style scoped>
.settings-content {
  padding: 8px 0;
}

.setting-item {
  margin-bottom: 16px;
}

.setting-label {
  font-weight: 500;
  margin-bottom: 8px;
  font-size: 14px;
}

.setting-desc {
  margin-top: 6px;
  font-size: 12px;
  color: #999;
}
</style>
