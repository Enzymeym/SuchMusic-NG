import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

/** 单首歌曲的响度分析结果 */
export interface VolumeBalanceResult {
  lufs: number
  gainDb: number
}

/** 批量分析汇总 */
export interface AnalyzeSummary {
  done: number
  failed: number
  canceled: boolean
}

const STORAGE_KEY = 'volume-balance'

/** 后台自动分析的防抖延迟：曲库扫描/导入完成后再等一会儿，避免边扫边算抢 IO */
const AUTO_ANALYZE_DELAY_MS = 2_500
/** 正在分析时再次收到调度请求的延后时间 */
const AUTO_ANALYZE_RETRY_MS = 8_000

/** 将数值钳制到区间 */
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 判断是否为可分析的本地文件路径（排除在线 URL） */
function isLocalFile(filePath?: string | null): filePath is string {
  return !!filePath && !/^https?:\/\//.test(filePath)
}

export const useVolumeBalanceStore = defineStore('volumeBalance', () => {
  // --- State ---
  const enabled = ref(false) // 是否启用音量平衡
  const targetLufs = ref(-14) // 目标响度（LUFS，范围 -11 ~ -23）
  const maxGainDb = ref(12) // 最大增益范围（dB，可选 6 / 12 / 18）
  const analyzing = ref(false) // 是否正在批量分析
  const cancelRequested = ref(false) // 是否请求取消分析
  const progress = ref({ done: 0, total: 0, currentName: '' })
  const results = ref<Record<string, VolumeBalanceResult>>({})
  const analyzedAt = ref<number | null>(null)

  // --- 后台自动分析（内部状态，不持久化）---
  /** 本会话内分析失败的文件：后台自动分析不再反复重试同一首坏文件 */
  const failedPaths = new Set<string>()
  /** 调度定时器 */
  let autoAnalyzeTimer: ReturnType<typeof setTimeout> | null = null
  /** 最近一次调度传入的曲库快照（定时器触发时重新过滤，拿到最新结果） */
  let pendingSongs: Array<{ filePath?: string; name?: string }> = []

  // --- 持久化 ---
  const load = () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (!stored) return
      const data = JSON.parse(stored)
      if (typeof data.enabled === 'boolean') enabled.value = data.enabled
      if (typeof data.targetLufs === 'number') targetLufs.value = clamp(data.targetLufs, -23, -11)
      if (typeof data.maxGainDb === 'number') maxGainDb.value = data.maxGainDb
      if (data.results && typeof data.results === 'object') results.value = data.results
      if (typeof data.analyzedAt === 'number') analyzedAt.value = data.analyzedAt
    } catch (e) {
      console.error('Failed to load volume balance settings', e)
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            enabled: enabled.value,
            targetLufs: targetLufs.value,
            maxGainDb: maxGainDb.value,
            results: results.value,
            analyzedAt: analyzedAt.value
          })
        )
      } catch (e) {
        console.error('Failed to save volume balance settings', e)
      }
      saveTimer = null
    }, 500)
  }

  // 配置项变化时自动保存；results 由分析完成/清空时的显式 save() 覆盖，避免深监听大对象
  watch([enabled, targetLufs, maxGainDb], () => save())

  // --- Actions ---
  const setEnabled = (v: boolean) => {
    enabled.value = v
    // 关闭功能时立刻中断正在进行的后台分析，避免白耗 CPU
    if (!v) {
      cancelRequested.value = true
      if (autoAnalyzeTimer) {
        clearTimeout(autoAnalyzeTimer)
        autoAnalyzeTimer = null
      }
    }
  }
  const setTargetLufs = (v: number) => {
    targetLufs.value = clamp(v, -23, -11)
  }
  const setMaxGainDb = (v: number) => {
    maxGainDb.value = v
  }

  /** 获取指定文件路径的播放补偿增益（dB）；未启用或未分析时返回 0 */
  const getGainDb = (filePath?: string | null): number => {
    if (!enabled.value || !filePath) return 0
    const r = results.value[filePath]
    return r ? r.gainDb : 0
  }

  const cancel = () => {
    cancelRequested.value = true
  }

  /** 待分析的本地歌曲：本地路径 + 尚无结果 + 本会话未失败过 */
  const pickPending = (
    songs: Array<{ filePath?: string; name?: string }>
  ): Array<{ filePath?: string; name?: string }> =>
    songs.filter(
      (s) => isLocalFile(s.filePath) && !results.value[s.filePath] && !failedPaths.has(s.filePath)
    )

  /**
   * 批量分析本地歌曲响度（仅分析尚无结果的文件，串行）
   * @param songs 本地歌曲列表（含 filePath）
   * @returns 分析汇总；无待分析歌曲或正在分析中返回 null
   */
  const analyzeLocalSongs = async (
    songs: Array<{ filePath?: string; name?: string }>
  ): Promise<AnalyzeSummary | null> => {
    if (analyzing.value) return null

    const targets = pickPending(songs)
    if (targets.length === 0) return null

    analyzing.value = true
    cancelRequested.value = false
    progress.value = { done: 0, total: targets.length, currentName: '' }

    let done = 0
    let failed = 0

    // 主进程侧已改为流式解码（内存恒定），但流式不可用时会回退整曲解码，
    // 因此这里保持串行，避免极端情况下多首整曲 PCM 同时驻留主进程
    const concurrency = 1
    for (let i = 0; i < targets.length && !cancelRequested.value; i += concurrency) {
      const batch = targets.slice(i, i + concurrency)
      await Promise.all(
        batch.map(async (song) => {
          if (cancelRequested.value) return
          const path = song.filePath!
          progress.value.currentName = song.name || path
          try {
            // @ts-ignore electron 全局 API
            const res = await window.electron.ipcRenderer.invoke('volume-balance:analyze-file', path)
            if (res && res.success && typeof res.lufs === 'number' && Number.isFinite(res.lufs)) {
              const gainDb = clamp(targetLufs.value - res.lufs, -maxGainDb.value, maxGainDb.value)
              results.value[path] = { lufs: res.lufs, gainDb: Math.round(gainDb * 10) / 10 }
            } else {
              failed++
              failedPaths.add(path)
            }
          } catch (err) {
            console.error('[VolumeBalance] 分析歌曲失败:', path, err)
            failed++
            failedPaths.add(path)
          } finally {
            done++
            progress.value.done = done
            // 后台分析可能持续很久（整库首次分析），每 10 首落盘一次，
            // 避免应用中途退出丢掉整轮结果、下次启动从零重算
            if (done % 10 === 0) save()
          }
        })
      )
    }

    const canceled = cancelRequested.value
    analyzing.value = false
    cancelRequested.value = false
    analyzedAt.value = Date.now()
    save()
    return { done, failed, canceled }
  }

  /**
   * 后台自动分析调度（防抖）。
   *
   * 触发时机由调用方决定：曲库扫描/导入完成、应用启动、开关打开时各调一次即可，
   * 内部按「尚无分析结果」过滤，所以重复调用不会重复分析。
   * 功能未启用时直接忽略——关闭音量平衡就没必要白跑解码。
   */
  const scheduleAutoAnalyze = (
    songs: Array<{ filePath?: string; name?: string }>,
    delay = AUTO_ANALYZE_DELAY_MS
  ): void => {
    if (!enabled.value) return
    pendingSongs = songs
    if (autoAnalyzeTimer) clearTimeout(autoAnalyzeTimer)
    autoAnalyzeTimer = setTimeout(() => {
      autoAnalyzeTimer = null
      void runAutoAnalyze()
    }, delay)
  }

  /** 执行一轮后台分析；分析期间又有新歌加入时自动补跑（函数声明以便上面的调度器直接引用） */
  async function runAutoAnalyze(): Promise<void> {
    if (!enabled.value) return
    const songs = pendingSongs
    if (!songs.length) return

    if (analyzing.value) {
      // 上一轮还没跑完，稍后再看（期间可能又新增了歌曲）
      scheduleAutoAnalyze(songs, AUTO_ANALYZE_RETRY_MS)
      return
    }

    const targets = pickPending(songs)
    if (!targets.length) return

    const summary = await analyzeLocalSongs(targets)
    // 分析期间曲库可能继续增长（扫描/导入），这里补跑一轮；
    // 失败文件已记入 failedPaths，不会因此陷入死循环
    if (summary && !summary.canceled && enabled.value && pickPending(pendingSongs).length > 0) {
      scheduleAutoAnalyze(pendingSongs, AUTO_ANALYZE_RETRY_MS)
    }
  }

  const clearResults = () => {
    results.value = {}
    analyzedAt.value = null
    // 清空后允许重新尝试此前失败的文件
    failedPaths.clear()
    save()
  }

  load()

  return {
    enabled,
    targetLufs,
    maxGainDb,
    analyzing,
    cancelRequested,
    progress,
    results,
    analyzedAt,
    setEnabled,
    setTargetLufs,
    setMaxGainDb,
    getGainDb,
    analyzeLocalSongs,
    scheduleAutoAnalyze,
    cancel,
    clearResults,
    load
  }
})
