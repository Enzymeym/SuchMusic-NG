<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, onMounted } from 'vue'
import {
  NSlider,
  NIcon,
  NText,
  NButton,
  NPopover,
  NDropdown,
  NTag,
  useThemeVars,
  NDrawer,
  NDrawerContent,
  NEmpty,
  useMessage,
  NBadge,
  NCheckbox,
  useDialog
} from 'naive-ui'
import { usePlayerStore, type PlayerSong } from '../../stores/playerStore'
import { usePlaylistStore } from '../../stores/playlistStore'
import { useVolumeBalanceStore } from '../../stores/volumeBalanceStore'
import defaultCover from '@renderer/assets/default-cover.png'
import { audioEngine } from '../../audio/audio-engine'
import PlayerPage from './PlayerPage.vue'
import { useSettingsStore } from '../../stores/settingsStore'
import { useDesktopLyric } from '../../composables/useDesktopLyric'
import { useTaskbarLyric } from '../../composables/useTaskbarLyric'
import { AudioPlayerManager } from '../../utils/audioPlayerManager'
import SoundEffectsModal from '../common/SoundEffectsModal.vue'
import ShinyText from '../common/ShinyText.vue'
import { useRouter } from 'vue-router'
import { getTransitionController } from '../../audio/transition-controller'
import { mixHexColor } from '../../utils/color'
import { formatTime } from '../../utils/format'

const themeVars = useThemeVars()
const message = useMessage()
const dialog = useDialog()
const router = useRouter()

// 获取全局播放器 store
const player = usePlayerStore()
const playlistStore = usePlaylistStore()
// 获取全局设置 store
const settingsStore = useSettingsStore()
// 音量平衡（本地响度分析）store
const volumeBalanceStore = useVolumeBalanceStore()

/**
 * 将音量平衡补偿增益应用到音频引擎（按当前歌曲的本地文件路径查表）
 * 无 filePath（在线歌曲）或未启用/未分析时应用 0 dB
 */
const applyTrackGain = (song: PlayerSong | null) => {
  const db = volumeBalanceStore.getGainDb((song as any)?.filePath)
  audioEngine.setTrackGainDb(db)
}

const { isDesktopLyricOpen, toggleDesktopLyric } = useDesktopLyric()
const {
  isOpen: isTaskbarLyricOpen,
  toggle: toggleTaskbarLyric,
  init: initTaskbarLyric
} = useTaskbarLyric()

// 音效调节弹窗
const showSoundEffectsModal = ref(false)

// Automix 智能过渡调度控制器（任务 4）
const transitionController = getTransitionController()

// 初始化任务栏歌词、音频引擎和 SMTC 控制
onMounted(async () => {
  // 恢复音量平衡设置并对当前歌曲应用一次补偿增益（应用启动恢复场景）
  volumeBalanceStore.load()
  applyTrackGain(player.currentSong)
  initTaskbarLyric()
  // 提前初始化音频引擎，避免拖动滑块时的初始化开销；
  // WASAPI 模式下必须先 await 完成引擎创建，否则后续恢复歌曲的 load 会失败
  await audioEngine.ensureContext()
  // 初始化智能过渡调度（时域帧采集 + 决策回调 + 交叉淡化完成回调）
  transitionController.init()

  // 设置音频播放结束回调
  audioEngine.setOnEndedCallback(() => {
    // 防御：过渡标志卡住但引擎并未在交叉淡化（过渡被中断但状态未清理）时，
    // 复位过渡状态继续切歌，避免 UI 显示播放中而音频静默的卡死状态。
    // 正常交叉淡化中 sourceA 结束走引擎内部 finalizeCrossfade，不会进此回调
    if (player.isTransitioning && !audioEngine.isCrossfading) {
      player.setTransitioning(false)
    }
    player.handleSongEnd()
  })

  // 注册 SMTC 多媒体控制（Windows 任务栏媒体按钮 / 系统媒体键）
  registerMediaSessionHandlers()

  // 恢复上次播放的歌曲（仅加载并定位到保存的进度，不自动播放）。
  // 原因：loadPlayerState() 在 App.vue setup 中执行，早于本组件 currentSong
  // watch 的注册，恢复的歌曲不会触发 watch 加载；这里显式加载一次，
  // 配合 shouldAutoPlay=false（恢复流程已置 false）完成"点击播放继续"的恢复。
  if (player.currentSong) {
    loadAndPlaySong(player.currentSong)
  }
})

// 清理音频播放结束回调和 SMTC 控制
onBeforeUnmount(() => {
  transitionController.dispose()
  audioEngine.removeOnEndedCallback()
  unregisterMediaSessionHandlers()
  stopProgressPolling()

  if (playlistScrollTimer) {
    clearTimeout(playlistScrollTimer)
    playlistScrollTimer = null
  }
  if (playerPageShowTimer) {
    clearTimeout(playerPageShowTimer)
    playerPageShowTimer = null
  }
})

// 播放锁，防止并发播放
let isLoadingSong = false

// ===== 进度轮询 =====
let progressPollTimer: ReturnType<typeof setInterval> | null = null

const startProgressPolling = () => {
  stopProgressPolling()
  progressPollTimer = setInterval(async () => {
    if (!player.isPlaying) {
      return
    }
    if (isDraggingProgress.value) return // 拖拽时不更新
    try {
      const pos = await audioEngine.getCurrentPosition()
      if (pos > 0) {
        player.setPosition(pos)
        // Automix：将进度喂给过渡调度，到达触发点执行过渡
        transitionController.onProgress(pos)
      }
    } catch {
      // 忽略轮询错误
    }
  }, 250)
}

const stopProgressPolling = () => {
  if (progressPollTimer) {
    clearInterval(progressPollTimer)
    progressPollTimer = null
  }
}

// 加载并播放歌曲的核心逻辑
const loadAndPlaySong = async (song: PlayerSong, forcePlay: boolean = false) => {
  // 防止并发播放
  if (isLoadingSong) {
    console.log('[PlayerBar] 正在加载歌曲，跳过重复请求')
    return
  }
  isLoadingSong = true

  try {
    await doLoadAndPlaySong(song, forcePlay)
  } finally {
    isLoadingSong = false
  }
}

