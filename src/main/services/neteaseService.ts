/**
 * 网易云音乐服务
 * 基于 https://api.enzymeym.top/docs/#/ （网易云音乐 API Enhanced）提供歌曲搜索、播放地址、热搜等基础能力
 */

import { app, ipcMain } from 'electron'
import { join } from 'path'
import { promises as fs, existsSync } from 'fs'
import { getNeteaseCoverUrl } from './lyricService'

/** 网易云 API 基础地址 */
const API_BASE = 'https://api.enzymeym.top'

/** 已登录账号列表（内存态），支持多账号 */
let neteaseAccounts: NeteaseAccount[] = []

/** 当前活跃账号 userId（空表示未登录） */
let activeUserId = ''

/** 账号持久化文件路径 */
const accountsFilePath = (): string => join(app.getPath('userData'), 'netease-accounts.json')

/** 旧版单账号 Cookie 文件路径（用于迁移） */
const legacyCookieFilePath = (): string => join(app.getPath('userData'), 'netease-cookie.json')

/** 搜索结果中的歌曲结构（原始 API 返回） */
interface WyRawSong {
  id: number
  name: string
  // 搜索接口字段：artists / album / duration / mvid
  artists?: { id: number; name: string }[]
  album?: { id: number; name: string; picId?: number; picUrl?: string }
  duration?: number
  mvid?: number
  // 歌单/详情接口字段：ar / al / dt / mv
  ar?: { id: number; name: string }[]
  al?: { id: number; name: string; picId?: number; picUrl?: string }
  dt?: number
  mv?: number
  picId?: number
  fee?: number
}

/** 归一化后的网易云歌曲（可直接喂给渲染层 SongList） */
export interface NeteaseSong {
  id: number
  name: string
  ar: { id: number; name: string }[]
  al: { id: number; name: string; picUrl: string }
  dt: number
  mv: number
  fee: number
  source: 'netease'
}

/** 搜索接口响应 */
interface WySearchResponse {
  code: number
  result?: {
    songs?: WyRawSong[]
    songCount?: number
  }
}

/** 播放地址接口响应 */
interface WySongUrlResponse {
  code: number
  data?: {
    id: number
    url: string | null
    fee?: number
  }[]
}

/** 热搜接口响应 */
interface WyHotSearchResponse {
  code: number
  data?: {
    list?: {
      searchWord: string
      score?: number
      iconUrl?: string
      content?: string
    }[]
  }
}

/**
 * 归一化原始歌曲结构（兼容搜索接口 artists/album/duration 与歌单接口 ar/al/dt 两套字段）
 */
function normalizeSong(song: WyRawSong): NeteaseSong {
  const artists = song.ar?.length ? song.ar : song.artists || []
  const albumName = song.al?.name || song.album?.name || ''
  const picId = song.al?.picId ?? song.album?.picId ?? song.picId
  const picUrl = song.al?.picUrl || song.album?.picUrl || (picId ? getNeteaseCoverUrl(picId) : '')
  return {
    id: song.id,
    name: song.name || '未知歌曲',
    ar: artists.map((a) => ({ id: a.id ?? 0, name: a.name })),
    al: {
      id: song.al?.id ?? song.album?.id ?? 0,
      name: albumName,
      picUrl
    },
    dt: song.dt || song.duration || 0,
    mv: song.mv || song.mvid || 0,
    fee: song.fee ?? 0,
    source: 'netease'
  }
}

/**
 * 批量获取歌曲详情（用于修正搜索接口不准确的封面）
 * 实测 `/search` 返回的 album.picId 与真实封面存在偏差（尾号差 1~6），
 * 而 `/song/detail` 返回的 al.picUrl 为真实封面地址
 * @param ids 网易云歌曲 ID 列表
 */
async function fetchSongDetailMap(
  ids: number[]
): Promise<Map<number, { al?: { name?: string; picUrl?: string } }>> {
  const map = new Map<number, { al?: { name?: string; picUrl?: string } }>()
  if (ids.length === 0) return map
  try {
    const resp = await fetch(`${API_BASE}/song/detail?ids=${ids.join(',')}`)
    if (!resp.ok) return map
    const data = await resp.json()
    for (const s of (data.songs ?? []) as { id: number; al?: { name?: string; picUrl?: string } }[]) {
      map.set(s.id, s)
    }
  } catch (e) {
    console.warn('[neteaseService] 批量获取歌曲详情失败，封面可能不准确:', e)
  }
  return map
}

