<script setup lang="ts">
/**
 * 插件初始化弹窗组件
 * 用于插件首次启用时的配置流程
 * @author SuchMusic Plugin System
 */
import { ref, computed, watch, h } from 'vue'
import {
  NModal,
  NCard,
  NSteps,
  NStep,
  NButton,
  NSpin,
  NAlert,
  NDivider,
  NTag,
  NIcon,
  useThemeVars,
  useMessage
} from 'naive-ui'
import { usePluginStore } from '../../../stores/pluginStore'
import PluginConfigForm from './PluginConfigForm.vue'
import PluginDiscovery from './PluginDiscovery.vue'
import type { PluginInfo, PluginConfigItem, PluginSource } from '../../../types/plugin'

const themeVars = useThemeVars()
const message = useMessage()
const pluginStore = usePluginStore()

/**
 * 组件属性定义
 * @property show - 控制弹窗显示/隐藏
 * @property pluginId - 可选，指定要初始化的插件ID
 * @property pluginCode - 可选，直接传入插件代码进行初始化
 */
const props = defineProps<{
  show: boolean
  pluginId?: string
  pluginCode?: string
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'initialized', pluginId: string): void
  (e: 'cancel'): void
}>()

// 弹窗显示状态
const showModal = computed({
  get: () => props.show,
  set: (val) => emit('update:show', val)
})

// 当前步骤索引
const currentStep = ref(0)
// 步骤总数 (目前未直接使用，保留作为参考)
// const totalSteps = 4

// 加载状态
const loading = ref(false)
// 错误信息
const errorMessage = ref<string | null>(null)

// 当前处理的插件信息
const currentPlugin = ref<{
  id: string
  info: PluginInfo
  sources: PluginSource[]
  configUI: PluginConfigItem[]
  code: string
} | null>(null)

// 用户配置的存储
const userConfig = ref<Record<string, any>>({})

// 步骤标题
const stepTitles = ['发现插件', '验证插件', '配置插件', '完成初始化']

// 是否可以进入下一步
const canProceed = computed(() => {
  switch (currentStep.value) {
    case 0: // 发现插件 - 需要选择或导入插件
      return !!currentPlugin.value
    case 1: // 验证插件 - 验证通过
      return !!currentPlugin.value && !errorMessage.value
    case 2: // 配置插件 - 如果有配置项则必须完成
      if (!currentPlugin.value) return false
      if (currentPlugin.value.configUI.length === 0) return true
      // 检查所有必填项是否已填写
      return currentPlugin.value.configUI.every(item => {
        if (!item.required) return true
        const value = userConfig.value[item.id]
        return value !== undefined && value !== '' && value !== null
      })
    case 3: // 完成
      return true
    default:
      return false
  }
})

/**
 * 处理插件发现完成
 * @param plugin - 发现的插件信息
 */
const handlePluginDiscovered = async (plugin: {
  id: string
  code: string
  info: PluginInfo
  sources: PluginSource[]
  configUI: PluginConfigItem[]
}) => {
  currentPlugin.value = plugin
  userConfig.value = {}

  // 初始化默认值
  plugin.configUI.forEach(item => {
    if (item.defaultValue !== undefined) {
      userConfig.value[item.id] = item.defaultValue
    }
  })

  // 自动进入下一步
  currentStep.value = 1

  // 执行验证
  await validatePlugin()
}

/**
 * 验证插件
 */
const validatePlugin = async () => {
  if (!currentPlugin.value) return

  loading.value = true
  errorMessage.value = null

  try {
    const result = await pluginStore.validatePlugin(
      currentPlugin.value.id,
      currentPlugin.value.code
    )

    if (result.valid) {
      // 验证通过，延迟后自动进入配置步骤
      setTimeout(() => {
        if (currentPlugin.value!.configUI.length > 0) {
          currentStep.value = 2
        } else {
          // 没有配置项，直接完成
          currentStep.value = 3
        }
      }, 800)
    } else {
      errorMessage.value = result.error || '插件验证失败'
    }
  } catch (err: any) {
    errorMessage.value = err.message || '验证过程中发生错误'
  } finally {
    loading.value = false
  }
}

/**
 * 处理配置变更
 * @param config - 更新后的配置
 */
const handleConfigChange = (config: Record<string, any>) => {
  userConfig.value = { ...config }
}

/**
 * 完成初始化
 */
