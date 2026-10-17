/**
 * 澜音 Ceru v2 内置兼容模块
 *
 * 澜音插件通过 `ctx.modules.require(name)`（或打包后残留的 `require(name)`）访问宿主内建模块。
 * 本文件实现这些模块的宿主侧替身，使插件无需把宿主依赖打包进自己的文件即可运行。
 *
 * 参考：https://ceru.docs.shiqianjiang.cn/guide/plugins/v2/runtime.html
 */
import {
  createHash as nodeCreateHash,
  createCipheriv as nodeCreateCipheriv,
  createDecipheriv as nodeCreateDecipheriv,
  publicEncrypt as nodePublicEncrypt,
  randomBytes as nodeRandomBytes,
  randomUUID as nodeRandomUUID,
  constants as cryptoConstants
} from 'crypto'
import zlib from 'zlib'
import { QUALITY_ORDER } from '../types'

/** 宿主支持的内建模块名（与澜音 HOST_MODULE_NAMES 对齐） */
export const HOST_MODULE_NAMES = [
  'ceru',
  '@ceru/http',
  '@ceru/ui',
  '@ceru/socket',
  '@ceru/library',
  '@ceru/account',
  '@ceru/player',
  '@ceru/tools',
  '@ceru/crypto',
  '@ceru/compression',
  '@ceru/encoding',
  '@ceru/legacy-http',
  'lodash'
] as const

export type HostModuleName = (typeof HOST_MODULE_NAMES)[number]

/** 判定是否为宿主内建模块名 */
export function resolveBuiltinModuleName(name: string): HostModuleName | null {
  return (HOST_MODULE_NAMES as readonly string[]).includes(name) ? (name as HostModuleName) : null
}

// ==================== Lodash 子集 ====================

/** 澜音宿主允许使用的 Lodash 方法（与 LODASH_METHODS 对齐） */
export const LODASH_METHODS = [
  'chunk',
  'compact',
  'concat',
  'difference',
  'drop',
  'dropRight',
  'flatten',
  'flattenDeep',
  'head',
  'last',
  'intersection',
  'uniq',
  'uniqBy',
  'union',
  'zip',
  'take',
  'takeRight',
  'groupBy',
  'keyBy',
  'countBy',
  'orderBy',
  'sortBy',
  'partition',
  'shuffle',
  'sample',
  'map',
  'filter',
  'find',
  'some',
  'every',
  'reduce',
  'includes',
  'get',
  'has',
  'pick',
  'omit',
  'mapKeys',
  'mapValues',
  'cloneDeep',
  'isEqual',
  'isEmpty',
  'isNil',
  'isString',
  'isNumber',
  'isArray',
  'isPlainObject',
  'camelCase',
  'kebabCase',
  'snakeCase',
  'startCase',
  'capitalize',
  'escape',
  'unescape',
  'trim',
  'truncate',
  'debounce',
  'throttle',
  'once',
  'memoize',
  'clamp',
  'range',
  'sum',
  'sumBy',
  'round'
] as const

/** 将 iteratee（函数 / 属性名 / 属性路径）归一为取值函数 */
function toIteratee(iteratee: any): (value: any, ...rest: any[]) => any {
  if (typeof iteratee === 'function') return iteratee
  if (typeof iteratee === 'string') {
    const path = iteratee.split('.')
    return (value: any) => getPath(value, path)
  }
  if (Array.isArray(iteratee)) {
    return (value: any) => getPath(value, iteratee as (string | number)[])
  }
  return (value: any) => value
}

/** 按路径取值（支持 a.b[0].c 与数组/字符串路径） */
export function getPath(value: any, path: (string | number)[]): any {
  let cur = value
  for (const seg of path) {
    if (cur == null) return undefined
    cur = cur[seg as any]
  }
  return cur
}

