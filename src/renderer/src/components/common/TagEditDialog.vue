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

          <!-- 自动匹配 Tab -->
          <n-tab-pane name="match" tab="自动匹配">
            <n-form
              ref="matchFormRef"
              :model="matchForm"
              :rules="matchRules"
              label-placement="top"
              require-mark-placement="right-hanging"
            >
              <n-alert type="info" :bordered="false" style="margin-bottom: 16px">
                填写歌名（必填）等信息，从在线曲库搜索歌曲并将匹配到的标签自动填充到上方表单；匹配后可一键撤销，恢复匹配前的标签。
              </n-alert>

              <n-grid :cols="2" :x-gap="24">
                <n-grid-item>
                  <n-form-item label="歌名" path="title">
                    <n-input v-model:value="matchForm.title" placeholder="必填，作为在线搜索关键词" />
                  </n-form-item>
                </n-grid-item>
                <n-grid-item>
                  <n-form-item label="歌手">
                    <n-input v-model:value="matchForm.artist" placeholder="可选，多个歌手用空格分隔" />
                  </n-form-item>
                </n-grid-item>
              </n-grid>

              <div style="display: flex; gap: 8px; margin-bottom: 16px">
                <n-button type="primary" :loading="matchLoading" @click="handleMatchSearch">
                  <template #icon>
                    <n-icon><i class="mgc_search_line" /></n-icon>
                  </template>
                  搜索匹配
                </n-button>
                <n-button
                  v-if="appliedMatch"
                  type="warning"
                  ghost
                  :disabled="matchLoading"
                  @click="undoMatch"
                >
                  <template #icon>
                    <n-icon><i class="mgc_history_line" /></n-icon>
                  </template>
                  撤销匹配
                </n-button>
              </div>

              <template v-if="matchResults.length">
                <n-form-item label="选择匹配结果" required>
                  <n-radio-group v-model:value="matchSelectedId" style="width: 100%">
                    <n-space direction="vertical" size="small" style="width: 100%">
                      <n-radio
                        v-for="item in matchResults"
                        :key="item.id"
                        :value="item.id"
                        style="width: 100%"
                      >
                        <div style="display: flex; align-items: center; gap: 12px; padding: 4px 0">
                          <n-image
                            v-if="item.coverUrl"
                            :src="item.coverUrl"
                            width="36"
                            height="36"
                            object-fit="cover"
                            style="border-radius: 4px; flex-shrink: 0"
                          />
                          <div>
                            <div style="font-weight: 500">{{ item.name }}</div>
                            <div style="font-size: 12px; color: #888">
                              {{ item.artists }}<template v-if="item.album"> · {{ item.album }}</template>
                            </div>
                          </div>
                        </div>
                      </n-radio>
                    </n-space>
                  </n-radio-group>
                </n-form-item>
                <div style="display: flex; justify-content: flex-end">
                  <n-button
                    type="primary"
                    :disabled="!matchSelectedId"
                    :loading="applyingMatch"
                    @click="applyMatch"
                  >
                    <template #icon>
                      <n-icon><i class="mgc_check_line" /></n-icon>
                    </template>
                    应用到标签
                  </n-button>
                </div>
              </template>

              <n-empty
                v-else-if="searched && !matchLoading"
                style="padding: 24px 0"
                description="未找到匹配结果"
              />
            </n-form>
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
import { ref, computed, watch, reactive } from 'vue'
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
  NAlert,
  NRadio,
  NRadioGroup,
  NSpace,
  NImage,
  NEmpty,
  useMessage,
  type UploadFileInfo,
  type FormInst
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

// ==================== 自动匹配 ====================
// 在线曲库匹配结果项
interface MatchResult {
  id: number
  name: string
  artists: string
  album: string
  coverUrl: string
}

// 匹配关键词表单（歌名为必填信息）
const matchFormRef = ref<FormInst | null>(null)
const matchForm = reactive({ title: '', artist: '' })
const matchRules = {
  title: { required: true, message: '请输入歌名', trigger: ['blur', 'input'] }
}

