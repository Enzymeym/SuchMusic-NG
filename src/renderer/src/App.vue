<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import {
  NConfigProvider,
  NGlobalStyle,
  NMessageProvider,
  NDialogProvider,
  NButton,
  NCard,
  NTag,
  NCode,
  NSpin
} from 'naive-ui'
// 引入 highlight.js 提供代码高亮能力
import hljs from 'highlight.js'
import { themeOverridesRef, setPrimaryColor } from './themes'
import { useSettingsStore } from './stores/settingsStore'
import { usePlayerStore } from './stores/playerStore'
import { useAutoNaiveTheme } from './themes/autoNaiveTheme'
import {
  runSnowdropTransformTest,
  runSnowdropTransformFromFile,
  runSnowdropLoadAllPlugins,
  type SnowdropTransformTestResult
} from './apis/snowdrop-transform'

// 初始化主题主色为默认值，后续由设置中的主题色控制
setPrimaryColor('#2C8EFD')

// 从设置中读取用户配置的主题色并应用
const settingsStore = useSettingsStore()
if (settingsStore.appearance.customThemeColor) {
  setPrimaryColor(settingsStore.appearance.customThemeColor)
}

const { theme } = useAutoNaiveTheme()

const route = useRoute()
const isDesktopLyric = computed(() => route.name === 'desktop-lyric')

const playerStore = usePlayerStore()

onMounted(() => {
  if (!isDesktopLyric.value) {
    window.electron.ipcRenderer.on('player:control', (_, action: string) => {
      switch (action) {
        case 'play':
          if (!playerStore.isPlaying) {
            // We need to access the togglePlay function from PlayerBar or implement it globally
            // Since PlayerBar logic is inside component, we should probably expose it or move to store/composable
            // But for now, we can use the webAudioEngine directly if we import it
            import('./audio/audio-engine').then(async ({ webAudioEngine }) => {
              if (playerStore.currentSong) {
                await webAudioEngine.resume()
                playerStore.setPlaying(true)
              }
            })
          }
          break
        case 'pause':
          if (playerStore.isPlaying) {
            import('./audio/audio-engine').then(async ({ webAudioEngine }) => {
              await webAudioEngine.pause()
              playerStore.setPlaying(false)
            })
          }
          break
        case 'toggle':
          import('./audio/audio-engine').then(async ({ webAudioEngine }) => {
            if (playerStore.isPlaying) {
              await webAudioEngine.pause()
              playerStore.setPlaying(false)
            } else if (playerStore.currentSong) {
              await webAudioEngine.resume()
              playerStore.setPlaying(true)
            }
          })
          break
        case 'next':
          playerStore.playNext()
          break
        case 'prev':
          playerStore.playPrev()
          break
        case 'toggle-lock':
          settingsStore.playback.desktopLyricsLocked = !settingsStore.playback.desktopLyricsLocked
          break
      }
    })
  }
})

const testingSnowdrop = ref(false)
const snowdropResults = ref<SnowdropTransformTestResult[]>([])
const snowdropError = ref<string | null>(null)

// 触发落雪插件转换测试
const handleTestSnowdrop = async () => {
  testingSnowdrop.value = true
  snowdropError.value = null
  try {
    const result = await runSnowdropTransformTest()
    // 移除之前的测试结果（假设没有文件路径的是测试结果）
    snowdropResults.value = snowdropResults.value.filter((r) => r.filePath)
    snowdropResults.value.unshift(result) // 添加到开头

    // 在渲染进程控制台输出详细调试信息
    console.group('[SnowdropTest] 渲染进程结果')
    console.log('meta:', result.meta)
    console.log('type:', result.type)
    console.log('stats:', result.stats)
    console.log('sources:', result.sources)
    console.log('runtimeLogs:', result.runtimeLogs)
    if (result.warnings.length) {
      console.warn('warnings:', result.warnings)
    }
    if (result.errors.length) {
      console.error('errors:', result.errors)
    }
    if (result.logs.length) {
      console.log('logs:')
      for (const log of result.logs) {
        console.log('  ', log)
      }
    }
    console.groupEnd()
  } catch (e: any) {
    snowdropError.value = e && e.message ? String(e.message) : String(e)
  } finally {
    testingSnowdrop.value = false
  }
}

// 从本地选择落雪插件文件并解析
const handlePickSnowdropFile = async () => {
  testingSnowdrop.value = true
  snowdropError.value = null
  try {
    const { canceled, results, errors } = await runSnowdropTransformFromFile()
    if (canceled) {
      return
    }

    if (errors && errors.length) {
      snowdropError.value = errors.join('\n')
    }

    if (results && results.length) {
      // 合并结果，避免重复（基于 filePath）
      const existingPaths = new Set(snowdropResults.value.map((r) => r.filePath).filter(Boolean))
      for (const res of results) {
        if (res.filePath && !existingPaths.has(res.filePath)) {
          snowdropResults.value.push(res)
          existingPaths.add(res.filePath)
        }
      }
    }

    // 在渲染进程控制台输出详细调试信息
    console.group('[SnowdropTest] 本地文件解析结果')
    console.log('results:', results)
    console.groupEnd()
  } catch (e: any) {
    snowdropError.value = e && e.message ? String(e.message) : String(e)
  } finally {
    testingSnowdrop.value = false
  }
}

// 打开音源设置页（通过全局事件唤起设置弹窗并跳转到音源分组）
const handleOpenSourceSettings = () => {
  window.dispatchEvent(
    new CustomEvent('open-settings', {
      detail: {
        section: 'source',
        settingKey: 'source.plugins'
      }
    })
  )
}