// 实际加载并播放歌曲的逻辑
const doLoadAndPlaySong = async (song: PlayerSong, forcePlay: boolean = false, isRetry = false) => {
  // 应用音量平衡补偿增益（覆盖手动播放、上一首/下一首、自动连播）
  applyTrackGain(song)

  // 决定是否播放：如果是强制播放，则为 true；否则读取 store 中的 shouldAutoPlay
  // 注意：如果是 watch 触发（forcePlay=false），我们需要消费并重置 shouldAutoPlay
  let shouldPlay = forcePlay
  if (!forcePlay) {
    shouldPlay = player.shouldAutoPlay
    player.shouldAutoPlay = true
  }

  // 切歌时进度已在 playSongAtIndex/setCurrentSong 中重置为 0，
  // 这里不再无条件清零，避免覆盖恢复状态/播放重试时保存的进度

  const currentProcessId = song.id
  let filePath = (song as any).filePath as string | undefined

  // 重启恢复的在线歌曲未持久化 filePath（CDN 地址会过期），按 sourceSongId 重新解析
  if (!filePath && (song as any).source === 'netease' && (song as any).sourceSongId) {
    try {
      const songId = Number((song as any).sourceSongId)
      const urlMap = await window.api.netease.songUrl([songId])
      const freshUrl = urlMap[songId]
      if (freshUrl) {
        filePath = freshUrl
        ;(song as any).filePath = freshUrl
      }
    } catch (e) {
      console.warn('[PlayerBar] 重新解析网易云播放地址失败:', e)
    }
  }

  const isUrl = filePath && /^https?:\/\//.test(filePath)

  if (filePath && window.electron && window.electron.ipcRenderer) {
    // 远程 URL：直接流式播放，无需检查本地文件
    if (isUrl) {
      try {
        if (shouldPlay) {
          await AudioPlayerManager.play({ url: filePath, volume: player.volume })
          // 播放重试（如重启后首次播放失败）：加载后跳回保存的进度继续播放
          if (player.positionMs > 0 && player.currentSong?.id === currentProcessId) {
            audioEngine.seek(player.positionMs)
          }
        } else {
          await AudioPlayerManager.load({ url: filePath, volume: player.volume })
          if (player.positionMs > 0) {
            audioEngine.seek(player.positionMs, false)
          }
        }

        if (player.currentSong?.id !== currentProcessId) {
          audioEngine.stop()
          return
        }
        if (shouldPlay) {
          player.setPlaying(true)
          // Automix：开启当前曲的过渡循环（远程 URL 不支持预解码，controller 内部会跳过）
          transitionController.onSongStarted(song)
        }
        return
      } catch (e) {
        console.error('[PlayerBar] Failed to play remote audio:', e)
        // 网易云在线歌曲：CDN 地址可能已过期/需登录态，重新解析一次后重试
        if (!isRetry && (song as any).source === 'netease' && (song as any).sourceSongId) {
          try {
            const songId = Number((song as any).sourceSongId)
            const urlMap = await window.api.netease.songUrl([songId])
            const freshUrl = urlMap[songId]
            if (freshUrl && freshUrl !== filePath) {
              ;(song as any).filePath = freshUrl
              return await doLoadAndPlaySong(song, forcePlay, true)
            }
          } catch (err) {
            console.warn('[PlayerBar] 重新解析播放地址失败:', err)
          }
        }
        message.error('在线音频加载失败')
        return
      }
    }

    // 先检查文件是否存在
    const exists = await window.electron.ipcRenderer.invoke('system:fs-exists', filePath)

    if (player.currentSong?.id !== currentProcessId) return

    if (exists) {
      // 尝试加载本地歌词（如果缺失）
      if (!song.lyrics) {
        window.electron.ipcRenderer
          .invoke('local-music:get-meta', filePath)
          .then((meta: any) => {
            if (meta && meta.lyrics && player.currentSong?.id === song.id) {
              player.setLyrics(meta.lyrics)
            }
          })
          .catch((err) => {
            console.warn('Failed to load local lyrics:', err)
          })
      }

      try {
        if (shouldPlay) {
          await AudioPlayerManager.play({
            filePath,
            volume: player.volume
          })
          // 播放重试（如重启后首次播放失败）：加载后跳回保存的进度继续播放
          if (player.positionMs > 0 && player.currentSong?.id === currentProcessId) {
            audioEngine.seek(player.positionMs)
          }
        } else {
          await AudioPlayerManager.load({
            filePath,
            volume: player.volume
          })
          // 恢复进度（仅定位不播放）
          if (player.positionMs > 0) {
            audioEngine.seek(player.positionMs, false)
          }
        }

        if (player.currentSong?.id !== currentProcessId) {
          audioEngine.stop() // 如果播放后发现切歌了，立即停止
          return
        }
        if (shouldPlay) {
          player.setPlaying(true)
          // Automix：开启当前曲的过渡循环（预解码下一首 + 实时过渡点分析）
          transitionController.onSongStarted(song)
        }
        return
      } catch (e: any) {
        console.error('[PlayerBar] Failed to play local file:', e)
        player.setPlaying(false)
        const errMsg = e?.message || String(e)
        message.error(
          errMsg.includes('文件不存在')
            ? `本地文件已不存在，无法播放 (${filePath})`
            : `播放失败: ${errMsg}`
        )
        return
      }
    } else {
      console.warn('[PlayerBar] Local file not found:', filePath)
      player.setPlaying(false)
      message.error(`本地文件不存在，无法播放 (${filePath})`)
      return
    }
  }

  // 既不是远程 URL 也没有本地文件路径，无法播放
  message.warning('没有可用的文件路径，无法播放')
}

// 监听 currentSong 变化，触发播放
// 注意：LocalMusicView 中也有播放逻辑，这里主要是响应上一首/下一首的切换
// 使用对象引用比较而非 id 比较，确保单曲循环模式下同一首歌也能重新加载
watch(
  () => player.currentSong,
  async (newSong, oldSong) => {
    if (!newSong || newSong === oldSong) return

    // 过渡完成：音频已被 controller 的交叉淡化接管（sourceB 正在播放），
    // 跳过重复加载，仅复位标志并开启下一曲的过渡循环
    if (player.transitionConsumed) {
      player.setTransitionConsumed(false)
      // 交叉淡化完成后应用下一曲的音量平衡增益
      applyTrackGain(newSong)
      // 过渡流程仍在进行中（交叉淡化未完成，UI 已提前切换歌曲信息）：
      // 不在此开启新过渡循环，等交叉淡化完成后由本 watch 再次触发
      if (transitionController.isActive || player.isTransitioning) return
      transitionController.onSongStarted(newSong)
      return
    }

    await loadAndPlaySong(newSong)
  }
)

// 音量平衡开关 / 目标响度 / 增益范围变化时，对当前歌曲即时重新应用补偿增益
watch(
  () => [volumeBalanceStore.enabled, volumeBalanceStore.targetLufs, volumeBalanceStore.maxGainDb],
  () => {
    applyTrackGain(player.currentSong)
  }
)

// 播放 / 暂停切换
const togglePlay = async () => {
  if (player.isPlaying) {
    // 暂停时若正在过渡（交叉淡化/分析中），中断过渡流程
    if (transitionController.isActive) {
      transitionController.abort()
      player.setTransitioning(false)
    }
    await audioEngine.pause()
    player.setPlaying(false)
    // 主动更新 SMTC 播放状态
    updateMediaPlaybackState()
    updateMediaPositionState()
  } else {
    if (player.currentSong) {
      const success = await audioEngine.play()
      if (success) {
        player.setPlaying(true)
        // 手动/恢复播放：重新武装智能过渡（暂停或恢复状态加载时未走 onSongStarted，
        // 不武装则 transitionController.active 恒为 false，歌曲结束直接硬切）
        if (!transitionController.isActive) {
          transitionController.onSongStarted(player.currentSong)
        }
        // 主动更新 SMTC 播放状态
        updateMediaPlaybackState()
        updateMediaPositionState()
      } else {
        // 播放失败（如未加载），尝试重新加载并播放
        console.log('[PlayerBar] Play failed, reloading song...')
        await loadAndPlaySong(player.currentSong, true)
      }
    }
  }
}

