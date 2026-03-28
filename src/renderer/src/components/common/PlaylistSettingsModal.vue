<template>
  <n-modal
    :show="show"
    @update:show="$emit('update:show', $event)"
    preset="card"
    class="playlist-settings-modal"
    :style="{ width: '480px', borderRadius: '16px', overflow: 'hidden' }"
    :title="undefined"
    :header-style="{ display: 'none' }"
    :content-style="{ padding: 0 }"
  >
    <div class="modal-container">
      <!-- 顶部标题区域 -->
      <div class="modal-header">
        <div class="title">编辑歌单</div>
        <div class="subtitle">查看和修改一些附加信息</div>
        <div class="close-btn" @click="$emit('update:show', false)">
          <n-icon size="20"><i class="mgc_close_line"></i></n-icon>
        </div>
      </div>

      <!-- 预览区域 -->
      <div class="preview-area" :style="previewStyle">
        <div class="preview-content">
          <img :src="cover || defaultCover" class="preview-cover" :class="form.coverStyle" />
          <div class="preview-title" :style="titleStyle">{{ form.name || '歌单名称' }}</div>
        </div>
        <!-- 背景模糊 -->
        <div class="preview-bg" :style="{ backgroundImage: `url(${cover || defaultCover})` }"></div>
      </div>

      <!-- 表单区域 -->
      <div class="form-area">
        <div v-show="activeTab === 'general'">
          <div class="form-item">
            <div class="label"><n-icon><i class="mgc_text_2_line"></i></n-icon> 名称</div>
            <n-input v-if="playlist?.id !== 'favorite'" v-model:value="form.name" placeholder="歌单名称" />
             <div v-else class="info-text">
              “我喜爱的音乐”歌单是系统默认歌单，暂不支持修改名称。
            </div>
          </div>

          <div class="form-item">
            <div class="label"><n-icon><i class="mgc_pic_line"></i></n-icon> 样式</div>
            <n-select v-model:value="form.coverStyle" :options="coverStyleOptions" />
          </div>

          <div class="section-title">字设计</div>

          <div class="form-item">
            <div class="label"><strong>B</strong> 字重</div>
            <n-select v-model:value="form.titleFontWeight" :options="fontWeightOptions" />
          </div>

          <div class="form-item">
            <div class="label"><n-icon><i class="mgc_font_line"></i></n-icon> 字体</div>
            <n-select v-model:value="form.titleFontFamily" :options="fontFamilyOptions" />
          </div>
        </div>

        <div v-show="activeTab === 'detail'">
          <div class="form-item">
            <div class="label"><n-icon><i class="mgc_text_align_left_line"></i></n-icon> 描述</div>
            <n-input 
              v-if="playlist?.id !== 'favorite'"
              v-model:value="form.description" 
              type="textarea" 
              placeholder="为歌单添加描述..." 
              :autosize="{ minRows: 6, maxRows: 10 }"
            />
            <div v-else class="info-text">
              “我喜爱的音乐”歌单是系统默认歌单，暂不支持修改描述。
            </div>
          </div>
        </div>
      </div>

      <!-- 底部 Tabs 和 操作栏 -->
      <div class="modal-footer">
        <div class="tabs">
          <div 
            class="tab-item" 
            :class="{ active: activeTab === 'general' }"
            @click="activeTab = 'general'"
          >
            常规
          </div>
          <div 
            class="tab-item" 
            :class="{ active: activeTab === 'detail' }"
            @click="activeTab = 'detail'"
          >
            详情
          </div>
        </div>

        <div class="actions">
          <n-button 
            v-if="playlist?.id !== 'favorite'"
            type="error" 
            secondary 
            @click="handleDelete" 
            class="delete-btn"
          >
            删除歌单
          </n-button>
          <n-button type="primary" @click="handleSave" class="save-btn">
            完成
          </n-button>
        </div>
      </div>
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NModal, NInput, NSelect, NIcon, NButton, useMessage, useDialog } from 'naive-ui'
import type { UserPlaylist } from '../../stores/playlistStore'
import defaultCoverIcon from '@renderer/assets/icon.png'

const props = defineProps<{
  show: boolean
  playlist: UserPlaylist | null
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'save', playlist: UserPlaylist): void
  (e: 'delete', id: string): void
}>()

const message = useMessage()
const dialog = useDialog()
const activeTab = ref<'general' | 'detail'>('general')
const defaultCover = defaultCoverIcon

// 表单数据
const form = ref({
  name: '',
  description: '',
  coverStyle: 'square',
  titleFontWeight: 'bold',
  titleFontFamily: 'default'
})

