<template>
  <n-modal
    v-model:show="showModal"
    preset="dialog"
    title="编辑音乐标签"
    style="width: 700px"
    :mask-closable="false"
  >
    <n-spin :show="loading">
      <n-form
        ref="formRef"
        :model="formModel"
        label-placement="top"
        label-width="auto"
        require-mark-placement="right-hanging"
        style="margin-top: 16px"
      >
        <n-tabs type="segment" animated>
          <!-- 基础信息 Tab -->
          <n-tab-pane name="basic" tab="基础信息">
            <n-grid :cols="2" :x-gap="24">
              <n-grid-item>
                <n-form-item label="歌名" path="title">
                  <n-input v-model:value="formModel.title" placeholder="输入歌曲标题" />
                </n-form-item>
              </n-grid-item>

              <n-grid-item>
                <n-form-item label="歌手" path="artist">
                  <n-input
                    v-model:value="formModel.artist"
                    placeholder="输入艺术家（多人用 / 分隔）"
                  />
                </n-form-item>
              </n-grid-item>

              <n-grid-item>
                <n-form-item label="专辑" path="album">
                  <n-input v-model:value="formModel.album" placeholder="输入专辑名称" />
                </n-form-item>
              </n-grid-item>

              <n-grid-item>
                <n-form-item label="年份" path="year">
                  <n-input-number
                    v-model:value="formModel.year"
                    placeholder="年份"
                    :show-button="false"
                    style="width: 100%"
                    clearable
                  />
                </n-form-item>
              </n-grid-item>
            </n-grid>

            <n-form-item label="歌词" path="lyrics" style="margin-top: 8px">
              <n-input
                v-model:value="formModel.lyrics"
                type="textarea"
                placeholder="输入歌词文本"
                :autosize="{ minRows: 8, maxRows: 12 }"
                style="font-family: monospace; font-size: 14px"
              />
            </n-form-item>
          </n-tab-pane>

          <!-- 封面编辑 Tab -->
          <n-tab-pane name="cover" tab="封面编辑">
            <div
              style="
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 24px;
                padding: 16px 0;
              "
            >
              <div
                style="
                  width: 180px;
                  height: 180px;
                  background-color: #f3f4f6;
                  border-radius: 8px;
                  overflow: hidden;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  border: 1px solid #e5e7eb;
                  position: relative;
                "
              >
                <img
                  v-if="previewCover"
                  :src="previewCover"
                  style="width: 100%; height: 100%; object-fit: cover"
                />
                <div
                  v-else
                  style="color: #9ca3af; display: flex; flex-direction: column; align-items: center"
                >
                  <n-icon size="64">
                    <i class="mgc_music_2_line" />
                  </n-icon>
                  <span style="font-size: 14px; margin-top: 12px">暂无封面</span>
                </div>
              </div>

              <div style="display: flex; gap: 16px">
                <n-upload
                  :show-file-list="false"
                  @change="handleCoverChange"
                  accept="image/jpeg,image/png,image/jpg"
                  :default-upload="false"
                >
                  <n-button>
                    <template #icon>
                      <n-icon><i class="mgc_pic_line" /></n-icon>
                    </template>
                    更换封面
                  </n-button>
                </n-upload>
                <n-button v-if="formModel.coverData" type="error" ghost @click="clearCover">
                  <template #icon>
                    <n-icon><i class="mgc_delete_line" /></n-icon>
                  </template>
                  清除封面
                </n-button>
              </div>

              <div style="color: #9ca3af; font-size: 12px; text-align: center; max-width: 300px">
                支持 JPG/PNG 格式图片，建议尺寸 500x500 以上
              </div>
            </div>
          </n-tab-pane>
        </n-tabs>
      </n-form>
    </n-spin>

    <template #action>
      <div style="display: flex; justify-content: flex-end; gap: 8px">
        <n-button @click="showModal = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="handleSave">保存修改</n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  NModal,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NButton,
  NIcon,
  NUpload,
  NSpin,
  NTabs,
  NTabPane,
  NGrid,
  NGridItem,
  useMessage,
  type UploadFileInfo
} from 'naive-ui'

interface Props {
  show: boolean
  filePath?: string
}

const props = defineProps<Props>()
const emit = defineEmits(['update:show', 'saved'])

const message = useMessage()
const loading = ref(false)
const saving = ref(false)

// Form data model
interface TagForm {
  title?: string
  artist?: string
  album?: string
  year?: number
  lyrics?: string
  coverData?: {
    mimeType: string
    base64: string // Base64 string without prefix
  }
}

const formModel = ref<TagForm>({})

// Computed property for v-model binding
const showModal = computed({
  get: () => props.show,
  set: (val) => emit('update:show', val)
})

// Preview URL for the cover image
const previewCover = computed(() => {
  if (formModel.value.coverData) {
    const { mimeType, base64 } = formModel.value.coverData
    if (!base64) return null
    // Ensure mimeType has a default
    const mime = mimeType || 'image/jpeg'
    return `data:${mime};base64,${base64}`
  }
  return null
})

// Load metadata when dialog opens
watch(
  () => props.show,
  async (val) => {
    if (val && props.filePath) {
      await loadMetadata(props.filePath)
    } else {
      formModel.value = {}
    }
  }
)

const loadMetadata = async (filePath: string) => {
  loading.value = true
  try {
    // Call IPC to get metadata
    const meta = await window.electron.ipcRenderer.invoke('local-music:get-meta', filePath)

    formModel.value = {
      title: meta.title,
      artist: meta.artists ? meta.artists.join(' / ') : undefined,
      album: meta.album,
      year: meta.year ? parseInt(meta.year) : undefined,
      lyrics: meta.lyrics,
      coverData: meta.cover // Expecting { mimeType, base64 }
    }
  } catch (error) {
    console.error('Failed to load metadata:', error)
    message.error('读取音乐信息失败')
  } finally {
    loading.value = false
  }
}

const handleCoverChange = async (options: { file: UploadFileInfo }) => {
  const file = options.file.file
  if (!file) return

  // 校验图片类型
  if (!['image/jpeg', 'image/png', 'image/jpg'].includes(file.type)) {
    message.error('仅支持 JPG/PNG 格式图片')
    return
  }
  // 转成 base64 以便写入音频标签
  const reader = new FileReader()
  reader.onload = (e) => {
    const result = e.target?.result as string
    // Remove data URL prefix to store just base64
    const base64 = result.split(',')[1]
    formModel.value.coverData = {
      mimeType: file.type,
      base64
    }
  }
  reader.readAsDataURL(file)
}

const clearCover = () => {
  formModel.value.coverData = undefined
}

const handleSave = async () => {
  if (!props.filePath) return

  saving.value = true
  try {
    // Prepare tags for node-id3
    const tags: any = {
      title: formModel.value.title,
      artist: formModel.value.artist,
      album: formModel.value.album,
      year: formModel.value.year,
      unsynchronisedLyrics: {
        language: 'eng',
        text: formModel.value.lyrics || ''
      }
    }

    // Handle cover image
    if (formModel.value.coverData) {
      tags.image = {
        mime: formModel.value.coverData.mimeType,
        type: {
          id: 3,
          name: 'front cover'
        },
        description: 'Cover',
        imageBuffer: formModel.value.coverData.base64
      }
    }

    // Call IPC to save
    await window.electron.ipcRenderer.invoke('local-music:write-meta', props.filePath, tags)

    message.success('保存成功')
    emit('saved')
    showModal.value = false
  } catch (error) {
    console.error('Failed to save tags:', error)
    message.error('保存失败: ' + (error as Error).message)
  } finally {
    saving.value = false
  }
}
</script>