const finishInitialization = async () => {
  if (!currentPlugin.value) return

  loading.value = true

  try {
    // 保存插件配置
    await pluginStore.savePluginConfig(currentPlugin.value.id, userConfig.value)

    // 激活插件
    await pluginStore.activatePlugin(currentPlugin.value.id)

    message.success(`插件 "${currentPlugin.value.info.name}" 初始化成功！`)

    emit('initialized', currentPlugin.value.id)
    showModal.value = false

    // 重置状态
    resetState()
  } catch (err: any) {
    errorMessage.value = err.message || '初始化失败'
    message.error(errorMessage.value as string)
  } finally {
    loading.value = false
  }
}

/**
 * 重置状态
 */
const resetState = () => {
  currentStep.value = 0
  currentPlugin.value = null
  userConfig.value = {}
  errorMessage.value = null
  loading.value = false
}

/**
 * 处理取消
 */
const handleCancel = () => {
  emit('cancel')
  showModal.value = false
  resetState()
}

/**
 * 处理上一步
 */
const handlePrev = () => {
  if (currentStep.value > 0) {
    currentStep.value--
  }
}

/**
 * 处理下一步
 */
const handleNext = async () => {
  if (currentStep.value === 2) {
    // 配置步骤，进入完成步骤
    currentStep.value = 3
  } else if (currentStep.value === 3) {
    // 完成步骤
    await finishInitialization()
  } else if (canProceed.value) {
    currentStep.value++
  }
}

// 监听弹窗显示状态
watch(() => props.show, (newVal) => {
  if (newVal && props.pluginId) {
    // 如果指定了插件ID，加载插件信息
    loadPluginById(props.pluginId)
  }
})

/**
 * 根据ID加载插件
 */
const loadPluginById = async (id: string) => {
  loading.value = true
  try {
    const plugin = await pluginStore.getPluginById(id)
    if (plugin) {
      currentPlugin.value = plugin
      currentStep.value = 1
      await validatePlugin()
    }
  } catch (err: any) {
    errorMessage.value = err.message
  } finally {
    loading.value = false
  }
}

// 渲染步骤图标
const renderStepIcon = (index: number) => {
  const icons = ['mgc_search_line', 'mgc_shield_check_line', 'mgc_settings_3_line', 'mgc_check_circle_line']
  return () => h(NIcon, null, { default: () => h('i', { class: icons[index] }) })
}
</script>