/** 解析 'a.b[0].c' 形式的路径 */
function toPath(path: string | (string | number)[]): (string | number)[] {
  if (Array.isArray(path)) return path
  const result: (string | number)[] = []
  for (const part of String(path).split('.')) {
    const re = /([^[\]]+)|\[(\d+)\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(part))) {
      if (m[1] != null && m[1] !== '') result.push(m[1])
      else if (m[2] != null) result.push(Number(m[2]))
    }
  }
  return result
}

/** 深拷贝（结构化 JSON 兼容值） */
function deepClone<T>(value: T, seen = new WeakMap<object, any>()): T {
  if (value === null || typeof value !== 'object') return value
  const obj = value as unknown as object
  const cached = seen.get(obj)
  if (cached) return cached as T
  if (Array.isArray(value)) {
    const arr: any[] = []
    seen.set(obj, arr)
    for (const item of value) arr.push(deepClone(item, seen))
    return arr as unknown as T
  }
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T
  const out: Record<string, any> = {}
  seen.set(obj, out)
  for (const key of Object.keys(value as Record<string, any>)) {
    out[key] = deepClone((value as Record<string, any>)[key], seen)
  }
  return out as unknown as T
}

/** 深比较 */
function deepEqual(a: any, b: any, seen = new WeakMap<object, Set<object>>()): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return a !== a && b !== b
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const ao = a as object
  const bo = b as object
  const seenFor = seen.get(ao)
  if (seenFor?.has(bo)) return true
  if (seenFor) seenFor.add(bo)
  else seen.set(ao, new Set([bo]))

  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const key of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!deepEqual(a[key], b[key], seen)) return false
  }
  return true
}

function isPlainObjectValue(value: any): boolean {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function words(value: string): string[] {
  return String(value)
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9\u4e00-\u9fa5]+/)
    .filter(Boolean)
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}
const HTML_UNESCAPES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'"
}

