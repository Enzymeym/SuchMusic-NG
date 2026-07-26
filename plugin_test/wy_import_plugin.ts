/* eslint-disable prettier/prettier */
/**
 * Such 插件 - 网易云音乐歌单导入
 * 通过二维码登录网易云账号，选择歌单一键导入到 Such
 */
window.source = {
  id: 'SUCH_NETEASE_IMPORT',
  name: '网易云歌单导入',
  version: '2.0.0',
  author: 'enzymeym',
  description: '扫码登录网易云音乐，选择歌单一键导入到 Such',
  isUIWidget: true,
  permissions: ['fetch', 'playlist', 'file_system', 'app_info'],

  // ==================== JSON UI Schema ====================
  uiSchema: {
    sections: [
      {
        title: '账号登录',
        fields: [
          {
            type: 'tag',
            key: 'loginStatus'
          },
          {
            type: 'image',
            key: 'qrImage',
            label: '请使用网易云音乐 APP 扫码',
            width: 220
          }
        ],
        actions: [
          {
            type: 'button',
            label: '刷新二维码',
            method: 'startQrLogin',
            variant: 'primary'
          },
          {
            type: 'button',
            label: '注销登录',
            method: 'logout'
          }
        ]
      },
      {
        title: '歌单选择',
        fields: [
          {
            type: 'select',
            key: 'selectedPlaylistId',
            label: '选择要导入的歌单',
            placeholder: '请先登录后选择歌单',
            options: []
          }
        ],
        actions: [
          {
            type: 'button',
            label: '开始导入',
            method: 'startImport',
            variant: 'primary'
          }
        ]
      },
      {
        title: '状态',
        fields: [
          {
            type: 'tag',
            key: 'statusText'
          }
        ]
      },
      {
        title: '导入日志',
        fields: [
          {
            type: 'log',
            key: 'importLog'
          }
        ]
      }
    ]
  },

  // ==================== 内部状态 ====================
  _cookie: '',
  _isImporting: false,
  _logLines: [],
  _statusText: '就绪',
  _qrKey: '',
  _pollTimer: null,
  _isLoggedIn: false,
  _nickname: '',
  _userId: '',
  _userPlaylists: [],
  _selectedPlaylistId: '',

  // ==================== API 基础地址 ====================
  _apiBase: 'https://api.enzymeym.top',

  // ==================== 获取防缓存时间戳参数 ====================
  _tsParam: function () {
    return 'timestamp=' + Date.now()
  },

  // ==================== 初始化 ====================
  initialization: function () {
    this.setProps({
      loginStatus: '未登录',
      qrImage: '',
      selectedPlaylistId: '',
      statusText: '就绪',
      importLog: ''
    })
    // 自动开始二维码登录
    this.startQrLogin()
  },

  // ==================== 追加日志 ====================
  _log: function (msg) {
    this._logLines.push('[' + new Date().toLocaleTimeString() + '] ' + msg)
    if (this._logLines.length > 200) {
      this._logLines = this._logLines.slice(-200)
    }
    this.setProps({ importLog: this._logLines.join('\n') })
  },

  // ==================== 设置状态 ====================
  _setStatus: function (text) {
    this._statusText = text
    this.setProps({ statusText: text })
  },

  // ==================== 获取状态 (供宿主调用) ====================
  getStatus: function () {
    return {
      statusText: this._statusText,
      importLog: this._logLines.join('\n'),
      isLoggedIn: this._isLoggedIn,
      userId: this._userId,
      cookie: this._cookie ? '已设置 (长度: ' + this._cookie.length + ')' : '未设置',
      playlists: this._userPlaylists.length + ' 个歌单',
      loginStatus: this._isLoggedIn
        ? ('已登录: ' + (this._nickname || '网易云用户'))
        : (this._qrKey ? '等待扫码中...' : '未登录'),
      qrImage: this._qrImageBase64 || '',
      selectedPlaylistId: this._selectedPlaylistId
    }
  },

  // ==================== 带 Cookie 的请求 ====================
  _fetchWithCookie: async function (url) {
    var options = {}
    if (this._cookie) {
      options = { headers: { 'Cookie': this._cookie } }
    }
    var resp = await suchmusic.fetch(url, options)
    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status + ': ' + (resp.statusText || '请求失败'))
    }
    return resp.json()
  },

  // ==================== 清洗 Cookie（去属性只保留 key=value） ====================
  _cleanCookie: function (rawCookie) {
    if (!rawCookie) return ''
    // 按 ;; 分割，只保留含 = 且非属性名的片段
    var parts = rawCookie.split(';')
    var cleaned = []
    var attrKeywords = ['max-age', 'path', 'domain', 'expires', 'secure', 'httponly', 'samesite', 'priority', 'partitioned']
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim()
      if (!p) continue
      var eqIdx = p.indexOf('=')
      if (eqIdx > 0) {
        var key = p.substring(0, eqIdx).trim().toLowerCase()
        if (attrKeywords.indexOf(key) === -1) {
          cleaned.push(p)
        }
      }
    }
    return cleaned.join('; ')
  },

  // ==================== 停止二维码轮询 ====================
  _stopQrPolling: function () {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
  },

  // ==================== 注销登录 ====================
  logout: function () {
    this._stopQrPolling()
    this._cookie = ''
    this._isLoggedIn = false
    this._nickname = ''
    this._userId = ''
    this._userPlaylists = []
    this._selectedPlaylistId = ''
    this._qrKey = ''
    this._qrImageBase64 = ''
    this.setProps({
      loginStatus: '未登录',
      qrImage: '',
      selectedPlaylistId: '',
      optionsList: []
    })
    this._setStatus('已注销')
    this._log('已退出登录')
    window.notify('已退出网易云登录', 'info')
  },

  // ==================== 开始二维码登录 ====================
  startQrLogin: async function () {
    var self = this
    if (self._isLoggedIn) {
      window.notify('已登录，无需重复操作', 'info')
      return { code: false, message: '已登录' }
    }

    self._stopQrPolling()
    self._setStatus('正在生成二维码...')
    self._log('开始二维码登录流程')

    try {
      // 1. 获取二维码 key
      self._log('正在获取二维码 key...')
      var keyUrl = self._apiBase + '/login/qr/key?' + self._tsParam()
      var keyResp = await self._fetchWithCookie(keyUrl)
      if (!keyResp || keyResp.code !== 200 || !keyResp.data || !keyResp.data.unikey) {
        throw new Error('获取二维码 key 失败: ' + (keyResp && keyResp.message || '未知错误'))
      }
      self._qrKey = keyResp.data.unikey
      self._log('已获取二维码 key: ' + self._qrKey)

      // 2. 生成二维码
      self._log('正在生成二维码...')
      var qrUrl = self._apiBase + '/login/qr/create?key=' + self._qrKey + '&qrimg=true&' + self._tsParam()
      var qrResp = await self._fetchWithCookie(qrUrl)
      if (!qrResp || qrResp.code !== 200 || !qrResp.data) {
        throw new Error('生成二维码失败: ' + (qrResp && qrResp.message || '未知错误'))
      }

      var qrData = qrResp.data
      // API 返回的 qrimg 是原始 base64，需补充 data URI 前缀
      var rawBase64 = qrData.qrimg || ''
      self._qrImageBase64 = rawBase64
        ? (rawBase64.indexOf('data:') === 0 ? rawBase64 : 'data:image/png;base64,' + rawBase64)
        : ''
      self._setStatus('请使用网易云音乐 APP 扫码登录')
      self.setProps({
        loginStatus: '等待扫码中...',
        qrImage: self._qrImageBase64
      })
      self._log('二维码已生成，请使用网易云音乐 APP 扫码')

      // 3. 开始轮询检测扫码状态
      self._pollQrStatus(self._qrKey)

    } catch (err) {
      var errMsg = err.message || '生成二维码失败'
      self._log('错误: ' + errMsg)
      self._setStatus('二维码生成失败')
      window.notify('二维码生成失败: ' + errMsg, 'error')
    }
  },

  // ==================== 轮询检测二维码扫码状态 ====================
  _pollQrStatus: function (key) {
    var self = this
    // 清除之前的轮询
    self._stopQrPolling()

    self._pollTimer = setInterval(async function () {
      try {
        var checkUrl = self._apiBase + '/login/qr/check?key=' + key + '&' + self._tsParam()
        var checkResp = await self._fetchWithCookie(checkUrl)

        if (!checkResp) {
          self._log('检测响应为空，继续等待...')
          return
        }

        var code = checkResp.code

        // 800: 二维码过期
        if (code === 800) {
          self._stopQrPolling()
          self._log('二维码已过期，请刷新重试')
          self._setStatus('二维码已过期')
          self.setProps({ loginStatus: '二维码已过期，请点击刷新' })
          window.notify('二维码已过期，请刷新重试', 'warning')
          return
        }

        // 801: 等待扫码
        if (code === 801) {
          self.setProps({ loginStatus: '等待扫码...' })
          return
        }

        // 802: 已扫码，等待确认
        if (code === 802) {
          self.setProps({ loginStatus: '已扫码，请在手机上确认登录' })
          return
        }

        // 803: 授权登录成功
        if (code === 803) {
          self._stopQrPolling()
          self._log('扫码授权成功！')

          // 提取 Cookie
          if (checkResp.cookie) {
            self._cookie = self._cleanCookie(checkResp.cookie)
          } else {
            self._cookie = self._cleanCookie(checkResp.data || '')
          }

          if (!self._cookie) {
            self._log('警告: 未获取到登录凭证')
            self._setStatus('登录凭证获取失败')
            window.notify('登录凭证获取失败，请重试', 'error')
            return
          }

          self._log('已获取登录凭证')
          self._isLoggedIn = true

          // 调用 /login/status 获取用户信息
          await self._fetchUserInfo()
          return
        }

        // 502: 需要 noCookie=true 重试
        if (code === 502) {
          self._log('检测到 502，尝试添加 noCookie 参数重试...')
          var retryUrl = self._apiBase + '/login/qr/check?key=' + key + '&noCookie=true&' + self._tsParam()
          var retryResp = await self._fetchWithCookie(retryUrl)
          if (!retryResp) return

          var retryCode = retryResp.code
          if (retryCode === 803) {
            self._stopQrPolling()
            self._log('扫码授权成功（noCookie 重试）！')

            if (retryResp.cookie) {
              self._cookie = self._cleanCookie(retryResp.cookie)
            } else {
              self._cookie = self._cleanCookie(retryResp.data || '')
            }

            if (!self._cookie) {
              self._log('警告: 未获取到登录凭证')
              self._setStatus('登录凭证获取失败')
              window.notify('登录凭证获取失败，请重试', 'error')
              return
            }

            self._log('已获取登录凭证')
            self._isLoggedIn = true

            await self._fetchUserInfo()
          }
          return
        }

      } catch (err) {
        self._log('轮询检测出错: ' + (err.message || '未知错误'))
        // 不中断轮询，继续等待
      }
    }, 3000) // 每 3 秒轮询一次
  },

  // ==================== 获取登录用户信息 ====================
  _fetchUserInfo: async function () {
    var self = this
    try {
      self._log('正在获取用户信息...')
      var statusUrl = self._apiBase + '/login/status'
      var statusResp = await self._fetchWithCookie(statusUrl)

      // 调试：输出原始响应结构关键词
      self._log('status 响应顶层 keys: ' + (statusResp ? Object.keys(statusResp).join(', ') : 'null'))

      if (statusResp && statusResp.data) {
        var data = statusResp.data
        self._log('status data keys: ' + Object.keys(data).join(', '))
        var profile = data.profile || data
        var account = data.account || {}
        self._userId = String(profile.userId || profile.id || account.id || data.userId || data.id || '')
        self._nickname = profile.nickname || account.userName || data.nickname || '网易云用户'
      } else if (statusResp && statusResp.profile) {
        self._userId = String(statusResp.profile.userId || '')
        self._nickname = statusResp.profile.nickname || '网易云用户'
      } else {
        self._log('status 响应无 data 也无 profile，code=' + (statusResp && statusResp.code))
      }

      self._log('用户: ' + self._nickname + ' (ID: ' + self._userId + ')')

      self.setProps({
        loginStatus: '已登录: ' + self._nickname,
        qrImage: ''
      })
      self._setStatus('已登录: ' + self._nickname)
      window.notify('登录成功，欢迎 ' + self._nickname + '！', 'success')

      // 获取用户歌单 （Cookie 优先识别用户，uid 为可选参数）
      self._log('正在获取用户歌单...')
      await self.fetchUserPlaylists()

    } catch (err) {
      self._log('获取用户信息出错: ' + (err.message || '未知错误'))
      self._nickname = '网易云用户'
      self.setProps({
        loginStatus: '已登录: ' + self._nickname,
        qrImage: ''
      })
      self._setStatus('已登录')
      window.notify('登录成功', 'success')
      // 仍然尝试获取歌单
      try {
        self._log('正在获取用户歌单...')
        await self.fetchUserPlaylists()
      } catch (_e) {
        // 忽略
      }
    }
  },

  // ==================== 获取用户歌单 ====================
  fetchUserPlaylists: async function () {
    var self = this
    if (!self._isLoggedIn) {
      window.notify('请先登录', 'warning')
      return { code: false, message: '未登录' }
    }

    try {
      self._log('正在获取用户歌单列表...')
      var allPlaylists = []
      var offset = 0
      var limit = 30
      var hasMore = true

      while (hasMore) {
        var url = self._apiBase + '/user/playlist?limit=' + limit + '&offset=' + offset
        // uid 可选：有则传，无则由 Cookie 自动识别
        if (self._userId) {
          url += '&uid=' + self._userId
        }
        var resp = await self._fetchWithCookie(url)

        if (!resp || resp.code !== 200) {
          throw new Error('获取歌单失败: ' + (resp && resp.message || '未知错误'))
        }

        var playlists = (resp.playlist && Array.isArray(resp.playlist)) ? resp.playlist : []
        if (playlists.length === 0) {
          hasMore = false
        } else {
          allPlaylists = allPlaylists.concat(playlists)
          offset += limit
          if (playlists.length < limit) {
            hasMore = false
          }
        }
      }

      self._userPlaylists = allPlaylists
      self._log('已获取 ' + allPlaylists.length + ' 个歌单')

      // 构建下拉选项
      var options = []
      for (var i = 0; i < allPlaylists.length; i++) {
        var pl = allPlaylists[i]
        var trackInfo = pl.trackCount ? (' (' + pl.trackCount + ' 首)') : ''
        options.push({
          label: pl.name + trackInfo,
          value: String(pl.id)
        })
      }

      self.setProps({ optionsList: options })
      self._setStatus('已加载 ' + allPlaylists.length + ' 个歌单，请选择')

      return { code: true, count: allPlaylists.length }

    } catch (err) {
      var errMsg = err.message || '获取歌单失败'
      self._log('错误: ' + errMsg)
      self._setStatus('获取歌单失败')
      window.notify('获取歌单失败: ' + errMsg, 'error')
      return { code: false, message: errMsg }
    }
  },

  // ==================== 选择歌单 ====================
  selectPlaylist: function (id) {
    this._selectedPlaylistId = id
    this._log('已选择歌单 ID: ' + id)
  },

  // ==================== 设置选中的歌单 ID (供 UI select 变更回调) ====================
  setSelectedPlaylistId: function (id) {
    this._selectedPlaylistId = id
    if (id) {
      var plName = ''
      for (var i = 0; i < this._userPlaylists.length; i++) {
        if (String(this._userPlaylists[i].id) === String(id)) {
          plName = this._userPlaylists[i].name
          break
        }
      }
      this._log('已选择歌单: ' + (plName || id))
    }
  },

  // ==================== 开始导入 ====================
  startImport: async function () {
    var self = this
    if (self._isImporting) {
      window.notify('正在导入中，请稍候', 'warning')
      return { code: false, message: '正在导入中' }
    }

    if (!self._isLoggedIn || !self._cookie) {
      window.notify('请先扫码登录', 'warning')
      return { code: false, message: '未登录' }
    }

    var playlistId = self._selectedPlaylistId
    if (!playlistId) {
      window.notify('请选择要导入的歌单', 'warning')
      return { code: false, message: '未选择歌单' }
    }

    self._isImporting = true
    self._logLines = []
    self._setStatus('导入中...')

    try {
      // 1. 获取歌单详情
      self._log('正在获取歌单详情...')
      var detailUrl = self._apiBase + '/playlist/detail?id=' + playlistId
      var detail = await self._fetchWithCookie(detailUrl)
      if (!detail || detail.code !== 200) {
        throw new Error('获取歌单详情失败: ' + (detail && detail.message || '未知错误'))
      }

      var playlist = detail.playlist
      if (!playlist) {
        throw new Error('歌单数据为空，请检查歌单 ID 是否正确')
      }

      var playlistName = playlist.name || '导入的歌单'
      var trackCount = playlist.trackCount || 0
      self._log('歌单名称: ' + playlistName + '，共 ' + trackCount + ' 首歌曲')

      // 2. 获取所有歌曲信息
      self._log('正在获取歌曲列表...')
      var allTracks = await self._fetchAllTracks(playlistId, trackCount)
      self._log('已获取 ' + allTracks.length + ' 首歌曲信息')

      if (allTracks.length === 0) {
        throw new Error('歌单中没有歌曲')
      }

      // 3. 获取歌曲链接
      self._log('正在获取歌曲链接...')
      var songUrls = await self._fetchSongUrls(allTracks)
      self._log('已获取 ' + Object.keys(songUrls).length + ' 首歌曲链接')

      // 4. 批量下载歌曲到本地
      self._log('正在下载歌曲到本地...')
      var localPathMap = await self._downloadSongs(allTracks, songUrls)

      // 5. 创建 Such 歌单
      self._log('正在创建歌单: ' + playlistName)
      var trackEntries = self._buildTrackEntries(allTracks, songUrls, localPathMap)
      var newPlaylist = await suchmusic.createPlaylist(playlistName, trackEntries)

      if (!newPlaylist || !newPlaylist.id) {
        throw new Error('创建歌单失败')
      }

      self._log('歌单创建成功！ID: ' + newPlaylist.id)
      self._setStatus('导入完成: ' + playlistName)
      window.notify('歌单 "' + playlistName + '" 导入成功！共 ' + trackEntries.length + ' 首歌曲', 'success')
      return { code: true, playlistId: newPlaylist.id, trackCount: trackEntries.length }

    } catch (err) {
      var errMsg = err.message || '导入失败'
      self._log('错误: ' + errMsg)
      self._setStatus('导入失败')
      window.notify('导入失败: ' + errMsg, 'error')
      return { code: false, message: errMsg }
    } finally {
      self._isImporting = false
    }
  },

  // ==================== 分页获取所有歌曲 ====================
  _fetchAllTracks: async function (playlistId, totalCount) {
    var self = this
    var allTracks = []
    var offset = 0
    var limit = 100
    var maxPages = Math.ceil(totalCount / limit)

    while (offset < totalCount) {
      var pageNum = Math.floor(offset / limit) + 1
      self._log('获取歌曲列表: 第 ' + pageNum + '/' + maxPages + ' 页...')

      var url = self._apiBase + '/playlist/track/all?id=' + playlistId + '&offset=' + offset + '&limit=' + limit
      var resp = await self._fetchWithCookie(url)

      var tracks = []
      if (resp && resp.songs && Array.isArray(resp.songs)) {
        tracks = resp.songs
      } else if (resp && resp.code === 200 && resp.body && Array.isArray(resp.body)) {
        tracks = resp.body
      } else if (Array.isArray(resp)) {
        tracks = resp
      }

      if (tracks.length === 0) {
        self._log('第 ' + pageNum + ' 页无数据，停止获取')
        break
      }

      allTracks = allTracks.concat(tracks)
      offset += limit

      if (tracks.length < limit) {
        break
      }
    }

    return allTracks
  },

  // ==================== 批量获取歌曲链接 ====================
  _fetchSongUrls: async function (tracks) {
    var self = this
    var songUrls = {}
    var ids = []

    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i]
      var songId = track.id
      if (songId) {
        ids.push(songId)
      }
    }

    var batchSize = 500
    for (var b = 0; b < ids.length; b += batchSize) {
      var batchIds = ids.slice(b, b + batchSize)
      var batchNum = Math.floor(b / batchSize) + 1
      var totalBatches = Math.ceil(ids.length / batchSize)
      self._log('获取歌曲链接: 第 ' + batchNum + '/' + totalBatches + ' 批 (' + batchIds.length + ' 首)...')

      var url = self._apiBase + '/song/url/v1?id=' + batchIds.join(',') + '&level=lossless'
      var resp = await self._fetchWithCookie(url)

      var dataList = []
      if (resp && resp.data && Array.isArray(resp.data)) {
        dataList = resp.data
      }

      for (var j = 0; j < dataList.length; j++) {
        var item = dataList[j]
        if (item && item.id && item.url) {
          songUrls[item.id] = {
            url: item.url,
            level: item.level || 'lossless',
            type: item.type || 'flac'
          }
        }
      }
    }

    return songUrls
  },

  // ==================== 清理文件名中的非法字符 ====================
  _sanitizeFilename: function (name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  },

  // ==================== 批量下载歌曲 ====================
  _downloadSongs: async function (tracks, songUrls) {
    var self = this
    var localPathMap = {}
    var musicFolder = suchmusic.getSetting('musicFolder') || ''

    if (!musicFolder) {
      self._log('警告: 未获取到音乐目录，将使用远程链接')
      return localPathMap
    }

    var toDownload = []
    var noUrlCount = 0
    var alreadyExistCount = 0

    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i]
      var songId = t.id
      var urlInfo = songUrls[songId]

      if (!urlInfo || !urlInfo.url) {
        noUrlCount++
        continue
      }

      var artistName = '未知歌手'
      if (t.ar && t.ar.length > 0) {
        artistName = t.ar.map(function (a) { return a.name }).join(',')
      }
      var title = t.name || '未知歌曲'
      var ext = urlInfo.type || 'flac'

      var fileName = self._sanitizeFilename(artistName + ' - ' + title) + '.' + ext
      var localPath = musicFolder + '\\' + fileName

      var exists = await suchmusic.fileOp('exists', localPath)
      if (exists) {
        alreadyExistCount++
        localPathMap[songId] = localPath
        continue
      }

      toDownload.push({
        songId: songId,
        url: urlInfo.url,
        localPath: localPath,
        fileName: fileName
      })
    }

    self._log('下载统计: 需下载 ' + toDownload.length + ' 首, 已存在 ' + alreadyExistCount + ' 首, 无链接 ' + noUrlCount + ' 首')

    if (toDownload.length === 0) {
      return localPathMap
    }

    var batchSize = 3
    var downloadedCount = 0
    var failedCount = 0

    for (var b = 0; b < toDownload.length; b += batchSize) {
      var batch = toDownload.slice(b, b + batchSize)
      var batchNum = Math.floor(b / batchSize) + 1
      var totalBatches = Math.ceil(toDownload.length / batchSize)

      self._log('下载歌曲: 第 ' + batchNum + '/' + totalBatches + ' 批 (' + batch.length + ' 首)...')

      var results = await Promise.allSettled(
        batch.map(function (item) {
          return suchmusic.downloadFile(item.url, item.localPath).then(function (result) {
            if (result && result.success) {
              localPathMap[item.songId] = item.localPath
              return { success: true, fileName: item.fileName }
            } else {
              return { success: false, fileName: item.fileName, error: '下载返回失败' }
            }
          }).catch(function (err) {
            return { success: false, fileName: item.fileName, error: err.message || '下载异常' }
          })
        })
      )

      for (var j = 0; j < results.length; j++) {
        var r = results[j]
        if (r.status === 'fulfilled' && r.value && r.value.success) {
          downloadedCount++
          self._log('已下载: ' + r.value.fileName)
        } else {
          failedCount++
          var errInfo = (r.status === 'fulfilled' && r.value) ? r.value : r.reason
          self._log('下载失败: ' + (errInfo.fileName || '未知文件') + ' - ' + (errInfo.error || '未知错误'))
        }
      }
    }

    self._log('下载完成: 成功 ' + downloadedCount + ' 首, 失败 ' + failedCount + ' 首, 已存在 ' + alreadyExistCount + ' 首')
    return localPathMap
  },

  // ==================== 构建曲目列表 ====================
  _buildTrackEntries: function (tracks, songUrls, localPathMap) {
    var entries = []
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i]
      var songId = t.id
      var urlInfo = songUrls[songId] || {}

      var artistName = '未知歌手'
      if (t.ar && t.ar.length > 0) {
        artistName = t.ar.map(function (a) { return a.name }).join('/')
      }

      var albumName = ''
      if (t.al && t.al.name) {
        albumName = t.al.name
      }

      var coverUrl = ''
      if (t.al && t.al.picUrl) {
        coverUrl = t.al.picUrl
      }

      var localPath = localPathMap[songId] || ''
      var entry = {
        id: 'wy-' + songId,
        title: t.name || '未知歌曲',
        artist: artistName,
        album: albumName,
        cover: coverUrl,
        filePath: localPath || urlInfo.url || '',
        durationMs: (t.dt || 0),
        source: 'netease',
        sourceSongId: String(songId)
      }

      entries.push(entry)
    }
    return entries
  }
}