// 切歌
const handlePrev = () => {
  // 中断过渡流程，走现有快速切换路径
  transitionController.abort()
  player.setTransitioning(false)
  player.playPrev()
}

const handleNext = () => {
  // 中断过渡流程，走现有快速切换路径
  transitionController.abort()
  player.setTransitioning(false)
  player.playNext()
}

// 播放模式
const toggleMode = () => {
  player.togglePlayMode()
}

const modeIcon = computed(() => {
  switch (player.playMode) {
    case 'loop':
      return 'mgc_repeat_one_line'
    case 'shuffle':
      return 'mgc_shuffle_line'
    case 'list':
    default:
      return 'mgc_repeat_line'
  }
})

// 显示播放列表抽屉
const showPlaylist = ref(false)

// 批量管理模式
const isBatchMode = ref(false)
const selectedIds = ref<Set<string>>(new Set())

const toggleBatchMode = () => {
  if (isBatchMode.value) {
    isBatchMode.value = false
    selectedIds.value = new Set()
  } else {
    isBatchMode.value = true
    selectedIds.value = new Set()
  }
}

const toggleItemSelection = (songId: string | number | undefined | null) => {
  if (!songId) return
  const id = String(songId)
  const newSet = new Set(selectedIds.value)
  if (newSet.has(id)) {
    newSet.delete(id)
  } else {
    newSet.add(id)
  }
  selectedIds.value = newSet
}

const allSelected = computed(() => {
  return (
    player.playlist.length > 0 &&
    player.playlist.every((s) => s.id && selectedIds.value.has(String(s.id)))
  )
})

const toggleSelectAll = () => {
  if (allSelected.value) {
    selectedIds.value = new Set()
  } else {
    selectedIds.value = new Set(player.playlist.filter((s) => s.id).map((s) => String(s.id)))
  }
}

// 批量模式下拖拽排序
const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

const handleDragStart = (index: number, e: DragEvent) => {
  if (!isBatchMode.value) return
  dragIndex.value = index
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
  }
}

const handleDragOver = (index: number, e: DragEvent) => {
  if (!isBatchMode.value || dragIndex.value === null) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  if (dragOverIndex.value !== index) dragOverIndex.value = index
}

const handleDragLeave = (index: number, e: DragEvent) => {
  const related = e.relatedTarget as HTMLElement | null
  if (related && (e.currentTarget as HTMLElement).contains(related)) return
  if (dragOverIndex.value === index) dragOverIndex.value = null
}

const handleDrop = (index: number) => {
  if (!isBatchMode.value || dragIndex.value === null) return
  player.reorderPlaylist(dragIndex.value, index)
  dragOverIndex.value = null
}

const handleDragEnd = () => {
  dragIndex.value = null
  dragOverIndex.value = null
}

const handleBatchDelete = () => {
  const ids = Array.from(selectedIds.value)
  if (ids.length === 0) return
  dialog.warning({
    title: '确认删除',
    content: `确定从播放列表中移除 ${ids.length} 首歌曲吗？`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: () => {
      player.removeMultipleFromPlaylist(ids)
      message.success(`已移除 ${ids.length} 首歌曲`)
      toggleBatchMode()
    }
  })
}

const handleBatchFavorite = () => {
  const ids = Array.from(selectedIds.value)
  if (ids.length === 0) return
  let addedCount = 0
  for (const id of ids) {
    const song = player.playlist.find((s) => s.id && String(s.id) === id)
    if (!song) continue
    playlistStore.toggleFavorite({
      id: song.id!,
      title: song.title,
      artist: song.artist,
      album: song.album,
      cover: song.cover,
      filePath: (song as any).filePath,
      durationMs: song.durationMs,
      source: song.source,
      sourceSongId: song.sourceSongId
    })
    addedCount++
  }
  message.success(`已收藏 ${addedCount} 首歌曲`)
  toggleBatchMode()
}

const batchAddToPlaylistOptions = computed(() => {
  return playlistStore.playlists.map((pl) => ({
    label: pl.name,
    key: pl.id
  }))
})

const batchActionOptions = computed(() => [
  {
    label: '删除',
    key: 'delete',
    disabled: selectedIds.value.size === 0
  },
  {
    label: '收藏',
    key: 'favorite',
    disabled: selectedIds.value.size === 0
  },
  {
    type: 'divider' as const,
    key: 'd1'
  },
  {
    label: '添加到歌单',
    key: 'add-to-playlist-header',
    children: batchAddToPlaylistOptions.value
  }
])

const handleBatchActionSelect = (key: string) => {
  if (key === 'delete') {
    handleBatchDelete()
  } else if (key === 'favorite') {
    handleBatchFavorite()
  } else if (key !== 'add-to-playlist-header' && key !== 'd1') {
    handleBatchAddToPlaylistSelect(key)
  }
}

const handleBatchAddToPlaylistSelect = (playlistId: string | number) => {
  const id = String(playlistId)
  const target = playlistStore.playlists.find((p) => p.id === id)
  if (!target) return
  const ids = Array.from(selectedIds.value)
  if (ids.length === 0) return

  const newTracks = ids
    .map((id) => player.playlist.find((s) => s.id && String(s.id) === id))
    .filter((s): s is PlayerSong => !!s)
    .filter((s) => !target.tracks.some((t) => t.id && String(t.id) === String(s.id)))
    .map((s) => ({
      id: s.id ?? '',
      title: s.title,
      artist: s.artist,
      album: s.album,
      cover: s.cover,
      filePath: (s as any).filePath,
      durationMs: s.durationMs,
      source: s.source,
      sourceSongId: s.sourceSongId
    }))

  if (newTracks.length === 0) {
    message.info('所选歌曲均已存在该歌单中')
    return
  }

  const updated = { ...target, tracks: [...target.tracks, ...newTracks] }
  playlistStore.updatePlaylist(updated)
  message.success(`已添加 ${newTracks.length} 首歌曲到「${target.name}」`)
  toggleBatchMode()
}

// 更多菜单显示状态
const showMoreMenu = ref(false)

/**
 * 歌词偏移预设选项
 */
const lyricsOffsetOptions = [-2.0, -1.0, -0.5, 0, 0.5, 1.0, 2.0].map((offset) => ({
  label: offset === 0 ? '0s（默认）' : offset > 0 ? `+${offset}s` : `${offset}s`,
  key: `lyrics-offset-${offset}`,
  offset
}))

/**
 * 播放速度预设选项
 */
const playbackRateOptions = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((rate) => ({
  label: rate === 1.0 ? `${rate}x（正常）` : `${rate}x`,
  key: `playback-rate-${rate}`,
  rate
}))

/**
 * 更多菜单选项
 */
const moreMenuOptions = computed(() => [
  {
    label: '歌词偏移',
    key: 'lyrics-offset-header',
    icon: () => null,
    children: lyricsOffsetOptions
  },
  {
    label: '播放速度',
    key: 'playback-rate-header',
    icon: () => null,
    children: playbackRateOptions
  },
  {
    type: 'divider' as const,
    key: 'divider-1'
  },
  {
    label: '搜索同名歌曲',
    key: 'search-same-name',
    disabled: !player.currentSong?.title
  }
])

