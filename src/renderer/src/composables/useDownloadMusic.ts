import { useSettingsStore } from '../stores/settingsStore'
import { runSnowdropGetMusicUrl } from '../apis/snowdrop-transform'
import { useMessage } from 'naive-ui'
import type { PlayerSong } from '../stores/playerStore'

export function useDownloadMusic() {
  const settingsStore = useSettingsStore()
  const message = useMessage()

  let isDownloading = false

  const downloadMusic = async (song: PlayerSong) => {
    if (isDownloading) {
      message.warning('正在下载中，请稍后再试')
      return
    }
    isDownloading = true
    try {
      // 1. 获取源信息
      let source = song.source || 'wy'
      // 兼容 source 映射
      switch (source) {
        case 'netease': source = 'wy'; break;
        case 'qq': source = 'tx'; break;
        case 'kugou': source = 'kg'; break;
        case 'kuwo': source = 'kw'; break;
        case 'migu': source = 'mg'; break;
      }

      const songId = song.sourceSongId ?? song.id
      if (!songId) {
        message.error('无法获取歌曲 ID，下载失败')
        return
      }

      const musicInfo = {
        id: String(songId),
        name: song.title || '未知歌曲',
        singer: song.artist || '未知歌手',
        albumName: song.album || '未知专辑',
        pic: song.cover || '',
        songmid: String(songId),
        mediaId: String(songId)
      }

      const quality = settingsStore.playback.preloadQualityLevel || '128k'

      const loadingMsg = message.loading('正在获取下载链接...', { duration: 0 })

      // 2. 获取音乐 URL
      let url = ''
      try {
        const res = await runSnowdropGetMusicUrl(source, musicInfo, quality)
        url = res.url
        if (!url) throw new Error('未获取到下载链接')
      } catch (err: any) {
        loadingMsg.destroy()
        throw err
      }

      // 3. 确定文件名和后缀
      let ext = 'mp3'
      if (quality === 'flac') ext = 'flac'
      else {
        try {
          const u = new URL(url)
          const name = u.pathname.split('/').pop() || ''
          const idx = name.lastIndexOf('.')
          if (idx !== -1 && idx < name.length - 1) {
            const parsedExt = name.slice(idx + 1).toLowerCase()
            if (['mp3', 'flac', 'wav', 'ogg', 'm4a'].includes(parsedExt)) {
              ext = parsedExt
            }
          }
        } catch {
          // ignore
        }
      }

      // 过滤掉非法字符
      const safeTitle = (song.title || '未知歌曲').replace(/[\\/:*?"<>|]/g, '_')
      const safeArtist = (song.artist || '未知歌手').replace(/[\\/:*?"<>|]/g, '_')
      const filename = `${safeTitle} - ${safeArtist}.${ext}`

      // 4. 调用下载
      const dir = settingsStore.local.downloadDir || ''
      loadingMsg.content = `正在下载 ${filename}...`

      const targetPath = await window.electron.ipcRenderer.invoke('system:download-music', {
        url,
        filename,
        dir
      })

      loadingMsg.destroy()
      message.success(`下载成功: ${targetPath}`, { duration: 5000 })
    } catch (error: any) {
      console.error('下载失败:', error)
      message.error(`下载失败: ${error.message || '未知错误'}`)
    } finally {
      isDownloading = false
    }
  }

  return { downloadMusic }
}