/**
 * 搜索网易云歌曲
 * @param keywords 关键词
 * @param offset 偏移量（分页）
 * @param limit 每页数量
 */
async function searchSongs(
  keywords: string,
  offset = 0,
  limit = 30
): Promise<{ songs: NeteaseSong[]; hasMore: boolean; total: number }> {
  const url =
    `${API_BASE}/search?keywords=${encodeURIComponent(keywords)}` +
    `&type=1&offset=${offset}&limit=${limit}`
  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} searching for "${keywords}"`)
      return { songs: [], hasMore: false, total: 0 }
    }
    const data: WySearchResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[neteaseService] API error code ${data.code} searching for "${keywords}"`)
      return { songs: [], hasMore: false, total: 0 }
    }
    const rawSongs = data.result?.songs || []
    const total = data.result?.songCount ?? rawSongs.length

    // 搜索接口的 album.picId 不准确，批量拉取详情用真实封面覆盖
    const detailMap = await fetchSongDetailMap(rawSongs.map((s) => s.id))

    const songs = rawSongs.map((raw) => {
      const song = normalizeSong(raw)
      const realPicUrl = detailMap.get(raw.id)?.al?.picUrl
      if (realPicUrl) {
        // 追加缩略参数减小图片体积（详情返回的是原图地址）
        song.al.picUrl = realPicUrl.includes('?') ? realPicUrl : `${realPicUrl}?param=300y300`
      }
      return song
    })
    return {
      songs,
      hasMore: offset + songs.length < total,
      total
    }
  } catch (e) {
    console.error(`[neteaseService] Failed to search for "${keywords}":`, e)
    return { songs: [], hasMore: false, total: 0 }
  }
}

/**
 * 音质等级映射：内部质量标识 -> 网易云 API level
 * standard=标准(128k) higher=较高(192k) exhigh=极高/高品(320k) lossless=无损(FLAC) hires=高解析
 */
const QUALITY_LEVEL_MAP: Record<string, string> = {
  '128k': 'standard',
  '192k': 'higher',
  '320k': 'exhigh',
  flac: 'lossless',
  lossless: 'lossless',
  hires: 'hires'
}

/**
 * 批量获取歌曲播放地址
 * @param ids 网易云歌曲 ID 列表
 * @param quality 音质标识（128k / 192k / 320k / flac 等），默认标准音质
 * @returns id -> 播放地址 映射（无播放地址的条目会被剔除）
 */
async function getSongUrlMap(
  ids: number[],
  quality = '128k'
): Promise<Record<number, string>> {
  if (ids.length === 0) return {}
  const level = QUALITY_LEVEL_MAP[quality] || 'standard'
  const url =
    `${API_BASE}/song/url/v1?id=${ids.join(',')}` +
    `&level=${level}&randomCNIP=true`
  try {
    const cookie = activeAccount()?.cookie || ''
    const resp = await fetch(
      url,
      cookie ? { headers: { Cookie: cookie } } : undefined
    )
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching song urls`)
      return {}
    }
    const data: WySongUrlResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[neteaseService] API error code ${data.code} fetching song urls`)
      return {}
    }
    const map: Record<number, string> = {}
    for (const item of data.data || []) {
      if (item && item.url) {
        map[item.id] = item.url
      }
    }
    return map
  } catch (e) {
    console.error('[neteaseService] Failed to fetch song urls:', e)
    return {}
  }
}

/**
 * 获取网易云热搜列表
 */