/** 构造 Lodash 子集（仅澜音允许的方法） */
export function createLodashSubset(): Record<string, any> {
  const groupBy = (collection: any, iteratee?: any): Record<string, any[]> => {
    const fn = toIteratee(iteratee)
    const out: Record<string, any[]> = {}
    for (const item of Object.values(collection ?? {})) {
      const key = String(fn(item))
      ;(out[key] ||= []).push(item)
    }
    return out
  }

  return {
    // ---- 数组 ----
    chunk: (array: any[], size = 1) => {
      const n = Math.max(1, Math.floor(size) || 1)
      const out: any[][] = []
      for (let i = 0; i < (array?.length ?? 0); i += n) out.push(array.slice(i, i + n))
      return out
    },
    compact: (array: any[]) => (array ?? []).filter(Boolean),
    concat: (...args: any[]) => {
      const base = Array.isArray(args[0]) ? [...args[0]] : args[0] === undefined ? [] : [args[0]]
      for (let i = 1; i < args.length; i++) {
        const v = args[i]
        if (Array.isArray(v)) base.push(...v)
        else base.push(v)
      }
      return base
    },
    difference: (array: any[], ...values: any[]) => {
      const set = new Set(values.flat())
      return (array ?? []).filter((v) => !set.has(v))
    },
    drop: (array: any[], n = 1) => (array ?? []).slice(n),
    dropRight: (array: any[], n = 1) =>
      n <= 0 ? [...(array ?? [])] : (array ?? []).slice(0, Math.max(0, array.length - n)),
    flatten: (array: any[]) => (array ?? []).flat(1),
    flattenDeep: (array: any[]) => (array ?? []).flat(Infinity),
    head: (array: any[]) => (array ?? [])[0],
    last: (array: any[]) => {
      const a = array ?? []
      return a[a.length - 1]
    },
    intersection: (array: any[], ...values: any[]) => {
      const sets = values.map((v) => new Set(v))
      return [...new Set(array ?? [])].filter((v) => sets.every((s) => s.has(v)))
    },
    uniq: (array: any[]) => [...new Set(array ?? [])],
    uniqBy: (array: any[], iteratee?: any) => {
      const fn = toIteratee(iteratee)
      const seen = new Set<any>()
      const out: any[] = []
      for (const item of array ?? []) {
        const key = fn(item)
        if (!seen.has(key)) {
          seen.add(key)
          out.push(item)
        }
      }
      return out
    },
    union: (...arrays: any[][]) => [...new Set(arrays.flat())],
    zip: (...arrays: any[][]) => {
      const len = Math.max(0, ...arrays.map((a) => a?.length ?? 0))
      return Array.from({ length: len }, (_, i) => arrays.map((a) => (a ?? [])[i]))
    },
    take: (array: any[], n = 1) => (array ?? []).slice(0, Math.max(0, n)),
    takeRight: (array: any[], n = 1) => (n <= 0 ? [] : (array ?? []).slice(-n)),

    // ---- 集合 ----
    groupBy,
    keyBy: (collection: any, iteratee?: any) => {
      const fn = toIteratee(iteratee)
      const out: Record<string, any> = {}
      for (const item of Object.values(collection ?? {})) out[String(fn(item))] = item
      return out
    },
    countBy: (collection: any, iteratee?: any) => {
      const fn = toIteratee(iteratee)
      const out: Record<string, number> = {}
      for (const item of Object.values(collection ?? {})) {
        const key = String(fn(item))
        out[key] = (out[key] ?? 0) + 1
      }
      return out
    },
    orderBy: (collection: any, iteratees: any = [], orders: any = []) => {
      const fns = (Array.isArray(iteratees) ? iteratees : [iteratees]).map(toIteratee)
      const dirs = Array.isArray(orders) ? orders : [orders]
      return [...Object.values(collection ?? {})].sort((a, b) => {
        for (let i = 0; i < fns.length; i++) {
          const av = fns[i](a)
          const bv = fns[i](b)
          let cmp = 0
          if (av < bv) cmp = -1
          else if (av > bv) cmp = 1
          if (cmp !== 0) return dirs[i] === 'desc' ? -cmp : cmp
        }
        return 0
      })
    },
    sortBy: (collection: any, iteratees: any = []) => {
      const fns = (Array.isArray(iteratees) ? iteratees : [iteratees]).map(toIteratee)
      return [...Object.values(collection ?? {})].sort((a, b) => {
        for (const fn of fns) {
          const av = fn(a)
          const bv = fn(b)
          if (av < bv) return -1
          if (av > bv) return 1
        }
        return 0
      })
    },
    partition: (collection: any, iteratee?: any) => {
      const fn = toIteratee(iteratee)
      const yes: any[] = []
      const no: any[] = []
      for (const item of Object.values(collection ?? {})) (fn(item) ? yes : no).push(item)
      return [yes, no]
    },
    shuffle: (collection: any) => {
      const arr = [...Object.values(collection ?? {})]
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
      }
      return arr
    },
    sample: (collection: any) => {
      const arr = Object.values(collection ?? {})
      return arr[Math.floor(Math.random() * arr.length)]
    },
    map: (collection: any, iteratee?: any) => {
      const fn = toIteratee(iteratee)
      return Object.values(collection ?? {}).map((item, i) => fn(item, i))
    },
    filter: (collection: any, predicate?: any) => {
      const fn = toIteratee(predicate)
      return Object.values(collection ?? {}).filter((item) => fn(item))
    },
    find: (collection: any, predicate?: any) => {
      const fn = toIteratee(predicate)
      return Object.values(collection ?? {}).find((item) => fn(item))
    },
    some: (collection: any, predicate?: any) => {
      const fn = toIteratee(predicate)
      return Object.values(collection ?? {}).some((item) => fn(item))
    },
    every: (collection: any, predicate?: any) => {
      const fn = toIteratee(predicate)
      return Object.values(collection ?? {}).every((item) => fn(item))
    },
    reduce: (collection: any, iteratee: any, accumulator?: any, ...rest: any[]) => {
      const values = Object.values(collection ?? {})
      const fn =
        typeof iteratee === 'function'
          ? iteratee
          : (_acc: any, v: any) => getPath(v, toPath(iteratee))
      const hasAcc = accumulator !== undefined || rest.length > 0
      if (!hasAcc && values.length === 0) return undefined
      let acc = hasAcc ? accumulator : values.shift()
      for (const v of values) acc = fn(acc, v)
      return acc
    },
    includes: (collection: any, value: any, fromIndex = 0) => {
      if (typeof collection === 'string') return collection.includes(String(value), fromIndex)
      return Object.values(collection ?? {}).includes(value, fromIndex)
    },

    // ---- 对象 ----
    get: (object: any, path: any, defaultValue?: any) => {
      const value = getPath(object, toPath(path))
      return value === undefined ? defaultValue : value
    },
    has: (object: any, path: any) => getPath(object, toPath(path)) !== undefined,
    pick: (object: any, ...paths: any[]) => {
      const out: Record<string, any> = {}
      for (const p of paths.flat()) out[String(p)] = object?.[p]
      return out
    },
    omit: (object: any, ...paths: any[]) => {
      const drop = new Set(paths.flat().map(String))
      const out: Record<string, any> = {}
      for (const key of Object.keys(object ?? {})) if (!drop.has(key)) out[key] = object[key]
      return out
    },
    mapKeys: (object: any, iteratee?: any) => {
      const fn = toIteratee(iteratee)
      const out: Record<string, any> = {}
      for (const [key, value] of Object.entries(object ?? {})) out[String(fn(value, key))] = value
      return out
    },
    mapValues: (object: any, iteratee?: any) => {
      const fn = toIteratee(iteratee)
      const out: Record<string, any> = {}
      for (const [key, value] of Object.entries(object ?? {})) out[key] = fn(value, key)
      return out
    },
    cloneDeep: (value: any) => deepClone(value),
    isEqual: (a: any, b: any) => deepEqual(a, b),
    isEmpty: (value: any) => {
      if (value == null) return true
      if (typeof value === 'string' || Array.isArray(value)) return value.length === 0
      if (value instanceof Map || value instanceof Set) return value.size === 0
      if (typeof value === 'object') return Object.keys(value).length === 0
      return true
    },
    isNil: (value: any) => value == null,
    isString: (value: any) => typeof value === 'string',
    isNumber: (value: any) => typeof value === 'number',
    isArray: (value: any) => Array.isArray(value),
    isPlainObject: (value: any) => isPlainObjectValue(value),

    // ---- 字符串 ----
    camelCase: (value: any) =>
      words(value)
        .map((w, i) =>
          i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        )
        .join(''),
    kebabCase: (value: any) =>
      words(value)
        .map((w) => w.toLowerCase())
        .join('-'),
    snakeCase: (value: any) =>
      words(value)
        .map((w) => w.toLowerCase())
        .join('_'),
    startCase: (value: any) =>
      words(value)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' '),
    capitalize: (value: any) => {
      const s = String(value ?? '')
      return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
    },
    escape: (value: any) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]),
    unescape: (value: any) =>
      String(value ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (m) => HTML_UNESCAPES[m]),
    trim: (value: any, chars?: string) => {
      const s = String(value ?? '')
      if (!chars) return s.trim()
      const set = new Set(chars.split(''))
      let start = 0
      let end = s.length
      while (start < end && set.has(s[start])) start++
      while (end > start && set.has(s[end - 1])) end--
      return s.slice(start, end)
    },
    truncate: (value: any, options: any = {}) => {
      const s = String(value ?? '')
      const length = options.length ?? 30
      const omission = options.omission ?? '...'
      if (s.length <= length) return s
      return s.slice(0, Math.max(0, length - omission.length)) + omission
    },

    // ---- 函数 ----
    debounce: (fn: any, wait = 0, options: any = {}) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let lastArgs: any[] = []
      const invoke = (): void => {
        timer = null
        fn(...lastArgs)
      }
      const debounced = (...args: any[]): void => {
        lastArgs = args
        if (options.leading && !timer) fn(...args)
        if (timer) clearTimeout(timer)
        timer = setTimeout(invoke, wait)
      }
      debounced.cancel = () => {
        if (timer) clearTimeout(timer)
        timer = null
      }
      return debounced
    },
    throttle: (fn: any, wait = 0) => {
      let last = 0
      let timer: ReturnType<typeof setTimeout> | null = null
      let lastArgs: any[] = []
      return (...args: any[]) => {
        const now = Date.now()
        lastArgs = args
        if (now - last >= wait) {
          last = now
          fn(...args)
        } else if (!timer) {
          timer = setTimeout(
            () => {
              last = Date.now()
              timer = null
              fn(...lastArgs)
            },
            wait - (now - last)
          )
        }
      }
    },
    once: (fn: any) => {
      let called = false
      let result: any
      return (...args: any[]) => {
        if (!called) {
          called = true
          result = fn(...args)
        }
        return result
      }
    },
    memoize: (fn: any, resolver?: any) => {
      const cache = new Map<any, any>()
      const memoized = (...args: any[]): any => {
        const key = resolver ? resolver(...args) : args[0]
        if (cache.has(key)) return cache.get(key)
        const result = fn(...args)
        cache.set(key, result)
        return result
      }
      memoized.cache = cache
      return memoized
    },

    // ---- 数学 ----
    clamp: (value: number, lower?: number, upper?: number) => {
      if (upper === undefined) {
        upper = lower
        lower = undefined
      }
      let v = value
      if (upper !== undefined && v > upper) v = upper
      if (lower !== undefined && v < lower) v = lower
      return v
    },
    range: (start: number, end?: number, step = 1) => {
      let from = 0
      let to = start
      if (end !== undefined) {
        from = start
        to = end
      }
      const out: number[] = []
      if (step === 0) return out
      if (step > 0) for (let i = from; i < to; i += step) out.push(i)
      else for (let i = from; i > to; i += step) out.push(i)
      return out
    },
    sum: (array: any[]) => (array ?? []).reduce((acc, v) => acc + (Number(v) || 0), 0),
    sumBy: (array: any[], iteratee?: any) => {
      const fn = toIteratee(iteratee)
      return (array ?? []).reduce((acc, v) => acc + (Number(fn(v)) || 0), 0)
    },
    round: (value: number, precision = 0) => {
      const factor = 10 ** precision
      return Math.round(value * factor) / factor
    }
  }
}

