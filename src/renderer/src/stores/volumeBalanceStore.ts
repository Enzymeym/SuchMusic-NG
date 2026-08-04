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

/** 将数值钳制到区间 */
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
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

  watch([enabled, targetLufs, maxGainDb, results], () => save(), { deep: true })

  // --- Actions ---
  const setEnabled = (v: boolean) => {
    enabled.value = v
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

  /**
   * 批量分析本地歌曲响度（仅分析尚无结果的文件，并发 2）
   * @param songs 本地歌曲列表（含 filePath）
   * @returns 分析汇总；无待分析歌曲或正在分析中返回 null
   */
  const analyzeLocalSongs = async (
    songs: Array<{ filePath?: string; name?: string }>
  ): Promise<AnalyzeSummary | null> => {
    if (analyzing.value) return null

    const targets = songs.filter((s) => {
      if (!s.filePath || /^https?:\/\//.test(s.filePath)) return false
      return !results.value[s.filePath]
    })
    if (targets.length === 0) return null

    analyzing.value = true
    cancelRequested.value = false
    progress.value = { done: 0, total: targets.length, currentName: '' }

    let done = 0
    let failed = 0

    const concurrency = 2
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
            }
          } catch (err) {
            console.error('[VolumeBalance] 分析歌曲失败:', path, err)
            failed++
          } finally {
            done++
            progress.value.done = done
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

  const clearResults = () => {
    results.value = {}
    analyzedAt.value = null
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
    cancel,
    clearResults,
    load
  }
})
