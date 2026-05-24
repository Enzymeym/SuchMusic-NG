<script setup lang="ts">
import { ref, computed } from 'vue'
import { NButton, NCard, NAvatar, NTag, useMessage } from 'naive-ui'
import { useUserStore } from '../../../stores/userStore'
import NeteaseLoginModal from '../NeteaseLoginModal.vue'

/**
 * 组件属性定义
 */
const props = defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  highlightKey?: string | null
}>()

const message = useMessage()
const userStore = useUserStore()

/**
 * 是否显示登录弹窗
 */
const showLoginModal = ref(false)

/**
 * 是否正在处理登出
 */
const isLoggingOut = ref(false)

/**
 * 格式化日期
 * @param timestamp 时间戳
 * @returns 格式化后的日期字符串
 */
function formatDate(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * 打开登录弹窗
 */
function handleLogin(): void {
  showLoginModal.value = true
}

/**
 * 处理登录成功
 */
function handleLoginSuccess(): void {
  message.success('登录成功')
}

/**
 * 处理登出
 */
async function handleLogout(): Promise<void> {
  isLoggingOut.value = true
  try {
    const success = await userStore.logout()
    if (success) {
      message.success('已退出登录')
    } else {
      message.error('退出登录失败')
    }
  } catch (error) {
    console.error('[SettingsAccountSection] 退出登录失败', error)
    message.error('退出登录失败')
  } finally {
    isLoggingOut.value = false
  }
}
</script>

<template>
  <div class="settings-content">
    <div class="section-group-title">网易云账户</div>

    <!-- 未登录状态 -->
    <n-card
      v-if="!userStore.isLoggedIn"
      class="setting-item"
      :class="{ 'setting-item--highlight': props.highlightKey === 'account.login' }"
      data-setting-key="account.login"
      :bordered="true"
      size="small"
      :style="{
        backgroundColor: props.settingItemBgColor,
        borderColor: props.settingItemBorderColor
      }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">登录网易云音乐</div>
          <div class="sub-label">登录后可访问您的私人歌单、收藏和每日推荐</div>
        </div>
        <n-button type="primary" @click="handleLogin">登录</n-button>
      </div>
    </n-card>

    <!-- 已登录状态 -->
    <template v-else>
      <n-card
        class="setting-item"
        :class="{ 'setting-item--highlight': props.highlightKey === 'account.info' }"
        data-setting-key="account.info"
        :bordered="true"
        size="small"
        :style="{
          backgroundColor: props.settingItemBgColor,
          borderColor: props.settingItemBorderColor
        }"
      >
        <div class="user-info-container">
          <div class="user-info-left">
            <n-avatar
              :src="userStore.avatarUrl"
              :size="64"
              round
              class="user-avatar"
            />
            <div class="user-details">
              <div class="user-name-row">
                <span class="user-nickname">{{ userStore.nickname }}</span>
                <n-tag v-if="userStore.userInfo?.vipType" size="small" type="warning" round>
                  VIP
                </n-tag>
              </div>
              <div class="user-id">ID: {{ userStore.userId }}</div>
              <div v-if="userStore.loginTime" class="login-time">
                登录时间: {{ formatDate(userStore.loginTime) }}
              </div>
            </div>
          </div>
          <n-button
            type="error"
            tertiary
            :loading="isLoggingOut"
            @click="handleLogout"
          >
            退出登录
          </n-button>
        </div>
      </n-card>

      <n-card
        class="setting-item"
        :bordered="true"
        size="small"
        :style="{
          backgroundColor: props.settingItemBgColor,
          borderColor: props.settingItemBorderColor
        }"
      >
        <div class="setting-row">
          <div class="setting-label">
            <div class="main-label">账户功能</div>
            <div class="sub-label">登录后您可以使用以下功能</div>
          </div>
        </div>
        <div class="feature-list">
          <div class="feature-item">
            <i class="mgc_heart_line feature-icon"></i>
            <span class="feature-text">访问喜欢的音乐</span>
          </div>
          <div class="feature-item">
            <i class="mgc_playlist_line feature-icon"></i>
            <span class="feature-text">管理私人歌单</span>
          </div>
          <div class="feature-item">
            <i class="mgc_calendar_line feature-icon"></i>
            <span class="feature-text">每日歌曲推荐</span>
          </div>
          <div class="feature-item">
            <i class="mgc_radio_line feature-icon"></i>
            <span class="feature-text">私人 FM</span>
          </div>
        </div>
      </n-card>
    </template>

    <!-- 登录弹窗 -->
    <netease-login-modal
      v-model:show="showLoginModal"
      @login-success="handleLoginSuccess"
    />
  </div>
</template>

<style scoped>
.settings-content {
  padding-bottom: 24px;
}

.section-group-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--n-text-color-1);
}

.setting-item {
  margin-bottom: 12px;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.setting-label {
  flex: 1;
}

.main-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--n-text-color-1);
}

.sub-label {
  font-size: 12px;
  color: var(--n-text-color-3);
  margin-top: 4px;
}

.user-info-container {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.user-info-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.user-avatar {
  border: 2px solid var(--n-border-color);
}

.user-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.user-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.user-nickname {
  font-size: 16px;
  font-weight: 600;
  color: var(--n-text-color-1);
}

.user-id {
  font-size: 12px;
  color: var(--n-text-color-3);
}

.login-time {
  font-size: 11px;
  color: var(--n-text-color-3);
}

.feature-list {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-top: 16px;
}

.feature-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background-color: var(--n-hover-color);
  border-radius: 8px;
}

.feature-icon {
  font-size: 20px;
  color: var(--n-primary-color);
}

.feature-text {
  font-size: 13px;
  color: var(--n-text-color-2);
}
</style>