// ==================== SDK 替身 ====================

/**
 * 构造 `@shiqianjiang/ceru-plugin-sdk` 的宿主侧替身。
 * 其中的校验断言在宿主内不再需要，退化为空实现；入口包装函数原样返回参数。
 */
export function createSdkStub(): Record<string, any> {
  return {
    definePlugin: (entry: any) => entry,
    defineSurface: (entry: any) => entry,
    defineGuestAdapter: (entry: any) => entry,
    defineManifest: (manifest: any) => manifest,
    definePluginConfig: (config: any) => config,
    defineUISchema: (schema: any) => schema,
    defineNativeView: (render: any) => render,

    // 校验类：宿主已完成校验，此处退化为空操作
    assertNativeView: () => undefined,
    assertAccountSummary: () => undefined,
    assertNavigationRequest: () => undefined,
    assertResourceRef: () => undefined,
    assertContentPage: () => undefined,
    assertResolveResult: () => undefined,
    assertLyricsDocument: () => undefined,
    assertRemovableTracks: () => undefined,

    retargetTrackRef: (ref: any, pluginId: string) => ({ ...ref, pluginId }),
    hostIcon: (name: string) => ({ kind: 'host', name }),
    /** 构造播放失败结果 */
    failure: (error: any) => ({ ok: false, error: { retryable: false, ...error } }),
    networkPermissionKey: (origin: string) => `network:${origin}`,

    /** 以 manifest 声明的音质顺序（低 → 高）比较音质 */
    compareQualities: (order: readonly string[], a: string, b: string) => {
      const list = order?.length ? order : QUALITY_ORDER
      const ia = list.indexOf(a)
      const ib = list.indexOf(b)
      if (ia === -1 || ib === -1) return undefined
      return ia === ib ? 0 : ia < ib ? -1 : 1
    },
    /** 在可用音质中挑选不高于 requested 的最优项 */
    selectQuality: (
      order: readonly string[],
      available?: readonly string[],
      requested?: string
    ) => {
      const list = order?.length ? order : QUALITY_ORDER
      const pool = available?.length ? list.filter((q) => available.includes(q)) : [...list]
      if (!pool.length) return undefined
      if (!requested) return pool[pool.length - 1]
      const idx = list.indexOf(requested)
      if (idx === -1) return pool[pool.length - 1]
      for (let i = idx; i >= 0; i--) if (pool.includes(list[i])) return list[i]
      for (let i = idx + 1; i < list.length; i++) if (pool.includes(list[i])) return list[i]
      return pool[pool.length - 1]
    }
  }
}