// 自动加载所有插件
onMounted(async () => {
  try {
    const { canceled, results, errors } = await runSnowdropLoadAllPlugins()
    if (!canceled && results && results.length) {
      snowdropResults.value = results
      // 自动打开音源设置面板以展示加载结果
      // showSourceSettings.value = true
      console.log('[AutoLoad] Successfully loaded plugins:', results.length)
    }
    if (errors && errors.length) {
      console.error('[AutoLoad] Errors:', errors)
    }
  } catch (err) {
    console.error('[AutoLoad] Failed to load plugins:', err)
  }
})
</script>

<template>
  <n-config-provider :theme="isDesktopLyric ? null : theme" :theme-overrides="themeOverridesRef" :hljs="hljs">
    <n-global-style v-if="!isDesktopLyric" />
    <n-message-provider>
      <n-dialog-provider>
        <router-view />
        <div class="snowdrop-test-panel">
          <n-card size="small" title="落雪音源插件调试">
            <div class="snowdrop-test-header">
              <n-button
                type="primary"
                size="small"
                :loading="testingSnowdrop"
                @click="handleTestSnowdrop"
              >
                测试落雪音源插件
              </n-button>
              <n-button size="small" :loading="testingSnowdrop" @click="handlePickSnowdropFile">
                从文件解析落雪插件
              </n-button>
              <n-button size="small" tertiary @click="handleOpenSourceSettings">
                打开音源设置
              </n-button>
              <n-tag
                v-if="snowdropResults.length"
                :type="snowdropResults[0].errors.length ? 'error' : 'success'"
                size="small"
              >
                {{ snowdropResults[0].errors.length ? '存在错误' : '转换成功' }}
              </n-tag>
            </div>
            <div v-if="snowdropError" class="snowdrop-test-error">
              {{ snowdropError }}
            </div>
            <div v-else-if="testingSnowdrop" class="snowdrop-test-loading">
              <n-spin size="small"> 正在执行转换与基准测试... </n-spin>
            </div>
            <template v-else-if="snowdropResults.length">
              <div class="snowdrop-meta">
                <div v-if="snowdropResults[0].filePath">
                  文件：{{ snowdropResults[0].filePath }}
                </div>
                <div>名称：{{ snowdropResults[0].meta.name }}</div>
                <div>版本：{{ snowdropResults[0].meta.version }}</div>
                <div>作者：{{ snowdropResults[0].meta.author }}</div>
                <div v-if="snowdropResults[0].meta.description">
                  描述：{{ snowdropResults[0].meta.description }}
                </div>
              </div>
              <div class="snowdrop-stats">
                <div>
                  单次转换耗时：{{ snowdropResults[0].stats.singleDurationMs.toFixed(3) }} ms
                </div>
                <div>
                  1000 次总耗时：{{ snowdropResults[0].stats.batchDurationMs.toFixed(3) }} ms
                </div>
                <div>平均耗时：{{ snowdropResults[0].stats.averageMs.toFixed(4) }} ms/次</div>
                <div>
                  估算内存变化：{{ snowdropResults[0].stats.estimatedMemoryDeltaMb.toFixed(2) }} MB
                </div>
              </div>
              <div
                v-if="snowdropResults[0].sources && snowdropResults[0].sources.length"
                class="snowdrop-sources"
              >
                <strong>音源列表：</strong>
                <ul>
                  <li v-for="src in snowdropResults[0].sources" :key="src.id">
                    {{ src.id }}（{{ src.name }}）- 质量：{{ src.qualities.join(', ') || '无' }}
                  </li>
                </ul>
              </div>
              <div class="snowdrop-logs">
                <div v-if="snowdropResults[0].warnings.length">
                  <strong>告警：</strong>
                  <ul>
                    <li v-for="(w, idx) in snowdropResults[0].warnings" :key="`w-${idx}`">
                      {{ w }}
                    </li>
                  </ul>
                </div>
                <div v-if="snowdropResults[0].errors.length">
                  <strong>错误：</strong>
                  <ul>
                    <li v-for="(err, idx) in snowdropResults[0].errors" :key="`e-${idx}`">
                      {{ err }}
                    </li>
                  </ul>
                </div>
                <div v-if="snowdropResults[0].logs.length">
                  <strong>日志：</strong>
                  <ul>
                    <li v-for="(log, idx) in snowdropResults[0].logs" :key="`l-${idx}`">
                      {{ log }}
                    </li>
                  </ul>
                </div>
                <div v-if="snowdropResults[0].runtimeLogs && snowdropResults[0].runtimeLogs.length">
                  <strong>插件输出日志：</strong>
                  <ul>
                    <li v-for="(rlog, idx) in snowdropResults[0].runtimeLogs" :key="`rl-${idx}`">
                      {{ rlog }}
                    </li>
                  </ul>
                </div>
              </div>
              <div class="snowdrop-code">
                <strong>转换结果预览：</strong>
                <n-code
                  :code="snowdropResults[0].transformedCodePreview"
                  language="javascript"
                  word-wrap
                />
              </div>
              <div v-if="snowdropResults[0].originalCodePreview" class="snowdrop-code">
                <strong>原始代码预览：</strong>
                <n-code
                  :code="snowdropResults[0].originalCodePreview"
                  language="javascript"
                  word-wrap
                />
              </div>
            </template>
          </n-card>
        </div>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
.snowdrop-test-panel {
  position: fixed;
  right: 16px;
  bottom: 96px;
  z-index: 1000;
  max-width: 520px;
  display: none;
}

.snowdrop-test-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.snowdrop-meta,
.snowdrop-stats,
.snowdrop-logs,
.snowdrop-code,
.snowdrop-sources {
  margin-top: 8px;
  font-size: 12px;
}

.snowdrop-test-error {
  margin-top: 8px;
  color: #f56c6c;
  font-size: 12px;
}

.snowdrop-test-loading {
  margin-top: 8px;
}

</style>
