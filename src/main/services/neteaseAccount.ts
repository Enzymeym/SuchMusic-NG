/**
 * 网易云账号信息的纯逻辑工具
 *
 * 这些判定直接决定渲染层显示的信息是否正确（会员类型、等级、账号身份归属），
 * 单独抽成不依赖 Electron 的文件，便于单测覆盖。
 */

/** 黑胶 VIP 的 vipType 位标志：10 / 100 / 110 都是黑胶，1 只代表「音乐包」 */
const BLACK_VIP_BIT = 10
const BLACK_VIP_MODERN = 100

/**
 * vipType 是否代表黑胶 VIP
 * 注意 vipType 是位标志而非等级：1 = 仅音乐包，10 = 黑胶，11 = 黑胶+音乐包，
 * 100 / 110 是同一含义的新版取值。旧实现用 `vipType > 0` 判定，会把
 * 「只买了音乐包」的账号显示成黑胶 VIP。
 */
export function isBlackVipType(vipType?: number | null): boolean {
  if (typeof vipType !== 'number' || !Number.isFinite(vipType) || vipType <= 0) return false
  return (vipType & BLACK_VIP_BIT) !== 0 || vipType >= BLACK_VIP_MODERN
}

/** 会员状态摘要：vipType=0 表示接口明确告知「当前无有效会员」 */
export interface VipSummary {
  vipType: number
  vipLevel?: number
}

/** /vip/info 里的单个会员项 */
interface VipEntry {
  vipLevel?: number
  expireTime?: number
}

/**
 * 会员项的有效等级
 * @returns undefined 表示无有效会员；0 表示在有效期但等级未知
 */
function activeVipLevel(entry: VipEntry | undefined, now: number): number | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const level =
    typeof entry.vipLevel === 'number' && entry.vipLevel > 0 ? Math.floor(entry.vipLevel) : 0
  const expireTime = typeof entry.expireTime === 'number' ? entry.expireTime : 0
  if (expireTime > now) return level
  // 少数节点不返回 expireTime，退化为「声明了等级即视为有效」
  if (!expireTime && level > 0) return level
  return undefined
}

/**
 * 解析 /vip/info 响应
 *
 * 旧实现只要 `redVipLevel` 是 number 就把 vipType 置为 11，而普通用户的该字段
 * 同样是 0，于是「非会员」也被标成黑胶 VIP、且等级显示成 Lv.1。
 * 这里以 associator（黑胶）与 musicPackage（音乐包）的有效期为准。
 *
 * @returns null 表示响应结构不可用（调用方应保留原有值）
 */
export function parseVipInfo(payload: unknown, now = Date.now()): VipSummary | null {
  const data = (
    payload as {
      data?: { associator?: VipEntry; musicPackage?: VipEntry; redVipLevel?: unknown }
    }
  )?.data
  if (!data || typeof data !== 'object') return null

  const blackLevel = activeVipLevel(data.associator, now)
  if (blackLevel !== undefined) {
    return { vipType: 11, vipLevel: blackLevel || undefined }
  }
  if (activeVipLevel(data.musicPackage, now) !== undefined) {
    return { vipType: 1 }
  }
  // 接口返回了会员结构但均已过期（或属于非会员）：显式清零，避免残留 VIP 标记
  if (data.associator || data.musicPackage || typeof data.redVipLevel === 'number') {
    return { vipType: 0 }
  }
  return null
}

/** 账号标识（只用到 userId / savedAt，便于泛型约束） */
export interface IdentifiedAccount {
  userId: string
  savedAt?: number
}

export interface IdentityRebindResult<T extends IdentifiedAccount> {
  accounts: T[]
  account: T
  activeUserId: string
  /** 是否发生了身份纠正 */
  rebind: boolean
}

/**
 * 按 Cookie 归属纠正本地账号标识
 *
 * `/login/status` 返回的 profile 才是 Cookie 真正所属的用户。本地记录的 userId
 * 若与它不一致（历史脏数据、Cookie 被后一次登录覆盖等），继续沿用旧 userId 就会
 * 出现「昵称 / 头像来自 A，用户 ID / 等级 / 歌单来自 B」的错乱：
 * `/user/detail?uid=` 与 `/user/playlist?uid=` 都按 userId 查询，而昵称头像来自 Cookie。
 *
 * @param accounts 现有账号列表
 * @param account 当前账号（持有待校验的 Cookie）
 * @param realUserId Cookie 解析出的真实 userId
 * @param activeUserId 当前活跃 userId
 */
export function rebindAccountIdentity<T extends IdentifiedAccount>(
  accounts: T[],
  account: T,
  realUserId: string,
  activeUserId: string
): IdentityRebindResult<T> {
  const prevUserId = account.userId
  if (!realUserId || realUserId === prevUserId) {
    return { accounts, account, activeUserId, rebind: false }
  }

  const updated = { ...account, userId: realUserId }
  const next: T[] = []
  for (const item of accounts) {
    if (item === account) {
      next.push(updated)
      continue
    }
    // 同一用户的旧记录：其 Cookie 已被本次这份覆盖，直接丢弃避免出现重复账号
    if (item.userId === realUserId) continue
    next.push(item)
  }
  if (!accounts.includes(account)) next.push(updated)

  return {
    accounts: next,
    account: updated,
    activeUserId: activeUserId === prevUserId ? realUserId : activeUserId,
    rebind: true
  }
}