// ==================== 加密 / 压缩 / 编码 / 旧版 HTTP ====================

/** `@ceru/crypto`：基于 Node crypto 的兼容实现 */
export function createCryptoModule(realm?: HostRealm): Record<string, any> {
  const out = (bytes: Buffer): any => (realm ? realm.toBytes(bytes) : bytes)
  /** ECB 不接受 IV，其余模式统一归一为 Buffer */
  const normalizeIv = (mode: string, iv: any): Buffer | null =>
    /-ecb$/i.test(String(mode)) ? null : toBuffer(iv ?? [])

  const createCipher = (mode: any, key: any, iv: any, decrypt: boolean): Record<string, any> => {
    const cipher = decrypt
      ? nodeCreateDecipheriv(String(mode), toBuffer(key), normalizeIv(String(mode), iv) as any)
      : nodeCreateCipheriv(String(mode), toBuffer(key), normalizeIv(String(mode), iv) as any)
    return {
      update(value: any): any {
        return out(cipher.update(toBuffer(value)))
      },
      final(): any {
        return out(cipher.final())
      }
    }
  }

  const mod = {
    createHash: (name: any) => {
      const hash = nodeCreateHash(String(name))
      return {
        update(value: any) {
          hash.update(toBuffer(value))
          return this
        },
        /** 无 encoding 时返回字节（SDK 行为：`digest()` → Buffer） */
        digest(encoding?: any): any {
          const digest = hash.digest()
          if (typeof encoding === 'string') return digest.toString(encoding as BufferEncoding)
          return out(digest)
        }
      }
    },
    createCipheriv: (mode: any, key: any, iv: any) => createCipher(mode, key, iv, false),
    createDecipheriv: (mode: any, key: any, iv: any) => createCipher(mode, key, iv, true),
    publicEncrypt: (options: any, value: any) => out(nodePublicEncrypt(options, toBuffer(value))),
    randomBytes: (size: any) => out(nodeRandomBytes(Number(size) || 1)),
    randomUUID: () => nodeRandomUUID(),
    constants: {
      ...cryptoConstants,
      RSA_NO_PADDING: cryptoConstants.RSA_NO_PADDING
    }
  }
  return { ...mod, default: mod }
}