/**
 * 处理更多菜单选择
 * @param key 选项键值
 */
const handleMoreMenuSelect = (key: string) => {
  showMoreMenu.value = false

  // 歌词偏移选项
  if (key.startsWith('lyrics-offset-')) {
    const offset = parseFloat(key.replace('lyrics-offset-', ''))
    settingsStore.playback.lyricsOffset = offset
    return
  }

  // 播放速度选项
  if (key.startsWith('playback-rate-')) {
    const rate = parseFloat(key.replace('playback-rate-', ''))
    settingsStore.playback.playbackRate = rate
    audioEngine.setPlaybackRate(rate)
    updateMediaPositionState()
    return
  }

  // 搜索同名歌曲
  if (key === 'search-same-name') {
    const title = player.currentSong?.title
    if (title) {
      router.push({ path: '/search', query: { q: title } })
    }
    return
  }
}

const togglePlaylist = () => {
  showPlaylist.value = !showPlaylist.value
}

// 从播放页打开发送播放列表时使用（只负责打开，不切换）
const openPlaylist = () => {
  showPlaylist.value = true
}

const handlePlaylistClick = (song: PlayerSong) => {
  // 手动选择歌曲，中断过渡流程
  transitionController.abort()
  player.setTransitioning(false)
  player.setCurrentSong(song)
  // 触发播放逻辑 (依赖 watch)
}

// 进度条拖拽状态
const isDraggingProgress = ref(false)
const dragValue = ref(0)

// 当前进度映射为 0-100 百分比
const progressPercent = computed(() => {
  if (isDraggingProgress.value) return dragValue.value
  if (!player.currentSong || player.currentSong.durationMs <= 0) return 0
  return (player.positionMs / player.currentSong.durationMs) * 100
})

/**
 * 中断过渡流程后再执行 seek：seek 会改变播放位置并可能打断引擎交叉淡化
 * （触发 onended），先放弃当前过渡避免状态错乱。
 * 注意：需在音频引擎 seek 前调用，且不能顺手清掉 isTransitioning 以外的状态。
 */
const abortTransitionForSeek = () => {
  if (transitionController.isActive) {
    transitionController.abort()
    player.setTransitioning(false)
  }
}

/**
 * 执行 seek 跳转
 */
const doSeek = (percent: number) => {
  if (!player.currentSong || player.currentSong.durationMs <= 0) return

  // seek 会打断引擎交叉淡化（触发 onended），先中断过渡流程避免状态错乱
  abortTransitionForSeek()

  const ratio = Math.min(Math.max(percent, 0), 100) / 100
  const targetMs = player.currentSong.durationMs * ratio
  player.setPosition(targetMs)
  audioEngine.seek(targetMs)
  // seek 中断了过渡流程：重新武装智能过渡，剩余播放时间仍能触发过渡
  transitionController.rearmAfterSeek()
}

const handleProgressUpdate = (val: number) => {
  dragValue.value = val

  // 拖拽中：仅更新 dragValue，seek 由 endDrag 统一处理
  if (isDraggingProgress.value) return

  // 点击进度条 → 立即跳转
  if (!player.currentSong || player.currentSong.durationMs <= 0) return

  // 防止轮询更新 player.positionMs 触发滑块 @update:value 造成反馈循环
  const currentPercent = (player.positionMs / player.currentSong.durationMs) * 100
  if (Math.abs(val - currentPercent) < 0.5) return

  doSeek(val)
}

const startDrag = () => {
  // 初始化 dragValue 为当前进度，防止跳变
  if (player.currentSong && player.currentSong.durationMs > 0) {
    dragValue.value = (player.positionMs / player.currentSong.durationMs) * 100
  } else {
    dragValue.value = 0
  }

  isDraggingProgress.value = true
}

const endDrag = () => {
  isDraggingProgress.value = false

  if (!player.currentSong || player.currentSong.durationMs <= 0) return

  doSeek(dragValue.value)
}

// 节流函数
const throttle = (func: Function, delay: number) => {
  let lastCall = 0
  return (...args: any[]) => {
    const now = Date.now()
    if (now - lastCall >= delay) {
      lastCall = now
      return func(...args)
    }
  }
}

// 节流处理的音量更新函数
const updateVolume = throttle((volume: number) => {
  const v = volume / 100
  // 先更新本地状态，避免UI卡顿
  player.setVolume(v)
  // 直接调用audioEngine.setVolume，避免双重requestAnimationFrame
  audioEngine.setVolume(v)
}, 30) // 减少节流间隔到30ms，提高响应速度

// 音量使用 0-100 的滑块值
const volumePercent = computed({
  get: () => Math.round(player.volume * 100),
  set: (val: number) => {
    updateVolume(val)
  }
})

// 已播放时间（秒），用于显示为分钟:秒
const playedSeconds = computed(() => Math.floor(player.positionMs / 1000))

// 总时长（秒），用于显示为分钟:秒
const totalSeconds = computed(() => {
  if (!player.currentSong || player.currentSong.durationMs <= 0) return 0
  return Math.floor(player.currentSong.durationMs / 1000)
})

// 判断当前环境是否支持 Media Session（用于 SMTC）
const supportsMediaSession =
  typeof navigator !== 'undefined' && (navigator as any).mediaSession !== undefined

// 更新 Media Session 的元数据（标题 / 艺术家 / 封面）
const updateMediaMetadata = () => {
  if (!supportsMediaSession) return

  const mediaSession = (navigator as any).mediaSession
  const MediaMetadataCtor = (window as any).MediaMetadata

  if (!MediaMetadataCtor) return

  const song = player.currentSong
  if (!song) {
    mediaSession.metadata = null
    return
  }

  const artworkSrc = song.cover || defaultCover

  // 尝试从 data URL 中解析封面 MIME 类型，保证与实际格式一致
  let artworkType = 'image/png'
  if (typeof artworkSrc === 'string' && artworkSrc.startsWith('data:')) {
    const mimeMatch = artworkSrc.slice(5).split(';', 1)[0]
    if (mimeMatch) {
      artworkType = mimeMatch
    }
  }

  mediaSession.metadata = new MediaMetadataCtor({
    title: song.title || '未选择歌曲',
    artist: song.artist || '',
    album: song.album || '',
    artwork: [
      {
        src: artworkSrc,
        sizes: '512x512',
        type: artworkType
      }
    ]
  })
}

// 更新 Media Session 的播放位置状态（用于系统进度条与拖动）
const updateMediaPositionState = () => {
  if (!supportsMediaSession) return

  const mediaSession = (navigator as any).mediaSession
  if (typeof mediaSession.setPositionState !== 'function') return

  const song = player.currentSong
  if (!song || !song.durationMs || song.durationMs <= 0) return

  // 确保 position 值不超过 duration 值，避免 setPositionState 抛出错误
  const duration = song.durationMs / 1000
  const position = Math.min(player.positionMs / 1000, duration)

  mediaSession.setPositionState({
    duration: duration,
    position: position,
    playbackRate: 1
  })
}