// 监听 playlist 变化，初始化表单
watch(
  () => props.playlist,
  (newVal) => {
    if (newVal) {
      form.value = {
        name: newVal.name,
        description: newVal.description || '',
        coverStyle: newVal.coverStyle || 'square',
        titleFontWeight: newVal.titleFontWeight || 'bold',
        titleFontFamily: newVal.titleFontFamily || 'default'
      }
    }
  },
  { immediate: true }
)

const cover = computed(() => props.playlist?.cover || (props.playlist?.tracks[0]?.cover))

// 预览样式计算
const previewStyle = computed(() => {
  return {
    position: 'relative' as const,
    height: '180px',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    borderRadius: '12px',
    margin: '0 20px 20px'
  }
})

const titleStyle = computed(() => {
  const weightMap: Record<string, string> = {
    light: '300',
    regular: '400',
    bold: '700',
    heavy: '900'
  }
  
  return {
    fontWeight: weightMap[form.value.titleFontWeight] || 'bold',
    fontFamily: form.value.titleFontFamily === 'serif' ? '"SHSC", serif' : 'inherit',
    fontSize: '24px',
    textShadow: '0 2px 4px rgba(0,0,0,0.3)',
    zIndex: 2,
    marginLeft: '16px'
  }
})

// 选项配置
const coverStyleOptions = [
  { label: '正方形', value: 'square' },
  { label: '全尺寸', value: 'full' }
]

const fontWeightOptions = [
  { label: '轻体', value: 'light' },
  { label: '常规', value: 'regular' },
  { label: '重体', value: 'bold' },
  { label: '特重', value: 'heavy' }
]

const fontFamilyOptions = [
  { label: '默认', value: 'default' },
  { label: '衬线体', value: 'serif' }
]

const handleSave = () => {
  if (!props.playlist) return
  emit('save', {
    ...props.playlist,
    name: form.value.name,
    description: form.value.description,
    coverStyle: form.value.coverStyle as any,
    titleFontWeight: form.value.titleFontWeight as any,
    titleFontFamily: form.value.titleFontFamily as any
  })
  emit('update:show', false)
  message.success('已保存修改')
}

const handleDelete = () => {
  dialog.warning({
    title: '确认删除',
    content: '确定要删除这个歌单吗？此操作无法撤销。',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      if (props.playlist) {
        emit('delete', props.playlist.id)
        emit('update:show', false)
      }
    }
  })
}
</script>

<style scoped>
.modal-container {
  background: #fff;
  display: flex;
  flex-direction: column;
}

html[data-theme='dark'] .modal-container {
  background: #1f1f1f;
}

.modal-header {
  padding: 20px 20px 16px;
  position: relative;
}

.title {
  font-size: 18px;
  font-weight: bold;
}

.subtitle {
  font-size: 12px;
  color: #999;
  margin-top: 4px;
}

.close-btn {
  position: absolute;
  top: 20px;
  right: 20px;
  cursor: pointer;
  color: #999;
}

.info-text {
  font-size: 13px;
  color: var(--n-text-color-3);
  line-height: 1.5;
  padding: 8px 0;
}

.preview-content {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  padding: 20px;
  width: 100%;
}

.preview-cover {
  width: 100px;
  height: 100px;
  object-fit: cover;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  transition: all 0.3s ease;
}

/* 封面样式类 */
.preview-cover.square { aspect-ratio: 1/1; }
.preview-cover.full { width: 100%; height: 100%; position: absolute; top: 0; left: 0; opacity: 0.8; z-index: -1; border-radius: 0; }

.preview-bg {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-size: cover;
  background-position: center;
  filter: blur(20px) brightness(0.7);
  z-index: 1;
}

.form-area {
  padding: 0 20px 20px;
}

.form-item {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
}

.form-item .label {
  width: 100px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: #666;
}

.section-title {
  font-size: 12px;
  color: #999;
  margin: 24px 0 12px;
  font-weight: bold;
}

.modal-footer {
  margin-top: auto;
  padding: 12px 20px;
  background: #f9f9f9;
  display: flex;
  flex-direction: column;
  gap: 16px;
  border-top: 1px solid #eee;
}

html[data-theme='dark'] .modal-footer {
  background: #2a2a2a;
  border-top-color: #333;
}

.tabs {
  display: flex;
  justify-content: center;
  gap: 4px;
  background: #eee;
  padding: 4px;
  border-radius: 8px;
  align-self: center;
  width: 100%;
}

html[data-theme='dark'] .tabs {
  background: #333;
}

.tab-item {
  flex: 1;
  text-align: center;
  padding: 6px 0;
  font-size: 13px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  color: #666;
}

.tab-item.active {
  background: #fff;
  color: #333;
  font-weight: 500;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

html[data-theme='dark'] .tab-item.active {
  background: #444;
  color: #fff;
}

.actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.delete-btn {
  width: 100px;
}

.save-btn {
  flex: 1;
  margin-left: 12px;
}
</style>