const matchLoading = ref(false)
const matchResults = ref<MatchResult[]>([])
const matchSelectedId = ref<number | null>(null)
const searched = ref(false)
const applyingMatch = ref(false)
const appliedMatch = ref(false)
// 匹配前标签快照，用于撤销
const undoSnapshot = ref<TagForm | null>(null)

// 重置自动匹配相关状态
const resetMatchState = () => {
  matchForm.title = ''
  matchForm.artist = ''
  matchResults.value = []
  matchSelectedId.value = null
  searched.value = false
  appliedMatch.value = false
  undoSnapshot.value = null
}

// 在线搜索歌词匹配结果
const handleMatchSearch = async () => {
  try {
    await matchFormRef.value?.validate()
  } catch {
    return
  }
  const keyword = `${matchForm.title} ${matchForm.artist}`.trim()
  if (!keyword) return

  matchLoading.value = true
  searched.value = true
  matchResults.value = []
  matchSelectedId.value = null
  appliedMatch.value = false
  undoSnapshot.value = null
  try {
    const res = await window.electron.ipcRenderer.invoke('netease:search', keyword, 0, 10)
    const songs = res?.songs || []
    matchResults.value = songs.map((s: any) => ({
      id: s.id,
      name: s.name,
      artists: (s.ar || []).map((a: any) => a.name).join(' / '),
      album: s.al?.name || '',
      coverUrl: s.al?.picUrl || ''
    }))
    if (!matchResults.value.length) {
      message.warning('未找到匹配结果')
    }
  } catch (error) {
    console.error('自动匹配搜索失败:', error)
    message.error('搜索失败')
  } finally {
    matchLoading.value = false
  }
}

// 将选中的匹配结果应用到标签表单，并保存快照用于撤销
const applyMatch = async () => {
  const item = matchResults.value.find((r) => r.id === matchSelectedId.value)
  if (!item) return

  applyingMatch.value = true
  try {
    // 快照当前标签，供「撤销匹配」恢复
    undoSnapshot.value = JSON.parse(JSON.stringify(formModel.value))

    formModel.value = {
      ...formModel.value,
      title: item.name,
      artist: item.artists,
      album: item.album
    }

    // 并行拉取封面与歌词（任一失败不影响其余字段填充）
    const [cover, lyric] = await Promise.all([
      item.coverUrl
        ? window.electron.ipcRenderer
            .invoke('local-music:fetch-cover', item.coverUrl)
            .catch(() => null)
        : Promise.resolve(null),
      item.id
        ? window.electron.ipcRenderer
            .invoke('lyric:fetch-wy', String(item.id))
            .catch(() => null)
        : Promise.resolve(null)
    ])

    if (cover?.mimeType && cover?.base64) {
      formModel.value = {
        ...formModel.value,
        coverData: { mimeType: cover.mimeType, base64: cover.base64 }
      }
    }
    if (lyric?.lyrics) {
      formModel.value = { ...formModel.value, lyrics: lyric.lyrics }
    }

    appliedMatch.value = true
    message.success('已应用匹配标签，可点击「撤销匹配」恢复')
  } catch (error) {
    console.error('应用匹配标签失败:', error)
    message.error('应用匹配标签失败')
  } finally {
    applyingMatch.value = false
  }
}

// 撤销匹配，恢复匹配前的标签
const undoMatch = () => {
  if (!undoSnapshot.value) return
  formModel.value = undoSnapshot.value
  undoSnapshot.value = null
  appliedMatch.value = false
  matchSelectedId.value = null
  message.success('已撤销匹配')
}

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
      resetMatchState()
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

    // 预填自动匹配必填信息，并重置匹配状态
    resetMatchState()
    matchForm.title = meta.title || ''
    matchForm.artist = meta.artists ? meta.artists.join(' ') : ''
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
