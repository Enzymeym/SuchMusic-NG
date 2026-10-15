<script setup lang="ts">
/**
 * 设置 · 手环联动（Windows 端最小入口）
 *
 * 依据 `docs/ARCH-手环通信.md` §4.3：Windows 无法直连手环，只能经手机中继。
 * 本面板负责：连接状态展示、手机地址/令牌配置、播放控制、当前歌曲与歌词。
 * 默认关闭，不影响不使用手环的用户。
 */

import { computed } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NDivider,
  NIcon,
  NInput,
  NInputNumber,
  NProgress,
  NScrollbar,
  NSpace,
  NTag,
  useMessage
} from 'naive-ui'
import {
  useBand,
  protocolModeIcon,
  protocolModeLabel,
  type ProtocolPlayMode
} from '../../../composables/useBand'

defineProps<{
  settingItemBgColor: string
  settingItemBorderColor: string
  highlightKey?: string | null
}>()

const message = useMessage()

// 解构组合式函数返回的顶层 ref（模板中自动解包）
const {
  config,
  status,
  song,
  playing,
  positionMs,
  durationMs,
  mode,
  lyricMeta,
  lyricLine,
  lyricWindow,
  logs,
  busy,
  saveConfig,
  connect,
  disconnect,
  play,
  pause,
  prev,
  next,
  setMode
} = useBand()

const MODES: ProtocolPlayMode[] = ['loop', 'single', 'shuffle']

/** 端口输入代理（NInputNumber 可能回传 null，需兜底）。 */
const portProxy = computed({
  get: () => config.value.port,
  set: (value: number | null) => {
    config.value.port = typeof value === 'number' ? value : 8787
  }
})

/** 连接状态 → 标签类型/文案。 */
const statusMeta = computed(() => {
  switch (status.value.state) {
    case 'ready':
      return { type: 'success' as const, text: '已连接' }
    case 'connecting':
    case 'handshaking':
      return { type: 'info' as const, text: '连接中…' }
    case 'error':
      return { type: 'error' as const, text: '连接异常' }
    case 'disabled':
      return { type: 'default' as const, text: '未启用' }
    default:
      return { type: 'warning' as const, text: '未连接' }
  }
})

const progressPercent = computed(() => {
  if (!durationMs.value) return 0
  return Math.min(100, Math.round((positionMs.value / durationMs.value) * 100))
})

const connected = computed(() => status.value.state === 'ready')

/** 毫秒 → mm:ss。 */
function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

async function handleToggleEnabled(value: boolean): Promise<void> {
  await saveConfig({ enabled: value })
  if (!value) {
    await disconnect()
    message.info('已关闭手环联动')
  } else {
    message.success('已启用手环联动，请填写手机地址后连接')
  }
}

async function handleSaveAddress(): Promise<void> {
  await saveConfig({
    host: config.value.host.trim(),
    port: config.value.port,
    path: config.value.path.trim() || '/suchmusic'
  })
  message.success('已保存手机地址')
}

async function handleSavePairing(): Promise<void> {
  await saveConfig({
    pairCode: config.value.pairCode.trim(),
    token: config.value.token.trim()
  })
  message.success('已保存配对信息')
}

async function handleConnect(): Promise<void> {
  await connect()
  if (status.value.state === 'ready') {
    message.success('已连接手机中继')
  } else {
    message.warning('正在连接，请留意状态与日志')
  }
}

async function handleCommand(action: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await action()
  } catch (error) {
    message.error(`${label}失败：${String(error)}`)
  }
}
</script>