async function getHotSearch(): Promise<{ searchWord: string; iconUrl?: string }[]> {
  const url = `${API_BASE}/search/hot/detail`
  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      console.error(`[neteaseService] HTTP ${resp.status} fetching hot search`)
      return []
    }
    const data: WyHotSearchResponse = await resp.json()
    if (data.code !== 200) {
      console.error(`[neteaseService] API error code ${data.code} fetching hot search`)
      return []
    }
    return (data.data?.list || []).map((item) => ({
      searchWord: item.searchWord,
      iconUrl: item.iconUrl
    }))
  } catch (e) {
    console.error('[neteaseService] Failed to fetch hot search:', e)
    return []
  }
}

// ==================== 登录状态与多账号管理 ====================

/** 网易云登录用户信息（渲染层展示用，含 VIP 与等级） */
export interface NeteaseLoginProfile {
  nickname: string
  userId: string
  avatarUrl?: string
  /** VIP 类型：0=无 VIP，>0 为黑胶 VIP（11=黑胶VIP，100=黑胶VIP旧版） */
  vipType?: number
  /** 黑胶 VIP 等级（来自 /vip/info 的 redVipLevel） */
  vipLevel?: number
  /** 账号等级（来自 /user/detail 的 level） */
  level?: number
  /** 个性签名 */
  signature?: string
}

/** 本地持久化的账号（含 Cookie 与缓存的详情） */
interface NeteaseAccount {
  userId: string
  nickname: string
  avatarUrl?: string
  cookie: string
  savedAt: number
  vipType?: number
  vipLevel?: number
  level?: number
  signature?: string
}

/** 当前活跃账号：优先按 activeUserId 匹配，无匹配时回退到最近保存的账号 */
function activeAccount(): NeteaseAccount | undefined {
  return neteaseAccounts.find((a) => a.userId === activeUserId) || neteaseAccounts[0]
}

/** 将账号转为渲染层可见的 profile */
function toProfile(a: NeteaseAccount): NeteaseLoginProfile {
  return {
    nickname: a.nickname,
    userId: a.userId,
    avatarUrl: a.avatarUrl || '',
    vipType: a.vipType,
    vipLevel: a.vipLevel,
    level: a.level,
    signature: a.signature
  }
}

/** 清洗 Cookie：按 ; 分割，剔除属性段，只保留 key=value */
function cleanCookie(rawCookie: string): string {
  if (!rawCookie) return ''
  const attrKeywords = [
    'max-age', 'path', 'domain', 'expires', 'secure',
    'httponly', 'samesite', 'priority', 'partitioned'
  ]
  const parts = rawCookie.split(';')
  const cleaned: string[] = []
  for (const part of parts) {
    const p = part.trim()
    if (!p) continue
    const eqIdx = p.indexOf('=')
    if (eqIdx > 0) {
      const key = p.substring(0, eqIdx).trim().toLowerCase()
      if (!attrKeywords.includes(key)) {
        cleaned.push(p)
      }
    }
  }
  return cleaned.join('; ')
}

/** 持久化账号列表 */
async function persistAccounts(): Promise<void> {
  try {
    await fs.writeFile(
      accountsFilePath(),
      JSON.stringify({ accounts: neteaseAccounts, activeUserId }, null, 2),
      'utf-8'
    )
  } catch (e) {
    console.error('[neteaseService] 保存账号列表失败:', e)
  }
}

/** 从 /login/status 响应解析用户信息 */
function parseLoginStatus(data: unknown): NeteaseLoginProfile | null {
  const profile = (data as {
    profile?: {
      nickname?: string
      userId?: number | string
      id?: number | string
      avatarUrl?: string
      vipType?: number
      signature?: string
    }
  })?.profile
  if (!profile) return null
  return {
    nickname: profile.nickname || '网易云用户',
    userId: String(profile.userId ?? profile.id ?? ''),
    avatarUrl: profile.avatarUrl || '',
    vipType: profile.vipType,
    signature: profile.signature
  }
}

/**
 * 用指定 Cookie 向 /login/status 校验并解析用户
 * @param cookie 登录 Cookie
 * @returns invalid=true 表示 Cookie 明确失效（301 或无 profile），网络异常等临时失败时 invalid 为 false
 */