<template>
  <n-modal
    v-model:show="showModal"
    :mask-closable="false"
    :esc-closable="false"
    style="width: 700px; max-width: 90vw;"
    preset="card"
    :title="currentPlugin ? `初始化插件: ${currentPlugin.info.name}` : '插件初始化向导'"
  >
    <div class="plugin-init-modal">
      <!-- 步骤条 -->
      <n-steps :current="currentStep" size="small" class="plugin-steps">
        <n-step
          v-for="(title, index) in stepTitles"
          :key="index"
          :title="title"
          :icon="renderStepIcon(index)"
        />
      </n-steps>

      <n-divider />

      <!-- 步骤内容 -->
      <div class="step-content">
        <!-- 步骤 0: 发现插件 -->
        <div v-if="currentStep === 0" class="step-panel">
          <plugin-discovery
            @plugin-discovered="handlePluginDiscovered"
            @error="(msg) => errorMessage = msg"
          />
        </div>

        <!-- 步骤 1: 验证插件 -->
        <div v-else-if="currentStep === 1" class="step-panel">
          <div v-if="loading" class="step-loading">
            <n-spin size="large" />
            <p>正在验证插件...</p>
          </div>

          <div v-else-if="errorMessage" class="step-error">
            <n-alert type="error" :title="'验证失败'">
              {{ errorMessage }}
            </n-alert>
            <div class="plugin-info-preview" v-if="currentPlugin">
              <h4>插件信息</h4>
              <p><strong>名称:</strong> {{ currentPlugin.info.name }}</p>
              <p><strong>版本:</strong> {{ currentPlugin.info.version }}</p>
              <p><strong>作者:</strong> {{ currentPlugin.info.author }}</p>
              <p v-if="currentPlugin.info.description">
                <strong>描述:</strong> {{ currentPlugin.info.description }}
              </p>
            </div>
          </div>

          <div v-else class="step-success">
            <n-alert type="success" title="验证通过">
              插件 "{{ currentPlugin?.info.name }}" 验证成功！
            </n-alert>
            <div class="plugin-info-preview">
              <h4>插件信息</h4>
              <p><strong>名称:</strong> {{ currentPlugin?.info.name }}</p>
              <p><strong>版本:</strong> {{ currentPlugin?.info.version }}</p>
              <p><strong>作者:</strong> {{ currentPlugin?.info.author }}</p>
              <p v-if="currentPlugin?.info.description">
                <strong>描述:</strong> {{ currentPlugin?.info.description }}
              </p>
              <div v-if="currentPlugin?.sources.length" class="plugin-sources">
                <strong>支持音源:</strong>
                <n-tag
                  v-for="source in currentPlugin.sources"
                  :key="source.id"
                  type="info"
                  size="small"
                  round
                >
                  {{ source.name }}
                </n-tag>
              </div>
            </div>
          </div>
        </div>

        <!-- 步骤 2: 配置插件 -->
        <div v-else-if="currentStep === 2" class="step-panel">
          <div v-if="currentPlugin?.configUI.length === 0" class="step-no-config">
            <n-alert type="info" title="无需配置">
              该插件没有需要配置的选项，点击"下一步"完成初始化。
            </n-alert>
          </div>
          <div v-else>
            <p class="config-hint">请完成以下配置项以启用插件：</p>
            <plugin-config-form
              :config-items="currentPlugin?.configUI || []"
              :model-value="userConfig"
              @update:model-value="handleConfigChange"
            />
          </div>
        </div>

        <!-- 步骤 3: 完成 -->
        <div v-else-if="currentStep === 3" class="step-panel">
          <div class="step-complete">
            <div class="complete-icon">
              <i class="mgc_check_circle_fill" :style="{ color: themeVars.successColor }" />
            </div>
            <h3>初始化完成！</h3>
            <p>插件 "{{ currentPlugin?.info.name }}" 已成功配置并激活。</p>
            <div class="complete-summary">
              <n-card size="small" title="配置摘要">
                <p><strong>插件名称:</strong> {{ currentPlugin?.info.name }}</p>
                <p><strong>版本:</strong> {{ currentPlugin?.info.version }}</p>
                <p><strong>作者:</strong> {{ currentPlugin?.info.author }}</p>
                <div v-if="Object.keys(userConfig).length > 0">
                  <strong>已配置项:</strong>
                  <ul>
                    <li v-for="(value, key) in userConfig" :key="key">
                      {{ key }}: {{ value }}
                    </li>
                  </ul>
                </div>
              </n-card>
            </div>
          </div>
        </div>
      </div>

      <n-divider />

      <!-- 底部按钮 -->
      <div class="modal-footer">
        <n-button @click="handleCancel">取消</n-button>
        <n-button
          v-if="currentStep > 0"
          @click="handlePrev"
          :disabled="loading"
        >
          上一步
        </n-button>
        <n-button
          v-if="currentStep < 3"
          type="primary"
          :disabled="!canProceed || loading"
          :loading="loading"
          @click="handleNext"
        >
          下一步
        </n-button>
        <n-button
          v-else
          type="primary"
          :loading="loading"
          @click="finishInitialization"
        >
          完成
        </n-button>
      </div>
    </div>
  </n-modal>
</template>

<style scoped lang="scss">
.plugin-init-modal {
  .plugin-steps {
    margin-bottom: 8px;
  }

  .step-content {
    min-height: 300px;
    max-height: 400px;
    overflow-y: auto;
  }

  .step-panel {
    padding: 8px 0;
  }

  .step-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 0;
    gap: 16px;
  }

  .step-error {
    .plugin-info-preview {
      margin-top: 16px;
      padding: 16px;
      background-color: var(--n-card-color);
      border-radius: 8px;

      h4 {
        margin: 0 0 12px 0;
        font-size: 14px;
      }

      p {
        margin: 8px 0;
        font-size: 13px;
      }
    }
  }

  .step-success {
    .plugin-info-preview {
      margin-top: 16px;
      padding: 16px;
      background-color: var(--n-card-color);
      border-radius: 8px;

      h4 {
        margin: 0 0 12px 0;
        font-size: 14px;
      }

      p {
        margin: 8px 0;
        font-size: 13px;
      }

      .plugin-sources {
        margin-top: 12px;

        .n-tag {
          margin-right: 8px;
          margin-top: 4px;
        }
      }
    }
  }

  .config-hint {
    margin-bottom: 16px;
    color: var(--n-text-color-3);
    font-size: 13px;
  }

  .step-no-config {
    padding: 40px 0;
  }

  .step-complete {
    text-align: center;
    padding: 20px 0;

    .complete-icon {
      font-size: 64px;
      margin-bottom: 16px;

      i {
        color: var(--n-success-color);
      }
    }

    h3 {
      margin: 0 0 8px 0;
      font-size: 18px;
    }

    p {
      color: var(--n-text-color-3);
      margin: 0 0 20px 0;
    }

    .complete-summary {
      text-align: left;
      max-width: 400px;
      margin: 0 auto;

      ul {
        margin: 8px 0;
        padding-left: 20px;

        li {
          font-size: 12px;
          color: var(--n-text-color-2);
        }
      }
    }
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }
}
</style>
