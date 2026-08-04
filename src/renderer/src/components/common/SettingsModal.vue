<script setup lang="ts">
import { ref, computed, h, onMounted, watch, nextTick } from 'vue'
import {
  NModal,
  NLayout,
  NLayoutSider,
  NLayoutContent,
  NMenu,
  NIcon,
  NAutoComplete,
  NCard,
  useThemeVars
} from 'naive-ui'
import { useAutoNaiveTheme } from '../../themes/autoNaiveTheme'
import SettingsGeneralSection from './Settings/SettingsGeneralSection.vue'
import SettingsAppearanceSection from './Settings/SettingsAppearanceSection.vue'
import SettingsPlaybackSection from './Settings/SettingsPlaybackSection.vue'
import SettingsLyricsSection from './Settings/SettingsLyricsSection.vue'
import SettingsLocalSection from './Settings/SettingsLocalSection.vue'
import SettingsPluginSection from './Settings/SettingsPluginSection.vue'
import SettingsAboutSection from './Settings/SettingsAboutSection.vue'
import SettingsMorphaeumSection from './Settings/SettingsMorphaeumSection.vue'

const themeVars = useThemeVars()
const { isDark } = useAutoNaiveTheme()
const isMac = ref(false)

const props = defineProps<{
  show: boolean
  initialSection?: string
  initialHighlightKey?: string | null
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
}>()

const showModal = computed({
  get: () => props.show,
  set: (val) => emit('update:show', val)
})

const activeKey = ref('general')

// 设置内容区滚动容器引用
const settingsContentRef = ref<any>(null)

// 搜索输入内容，用于命令面板风格搜索
const searchInput = ref('')

// Helper to render icon
const renderIcon = (iconClass: string) => {
  return () => h(NIcon, null, { default: () => h('i', { class: iconClass }) })
}

const menuOptions = [
  { label: '常规设置', key: 'general', icon: renderIcon('mgc_settings_3_line') },
  { label: '外观设置', key: 'appearance', icon: renderIcon('mgc_palette_line') },
  { label: '播放设置', key: 'playback', icon: renderIcon('mgc_play_circle_line') },
  { label: '歌词设置', key: 'lyrics', icon: renderIcon('mgc_music_line') },
  { label: '本地与缓存', key: 'local', icon: renderIcon('mgc_folder_line') },
  { label: '插件管理', key: 'plugins', icon: renderIcon('mgc_cube_3d_line') },
  { label: '关于', key: 'about', icon: renderIcon('mgc_information_line') }
]

const fontOptions = ref<{ label: string; value: string }[]>([])

const decodeMojibake = (str: string): string => {
  const hasCJK = /[\u4e00-\u9fff]/.test(str)
  const hasHighLatin = /[\u00c0-\u017f]/.test(str)
  if (hasCJK || !hasHighLatin) return str
  const bytes: number[] = []
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i)
    if (code <= 0xff) {
      bytes.push(code)
    } else {
      return str
    }
  }
  try {
    const decoder = new TextDecoder('utf-8')
    return decoder.decode(new Uint8Array(bytes))
  } catch {
    return str
  }
}