<template>
  <div class="settings-content">
    <div class="section-group-title">手环联动（经手机中转）</div>

    <!-- 链路说明：为何必须经手机 -->
    <n-alert type="info" :bordered="false" style="margin-bottom: 12px">
      手环无法被电脑直连（小米 interconnect 通道仅对手机 App + 手环快应用开放）。
      数据链路为：手环快应用 ↔ 手机 SuchMusic 概念版（局域网 WebSocket 服务端） ↔ 本应用（客户端）。
      请在手机端开启中继后，填写手机地址并连接。默认关闭，仅局域网。
    </n-alert>

    <!-- 总开关 -->
    <n-card
      class="setting-item"
      :class="{ 'setting-item--highlight': highlightKey === 'band.enabled' }"
      data-setting-key="band.enabled"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">启用手环联动</div>
          <div class="sub-label">开启后可通过手机中继与手环通信（默认关闭）</div>
        </div>
        <n-switch :value="config.enabled" @update:value="handleToggleEnabled" />
      </div>
    </n-card>

    <!-- 手机地址 -->
    <div class="section-group-title" style="margin-top: 24px">手机端地址</div>
    <n-card
      class="setting-item"
      data-setting-key="band.address"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <n-space vertical :size="12">
        <div class="setting-row">
          <div class="setting-label">
            <div class="main-label">手机 IP / 主机名</div>
            <div class="sub-label">例如 192.168.1.5，需与本机处于同一局域网</div>
          </div>
          <n-input v-model:value="config.host" placeholder="192.168.1.5" style="width: 220px" />
        </div>
        <div class="setting-row">
          <div class="setting-label">
            <div class="main-label">端口</div>
            <div class="sub-label">手机端 WebSocket 服务端口，默认 8787</div>
          </div>
          <n-input-number v-model:value="portProxy" :min="1" :max="65535" style="width: 160px" />
        </div>
        <div class="setting-row">
          <div class="setting-label">
            <div class="main-label">路径</div>
            <div class="sub-label">WebSocket 路径，默认 /suchmusic</div>
          </div>
          <n-input v-model:value="config.path" placeholder="/suchmusic" style="width: 220px" />
        </div>
        <div style="display: flex; justify-content: flex-end">
          <n-button size="small" type="primary" @click="handleSaveAddress">保存地址</n-button>
        </div>
      </n-space>
    </n-card>

    <!-- 配对信息 -->
    <div class="section-group-title" style="margin-top: 24px">配对与令牌</div>
    <n-card
      class="setting-item"
      data-setting-key="band.pairing"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <n-space vertical :size="12">
        <div class="setting-row">
          <div class="setting-label">
            <div class="main-label">配对码</div>
            <div class="sub-label">手机端显示的 6 位配对码，首次握手使用</div>
          </div>
          <n-input
            v-model:value="config.pairCode"
            placeholder="123456"
            :maxlength="6"
            style="width: 160px"
          />
        </div>
        <div class="setting-row">
          <div class="setting-label">
            <div class="main-label">会话令牌</div>
            <div class="sub-label">配对成功后由手机签发；明文存本地，不写入日志</div>
          </div>
          <n-input
            v-model:value="config.token"
            type="password"
            show-password-on="click"
            placeholder="可选"
            style="width: 220px"
          />
        </div>
        <div style="display: flex; justify-content: flex-end">
          <n-button size="small" type="primary" @click="handleSavePairing">保存配对信息</n-button>
        </div>
      </n-space>
    </n-card>

    <!-- 连接状态与控制 -->
    <div class="section-group-title" style="margin-top: 24px">连接与播放控制</div>
    <n-card
      class="setting-item"
      data-setting-key="band.connection"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="setting-row">
        <div class="setting-label">
          <div class="main-label">
            连接状态
            <n-tag :type="statusMeta.type" size="small" round style="margin-left: 8px">
              {{ statusMeta.text }}
            </n-tag>
          </div>
          <div class="sub-label">
            {{ status.peer ? `对端：${status.peer}` : '尚未建立链路' }}
            · 协议 v{{ status.proto }}
            · 能力 {{ status.caps.length ? status.caps.join('/') : '—' }}
          </div>
        </div>
        <n-space>
          <n-button size="small" type="primary" :loading="busy" @click="handleConnect">连接</n-button>
          <n-button size="small" @click="disconnect()">断开</n-button>
        </n-space>
      </div>

      <n-divider style="margin: 12px 0" />

      <n-space align="center" :size="8">
        <n-button size="small" :disabled="!connected" @click="handleCommand(prev, '上一首')">
          <template #icon><n-icon><i class="mgc_skip_back_line"></i></n-icon></template>
        </n-button>
        <n-button
          size="small"
          type="primary"
          :disabled="!connected"
          @click="handleCommand(playing ? pause : play, '播放/暂停')"
        >
          <template #icon>
            <n-icon><i :class="playing ? 'mgc_pause_line' : 'mgc_play_line'"></i></n-icon>
          </template>
        </n-button>
        <n-button size="small" :disabled="!connected" @click="handleCommand(next, '下一首')">
          <template #icon><n-icon><i class="mgc_skip_forward_line"></i></n-icon></template>
        </n-button>

        <n-divider vertical />

        <n-button
          v-for="m in MODES"
          :key="m"
          size="small"
          :type="mode === m ? 'primary' : 'default'"
          :disabled="!connected"
          @click="handleCommand(() => setMode(m), '切换模式')"
        >
          <template #icon><n-icon><i :class="protocolModeIcon(m)"></i></n-icon></template>
          {{ protocolModeLabel(m) }}
        </n-button>
      </n-space>
    </n-card>

    <!-- 当前歌曲 -->
    <div class="section-group-title" style="margin-top: 24px">当前歌曲</div>
    <n-card
      class="setting-item"
      data-setting-key="band.song"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <template v-if="song">
        <div class="setting-label">
          <div class="main-label">{{ song.name || '未知歌曲' }}</div>
          <div class="sub-label">
            {{ song.artist || '未知歌手' }}
            <template v-if="song.album"> · {{ song.album }}</template>
          </div>
        </div>
        <n-progress
          type="line"
          :percentage="progressPercent"
          :show-indicator="false"
          :height="6"
          style="margin-top: 12px"
        />
        <div class="sub-label" style="display: flex; justify-content: space-between; margin-top: 4px">
          <span>{{ formatMs(positionMs) }}</span>
          <span>{{ formatMs(durationMs) }}</span>
        </div>
      </template>
      <div v-else class="sub-label">暂无播放信息（请先连接手机并播放歌曲）</div>
    </n-card>

    <!-- 歌词 -->
    <div class="section-group-title" style="margin-top: 24px">歌词</div>
    <n-card
      class="setting-item"
      data-setting-key="band.lyric"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <div class="sub-label" style="margin-bottom: 8px">
        当前行
        <template v-if="lyricMeta">
          （{{ lyricMeta.has ? `${lyricMeta.count} 行` : '无歌词' }}）
        </template>
      </div>
      <div class="main-label" style="color: #2f84fe">
        {{ lyricLine ? lyricLine.text : '—' }}
      </div>
      <n-scrollbar v-if="lyricWindow.length" style="max-height: 120px; margin-top: 8px">
        <div v-for="(line, idx) in lyricWindow" :key="idx" class="sub-label" style="padding: 2px 0">
          {{ line.text }}
        </div>
      </n-scrollbar>
    </n-card>

    <!-- 运行日志（不含令牌等敏感信息） -->
    <div class="section-group-title" style="margin-top: 24px">运行日志</div>
    <n-card
      class="setting-item"
      :bordered="true"
      size="small"
      :style="{ backgroundColor: settingItemBgColor, borderColor: settingItemBorderColor }"
    >
      <n-scrollbar style="max-height: 140px">
        <div v-if="!logs.length" class="sub-label">暂无日志</div>
        <div v-for="(line, idx) in logs" :key="idx" class="sub-label" style="padding: 2px 0">
          {{ line }}
        </div>
      </n-scrollbar>
    </n-card>
  </div>
</template>
