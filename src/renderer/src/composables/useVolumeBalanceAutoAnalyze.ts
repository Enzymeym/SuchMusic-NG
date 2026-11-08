/**
 * 音量平衡：曲库后台自动分析
 *
 * 目标——用户只需要在设置里打开一个开关，剩下的全自动：
 * 1. 音乐库新增歌曲（首次扫描 / 重新扫描 / 新增文件）→ 只分析新歌；
 * 2. 曲库里已有但从未分析过的歌曲 → 启动后自动补齐；
 * 3. 上一轮没跑完或分析期间又有新歌进来 → 自动补跑一轮。
 *
 * 只挂在主窗口：桌面歌词 / 任务栏播控是独立渲染进程，同样会加载 App.vue，
 * 但它们没有分析的必要，重复跑会白耗 CPU 并争抢主进程解码资源。
 */

import { watch } from 'vue'
import { useLocalMusicStore } from '../stores/localMusicStore'
import { useVolumeBalanceStore } from '../stores/volumeBalanceStore'

/** 开启开关 / 元数据补全结束后等待一会儿再分析，避免用户连点开关时反复起停 */
const ENABLE_DELAY_MS = 1_000
/** 启动时曲库可能还在扫描，先排一次，扫描完成会再次触发调度 */
const STARTUP_DELAY_MS = 4_000

export function useVolumeBalanceAutoAnalyze(): void {
  const volumeBalance = useVolumeBalanceStore()
  const localMusicStore = useLocalMusicStore()

  const schedule = (delay?: number): void => {
    // 元数据补全（读封面/歌词）本身就在大量读文件，错开以免互相拖慢；
    // 补全结束后由下面的 fillingMeta 监听补触发
    if (localMusicStore.fillingMeta) return
    volumeBalance.scheduleAutoAnalyze(localMusicStore.songs, delay)
  }

  // 曲库变化：启动扫描完成、手动重新扫描、新增歌曲都会替换数组或改变长度。
  // 这里只做「提醒」，具体分析哪些歌由 store 按分析结果过滤，重复触发无副作用。
  watch(() => [localMusicStore.songs, localMusicStore.songs.length], () => schedule(), {
    flush: 'post'
  })

  // 元数据补全结束：此时曲库已是最终形态，开始（或继续）后台分析
  watch(
    () => localMusicStore.fillingMeta,
    (filling) => {
      if (!filling) schedule(ENABLE_DELAY_MS)
    }
  )

  // 打开开关：立刻补齐历史未分析歌曲
  watch(
    () => volumeBalance.enabled,
    (on) => {
      if (on) schedule(ENABLE_DELAY_MS)
    }
  )

  // 启动时开关已打开（store 构造时已从本地存储恢复）
  if (volumeBalance.enabled) schedule(STARTUP_DELAY_MS)
}
