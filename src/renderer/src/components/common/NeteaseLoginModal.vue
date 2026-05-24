<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { NModal, NButton, NSpin, useMessage } from 'naive-ui'
import {
  getQrKey,
  createQrCode,
  checkQrStatus,
  type QrCheckResponse
} from '../../apis/netease/login'
import { useUserStore } from '../../stores/userStore'

/**
 * 组件属性定义
 */
const props = defineProps<{
  show: boolean
}>()

/**
 * 组件事件定义
 */
const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'login-success'): void
}>()

const message = useMessage()
const userStore = useUserStore()

/**
 * 控制弹窗显示状态
 */
const showModal = computed({
  get: () => props.show,
  set: (val) => emit('update:show', val)
})

/**
 * 二维码状态码枚举
 */
enum QrStatusCode {
  EXPIRED = 800,      // 二维码过期
  WAITING = 801,      // 等待扫码
  CONFIRMING = 802,   // 待确认
  SUCCESS = 803       // 授权登录成功
}

/**
 * 当前二维码 key
 */
const qrKey = ref<string>('')

/**
 * 二维码图片 base64
 */
const qrImage = ref<string>('')

/**
 * 当前二维码状态
 */
const qrStatus = ref<QrStatusCode>(QrStatusCode.WAITING)

/**
 * 是否正在加载中
 */
const loading = ref(false)

/**
 * 是否已经登录成功（用于防止登录成功后还更新二维码状态）
 */
const hasLoginSuccess = ref(false)

/**
 * 轮询定时器 ID
 */
let pollTimer: ReturnType<typeof setInterval> | null = null

/**
 * 二维码状态文本
 */
const statusText = computed(() => {
  switch (qrStatus.value) {
    case QrStatusCode.WAITING:
      return '请使用网易云音乐 APP 扫码登录'
    case QrStatusCode.CONFIRMING:
      return '请在手机上确认登录'
    case QrStatusCode.EXPIRED:
      return '二维码已过期，请点击刷新'
    case QrStatusCode.SUCCESS:
      return '登录成功'
    default:
      return '请使用网易云音乐 APP 扫码登录'
  }
})

/**
 * 二维码状态样式类
 */
const statusClass = computed(() => {
  switch (qrStatus.value) {
    case QrStatusCode.WAITING:
      return 'status-waiting'
    case QrStatusCode.CONFIRMING:
      return 'status-confirming'
    case QrStatusCode.EXPIRED:
      return 'status-expired'
    case QrStatusCode.SUCCESS:
      return 'status-success'
    default:
      return 'status-waiting'
  }
})

/**
 * 是否显示刷新按钮
 */
const showRefresh = computed(() => {
  return qrStatus.value === QrStatusCode.EXPIRED
})

/**
 * 是否显示二维码
 */
const showQrCode = computed(() => {
  return qrImage.value && qrStatus.value !== QrStatusCode.SUCCESS
})

/**
 * 生成二维码
 */
async function generateQrCode(): Promise<void> {
  loading.value = true
  try {
    // 获取 key
    const key = await getQrKey()
    if (!key) {
      message.error('获取二维码失败，请重试')
      return
    }
    qrKey.value = key

    // 生成二维码
    const qrData = await createQrCode(key)
    if (!qrData) {
      message.error('生成二维码失败，请重试')
      return
    }
    qrImage.value = qrData.qrimg
    qrStatus.value = QrStatusCode.WAITING

    // 开始轮询
    startPolling()
  } catch (error) {
    console.error('[NeteaseLoginModal] 生成二维码失败', error)
    message.error('生成二维码失败，请重试')
  } finally {
    loading.value = false
  }
}

/**
 * 刷新二维码
 */
async function refreshQrCode(): Promise<void> {
  stopPolling()
  qrImage.value = ''
  qrStatus.value = QrStatusCode.WAITING
  await generateQrCode()
}

/**
 * 开始轮询检查二维码状态
 */
function startPolling(): void {
  // 清除之前的定时器
  stopPolling()

  // 重置登录成功标志
  hasLoginSuccess.value = false

  // 每 2 秒检查一次状态
  pollTimer = setInterval(async () => {
    // 如果已经登录成功，不再检查状态
    if (hasLoginSuccess.value) {
      return
    }

    if (!qrKey.value) {
      return
    }

    const result = await checkQrStatus(qrKey.value)
    if (!result) {
      return
    }

    handleQrStatus(result)
  }, 2000)
}

/**
 * 停止轮询
 */
function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * 处理二维码状态
 * @param result 状态检查结果
 */
function handleQrStatus(result: QrCheckResponse): void {
  // 如果已经登录成功，忽略所有状态更新
  if (hasLoginSuccess.value) {
    return
  }

  const code = result.code as QrStatusCode
  qrStatus.value = code

  switch (code) {
    case QrStatusCode.WAITING:
      // 等待扫码，继续轮询
      break

    case QrStatusCode.CONFIRMING:
      // 待确认，更新 UI
      break

    case QrStatusCode.SUCCESS:
      // 登录成功，立即设置标志并停止轮询
      hasLoginSuccess.value = true
      stopPolling()
      handleLoginSuccess(result)
      break

    case QrStatusCode.EXPIRED:
      // 二维码过期，停止轮询
      stopPolling()
      break

    default:
      console.warn('[NeteaseLoginModal] 未知的二维码状态码:', code)
  }
}

