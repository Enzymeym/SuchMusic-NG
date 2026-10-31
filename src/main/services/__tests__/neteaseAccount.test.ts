import { describe, expect, it } from 'vitest'
import {
  isBlackVipType,
  parseVipInfo,
  rebindAccountIdentity,
  type IdentifiedAccount
} from '../neteaseAccount'

interface TestAccount extends IdentifiedAccount {
  nickname?: string
  cookie?: string
}

const NOW = 1_700_000_000_000
const valid = (level: number) => ({ vipLevel: level, expireTime: NOW + 86_400_000 })
const expired = (level: number) => ({ vipLevel: level, expireTime: NOW - 86_400_000 })

describe('isBlackVipType', () => {
  it('只有音乐包（vipType=1）不算黑胶', () => {
    expect(isBlackVipType(1)).toBe(false)
  })

  it('黑胶（10 / 11 / 100 / 110）算黑胶', () => {
    for (const vipType of [10, 11, 100, 110]) {
      expect(isBlackVipType(vipType)).toBe(true)
    }
  })

  it('无会员 / 非法值不算黑胶', () => {
    expect(isBlackVipType(0)).toBe(false)
    expect(isBlackVipType(undefined)).toBe(false)
    expect(isBlackVipType(null)).toBe(false)
    expect(isBlackVipType(Number.NaN)).toBe(false)
    expect(isBlackVipType(-1)).toBe(false)
  })
})

describe('parseVipInfo', () => {
  it('黑胶有效期内返回黑胶与等级', () => {
    expect(parseVipInfo({ data: { associator: valid(5), musicPackage: valid(5) } }, NOW)).toEqual({
      vipType: 11,
      vipLevel: 5
    })
  })

  it('黑胶过期但音乐包有效时降级为音乐包', () => {
    const payload = { data: { associator: expired(5), musicPackage: valid(5) } }
    expect(parseVipInfo(payload, NOW)).toEqual({ vipType: 1 })
  })

  it('非会员（redVipLevel=0 且无会员项）显式清零，不能被标成 VIP', () => {
    expect(parseVipInfo({ data: { redVipLevel: 0 } }, NOW)).toEqual({ vipType: 0 })
  })

  it('会员全部过期时清零', () => {
    const payload = { data: { associator: expired(5), musicPackage: expired(5) } }
    expect(parseVipInfo(payload, NOW)).toEqual({ vipType: 0 })
  })

  it('缺少 expireTime 但声明了等级时视为有效', () => {
    expect(parseVipInfo({ data: { associator: { vipLevel: 3 } } }, NOW)).toEqual({
      vipType: 11,
      vipLevel: 3
    })
  })

  it('响应结构不可用时返回 null，交由调用方保留原值', () => {
    expect(parseVipInfo(null, NOW)).toBeNull()
    expect(parseVipInfo({}, NOW)).toBeNull()
    expect(parseVipInfo({ data: null }, NOW)).toBeNull()
  })
})

describe('rebindAccountIdentity', () => {
  it('userId 一致时不做改动', () => {
    const account: TestAccount = { userId: '1', nickname: 'A' }
    const result = rebindAccountIdentity([account], account, '1', '1')
    expect(result.rebind).toBe(false)
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toBe(account)
  })

  it('以 Cookie 归属纠正 userId，并同步活跃账号', () => {
    const account: TestAccount = { userId: '8674552614', nickname: '酶游明', cookie: 'c' }
    const result = rebindAccountIdentity([account], account, '10019863995', '8674552614')
    expect(result.rebind).toBe(true)
    expect(result.account.userId).toBe('10019863995')
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0].userId).toBe('10019863995')
    // 原对象不被就地修改，避免外部仍持有旧标识
    expect(account.userId).toBe('8674552614')
    expect(result.activeUserId).toBe('10019863995')
  })

  it('丢弃同一用户的旧记录，避免出现重复账号', () => {
    const stale: TestAccount = { userId: '1', nickname: '旧记录' }
    const active: TestAccount = { userId: '2', nickname: 'A', cookie: 'new' }
    const other: TestAccount = { userId: '3', nickname: 'B' }
    const result = rebindAccountIdentity([other, stale, active], active, '1', '2')
    expect(result.rebind).toBe(true)
    expect(result.accounts.map((a) => a.userId)).toEqual(['3', '1'])
    expect(result.accounts[1].nickname).toBe('A')
    // 被纠正的正是活跃账号，活跃标识随之改为 Cookie 的真实 userId
    expect(result.activeUserId).toBe('1')
  })

  it('账号不在列表中时补入', () => {
    const account: TestAccount = { userId: '9', nickname: 'X' }
    const result = rebindAccountIdentity([], account, '10', '')
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0].userId).toBe('10')
  })
})
