<script setup lang="ts">
/**
 * 插件配置表单组件
 * 根据 configUI 定义动态生成配置表单
 * @author SuchMusic Plugin System
 */
import { ref, watch } from 'vue'
import {
  NForm,
  NFormItem,
  NInput,
  NSwitch,
  NSelect,
  NInputNumber,
  NRadio,
  NRadioGroup,
  NCheckbox,
  NCheckboxGroup,
  NTooltip,
  NIcon
} from 'naive-ui'
import type { PluginConfigItem } from '../../../types/plugin'

/**
 * 组件属性定义
 * @property configItems - 配置项定义数组
 * @property modelValue - 当前配置值
 */
const props = defineProps<{
  configItems: PluginConfigItem[]
  modelValue: Record<string, any>
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, any>): void
}>()

// 本地配置值
const localConfig = ref<Record<string, any>>({ ...props.modelValue })

// 监听外部值变化
watch(() => props.modelValue, (newVal) => {
  localConfig.value = { ...newVal }
}, { deep: true })

// 监听本地值变化并通知父组件
watch(localConfig, (newVal) => {
  emit('update:modelValue', { ...newVal })
}, { deep: true })

/**
 * 处理配置项变更
 * @param key - 配置项ID
 * @param value - 新值
 */
const handleConfigChange = (key: string, value: any) => {
  localConfig.value[key] = value
}

/**
 * 获取配置项的当前值
 * @param item - 配置项定义
 * @returns 当前值或默认值
 */
const getConfigValue = (item: PluginConfigItem): any => {
  const value = localConfig.value[item.id]
  if (value !== undefined) return value
  return item.defaultValue
}

/**
 * 处理 emit 回调
 * @param item - 配置项定义
 * @param value - 新值
 */
const handleEmitCallback = async (item: PluginConfigItem, value: any) => {
  if (item.emit) {
    // 触发回调，实际逻辑由父组件处理
    emit('update:modelValue', {
      ...localConfig.value,
      [`__callback_${item.emit}`]: value
    })
  }
}

/**
 * 获取表单验证规则
 * @param item - 配置项定义
 * @returns 验证规则
 */
const getValidationRules = (item: PluginConfigItem) => {
  const rules: any[] = []

  if (item.required) {
    rules.push({
      required: true,
      message: `${item.name} 为必填项`,
      trigger: ['blur', 'change']
    })
  }

  if (item.validation?.pattern) {
    rules.push({
      pattern: new RegExp(item.validation.pattern),
      message: item.validation.message || '格式不正确',
      trigger: 'blur'
    })
  }

  return rules
}
</script>

<template>
  <n-form
    :model="localConfig"
    label-placement="left"
    label-width="120px"
    size="medium"
    class="plugin-config-form"
  >
    <n-form-item
      v-for="item in configItems"
      :key="item.id"
      :label="item.name"
      :path="item.id"
      :rule="getValidationRules(item)"
      class="config-form-item"
    >
      <template #label>
        <n-tooltip v-if="item.description" trigger="hover">
          <template #trigger>
            <span class="config-label">
              {{ item.name }}
              <n-icon class="info-icon">
                <i class="mgc_information_line" />
              </n-icon>
            </span>
          </template>
          {{ item.description }}
        </n-tooltip>
        <span v-else>{{ item.name }}</span>
      </template>

      <!-- 输入框类型 -->
      <n-input
        v-if="item.type === 'input'"
        :value="getConfigValue(item)"
        :placeholder="item.placeholder || `请输入${item.name}`"
        :type="(item.inputType as any) || 'text'"
        :disabled="item.disabled"
        @update:value="(val) => { handleConfigChange(item.id, val); handleEmitCallback(item, val); }"
      />

      <!-- 开关类型 -->
      <n-switch
        v-else-if="item.type === 'switch'"
        :value="getConfigValue(item) ?? false"
        :disabled="item.disabled"
        @update:value="(val) => { handleConfigChange(item.id, val); handleEmitCallback(item, val); }"
      />

      <!-- 下拉选择类型 -->
      <n-select
        v-else-if="item.type === 'dropdown'"
        :value="getConfigValue(item)"
        :options="item.dropdown?.map(opt => ({ label: opt.label, value: opt.id })) || []"
        :placeholder="item.placeholder || `请选择${item.name}`"
        :disabled="item.disabled"
        @update:value="(val) => { handleConfigChange(item.id, val); handleEmitCallback(item, val); }"
      />

      <!-- 数字输入类型 -->
      <n-input-number
        v-else-if="item.type === 'number'"
        :value="getConfigValue(item)"
        :min="item.validation?.min"
        :max="item.validation?.max"
        :placeholder="item.placeholder"
        :disabled="item.disabled"
        style="width: 100%"
        @update:value="(val) => { handleConfigChange(item.id, val); handleEmitCallback(item, val); }"
      />

      <!-- 单选类型 -->
      <n-radio-group
        v-else-if="item.type === 'radio'"
        :value="getConfigValue(item)"
        :disabled="item.disabled"
        @update:value="(val) => { handleConfigChange(item.id, val); handleEmitCallback(item, val); }"
      >
        <n-radio
          v-for="opt in item.dropdown"
          :key="opt.id"
          :value="opt.id"
        >
          {{ opt.label }}
        </n-radio>
      </n-radio-group>

      <!-- 多选类型 -->
      <n-checkbox-group
        v-else-if="item.type === 'checkbox'"
        :value="getConfigValue(item) || []"
        :disabled="item.disabled"
        @update:value="(val) => { handleConfigChange(item.id, val); handleEmitCallback(item, val); }"
      >
        <n-checkbox
          v-for="opt in item.dropdown"
          :key="opt.id"
          :value="opt.id"
        >
          {{ opt.label }}
        </n-checkbox>
n      </n-checkbox-group>

      <!-- 文本域类型 -->
      <n-input
        v-else-if="item.type === 'textarea'"
        :value="getConfigValue(item)"
        type="textarea"
        :placeholder="item.placeholder || `请输入${item.name}`"
        :rows="item.rows || 4"
        :disabled="item.disabled"
        @update:value="(val) => { handleConfigChange(item.id, val); handleEmitCallback(item, val); }"
      />

      <!-- 密码输入类型 -->
      <n-input
        v-else-if="item.type === 'password'"
        :value="getConfigValue(item)"
        type="password"
        :placeholder="item.placeholder || `请输入${item.name}`"
        :disabled="item.disabled"
        show-password-on="mousedown"
        @update:value="(val) => { handleConfigChange(item.id, val); handleEmitCallback(item, val); }"
      />

      <!-- 默认类型 -->
      <n-input
        v-else
        :value="getConfigValue(item)"
        :placeholder="item.placeholder || `请输入${item.name}`"
        :disabled="item.disabled"
        @update:value="(val) => { handleConfigChange(item.id, val); handleEmitCallback(item, val); }"
      />

      <!-- 配置项描述 -->
      <template v-if="item.description && !item.descriptionInTooltip" #feedback>
        <span class="config-description">{{ item.description }}</span>
      </template>
    </n-form-item>
  </n-form>
</template>

<style scoped lang="scss">
.plugin-config-form {
  .config-form-item {
    margin-bottom: 16px;
  }

  .config-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: help;

    .info-icon {
      font-size: 14px;
      color: var(--n-text-color-3);
    }
  }

  .config-description {
    font-size: 12px;
    color: var(--n-text-color-3);
  }

  :deep(.n-form-item-label) {
    font-weight: 500;
  }

  :deep(.n-radio-group) {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  :deep(.n-checkbox-group) {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
}
</style>