async function fetchStatusWithCookie(
  cookie: string
): Promise<{ loggedIn: boolean; profile?: NeteaseLoginProfile; invalid?: boolean }> {
  if (!cookie) return { loggedIn: false, invalid: true }
  try {
    const resp = await fetch(`${API_BASE}/login/status`, {
      headers: { Cookie: cookie }
    })
    if (!resp.ok) {
      console.warn(`[neteaseService] /login/status HTTP ${resp.status}`)
      return { loggedIn: false }
    }
    const data = (await resp.json()) as { code?: number; data?: { code?: number; profile?: unknown } }
    // 实测该 API 的 /login/status 顶层无 code 字段，code 位于 data.code（如 { data: { code: 200, profile } }）
    const code = data.data?.code ?? data.code
    // code 301 表示 Cookie 失效（未登录）
    if (code === 301) return { loggedIn: false, invalid: true }
    if (code !== 200) {
      console.warn(`[neteaseService] /login/status code ${code}`)
      return { loggedIn: false }
    }
    const profile = parseLoginStatus(data.data)
    return profile ? { loggedIn: true, profile } : { loggedIn: false, invalid: true }
  } catch (e) {
    console.warn('[neteaseService] 获取登录状态失败:', e)
    return { loggedIn: false }
  }
}

/**
 * 补充账号详情：等级（/user/detail）与黑胶 VIP 等级（/vip/info）
 * 两者都需要登录态，失败时静默降级
 */
async function enrichAccountDetail(account: NeteaseAccount): Promise<void> {
  try {
    // 1. 账号等级 / 签名 / vipType
    const detailResp = await fetch(
      `${API_BASE}/user/detail?uid=${encodeURIComponent(account.userId)}`,
      { headers: { Cookie: account.cookie } }
    )
    if (detailResp.ok) {
      const detail = (await detailResp.json()) as {
        level?: number
        profile?: { vipType?: number; signature?: string }
      }
      if (typeof detail.level === 'number') account.level = detail.level
      if (typeof detail.profile?.vipType === 'number') account.vipType = detail.profile.vipType
      if (detail.profile?.signature) account.signature = detail.profile.signature
    }
  } catch (e) {
    console.warn('[neteaseService] 获取账号等级失败:', e)
  }
  try {
    // 2. 黑胶 VIP 等级
    const vipResp = await fetch(`${API_BASE}/vip/info`, {
      headers: { Cookie: account.cookie }
    })
    if (vipResp.ok) {
      const vip = (await vipResp.json()) as { data?: { redVipLevel?: number } }
      const redVipLevel = vip.data?.redVipLevel
      if (typeof redVipLevel === 'number') {
        account.vipLevel = redVipLevel
        if (!account.vipType) account.vipType = 11
      }
    }
  } catch (e) {
    console.warn('[neteaseService] 获取 VIP 信息失败:', e)
  }
}

/** 从本地加载账号列表；兼容迁移旧版单账号 Cookie 文件 */
async function loadAccounts(): Promise<void> {
  try {
    const filePath = accountsFilePath()
    if (existsSync(filePath)) {
      const raw = await fs.readFile(filePath, 'utf-8')
      const data = JSON.parse(raw) as { accounts?: NeteaseAccount[]; activeUserId?: string }
      neteaseAccounts = (data.accounts || []).filter((a) => a.cookie && a.userId)
      activeUserId = data.activeUserId || neteaseAccounts[0]?.userId || ''
      if (neteaseAccounts.length) {
        console.log(`[neteaseService] 已从本地恢复 ${neteaseAccounts.length} 个网易云账号`)
      }
      return
    }

    // 迁移旧版单账号 Cookie
    if (existsSync(legacyCookieFilePath())) {
      const raw = await fs.readFile(legacyCookieFilePath(), 'utf-8')
      const legacy = JSON.parse(raw) as { cookie?: string; savedAt?: number }
      if (legacy.cookie) {
        const status = await fetchStatusWithCookie(legacy.cookie)
        if (status.loggedIn && status.profile) {
          const account: NeteaseAccount = {
            userId: status.profile.userId,
            nickname: status.profile.nickname,
            avatarUrl: status.profile.avatarUrl,
            cookie: legacy.cookie,
            savedAt: legacy.savedAt || Date.now(),
            vipType: status.profile.vipType,
            signature: status.profile.signature
          }
          neteaseAccounts = [account]
          activeUserId = account.userId
          await persistAccounts()
          console.log('[neteaseService] 已将旧版登录 Cookie 迁移为账号')
          await fs.unlink(legacyCookieFilePath()).catch(() => {})
        } else if (status.invalid) {
          // Cookie 已明确失效，清理旧文件
          await fs.unlink(legacyCookieFilePath()).catch(() => {})
        }
        // 网络异常等临时失败：保留旧文件，下次启动再尝试迁移
      }
    }
  } catch (e) {
    console.warn('[neteaseService] 读取本地账号失败:', e)
  }
}

