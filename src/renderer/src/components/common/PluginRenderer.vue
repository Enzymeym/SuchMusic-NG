<script setup lang="ts">
/**
 * PluginRenderer - 根据 JSON UI Schema 动态渲染插件界面
 * 使用 NaiveUI 组件，支持 input、text、tag、log 字段和操作按钮
 */
import { ref, watch } from 'vue'
import { NButton, NInput, NTag, NDivider, NSelect } from 'naive-ui'

interface UIField {
  type: 'input' | 'text' | 'log' | 'tag' | 'image' | 'select'
  key: string
  label?: string
  placeholder?: string
  readonly?: boolean
  action?: string
  width?: number
  height?: number
  optionsKey?: string
}

interface UIAction {
  type: 'button'
  label: string
  method: string
  variant?: 'primary' | 'default' | 'warning' | 'error'
}

interface UISection {
  title?: string
  description?: string
  fields?: UIField[]
  actions?: UIAction[]
}

interface UISchema {
  title?: string
  sections: UISection[]
}

const props = defineProps<{
  schema: UISchema
  values: Record<string, any>
  loading?: boolean
}>()

const emit = defineEmits<{
  (e: 'action', method: string): void
  (e: 'fieldAction', key: string, action: string): void
  (e: 'updateValue', key: string, value: any): void
}>()

// 本地输入缓冲
const localInputs = ref<Record<string, string>>({})

// 同步外部值到本地缓冲
watch(
  () => props.values,
  (vals) => {
    for (const key of Object.keys(vals)) {
      if (localInputs.value[key] === undefined) {
        localInputs.value[key] = vals[key] ?? ''
      }
    }
  },
  { immediate: true }
)

function getValue(key: string): any {
  return localInputs.value[key] ?? props.values[key] ?? ''
}

function handleInputUpdate(key: string, value: string): void {
  localInputs.value[key] = value
  emit('updateValue', key, value)
}

function handleAction(method: string): void {
  emit('action', method)
}

function handleFieldAction(key: string, action: string): void {
  emit('fieldAction', key, action)
}
</script>

<template>
  <div class="plugin-renderer" v-if="schema">
    <!-- 标题 -->
    <h3 v-if="schema.title" class="renderer-title">{{ schema.title }}</h3>

    <div v-for="(section, si) in schema.sections" :key="si" class="renderer-section">
      <!-- 区块标题 -->
      <div v-if="section.title" class="section-title">{{ section.title }}</div>
      <p v-if="section.description" class="section-desc">{{ section.description }}</p>

      <!-- 字段 -->
      <template v-for="field in section.fields" :key="field.key">
        <div class="field-wrapper">
          <label v-if="field.label" class="field-label">{{ field.label }}</label>

          <!-- input 文本框 -->
          <div v-if="field.type === 'input'" class="input-row">
            <n-input
              :value="getValue(field.key)"
              :placeholder="field.placeholder"
              :readonly="field.readonly"
              size="small"
              @update:value="(v: string) => handleInputUpdate(field.key, v)"
            />
            <n-button
              v-if="field.action"
              size="small"
              @click="handleFieldAction(field.key, field.action)"
            >
              {{ field.action === 'browse' ? '浏览' : field.action === 'browseDir' ? '选择目录' : field.action }}
            </n-button>
          </div>

          <!-- text 只读文本 -->
          <div v-else-if="field.type === 'text'" class="text-display">
            <span>{{ getValue(field.key) }}</span>
          </div>

          <!-- tag 标签 -->
          <n-tag
            v-else-if="field.type === 'tag'"
            :type="getValue(field.key) ? 'success' : 'warning'"
            size="small"
          >
            {{ getValue(field.key) }}
          </n-tag>

          <!-- log 日志输出 -->
          <pre
            v-else-if="field.type === 'log'"
            class="log-output"
          >{{ getValue(field.key) }}</pre>

          <!-- select 下拉选择 -->
          <n-select
            v-else-if="field.type === 'select'"
            :value="getValue(field.key)"
            :placeholder="field.placeholder"
            :options="getValue(field.optionsKey || 'optionsList') || []"
            size="small"
            clearable
            @update:value="(v: any) => handleInputUpdate(field.key, v)"
          />

          <!-- image 图片 -->
          <img
            v-else-if="field.type === 'image' && getValue(field.key)"
            :src="getValue(field.key)"
            :style="{
              width: field.width ? field.width + 'px' : '200px',
              height: field.height ? field.height + 'px' : 'auto'
            }"
            class="image-display"
          />
        </div>
      </template>

      <!-- 操作按钮 -->
      <div v-if="section.actions?.length" class="action-row">
        <n-button
          v-for="action in section.actions"
          :key="action.method"
          :type="action.variant === 'primary' ? 'primary'
            : action.variant === 'warning' ? 'warning'
            : action.variant === 'error' ? 'error'
            : 'default'"
          :ghost="action.variant !== 'primary'"
          size="small"
          :loading="loading"
          @click="handleAction(action.method)"
        >
          {{ action.label }}
        </n-button>
      </div>

      <n-divider v-if="si < schema.sections.length - 1" />
    </div>
  </div>
</template>

<style scoped>
.plugin-renderer {
  padding: 4px 0;
}

.renderer-title {
  font-size: 16px;
  font-weight: 700;
  margin: 0 0 12px;
  color: var(--n-text-color-1);
}

.renderer-section {
  margin-bottom: 4px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--n-text-color-2);
  margin-bottom: 8px;
}

.section-desc {
  font-size: 12px;
  color: var(--n-text-color-3);
  margin: 0 0 8px;
}

.field-wrapper {
  margin-bottom: 10px;
}

.field-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--n-text-color-3);
  margin-bottom: 4px;
}

.input-row {
  display: flex;
  gap: 8px;
}

.input-row > :first-child {
  flex: 1;
}

.text-display {
  font-size: 13px;
  color: var(--n-text-color-3);
  padding: 4px 8px;
  background: var(--n-action-color);
  border-radius: 4px;
  min-height: 26px;
  line-height: 26px;
}

.log-output {
  margin: 0;
  padding: 10px;
  border: 1px solid var(--n-border-color);
  border-radius: 6px;
  background: var(--n-action-color);
  font-size: 11px;
  font-family: monospace;
  color: var(--n-text-color-2);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 180px;
  overflow-y: auto;
}

.image-display {
  display: block;
  max-width: 100%;
  border: 1px solid var(--n-border-color);
  border-radius: 6px;
}

.action-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
}
</style>