/** `@ceru/compression`：zlib 兼容实现 */
export function createCompressionModule(): Record<string, any> {
  const mod = {
    inflate: (input: any, callback: any) => {
      zlib.inflate(toBuffer(input), (err, out) => callback?.(err, out))
    },
    unzipSync: (input: any) => zlib.unzipSync(toBuffer(input)),
    deflateSync: (input: any) => zlib.deflateSync(toBuffer(input)),
    inflateSync: (input: any) => zlib.inflateSync(toBuffer(input))
  }
  return { ...mod, default: mod }
}

/**
 * `@ceru/encoding`：字节/字符编码转换。
 * `decode` 优先走 TextDecoder —— Node 的 `Buffer#toString` 不支持 gbk / gb18030 / big5
 * 等编码，而旧版洛雪音源大量使用 `decode(buf, 'gb18030')`。
 */
export function createEncodingModule(): Record<string, any> {
  const decode = (bytes: any, encoding?: any): string => {
    const buf = toBuffer(bytes)
    const label = String(encoding ?? 'utf-8')
    try {
      return new TextDecoder(label).decode(buf)
    } catch {
      return buf.toString(label as BufferEncoding)
    }
  }
  const encode = (text: any, encoding?: any): Buffer => {
    const label = String(encoding ?? 'utf-8')
    try {
      return Buffer.from(String(text), label as BufferEncoding)
    } catch {
      throw new Error(`澜音编码模块不支持编码「${label}」`)
    }
  }
  const mod = {
    decode,
    encode,
    hex: (bytes: any) => toBuffer(bytes).toString('hex'),
    base64: (bytes: any) => toBuffer(bytes).toString('base64')
  }
  return { ...mod, default: mod }
}