// 更新 Media Session 的播放状态（playing/paused/none）
const updateMediaPlaybackState = () => {
  if (!supportsMediaSession) return
  const mediaSession = (navigator as any).mediaSession

  if (!player.currentSong) {
    mediaSession.playbackState = 'none'
    return
  }

  mediaSession.playbackState = player.isPlaying ? 'playing' : 'paused'
}

// 刷新完整的 SMTC 状态（metadata + playbackState + position）
const refreshMediaSession = () => {
  updateMediaMetadata()
  updateMediaPlaybackState()
  updateMediaPositionState()
}

// 注册 Media Session 操作处理器（在 onMounted 中调用一次）
const registerMediaSessionHandlers = () => {
  if (!supportsMediaSession) return

  const mediaSession = (navigator as any).mediaSession

  // 播放 —— 复用 togglePlay，包含 currentSong 检查和 play 失败兜底
  mediaSession.setActionHandler('play', () => {
    if (!player.isPlaying) {
      togglePlay()
    }
  })

  // 暂停 —— 复用 togglePlay
  mediaSession.setActionHandler('pause', () => {
    if (player.isPlaying) {
      togglePlay()
    }
  })

  // 停止
  mediaSession.setActionHandler('stop', () => {
    if (player.isPlaying) {
      togglePlay()
    }
  })

  // 上一首
  mediaSession.setActionHandler('previoustrack', () => {
    handlePrev()
    refreshMediaSession()
  })

  // 下一首
  mediaSession.setActionHandler('nexttrack', () => {
    handleNext()
    refreshMediaSession()
  })

  // 快退
  mediaSession.setActionHandler('seekbackward', (details: any) => {
    const offsetSec = details?.seekOffset ?? 10
    const targetMs = Math.max(0, player.positionMs - offsetSec * 1000)
    abortTransitionForSeek()
    audioEngine.seek(targetMs)
    // seek 中断了过渡流程：重新武装智能过渡
    transitionController.rearmAfterSeek()
    updateMediaPositionState()
  })

  // 快进
  mediaSession.setActionHandler('seekforward', (details: any) => {
    const offsetSec = details?.seekOffset ?? 10
    const targetMs = player.positionMs + offsetSec * 1000
    abortTransitionForSeek()
    audioEngine.seek(targetMs)
    // seek 中断了过渡流程：重新武装智能过渡
    transitionController.rearmAfterSeek()
    updateMediaPositionState()
  })

  // 跳转到指定时间
  mediaSession.setActionHandler('seekto', (details: any) => {
    if (typeof details?.seekTime !== 'number') return
    const targetMs = Math.max(0, details.seekTime * 1000)
    abortTransitionForSeek()
    audioEngine.seek(targetMs)
    // seek 中断了过渡流程：重新武装智能过渡
    transitionController.rearmAfterSeek()
    updateMediaPositionState()
  })
}

// 清除 Media Session 操作处理器
const unregisterMediaSessionHandlers = () => {
  if (!supportsMediaSession) return

  const mediaSession = (navigator as any).mediaSession
  const actions = [
    'play',
    'pause',
    'stop',
    'previoustrack',
    'nexttrack',
    'seekbackward',
    'seekforward',
    'seekto'
  ]
  for (const action of actions) {
    mediaSession.setActionHandler(action, null)
  }
}

// 监听当前歌曲及其元数据变化，刷新 SMTC
watch(
  () => ({
    id: player.currentSong?.id,
    title: player.currentSong?.title,
    artist: player.currentSong?.artist,
    album: player.currentSong?.album,
    cover: player.currentSong?.cover
  }),
  () => {
    updateMediaMetadata()
    updateMediaPositionState()
  },
  { immediate: true }
)

// 监听播放状态，更新 SMTC 播放状态并管理进度轮询
watch(
  () => player.isPlaying,
  (isPlaying) => {
    updateMediaPlaybackState()
    updateMediaPositionState()
    if (isPlaying) {
      startProgressPolling()
    } else {
      stopProgressPolling()
    }
  },
  { immediate: true }
)

// 监听播放进度，定期更新位置状态
watch(
  () => player.positionMs,
  () => {
    updateMediaPositionState()
  }
)

// 任务栏进度（0-1 之间，小于 0 表示关闭显示）
const taskbarProgress = computed(() => {
  if (!settingsStore.general.taskbarProgress) return -1
  if (!player.currentSong || player.currentSong.durationMs <= 0) return -1
  return player.positionMs / player.currentSong.durationMs
})

let lastTaskbarProgress = -1

// 监听进度变化，同步到主进程以更新任务栏图标进度
watch(
  taskbarProgress,
  (val) => {
    if (!(window as any).electron?.ipcRenderer) return

    // 关闭显示时，发送 -1 重置任务栏进度
    if (val < 0) {
      if (lastTaskbarProgress === -1) return
      lastTaskbarProgress = -1
      window.electron.ipcRenderer.send('player:taskbarProgress', { progress: -1 })
      return
    }

    const clamped = Math.max(0, Math.min(val, 1))
    // 量化到 1% 精度，避免频繁 IPC
    const normalized = Math.round(clamped * 100) / 100
    if (normalized === lastTaskbarProgress) return
    lastTaskbarProgress = normalized

    window.electron.ipcRenderer.send('player:taskbarProgress', { progress: normalized })
  },
  { immediate: true }
)

// 任务栏缩略图工具栏 —— 同步播放状态到主进程
const lastThumbnailState = ref<string>('')

const updateThumbnailToolbar = () => {
  if (!(window as any).electron?.ipcRenderer) return

  const hasSongs = player.playlist.length > 0
  const canPrev = hasSongs
  const canNext = hasSongs
  const visible = !!player.currentSong

  const stateKey = `${visible}|${player.isPlaying}|${canPrev}|${canNext}`
  if (stateKey === lastThumbnailState.value) return
  lastThumbnailState.value = stateKey

  window.electron.ipcRenderer.send('player:thumbnailToolbar', {
    isPlaying: player.isPlaying,
    canPrev,
    canNext,
    visible
  })
}

watch(
  () => ({
    song: player.currentSong?.id,
    isPlaying: player.isPlaying,
    playlistLength: player.playlist.length
  }),
  () => {
    updateThumbnailToolbar()
  },
  { immediate: true }
)

// 监听主进程缩略图按钮点击事件
const onThumbnailAction = (_event: any, data: { action: 'prev' | 'next' | 'togglePlay' }) => {
  switch (data.action) {
    case 'prev':
      handlePrev()
      break
    case 'next':
      handleNext()
      break
    case 'togglePlay':
      togglePlay()
      break
  }
}

const ipcRenderer = (window as any).electron?.ipcRenderer
if (ipcRenderer) {
  ipcRenderer.on('player:thumbnailAction', onThumbnailAction)
}

onBeforeUnmount(() => {
  if (ipcRenderer) {
    ipcRenderer.removeListener('player:thumbnailAction', onThumbnailAction)
  }
  // 清除缩略图工具栏按钮
  if (ipcRenderer) {
    ipcRenderer.send('player:thumbnailToolbar', { visible: false })
  }
  // 恢复默认标题
  if (ipcRenderer) {
    ipcRenderer.send('player:taskbarTitle', { title: 'Such Music' })
  }
})