// 设置搜索选项定义，每一项对应具体设置条目与描述
const searchOptions = [
  {
    label: '关闭软件时',
    value: 'general.closeAction',
    section: 'general',
    desc: '选择关闭软件的方式'
  },
  {
    label: '每次关闭前都进行提醒',
    value: 'general.remindOnClose',
    section: 'general',
    desc: ''
  },
  {
    label: '任务栏显示播放进度',
    value: 'general.taskbarProgress',
    section: 'general',
    desc: '是否在任务栏显示歌曲播放进度'
  },
  {
    label: '任务栏显示歌曲信息',
    value: 'general.taskbarSongInfo',
    section: 'general',
    desc: '播放时在任务栏应用名显示 歌曲名 - 歌手'
  },
  {
    label: '自动检查更新',
    value: 'general.autoCheckUpdate',
    section: 'general',
    desc: '在每次开启软件时自动检查更新'
  },
  {
    label: '更新通道',
    value: 'general.updateChannel',
    section: 'general',
    desc: '切换更新通道（测试版可体验最新功能，但不保证稳定性）'
  },
  {
    label: '全局字体',
    value: 'appearance.globalFont',
    section: 'appearance',
    desc: '软件界面的主要字体'
  },
  {
    label: '深浅色模式',
    value: 'appearance.themeMode',
    section: 'appearance',
    desc: '切换浅色、深色或跟随系统外观'
  },
  {
    label: '歌词字体',
    value: 'appearance.lyricsFont',
    section: 'appearance',
    desc: '歌词界面的显示字体'
  },
  {
    label: '任务栏歌词字体',
    value: 'appearance.taskbarLyricsFont',
    section: 'appearance',
    desc: '桌面歌词和任务栏歌词的显示字体'
  },
  {
    label: '主题主色',
    value: 'appearance.themeColor',
    section: 'appearance',
    desc: '影响按钮高亮、主色标签等界面主色调'
  },
  {
    label: '全屏播放时自动隐藏鼠标指针',
    value: 'playback.autoHideCursorWhenControlsHidden',
    section: 'playback',
    desc: '播放页底栏隐藏时自动隐藏鼠标指针'
  },
  {
    label: '自适应歌词大小',
    value: 'playback.lyricsAutoSize',
    section: 'lyrics',
    desc: '根据播放页空间自动调整歌词字号'
  },
  {
    label: '歌词字号',
    value: 'playback.lyricsFontSize',
    section: 'lyrics',
    desc: '关闭自适应后使用指定字号显示歌词'
  },
  {
    label: '播放页布局',
    value: 'playback.lyricsAreaRatio',
    section: 'appearance',
    desc: '调整封面与歌词在播放页中的宽度占比'
  },
  {
    label: 'Apple 风格歌词',
    value: 'playback.lyricsAppleStyle',
    section: 'lyrics',
    desc: '切换 Apple Music 风格逐字高亮歌词'
  },
  {
    label: '模糊背景效果',
    value: 'playback.lyricsBlurEnabled',
    section: 'lyrics',
    desc: '控制 Apple 风格歌词背后的模糊玻璃效果'
  },
  {
    label: '弹簧动效',
    value: 'playback.lyricsSpringEnabled',
    section: 'lyrics',
    desc: '控制 Apple 风格歌词的弹簧滚动动效'
  },
  {
    label: '显示翻译歌词',
    value: 'playback.lyricsShowTranslation',
    section: 'lyrics',
    desc: '控制在播放页和桌面歌词中是否显示翻译内容'
  },
  {
    label: '显示音译歌词',
    value: 'playback.lyricsShowTransliteration',
    section: 'lyrics',
    desc: '控制在播放页和桌面歌词中是否显示罗马音等音译内容'
  },
  {
    label: '翻译字号',
    value: 'playback.lyricsTranslationSize',
    section: 'lyrics',
    desc: '调节翻译和音译歌词的显示字号'
  },
  {
    label: '隐藏已播放歌词',
    value: 'playback.amllHidePassedLines',
    section: 'lyrics',
    desc: '播放过的歌词行自动隐藏，仅显示当前及后续歌词'
  },
  {
    label: '逐字歌词渐变宽度',
    value: 'playback.amllWordFadeWidth',
    section: 'lyrics',
    desc: '控制 AMLL 逐字高亮的颜色渐变过渡宽度'
  },
  {
    label: '排除 TTML 歌词',
    value: 'playback.lyricsExcludeTTML',
    section: 'lyrics',
    desc: '过滤 TTML 格式歌词，使用其他格式替代'
  },
  {
    label: '排除本地音乐歌词',
    value: 'playback.lyricsExcludeLocal',
    section: 'lyrics',
    desc: '过滤本地音乐内嵌歌词，优先使用在线歌词'
  },
  {
    label: '歌词元数据关键词过滤',
    value: 'playback.lyricsExcludeKeywords',
    section: 'lyrics',
    desc: '匹配歌词元数据冒号前的内容进行过滤'
  },
  {
    label: '强制对唱模式',
    value: 'playback.desktopLyricsForceDuet',
    section: 'lyrics',
    desc: '强制开启桌面歌词左右交替的对唱展示效果'
  },
  {
    label: '本地音乐扫描目录',
    value: 'local.scanDirs',
    section: 'local',
    desc: '配置本地音乐扫描时需要遍历的目录列表'
  },
  {
    label: '插件管理',
    value: 'plugins.manage',
    section: 'plugins',
    desc: '管理已加载的插件，支持加载、激活与移除'
  }
]

const highlightedKey = ref<string | null>(null)

// NAutoComplete 选项列表，携带所属分类与描述信息，并按输入手动过滤
const autoCompleteOptions = computed(() => {
  const sectionLabelMap: Record<string, string> = {
    general: '常规',
    appearance: '外观',
    playback: '播放',
    lyrics: '歌词',
    local: '本地',
    plugins: '插件',
    about: '关于'
  }

  const keyword = searchInput.value.trim().toLowerCase()

  return searchOptions
    .filter((item) => {
      if (!keyword) return true
      const text =
        `${item.label} ${sectionLabelMap[item.section] || item.section} ${item.desc || ''}`.toLowerCase()
      return text.includes(keyword)
    })
    .map((item) => ({
      // label 用于 NAutoComplete 内部展示文本基础
      label: item.label,
      value: item.value,
      sectionLabel: sectionLabelMap[item.section] || item.section,
      desc: item.desc,
      // title 作为真正展示的主标题文案
      title: item.label
    }))
})