/**
 * 获取当前登录状态（含账号列表与活跃账号）
 */
async function getLoginStatus(): Promise<{
  loggedIn: boolean
  profile?: NeteaseLoginProfile
  accounts: NeteaseLoginProfile[]
  activeUserId: string
}> {
  const account = activeAccount()
  if (!account) return { loggedIn: false, accounts: [], activeUserId: '' }

  const status = await fetchStatusWithCookie(account.cookie)
  if (!status.loggedIn) {
    // 仅当 Cookie 明确失效时移除该账号；网络异常等临时失败不删除
    if (status.invalid) {
      neteaseAccounts = neteaseAccounts.filter((a) => a.userId !== account.userId)
      if (activeUserId === account.userId) {
        activeUserId = neteaseAccounts[0]?.userId || ''
      }
      await persistAccounts()
      return getLoginStatus()
    }
    return {
      loggedIn: false,
      profile: toProfile(account),
      accounts: neteaseAccounts.map(toProfile),
      activeUserId
    }
  }

  // 更新昵称 / 头像 / VIP 类型（可能已变更）
  account.nickname = status.profile!.nickname
  account.avatarUrl = status.profile!.avatarUrl
  account.vipType = status.profile!.vipType
  account.signature = status.profile!.signature

  // 等级 / VIP 等级缺失时补充
  if (account.level === undefined || account.vipLevel === undefined) {
    await enrichAccountDetail(account)
    await persistAccounts()
  }

  return {
    loggedIn: true,
    profile: toProfile(account),
    accounts: neteaseAccounts.map(toProfile),
    activeUserId
  }
}

/**
 * 生成登录二维码
 * @returns unikey（轮询用）+ qrimg（base64 data URI）
 */
async function getLoginQr(): Promise<{ unikey: string; qrimg: string }> {
  // 1. 获取二维码 key
  const keyResp = await fetch(`${API_BASE}/login/qr/key?timestamp=${Date.now()}`)
  if (!keyResp.ok) throw new Error(`获取二维码 key 失败: HTTP ${keyResp.status}`)
  const keyData = await keyResp.json()
  const unikey: string = keyData.data?.unikey
  if (!unikey) throw new Error('获取二维码 key 失败: 响应缺少 unikey')

  // 2. 生成二维码图片
  const qrResp = await fetch(
    `${API_BASE}/login/qr/create?key=${encodeURIComponent(unikey)}&qrimg=true&timestamp=${Date.now()}`
  )
  if (!qrResp.ok) throw new Error(`生成二维码失败: HTTP ${qrResp.status}`)
  const qrData = await qrResp.json()
  let qrimg: string = qrData.data?.qrimg || ''
  if (!qrimg) throw new Error('生成二维码失败: 响应缺少 qrimg')
  if (!qrimg.startsWith('data:')) {
    qrimg = `data:image/png;base64,${qrimg}`
  }
  return { unikey, qrimg }
}

/**
 * 轮询检测二维码扫码状态
 * @param unikey 二维码 key
 * @returns code 与登录成功时的用户信息
 */