/**
 * 把宿主侧 Buffer 转成插件 realm（vm 上下文）内的 Uint8Array。
 *
 * 插件打包产物自带一份 `buffer` polyfill，其 `Buffer.concat` 用
 * `instanceof Uint8Array` 判断入参——跨 vm 上下文时宿主的 Buffer 会判定失败并抛
 * `"list" argument must be an Array of Buffers`。因此凡是「由宿主产出、又被插件
 * 喂回 polyfill」的字节，都要转成插件 realm 的对象。
 */
export interface HostRealm {
  toBytes(bytes: Buffer): any
}

/** `toBuffer`：把任意字节形态归一为宿主 Buffer（兼容跨 realm 的 TypedArray） */
function toBuffer(input: any): Buffer {
  if (Buffer.isBuffer(input)) return input
  if (ArrayBuffer.isView(input)) return Buffer.from(input as Uint8Array)
  if (typeof input === 'string') return Buffer.from(input)
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  if (Array.isArray(input)) return Buffer.from(input)
  return Buffer.from(input ?? [])
}

/** `@ceru/legacy-http` 的请求选项（洛雪/旧版插件风格） */
export interface LegacyHttpOptions {
  method?: string
  headers?: Record<string, unknown>
  /** application/x-www-form-urlencoded 表单 */
  form?: Record<string, unknown>
  /** 原始请求体（字符串原样发送，其它值按 JSON 序列化） */
  body?: unknown
  timeout?: number
  [key: string]: unknown
}

/** `@ceru/legacy-http` 依赖的宿主能力 */
export interface LegacyHttpDeps {
  /** 宿主的 HTTP 请求实现（`ctx.http.request` 语义） */
  request: (input: any) => Promise<any>
  /** 网络权限申请 */
  authorize: (permissionKey: string, origin: string) => Promise<void>
  /** 插件未包在 `withOperation` 内时兜底的操作上下文 */
  createOperation?: () => any
}

/** 不应从插件侧透传的请求头 */
const LEGACY_FORBIDDEN_HEADERS =
  /^(host|connection|content-length|transfer-encoding|accept-encoding|proxy-.*|upgrade)$/i

/** 解析响应文本：剥掉 JSONP 包裹后尝试 JSON，失败则保留原文（歌词/HTML） */
function parseLegacyBody(text: unknown): any {
  if (typeof text !== 'string') return text
  const content = text.trim().replace(/^[\w.$]+\s*\((\{[\s\S]*\})\)\s*;?$/, '$1')
  try {
    return JSON.parse(content)
  } catch {
    return text
  }
}

/**
 * `@ceru/legacy-http`：旧版 HTTP 风格桥接。
 *
 * 与官方 SDK `createLegacyHttpBridge` 保持一致：
 * - `httpFetch(address, options)` 同步返回 `{ promise, cancelHttp }`；
 * - `withOperation(operation, work)` 串行化顶层适配器调用（旧适配器带可变分页状态）；
 * - `ensurePermission(key, origin, operation)` / `permissionKey()`（固定 `network`）。
 */