watch(
  () => props.initialSection,
  (section) => {
    if (section) {
      activeKey.value = section
    }
  }
)

watch(
  () => props.initialHighlightKey,
  (key) => {
    highlightedKey.value = key ?? null
    if (!key) return
    nextTick(() => {
      const el = document.querySelector<HTMLElement>(`[data-setting-key="${key}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    })
  }
)

// 切换设置分区时重置滚动位置，避免从播放设置滚动后进入歌词设置继承 scrollY
watch(activeKey, () => {
  nextTick(() => {
    const el = settingsContentRef.value?.$el?.querySelector('.n-layout-scroll-container')
    if (el) {
      el.scrollTop = 0
    }
  })
})

// 自定义命令面板选项标签渲染：括号内容作为上副标题，描述作为下副标题
const renderSearchLabel = (rawOption: any) => {
  const option = rawOption as {
    title: string
    sectionLabel?: string
    desc?: string
  }
  return h('div', { class: 'settings-search-option' }, [
    option.sectionLabel
      ? h('div', { class: 'settings-search-option__top' }, option.sectionLabel)
      : null,
    h('div', { class: 'settings-search-option__label' }, option.title),
    option.desc ? h('div', { class: 'settings-search-option__desc' }, option.desc) : null
  ])
}

onMounted(async () => {
  if (window.electron && window.electron.ipcRenderer) {
    // 检测平台
    isMac.value = await window.electron.ipcRenderer.invoke('system:is-mac')

    try {
      const fonts = await window.electron.ipcRenderer.invoke('system:get-fonts')
      const systemFonts = (fonts as string[])
        .filter((f) => !!f)
        .map((f: string) => {
          const raw = String(f).trim()
          // 解码可能的乱码字体名，同时用于 label 和 value
          // 确保下拉菜单中字体预览和实际应用都使用正确的字体名
          const label = decodeMojibake(raw)
          const decodedValue = decodeMojibake(raw)
          return { label, value: decodedValue }
        })

      if (!systemFonts.find((f) => f.value === 'Microsoft YaHei UI')) {
        systemFonts.unshift({ label: 'Microsoft YaHei UI', value: 'Microsoft YaHei UI' })
      }

      fontOptions.value = [{ label: '跟随全局设置', value: 'follow_global' }, ...systemFonts]
    } catch (e) {
      console.error('Failed to load fonts', e)
      fontOptions.value = [
        { label: '跟随全局设置', value: 'follow_global' },
        { label: 'Microsoft YaHei UI', value: 'Microsoft YaHei UI' }
      ]
    }
  }
})

const globalFontOptions = computed(() => {
  return fontOptions.value.filter((opt) => opt.value !== 'follow_global')
})

// 设置项卡片背景色（深色用卡片色，浅色用纯白）
const settingItemBgColor = computed(() => {
  return isDark.value ? themeVars.value.cardColor : '#FFFFFF'
})

// 设置项卡片边框颜色（优先主题边框色，其次分隔线色），弱化为半透明以弱化边框
const settingItemBorderColor = computed(() => {
  const base = themeVars.value.borderColor || themeVars.value.dividerColor || 'transparent'
  if (base === 'transparent') return base
  return `color-mix(in srgb, ${base} 60%, transparent)`
})

// 处理搜索选择，切换到对应分组并高亮目标项
const handleSearchSelect = (value: string) => {
  const target = searchOptions.find((item) => item.value === value)
  if (!target) return

  activeKey.value = target.section
  highlightedKey.value = target.value

  nextTick(() => {
    // 通过 data-setting-key 精确定位目标设置项并滚动到视图
    const el = document.querySelector<HTMLElement>(`[data-setting-key="${target.value}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  })
}

// 当搜索框清空时，移除高亮状态
watch(searchInput, (val) => {
  if (!val) {
    highlightedKey.value = null
  }
})

// 同步主题变量到 CSS 自定义属性，供全局 SCSS 使用
watch(
  () => ({
    primaryColor: themeVars.value.primaryColor,
    textColor3: themeVars.value.textColor3,
    textColor2: themeVars.value.textColor2,
    hoverColor: themeVars.value.hoverColor
  }),
  (vars) => {
    const root = document.documentElement
    root.style.setProperty('--settings-section-primary-color', vars.primaryColor)
    root.style.setProperty('--settings-subtext-color', vars.textColor3)
    root.style.setProperty('--settings-close-icon-color', vars.textColor2)
    root.style.setProperty('--settings-close-hover-bg', vars.hoverColor)
  },
  { immediate: true }
)
</script>

<template>
  <n-modal v-model:show="showModal" style="border-radius: 12px; overflow: hidden">
    <n-card
      class="settings-root-card"
      :bordered="false"
      role="dialog"
      aria-modal="true"
      :style="{
        backgroundColor: themeVars.modalColor,
        maxWidth: 'calc(100vw - 96px)',
        height: '80vh'
      }"
      content-style="padding: 0; display: flex; flex-direction: column; min-height: 0;"
    >
      <!-- 顶部右上角关闭按钮区域 -->
      <div class="modal-topbar">
        <div class="close-btn" @click="showModal = false">
          <n-icon size="18"><i class="mgc_close_line"></i></n-icon>
        </div>
      </div>
      <div
        class="settings-container"
        style="flex: 1; min-height: 0; display: flex; flex-direction: column"
      >
        <n-layout has-sider style="height: 100%; min-height: 0">
          <n-layout-sider bordered width="220" content-style="padding: 16px 0; overflow: hidden;">
            <!-- 侧边栏标题 -->
            <div class="sider-header">
              <div class="sider-title">设置</div>
            </div>
            <!-- 设置搜索框（命令面板 / 自动完成风格） -->
            <div class="settings-search">
              <n-auto-complete
                v-model:value="searchInput"
                :options="autoCompleteOptions"
                :render-label="renderSearchLabel"
                placeholder="搜索设置..."
                clear-after-select
                @select="handleSearchSelect"
              />
            </div>
            <div style="padding: 0 4px">
              <n-menu v-model:value="activeKey" :options="menuOptions" />
            </div>
          </n-layout-sider>
          <n-layout-content
            ref="settingsContentRef"
            content-style="padding: 6px 32px;"
            :native-scrollbar="false"
            :style="{ backgroundColor: isDark ? undefined : '#F6F6F6' }"
          >
            <!-- 右侧内容区使用过渡包装，实现菜单切换时的淡入淡出效果 -->
            <transition name="settings-section-fade" mode="out-in">
              <!-- 使用 key 强制在菜单切换时重新挂载内容，从而触发过渡 -->
              <div :key="activeKey">
                <settings-general-section
                  v-if="activeKey === 'general'"
                  :setting-item-bg-color="settingItemBgColor"
                  :setting-item-border-color="settingItemBorderColor"
                  :highlight-key="highlightedKey"
                />

                <settings-appearance-section
                  v-else-if="activeKey === 'appearance'"
                  :font-options="fontOptions"
                  :global-font-options="globalFontOptions"
                  :setting-item-bg-color="settingItemBgColor"
                  :setting-item-border-color="settingItemBorderColor"
                  :highlight-key="highlightedKey"
                  :is-mac="isMac"
                />

                <settings-playback-section
                  v-else-if="activeKey === 'playback'"
                  :setting-item-bg-color="settingItemBgColor"
                  :setting-item-border-color="settingItemBorderColor"
                  :highlight-key="highlightedKey"
                />

                <settings-lyrics-section
                  v-else-if="activeKey === 'lyrics'"
                  :setting-item-bg-color="settingItemBgColor"
                  :setting-item-border-color="settingItemBorderColor"
                  :highlight-key="highlightedKey"
                />

                <settings-local-section
                  v-else-if="activeKey === 'local'"
                  :setting-item-bg-color="settingItemBgColor"
                  :setting-item-border-color="settingItemBorderColor"
                  :highlight-key="highlightedKey"
                />

                <settings-plugin-section
                  v-else-if="activeKey === 'plugins'"
                  :setting-item-bg-color="settingItemBgColor"
                  :setting-item-border-color="settingItemBorderColor"
                  :highlight-key="highlightedKey"
                />

                <settings-morphaeum-section
                  v-else-if="activeKey === 'morphaeum'"
                  :setting-item-bg-color="settingItemBgColor"
                  :setting-item-border-color="settingItemBorderColor"
                  :highlight-key="highlightedKey"
                />

                <settings-about-section
                  v-else-if="activeKey === 'about'"
                  @open-morphaeum="activeKey = 'morphaeum'"
                />
              </div>
            </transition>
          </n-layout-content>
        </n-layout>
      </div>
    </n-card>
  </n-modal>
</template>

<style lang="scss">
@use '../../styles/settings-modal.scss';
</style>