// 任务栏标题 —— 根据设置决定是否在窗口标题上显示歌曲信息
const taskbarTitle = computed(() => {
  if (!settingsStore.general.taskbarSongInfo || !player.currentSong) return 'Such Music'
  const song = player.currentSong
  if (song.artist) {
    return `${song.title} - ${song.artist}`
  }
  return song.title
})

let lastTaskbarTitle = ''

watch(
  taskbarTitle,
  (val) => {
    if (!(window as any).electron?.ipcRenderer) return
    if (val === lastTaskbarTitle) return
    lastTaskbarTitle = val
    window.electron.ipcRenderer.send('player:taskbarTitle', { title: val })
  },
  { immediate: true }
)

const playlistContainerRef = ref<HTMLElement | null>(null)

const toggleFavorite = () => {
  if (!player.currentSong) return
  const isAdded = playlistStore.toggleFavorite({
    id: player.currentSong.id,
    title: player.currentSong.title,
    artist: player.currentSong.artist,
    album: player.currentSong.album,
    cover: player.currentSong.cover,
    filePath: (player.currentSong as any).filePath,
    durationMs: player.currentSong.durationMs,
    source: player.currentSong.source,
    sourceSongId: player.currentSong.sourceSongId
  })
  if (isAdded) {
    message.success('已添加到我喜爱的音乐')
  } else {
    message.success('已取消收藏')
  }
}

const isCurrentFavorite = computed(() => {
  if (!player.currentSong) return false
  return playlistStore.isFavorite({
    id: player.currentSong.id,
    title: player.currentSong.title,
    artist: player.currentSong.artist,
    source: player.currentSong.source,
    sourceSongId: player.currentSong.sourceSongId
  })
})

const handleRemove = (song: PlayerSong) => {
  if (song.id) {
    player.removeFromPlaylist(song.id)
  }
}

const handleClear = () => {
  player.clearPlaylist()
}

const scrollToCurrent = () => {
  if (!player.currentSong?.id || !playlistContainerRef.value) return

  // id 可能是 Windows 文件路径（含 \ : 空格等），必须转义后才能用于 CSS 选择器
  const el = playlistContainerRef.value.querySelector(
    `#song-${CSS.escape(String(player.currentSong.id))}`
  )
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

let playlistScrollTimer: ReturnType<typeof setTimeout> | null = null

watch(showPlaylist, (val) => {
  if (playlistScrollTimer) {
    clearTimeout(playlistScrollTimer)
    playlistScrollTimer = null
  }
  if (val) {
    playlistScrollTimer = setTimeout(scrollToCurrent, 100)
  } else {
    // 关闭抽屉时退出批量模式
    if (isBatchMode.value) {
      toggleBatchMode()
    }
  }
})

import { nextTick } from 'vue'
const drawerTarget = ref('body')
let playerPageShowTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => player.isPlayerPageShown,
  async (val) => {
    if (playerPageShowTimer) {
      clearTimeout(playerPageShowTimer)
      playerPageShowTimer = null
    }
    if (val) {
      await nextTick()
      // Wait an extra tick to ensure Transition has started and element is fully inserted
      playerPageShowTimer = setTimeout(() => {
        drawerTarget.value = '#player-page-container'
        playerPageShowTimer = null
      }, 50)
    } else {
      drawerTarget.value = 'body'
    }
  },
  { immediate: true }
)
</script>