export function createLegacyHttpModule(deps: LegacyHttpDeps): Record<string, any> {
  return {
    createLegacyHttpBridge(host?: any): Record<string, any> {
      const request = (input: any): Promise<any> =>
        typeof host?.http?.request === 'function' ? host.http.request(input) : deps.request(input)

      let current: any
      let depth = 0
      let queue: Promise<any> = Promise.resolve()

      const permissionKey = (): string => 'network'

      const ensurePermission = async (key: string, origin: string): Promise<void> => {
        await deps.authorize(key || permissionKey(), origin)
      }

      const withOperation = <T>(operation: any, work: () => Promise<T>): Promise<T> => {
        // 嵌套调用直接执行，避免等待自身队列造成死锁
        if (depth > 0) {
          return (async () => {
            operation?.signal?.throwIfAborted?.()
            depth++
            try {
              return await work()
            } finally {
              depth--
            }
          })() as Promise<T>
        }
        const result = queue.then(async () => {
          operation?.signal?.throwIfAborted?.()
          current = operation
          depth++
          try {
            return await work()
          } finally {
            depth--
            current = undefined
          }
        })
        queue = result.catch(() => undefined)
        return result as Promise<T>
      }

      const httpFetch = (address: string, options: LegacyHttpOptions = {}) => {
        const operation = current ?? deps.createOperation?.()
        let cancelled = false

        const promise = (async () => {
          if (!operation) {
            throw new Error('澜音 legacy httpFetch 缺少操作上下文（请在 withOperation 内调用）')
          }
          operation?.signal?.throwIfAborted?.()
          const url = new URL(address)
          await ensurePermission(permissionKey(), url.origin)
          if (cancelled) throw new Error('请求已取消')

          const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0' }
          for (const [name, value] of Object.entries(options.headers ?? {})) {
            if (value != null && !LEGACY_FORBIDDEN_HEADERS.test(name)) headers[name] = String(value)
          }

          let body: string | undefined
          if (options.form) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
            body = new URLSearchParams(
              Object.entries(options.form).map(([k, v]) => [k, String(v)])
            ).toString()
          } else if (options.body != null) {
            if (typeof options.body === 'string') {
              body = options.body
            } else {
              body = JSON.stringify(options.body)
              headers['Content-Type'] = 'application/json'
            }
          }

          const send = (target: URL, method: string, withBody: boolean): Promise<any> =>
            request({
              permissionKey: permissionKey(),
              url: target.href,
              method,
              headers,
              body: withBody ? body : undefined,
              timeoutMs: Number(options.timeout) || undefined,
              operation,
              // 旧版桥接自行处理状态码（含 3xx 跳转）
              throwOnError: false
            })

          let response = await send(url, (options.method ?? 'GET').toUpperCase(), true)
          const firstLocation = response?.headers?.location

          // 跟随公开跳转（最多 4 次），每次重新申请目标域权限
          for (
            let count = 0;
            response?.status >= 300 && response?.status < 400 && response.headers?.location;
            count++
          ) {
            if (count >= 4) throw new Error('平台重定向次数过多')
            const next = new URL(String(response.headers.location), url)
            if (!['http:', 'https:'].includes(next.protocol)) {
              throw new Error('平台重定向协议不受支持')
            }
            await ensurePermission(permissionKey(), next.origin)
            response = await send(next, 'GET', false)
            url.href = next.href
          }

          operation?.signal?.throwIfAborted?.()
          if (cancelled) throw new Error('请求已取消')
          if (Number(response?.status) >= 400) {
            throw new Error(`${url.hostname} 返回 HTTP ${response.status}`)
          }

          return {
            body: parseLegacyBody(response?.body),
            statusCode: Number(response?.status) || 0,
            headers: {
              ...(response?.headers ?? {}),
              ...(firstLocation ? { location: url.href } : {})
            },
            raw: response?.body,
            url: url.href
          }
        })()

        return {
          promise,
          cancelHttp(): void {
            cancelled = true
          }
        }
      }

      return { httpFetch, withOperation, ensurePermission, permissionKey }
    }
  }
}