/**
 * 处理登录成功
 * @param result 状态检查结果
 */
async function handleLoginSuccess(result: QrCheckResponse): Promise<void> {
  console.log('[NeteaseLoginModal] handleLoginSuccess 被调用', result)
  
  if (!result.cookie) {
    console.error('[NeteaseLoginModal] 登录失败: 没有 cookie')
    message.error('登录失败，未获取到凭证')
    return
  }

  // 调用 store 的登录方法
  const success = await userStore.login(result.cookie)
  console.log('[NeteaseLoginModal] userStore.login 返回:', success)
  
  if (success) {
    console.log('[NeteaseLoginModal] 登录成功，准备关闭弹窗')
    message.success('登录成功')
    emit('login-success')
    // 延迟关闭弹窗
    setTimeout(() => {
      showModal.value = false
    }, 1000)
  } else {
    console.error('[NeteaseLoginModal] userStore.login 返回 false，显示登录失败')
    message.error('登录失败，请重试')
    // 重置标志，允许重新尝试
    hasLoginSuccess.value = false
    qrStatus.value = QrStatusCode.EXPIRED
  }
}

/**
 * 监听弹窗显示状态
 */
watch(
  () => props.show,
  (newVal) => {
    if (newVal) {
      // 弹窗打开时重置状态并生成二维码
      hasLoginSuccess.value = false
      qrKey.value = ''
      qrImage.value = ''
      qrStatus.value = QrStatusCode.WAITING
      generateQrCode()
    } else {
      // 弹窗关闭时停止轮询
      stopPolling()
      // 重置状态
      qrKey.value = ''
      qrImage.value = ''
      qrStatus.value = QrStatusCode.WAITING
      hasLoginSuccess.value = false
    }
  }
)

/**
 * 组件卸载时清理定时器
 */
onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <n-modal
    v-model:show="showModal"
    preset="card"
    title="网易云音乐登录"
    style="width: 400px"
    :mask-closable="false"
  >
    <div class="login-modal-content">
      <!-- 加载中 -->
      <div v-if="loading && !qrImage" class="loading-container">
        <n-spin size="large" />
        <p class="loading-text">正在生成二维码...</p>
      </div>

      <!-- 二维码区域 -->
      <div v-else class="qr-container">
        <div class="qr-image-wrapper" :class="statusClass">
          <img v-if="showQrCode" :src="qrImage" alt="登录二维码" class="qr-image" />
          <div v-if="qrStatus === QrStatusCode.EXPIRED" class="qr-overlay">
            <span class="overlay-text">已过期</span>
          </div>
          <div v-if="qrStatus === QrStatusCode.CONFIRMING" class="qr-overlay confirming">
            <i class="mgc_check_circle_line overlay-icon"></i>
            <span class="overlay-text">待确认</span>
          </div>
        </div>

        <p class="status-text" :class="statusClass">{{ statusText }}</p>

        <!-- 刷新按钮 -->
        <n-button
          v-if="showRefresh"
          type="primary"
          @click="refreshQrCode"
          :loading="loading"
        >
          刷新二维码
        </n-button>
      </div>

      <!-- 提示信息 -->
      <div class="tips">
        <p class="tip-text">请使用网易云音乐 APP 扫码</p>
        <p class="tip-sub">扫码即表示同意相关服务条款</p>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.login-modal-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 0;
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 40px 0;
}

.loading-text {
  color: var(--n-text-color-3);
  font-size: 14px;
}

.qr-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.qr-image-wrapper {
  position: relative;
  width: 200px;
  height: 200px;
  border-radius: 8px;
  overflow: hidden;
  background-color: var(--n-card-color);
  border: 2px solid transparent;
  transition: border-color 0.3s;
}

.qr-image-wrapper.status-waiting {
  border-color: var(--n-border-color);
}

.qr-image-wrapper.status-confirming {
  border-color: var(--n-primary-color);
}

.qr-image-wrapper.status-expired {
  border-color: var(--n-error-color);
}

.qr-image-wrapper.status-success {
  border-color: var(--n-success-color);
}

.qr-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.qr-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.7);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.qr-overlay.confirming {
  background-color: rgba(var(--n-primary-color-rgb), 0.9);
}

.overlay-icon {
  font-size: 48px;
  color: white;
}

.overlay-text {
  color: white;
  font-size: 16px;
  font-weight: 500;
}

.status-text {
  font-size: 14px;
  text-align: center;
  margin: 0;
  transition: color 0.3s;
}

.status-text.status-waiting {
  color: var(--n-text-color-2);
}

.status-text.status-confirming {
  color: var(--n-primary-color);
}

.status-text.status-expired {
  color: var(--n-error-color);
}

.status-text.status-success {
  color: var(--n-success-color);
}

.tips {
  margin-top: 24px;
  text-align: center;
}

.tip-text {
  font-size: 12px;
  color: var(--n-text-color-2);
  margin: 0;
}

.tip-sub {
  font-size: 11px;
  color: var(--n-text-color-3);
  margin: 4px 0 0 0;
}
</style>