<template>
  <div class="player-bar">
    <PlayerPage @open-playlist="openPlaylist" />
    <!-- Progress Bar (Top) -->
    <div class="progress-wrapper">
      <n-slider
        :value="progressPercent"
        :tooltip="false"
        class="main-progress"
        style="width: 100%"
        @update:value="handleProgressUpdate"
        @dragstart="startDrag"
        @dragend="endDrag"
      />
    </div>

    <!-- Song Info -->
    <div class="song-info">
      <img
        :src="player.currentSong?.cover || defaultCover"
        class="cover-image"
        style="cursor: pointer"
        @click="player.setPlayerPageShown(true)"
      />
      <Transition name="song-slide" mode="out-in">
        <div :key="player.currentSong?.id || 'empty'" class="song-details">
          <div class="song-title-row">
            <n-text strong class="song-title">
              {{ player.currentSong?.title || '未选择歌曲' }}
            </n-text>
            <n-tag
              v-if="player.isTransitioning"
              size="tiny"
              type="info"
              round
              :bordered="false"
              class="transition-badge"
            >
              <ShinyText
                text="智能过渡中"
                :speed="2.5"
                color="rgba(255, 255, 255, 0.7)"
                shine-color="#ffffff"
              />
            </n-tag>
            <n-button text style="display: none" @click="toggleFavorite">
              <n-icon size="18" :color="isCurrentFavorite ? '#d03050' : undefined">
                <i :class="isCurrentFavorite ? 'mgc_heart_fill' : 'mgc_heart_line'"></i>
              </n-icon>
            </n-button>
          </div>
          <n-text depth="3" class="song-artist">
            {{ player.currentSong?.artist || '未知歌手' }}
          </n-text>
        </div>
      </Transition>
    </div>

    <!-- Controls (Center) -->
    <div class="player-controls">
      <div class="control-buttons">
        <n-button strong circle quaternary class="control-btn" @click="toggleMode"
          ><n-icon size="20"><i :class="modeIcon"></i></n-icon
        ></n-button>
        <n-button strong circle quaternary class="control-btn" @click="handlePrev"
          ><n-icon size="22"><i class="mgc_skip_previous_fill"></i></n-icon
        ></n-button>
        <n-button strong circle secondary style="width: 44px; height: 44px" @click="togglePlay">
          <n-icon size="22">
            <i :class="player.isPlaying ? 'mgc_pause_line' : 'mgc_play_fill'"></i>
          </n-icon>
        </n-button>
        <n-button strong circle quaternary class="control-btn" @click="handleNext"
          ><n-icon style="margin: 3px" size="22"><i class="mgc_skip_forward_fill"></i></n-icon
        ></n-button>
        <n-button strong circle quaternary class="control-btn" @click="toggleFavorite">
          <n-icon size="20" :color="isCurrentFavorite ? '#d03050' : undefined">
            <i :class="isCurrentFavorite ? 'mgc_heart_fill' : 'mgc_heart_line'"></i>
          </n-icon>
        </n-button>
      </div>
    </div>

    <!-- Right Actions -->
    <div class="player-actions">
      <span class="time-text">
        {{ formatTime(playedSeconds, { padMinutes: true }) }} / {{ formatTime(totalSeconds, { padMinutes: true }) }}
      </span>
      <n-button
        quaternary
        class="action-btn"
        :type="isDesktopLyricOpen ? 'primary' : 'default'"
        @click="toggleDesktopLyric"
      >
        <n-icon size="22" style="margin-left: -5px"><i class="mgc_text_line"></i></n-icon>
      </n-button>
      <n-button
        quaternary
        class="action-btn"
        style="display: none"
        :type="isTaskbarLyricOpen ? 'primary' : 'default'"
        @click="toggleTaskbarLyric"
        title="任务栏歌词"
      >
        <n-icon size="22" style="margin-left: -5px"><i class="mgc_text_line"></i></n-icon>
      </n-button>
      <n-button quaternary class="action-btn" @click="showSoundEffectsModal = true">
        <n-icon size="22" style="margin-left: -5px"><i class="mgc_settings_2_line"></i></n-icon>
      </n-button>

      <n-dropdown
        trigger="click"
        :options="moreMenuOptions"
        :show="showMoreMenu"
        :to="drawerTarget"
        @select="handleMoreMenuSelect"
        @update:show="(val: boolean) => (showMoreMenu = val)"
      >
        <n-button quaternary class="action-btn">
          <n-icon size="22" style="margin-left: -5px"><i class="mgc_more_2_line"></i></n-icon>
        </n-button>
      </n-dropdown>

      <div class="volume-control">
        <n-popover
          trigger="click"
          :show-arrow="false"
          overlay-class="player-bar-volume-popover"
          :placement="'top'"
          :to="drawerTarget"
        >
          <template #trigger>
            <n-button style="width: 40px; height: 40px" quaternary class="action-btn">
              <n-icon size="22" style="margin-left: -4px"><i class="mgc_volume_line"></i></n-icon
            ></n-button>
          </template>
          <div class="volume-slider-container">
            <div class="volume-value">{{ volumePercent }}%</div>
            <n-slider
              v-model:value="volumePercent"
              :vertical="true"
              :min="0"
              :max="100"
              :tooltip="false"
              class="volume-slider"
              style="width: 4px; height: 100px; min-height: 100px; flex-shrink: 0"
            />
          </div>
        </n-popover>
      </div>
      <n-badge
        class="playlist-badge"
        :value="player.playlist.length"
        :max="999"
        :bordered="false"
        :show="player.playlist.length > 0"
      >
        <n-button
          style="width: 40px; height: 40px"
          quaternary
          class="action-btn"
          @click="togglePlaylist"
          ><n-icon size="22" style="margin-left: -4px"><i class="mgc_playlist_2_fill"></i></n-icon
        ></n-button>
      </n-badge>
    </div>

    <n-drawer
      v-model:show="showPlaylist"
      :width="400"
      placement="right"
      :trap-focus="false"
      :block-scroll="false"
      :to="drawerTarget"
      :z-index="10000"
    >
      <n-drawer-content :native-scrollbar="false" body-content-style="padding: 0;">
        <template #header>
          <div class="playlist-header">
            <div class="playlist-title">播放队列</div>
            <div class="playlist-header-right">
              <div class="playlist-count">{{ player.playlist.length }} 首歌曲</div>
              <n-button size="tiny" quaternary @click="toggleBatchMode">
                {{ isBatchMode ? '退出批量' : '批量管理' }}
              </n-button>
            </div>
          </div>
        </template>

        <div ref="playlistContainerRef" style="padding: 12px; overflow-x: hidden">
          <n-empty
            v-if="player.playlist.length === 0"
            description="暂无歌曲"
            style="margin-top: 40px"
          />
          <div
            v-else
            v-for="(song, index) in player.playlist"
            :key="song.id || index"
            class="playlist-item"
            :class="{
              active: player.currentSong?.id === song.id,
              dragging: dragIndex === index,
              'drag-over': dragOverIndex === index
            }"
            @click="isBatchMode ? toggleItemSelection(song.id) : handlePlaylistClick(song)"
            :id="'song-' + song.id"
            :draggable="isBatchMode"
            @dragstart="handleDragStart(index, $event)"
            @dragover="handleDragOver(index, $event)"
            @dragleave="handleDragLeave(index, $event)"
            @drop="handleDrop(index)"
            @dragend="handleDragEnd"
          >
            <div class="item-index">
              <n-checkbox
                v-if="isBatchMode"
                :checked="song.id ? selectedIds.has(String(song.id)) : false"
                size="small"
                @click.stop
                @update:checked="toggleItemSelection(song.id)"
              />
              <n-icon v-else-if="player.currentSong?.id === song.id" :color="themeVars.primaryColor"
                ><i class="mgc_music_fill"></i
              ></n-icon>
              <span v-else>{{ index + 1 }}</span>
            </div>
            <img
              class="item-cover"
              :src="song.cover || defaultCover"
              alt=""
              referrerpolicy="no-referrer"
              loading="lazy"
              decoding="async"
            />
            <div class="item-info">
              <div
                class="item-title"
                :class="{ 'active-text': player.currentSong?.id === song.id }"
              >
                {{ song.title }}
              </div>
              <div class="item-artist">{{ song.artist }}</div>
            </div>
            <div class="item-actions" v-if="!isBatchMode">
              <n-button text class="delete-btn" @click.stop="handleRemove(song)">
                <n-icon size="18"><i class="mgc_delete_line"></i></n-icon>
              </n-button>
            </div>
            <div v-else class="drag-handle">
              <n-icon size="18" :depth="3"><i class="mgc_dot_grid_line"></i></n-icon>
            </div>
          </div>
        </div>

        <template #footer>
          <!-- 批量操作栏 -->
          <div v-if="isBatchMode" class="batch-footer">
            <div class="batch-select-all" @click="toggleSelectAll">
              <n-checkbox :checked="allSelected" size="small" />
              <span style="margin-left: 6px; font-size: 13px; cursor: pointer">全选</span>
            </div>
            <span class="batch-count">已选 {{ selectedIds.size }} 首</span>
            <n-dropdown
              trigger="click"
              :options="batchActionOptions"
              @select="handleBatchActionSelect"
            >
              <n-button size="small" quaternary :disabled="selectedIds.size === 0">
                <template #icon
                  ><n-icon size="16"><i class="mgc_more_2_line"></i></n-icon
                ></template>
                批量操作
              </n-button>
            </n-dropdown>
          </div>
          <!-- 普通操作栏 -->
          <div v-else class="playlist-footer">
            <n-button class="footer-btn" tertiary @click="handleClear">
              <template #icon
                ><n-icon><i class="mgc_delete_2_line"></i></n-icon
              ></template>
              清空列表
            </n-button>
            <n-button class="footer-btn" secondary type="primary" @click="scrollToCurrent">
              <template #icon
                ><n-icon><i class="mgc_target_line"></i></n-icon
              ></template>
              当前播放
            </n-button>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>

    <!-- 音效调节弹窗 -->
    <sound-effects-modal v-model:show="showSoundEffectsModal" />
  </div>
</template>

<style scoped>
.player-bar {
  position: relative;
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 100%;
  padding: 12px 16px 13px;
  background-color: #fff;
  gap: 16px;
  flex-wrap: nowrap;
  overflow: hidden;
}

html[data-theme='dark'] .player-bar {
  background-color: #18181c !important;
}

.progress-wrapper {
  position: absolute;
  top: -6px; /* 保持贴顶观感，同时让 12px 圆形手柄完整落在 .player-bar 可视区内（不被 overflow:hidden 裁剪） */
  left: 0;
  width: 100%;
  height: 24px; /* 增高手柄居中区域，避免 hover 时圆形手柄上半部被裁掉只剩一半 */
  z-index: 1000;
  display: flex;
  align-items: center;
  cursor: pointer;
}

/* Ensure the slider wrapper spans the full width of the absolute container */
.progress-wrapper :deep(.n-slider) {
  width: 100% !important;
}