async function checkLoginQr(
  unikey: string
): Promise<{ code: number; profile?: NeteaseLoginProfile }> {
  const checkUrl = `${API_BASE}/login/qr/check?key=${encodeURIComponent(unikey)}&timestamp=${Date.now()}`
  let resp = await fetch(checkUrl)
  if (!resp.ok) {
    throw new Error(`检测扫码状态失败: HTTP ${resp.status}`)
  }
  let data = await resp.json()

  // 502：需要 noCookie=true 重试
  if (data.code === 502) {
    resp = await fetch(`${checkUrl}&noCookie=true`)
    if (!resp.ok) throw new Error(`检测扫码状态失败: HTTP ${resp.status}`)
    data = await resp.json()
  }

  // 803：扫码授权成功，提取 Cookie 并写入账号列表
  if (data.code === 803) {
    const rawCookie = data.cookie || data.data || ''
    const cookie = cleanCookie(rawCookie)
    if (!cookie) {
      throw new Error('未获取到登录凭证')
    }
    const status = await fetchStatusWithCookie(cookie)
    if (!status.loggedIn || !status.profile) {
      throw new Error('登录凭证校验失败')
    }
    const profile = status.profile
    // 同 userId 覆盖旧账号，并置为活跃
    const existing = neteaseAccounts.find((a) => a.userId === profile.userId)
    const account: NeteaseAccount = {
      userId: profile.userId,
      nickname: profile.nickname,
      avatarUrl: profile.avatarUrl,
      cookie,
      savedAt: Date.now(),
      vipType: profile.vipType,
      signature: profile.signature
    }
    if (existing) {
      neteaseAccounts[neteaseAccounts.indexOf(existing)] = account
    } else {
      neteaseAccounts.push(account)
    }
    activeUserId = profile.userId
    await enrichAccountDetail(account)
    await persistAccounts()
    return { code: 803, profile: toProfile(account) }
  }

  return { code: data.code ?? -1 }
}

/**
 * 退出登录：移除指定账号（缺省移除当前活跃账号）
 * @param userId 可选，目标账号 userId
 */
async function logout(userId?: string): Promise<void> {
  const targetId = userId || activeUserId
  if (!targetId) return
  neteaseAccounts = neteaseAccounts.filter((a) => a.userId !== targetId)
  if (activeUserId === targetId) {
    activeUserId = neteaseAccounts[0]?.userId || ''
  }
  await persistAccounts()
  console.log(`[neteaseService] 已退出网易云账号 ${targetId}`)
}

/**
 * 切换当前活跃账号
 * @param userId 目标账号 userId
 */
async function switchAccount(userId: string): Promise<{
  loggedIn: boolean
  profile?: NeteaseLoginProfile
  accounts: NeteaseLoginProfile[]
  activeUserId: string
}> {
  if (!neteaseAccounts.some((a) => a.userId === userId)) {
    return { loggedIn: false, accounts: neteaseAccounts.map(toProfile), activeUserId }
  }
  activeUserId = userId
  await persistAccounts()
  return getLoginStatus()
}

/**
 * 注册网易云相关 IPC handler
 */
export function registerNeteaseHandlers(): void {
  // 启动时恢复登录账号
  void loadAccounts()

  ipcMain.handle(
    'netease:search',
    async (_event, keywords: string, offset = 0, limit = 30) => {
      if (!keywords || !keywords.trim()) {
        return { songs: [], hasMore: false, total: 0 }
      }
      return searchSongs(keywords.trim(), Number(offset) || 0, Number(limit) || 30)
    }
  )

  ipcMain.handle('netease:song-url', async (_event, ids: number[], quality?: string) => {
    if (!Array.isArray(ids)) return {}
    return getSongUrlMap(ids.map(Number).filter((id) => Number.isFinite(id) && id > 0), quality)
  })

  ipcMain.handle('netease:hot-search', async () => {
    return getHotSearch()
  })

  ipcMain.handle('netease:login-qr', async () => {
    return getLoginQr()
  })

  ipcMain.handle('netease:login-qr-check', async (_event, unikey: string) => {
    if (!unikey) return { code: -1 }
    return checkLoginQr(unikey)
  })

  ipcMain.handle('netease:login-status', async () => {
    return getLoginStatus()
  })

  ipcMain.handle('netease:switch-account', async (_event, userId: string) => {
    if (!userId) return { loggedIn: false, accounts: [], activeUserId: '' }
    return switchAccount(userId)
  })

  ipcMain.handle('netease:logout', async (_event, userId?: string) => {
    await logout(userId)
  })
}
