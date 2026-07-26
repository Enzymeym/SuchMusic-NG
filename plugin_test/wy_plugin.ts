/* eslint-disable prettier/prettier */
/**
 * Such 插件 - 网易云音乐 NCM 解析器
 * 基于 ncmdump-go (https://git.taurusxin.com/taurusxin/ncmdump-go)
 * 支持批量解析 .ncm 文件并输出到 Such 音乐文件夹
 */

window.source = {
  id: 'SUCH_NETEASE_NCM_WIDGET',
  name: '网易云音乐 NCM 解析器',
  version: '1.0.0',
  author: 'enzymeym',
  icon: '图标 URL',
  description: '基于 ncmdump-go 批量解析 .ncm 文件并输出到 Such 音乐文件夹',
  isUIWidget: true,
  permissions: ['local_program', 'file_system', 'app_info', 'fetch', 'playlist'],

  // ==================== JSON UI Schema ====================
  uiSchema: {
    sections: [
      {
        title: '解密器设置',
        fields: [
          {
            type: 'input',
            key: 'decryptorPath',
            label: '解密器路径 (ncmdump-go)',
            placeholder: '例如: D:\\tools\\ncmdump-go.exe',
            action: 'browse'
          },
          {
            type: 'input',
            key: 'ncmDir',
            label: 'NCM 文件目录',
            placeholder: '选择包含 .ncm 文件的目录',
            readonly: true,
            action: 'browseDir'
          },
          {
            type: 'text',
            key: 'musicDir',
            label: '音乐输出目录'
          }
        ]
      },
      {
        title: '状态',
        fields: [
          {
            type: 'tag',
            key: 'decryptorStatusText'
          },
          {
            type: 'tag',
            key: 'statusText'
          }
        ]
      },
      {
        title: '操作',
        actions: [
          {
            type: 'button',
            label: '下载解密器',
            method: 'downloadDecryptor',
            variant: 'default'
          },
          {
            type: 'button',
            label: '检测解密器',
            method: 'checkDecryptorStatus'
          },
          {
            type: 'button',
            label: '开始解密',
            method: 'startDecrypt',
            variant: 'primary'
          }
        ]
      },
      {
        title: '输出日志',
        fields: [
          {
            type: 'log',
            key: 'outputLog'
          }
        ]
      }
    ]
  },

  // ==================== 状态 ====================
  _status: 'ready',
  _decryptorPath: '',
  _ncmDir: '',
  _isDecryptorValid: false,
  _downloadPath: '',

  // ==================== 初始化 ====================
  initialization: function () {
    var musicFolder = suchmusic.getSetting('musicFolder')
    this._musicDir = musicFolder || ''
    // 默认下载路径
    this._downloadPath = musicFolder ? musicFolder + '\\ncmdump-go.exe' : ''
    this.setProps({
      status: 'ready',
      decryptorPath: '',
      ncmDir: '',
      musicDir: this._musicDir,
      isDecryptorValid: false,
      decryptorStatusText: '未检测',
      statusText: '就绪',
      outputLog: ''
    })
  },

  // ==================== 设置解密器路径 ====================
  setDecryptorPath: function (path) {
    this._decryptorPath = path
    this.setProps({ decryptorPath: path, isDecryptorValid: false, decryptorStatusText: '未检测' })
    return { code: true }
  },

  // ==================== 设置 NCM 目录 ====================
  setNcmDir: function (dir) {
    this._ncmDir = dir
    this.setProps({ ncmDir: dir })
    return { code: true }
  },

  // ==================== 检查解密器状态 ====================
  checkDecryptorStatus: async function () {
    var path = this._decryptorPath
    if (!path) {
      window.notify('请先配置 ncmdump-go 解密器路径', 'warning')
      return { code: false, message: '未配置路径' }
    }
    try {
      var result = await suchmusic.execProgram(path, ['--version'])
      if (result && result.code === 0) {
        var ver = (result.stdout || '').trim()
        this._isDecryptorValid = true
        this.setProps({ isDecryptorValid: true, decryptorStatusText: '有效: ' + ver })
        window.notify('ncmdump-go 解密器就绪 (' + ver + ')', 'success')
        return { code: true, version: ver }
      } else {
        this._isDecryptorValid = false
        this.setProps({ isDecryptorValid: false, decryptorStatusText: '无效' })
        window.notify('ncmdump-go 解密器无效，请检查路径', 'error')
        return { code: false, message: '解密器无响应' }
      }
    } catch (err) {
      this._isDecryptorValid = false
      this.setProps({ isDecryptorValid: false, decryptorStatusText: '未找到' })
      window.notify('未找到 ncmdump-go 解密器', 'warning')
      return { code: false, message: err.message || String(err) }
    }
  },

  // ==================== 下载解密器 ====================
  downloadDecryptor: async function () {
    var self = this
    self.setProps({ statusText: '下载中...', outputLog: '正在获取最新版本信息...\n' })
    window.notify('正在获取 ncmdump-go 最新版本...', 'info')

    try {
      // 获取最新 release 信息
      var apiUrl = 'https://git.taurusxin.com/api/v1/repos/taurusxin/ncmdump-go/releases/latest'
      var response = await suchmusic.fetch(apiUrl)
      var release = await response.json()

      // 查找 Windows amd64 资产
      var assets = release.assets || []
      var downloadUrl = ''
      var assetName = ''
      for (var i = 0; i < assets.length; i++) {
        if (assets[i].name && assets[i].name.indexOf('windows_amd64') >= 0) {
          downloadUrl = assets[i].browser_download_url
          assetName = assets[i].name
          break
        }
      }

      if (!downloadUrl) {
        self.setProps({ statusText: '下载失败', outputLog: '未找到 Windows 版本' })
        window.notify('未找到 ncmdump-go Windows 版本', 'error')
        return { code: false, message: '未找到 Windows 版本' }
      }

      var musicDir = self._musicDir
      var zipPath = musicDir + '\\ncmdump-go.zip'
      var exePath = musicDir + '\\ncmdump-go.exe'

      // 步骤 1: 下载 ZIP 压缩包
      self.setProps({ outputLog: '正在下载: ' + assetName + '\n' })
      window.notify('正在下载 ncmdump-go...', 'info')

      var downloadResult = await suchmusic.downloadFile(downloadUrl, zipPath)
      if (!downloadResult || !downloadResult.success) {
        self.setProps({ statusText: '下载失败', outputLog: '下载失败' })
        window.notify('ncmdump-go 下载失败', 'error')
        return { code: false, message: '下载失败' }
      }

      // 步骤 2: 解压 ZIP 文件
      self.setProps({ statusText: '解压中...', outputLog: '正在解压 ' + assetName + '...\n' })
      window.notify('正在解压 ncmdump-go...', 'info')

      var extractDir = musicDir + '\\ncmdump-go_extract'
      var expandCmd = 'powershell -NoProfile -NonInteractive -Command "Expand-Archive -Path \'' + zipPath + '\' -DestinationPath \'' + extractDir + '\' -Force"'
      await suchmusic.execTerminal(expandCmd)

      // 步骤 3: 查找解压后的可执行文件并复制到目标路径
      var files = await suchmusic.fileOp('listDir', extractDir)
      var exeFound = false
      for (var j = 0; j < files.length; j++) {
        var fileName = files[j]
        if (fileName && fileName.toLowerCase().endsWith('.exe')) {
          await suchmusic.fileOp('copy', extractDir + '\\' + fileName, exePath)
          exeFound = true
          break
        }
      }

      if (!exeFound) {
        throw new Error('解压后未找到 .exe 可执行文件')
      }

      // 步骤 4: 清理临时文件
      try {
        await suchmusic.fileOp('delete', zipPath)
        var removeCmd = 'powershell -NoProfile -NonInteractive -Command "Remove-Item -Path \'' + extractDir + '\' -Recurse -Force"'
        await suchmusic.execTerminal(removeCmd)
      } catch (_e) {
        // 清理失败不影响主流程
      }

      self._downloadPath = exePath
      self._decryptorPath = exePath
      self._isDecryptorValid = false
      self.setProps({
        decryptorPath: exePath,
        statusText: '下载完成',
        outputLog: '下载并解压完成: ' + exePath,
        isDecryptorValid: false,
        decryptorStatusText: '已下载，请检测'
      })
      window.notify('ncmdump-go 下载解压完成，请点击"检测解密器"验证', 'success')
      return { code: true, filePath: exePath }
    } catch (err) {
      var errMsg = err.message || String(err)
      self.setProps({ statusText: '下载失败', outputLog: '下载出错:\n' + errMsg })
      window.notify('下载 ncmdump-go 失败: ' + errMsg, 'error')
      return { code: false, message: errMsg }
    }
  },

  // ==================== NCM 批量解析 ====================
  startDecrypt: async function () {
    var decryptorPath = this._decryptorPath
    var ncmDir = this._ncmDir
    var musicDir = this._musicDir

    if (!decryptorPath) {
      window.notify('请先配置 ncmdump-go 解密器路径', 'error')
      return { code: false, message: '未配置解密器路径' }
    }
    if (!ncmDir) {
      window.notify('请先选择 NCM 文件目录', 'error')
      return { code: false, message: '未选择 NCM 目录' }
    }

    this.setProps({ status: 'parsing', statusText: '解密中...' })
    window.notify('开始解密 NCM 文件...', 'info')

    try {
      var command = '"' + decryptorPath + '" -d "' + ncmDir + '" -o "' + musicDir + '" -r'
      var output = await suchmusic.execTerminal(command)

      this.setProps({
        status: 'done',
        statusText: '完成',
        outputLog: output
      })
      window.notify('NCM 文件解析完成，已输出到音乐文件夹', 'success')
      return { code: true, message: '解密完成' }
    } catch (err) {
      var errMsg = err.message || String(err)
      this.setProps({
        status: 'error',
        statusText: '失败',
        outputLog: '错误:\n' + errMsg
      })
      window.notify('解密失败: ' + errMsg, 'error')
      return { code: false, message: errMsg }
    }
  },

  // ==================== 获取状态 ====================
  getStatus: function () {
    return {
      status: this._status,
      decryptorPath: this._decryptorPath,
      ncmDir: this._ncmDir,
      musicDir: this._musicDir,
      isDecryptorValid: this._isDecryptorValid
    }
  },

  // ==================== 检查更新 ====================
  checkUpdate: async function () {
    try {
      var response = await suchmusic.fetch(
        'https://git.taurusxin.com/api/v1/repos/taurusxin/ncmdump-go/releases/latest'
      )
      var data = await response.json()
      var remoteVersion = (data.tag_name || '').replace(/^v/, '')
      var hasNew = remoteVersion > '1.0.0'

      if (hasNew) {
        window.notify('ncmdump-go 有新版本 v' + remoteVersion, 'info')
      } else {
        window.notify('ncmdump-go 已是最新版本', 'info')
      }

      return {
        hasNew: hasNew,
        version: remoteVersion,
        url: data.html_url || 'https://git.taurusxin.com/taurusxin/ncmdump-go/releases',
        changelog: data.body || ''
      }
    } catch (err) {
      window.notify('检查更新失败: ' + (err.message || String(err)), 'error')
      return { hasNew: false, version: '', url: '', changelog: '' }
    }
  }
}