.action-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}

:deep(.n-badge .n-badge-sup) {
  font-size: 10px;
  /* 使用主题前景色作为文字颜色，保证深浅色模式下都有良好对比度 */
  color: v-bind('themeVars.baseColor');
  /* 使用主题主色作为徽标背景，增强可读性 */
  background-color: v-bind('themeVars.primaryColor');
}

.progress-wrapper :deep(.n-slider .n-slider-rail) {
  width: 100%;
  height: 2px;
  background-color: rgba(0, 0, 0, 0.2) !important;
  border-radius: 1px;
}

html[data-theme='dark'] .progress-wrapper :deep(.n-slider .n-slider-rail) {
  background-color: rgba(255, 255, 255, 0.2) !important;
}

.progress-wrapper :deep(.n-slider .n-slider-rail .n-slider-rail__fill) {
  height: 2px !important;
  background-color: v-bind('themeVars.primaryColor') !important;
  border-radius: 1px;
}

.progress-wrapper :deep(.n-slider .n-slider-handle) {
  width: 0;
  height: 0;
  transition: all 0.2s;
  opacity: 0;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.2);
  background-color: v-bind('themeVars.primaryColor');
  border: none;
}

.progress-wrapper :deep(.n-slider:hover .n-slider-handle),
.progress-wrapper :deep(.n-slider--active .n-slider-handle) {
  width: 12px;
  height: 12px;
  opacity: 1;
  background-color: v-bind('themeVars.primaryColor');
  border: none;
}

.song-info {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 200px;
  max-width: 350px;
  flex: 1;
  overflow: hidden;
}

.song-slide-enter-active,
.song-slide-leave-active {
  transition: all 0.3s ease;
}

.song-slide-enter-from {
  opacity: 0;
  transform: translateX(10px);
}

.song-slide-leave-to {
  opacity: 0;
  transform: translateX(-10px);
}

.cover-image {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
}

.song-details {
  display: flex;
  flex-direction: column;
  justify-content: center;
  overflow: hidden;
}

.song-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.transition-badge {
  flex-shrink: 0;
}

.song-title {
  font-size: 15px;
  white-space: nowrap;
  transform: translateY(1px);
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
}

.song-artist {
  font-size: 12px;
  transform: translateY(-0.5px);
}

.icon-btn {
  cursor: pointer;
  color: #666;
}

.icon-btn:hover {
  color: #000;
}

.player-controls {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  min-width: 200px;
}

.control-buttons {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.play-pause-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background-color: #eee; /* Light gray background */
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 0.2s;
}

.play-pause-btn:hover {
  background-color: #ddd;
}

.player-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 0;
  width: auto;
  min-width: 250px;
  max-width: 350px;
  justify-content: flex-end;
  flex: 1;
  flex-shrink: 0;
}

.time-text {
  font-size: 14px;
  color: #666;
  font-variant-numeric: tabular-nums;
  margin-right: 8px;
  min-width: 80px;
  text-align: right;
  flex-shrink: 0;
}

.playlist-count-badge {
  font-size: 10px;
  background-color: #eee;
  padding: 2px 6px;
  border-radius: 10px;
  color: #666;
}

.playlist-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.playlist-title {
  font-size: 18px;
  font-weight: bold;
}

.playlist-count {
  font-size: 12px;
  opacity: 0.6;
}

.playlist-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.playlist-source-btn {
  padding: 0 8px;
  font-size: 12px;
}

.playlist-footer {
  display: flex;
  gap: 12px;
  width: 100%;
}

.footer-btn {
  flex: 1;
  height: 40px;
}

.batch-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 8px;
}

.batch-select-all {
  display: flex;
  align-items: center;
  cursor: pointer;
  flex-shrink: 0;
}

.batch-count {
  font-size: 13px;
  color: var(--n-text-color-3);
  flex-shrink: 0;
}

.playlist-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.2s;
  background-color: rgba(0, 0, 0, 0.02);
}

html[data-theme='dark'] .playlist-item {
  background-color: rgba(255, 255, 255, 0.04);
}

.playlist-item:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

html[data-theme='dark'] .playlist-item:hover {
  background-color: rgba(255, 255, 255, 0.08);
}

.playlist-item.active {
  border: 1px solid v-bind('themeVars.primaryColor');
  background-color: v-bind('mixHexColor(themeVars.primaryColor, "#ffffff", 0.05)');
}

html[data-theme='dark'] .playlist-item.active {
  background-color: v-bind('mixHexColor(themeVars.primaryColor, "#000000", 0.15)');
}

/* 批量模式拖拽排序 */
.playlist-item.dragging {
  opacity: 0.4;
  border: 1px dashed v-bind('themeVars.primaryColor');
}

.playlist-item.drag-over {
  border: 1px dashed v-bind('themeVars.primaryColor');
  background-color: v-bind('mixHexColor(themeVars.primaryColor, "#ffffff", 0.1)');
}

html[data-theme='dark'] .playlist-item.drag-over {
  background-color: v-bind('mixHexColor(themeVars.primaryColor, "#000000", 0.25)');
}

.drag-handle {
  margin-left: 8px;
  color: #999;
  cursor: grab;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.drag-handle:active {
  cursor: grabbing;
}

.item-index {
  width: 28px;
  text-align: center;
  font-size: 14px;
  margin-right: 8px;
  color: #999;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.item-cover {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
  margin-right: 10px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.12);
}

html[data-theme='dark'] .item-cover {
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.item-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.item-title {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.active-text {
  color: v-bind('themeVars.primaryColor');
}

.item-artist {
  font-size: 12px;
  color: #888;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-actions {
  opacity: 0;
  transition: opacity 0.2s;
  margin-left: 8px;
}

.playlist-item:hover .item-actions {
  opacity: 1;
}

.delete-btn {
  color: #999;
}

.delete-btn:hover {
  color: #ff4d4f;
}
</style>

<style lang="scss">
.player-bar-volume-popover {
  border-radius: 16px;
  padding: 0;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
  width: 100px;
  min-height: 150px;
}

.volume-slider-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  min-height: 120px;
  padding: 6px 0px;
}

.volume-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--n-text-color, #333);
  font-variant-numeric: tabular-nums;
  transition: none;
}

.volume-slider {
  width: 4px;
  height: 100px;
  min-height: 100px;
  flex-shrink: 0;
}

.volume-slider :deep(.n-slider) {
  width: 4px;
  height: 100px;
  min-height: 100px;
  flex-shrink: 0;
}

.volume-slider :deep(.n-slider-rail) {
  width: 4px;
  height: 100px;
  min-height: 100px;
  background-color: rgba(128, 128, 128, 0.2);
  border-radius: 999px;
}

.volume-slider :deep(.n-slider-rail__fill) {
  width: 4px;
  background-color: #2c8efd;
  border-radius: 999px;
}

.volume-slider :deep(.n-slider-handle) {
  width: 12px;
  height: 12px;
  background-color: #2c8efd;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  border: none;
  transition:
    width 0.1s ease,
    height 0.1s ease;
}

.volume-slider :deep(.n-slider:hover .n-slider-handle) {
  width: 14px;
  height: 14px;
}
</style>
