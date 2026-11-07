/**
 * `such.system` / `such.playlist` / `such.utils`
 *
 * 这三块都是「有副作用」或「提供基础能力」的部分，与核心 API 分文件维护。
 * - `system`：执行程序、读写文件、写音频标签 —— 需要 `@grant system`，每次调用确认
 * - `playlist`：歌单操作 —— 需要 `@grant playlist`，走 renderer 往返
 * - `utils`：crypto / buffer / base64 / zlib —— v2 沙箱不注入这些全局，只能从这里拿
 */
import { execFile } from 'node:child_process'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID
} from 'node:crypto'
import { promises as fs, existsSync } from 'node:fs'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import type { SuchApiContext } from './suchApi'
import { requireGrant } from './grant'

const execFileAsync = promisify(execFile)

const EXEC_TIMEOUT_MS = 60_000

/**
 * 把插件传入的「类字节」输入收敛成宿主 Buffer。
 *
 * 跨 vm realm 时 `value instanceof Uint8Array` 为 false，但 `ArrayBuffer.isView`
 * 是规范层面的内部槽检查，跨 realm 依然有效 —— v2 的字节工具全靠它兜底。
 */
function toBuffer(
  input: string | ArrayBuffer | ArrayBufferView | number[] | Buffer,
  encoding: BufferEncoding = 'utf8'
): Buffer {
  if (typeof input === 'string') return Buffer.from(input, encoding)
  if (Buffer.isBuffer(input)) return input
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  }
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  if (Array.isArray(input)) return Buffer.from(input)
  throw new Error('需要 string / ArrayBuffer / TypedArray / number[] 类型的字节输入')
}

/** 统一返回字节（Buffer 可被插件当 Uint8Array 用） */
function toBytes(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : toBuffer(value as any)
}

export function buildSystemApi(ctx: SuchApiContext): Record<string, any> {
  const confirmOrThrow = async (
    operation: Parameters<SuchApiContext['requestConfirm']>[1],
    detail: string
  ): Promise<void> => {
    const ok = await ctx.requestConfirm(ctx.header.name, operation, detail)
    if (!ok) throw new Error('用户拒绝了该敏感操作')
  }

  const utils = {
    crypto: {
      md5: (data: any) => createHash('md5').update(toBytes(data)).digest('hex'),
      sha1: (data: any) => createHash('sha1').update(toBytes(data)).digest('hex'),
      sha256: (data: any) => createHash('sha256').update(toBytes(data)).digest('hex'),
      hmac: (algo: string, key: any, data: any) =>
        createHmac(String(algo).toLowerCase(), toBytes(key)).update(toBytes(data)).digest('hex'),
      randomBytes: (size: number) => {
        const n = Math.floor(Number(size))
        if (!Number.isFinite(n) || n < 0 || n > 1024 * 1024) {
          throw new Error('randomBytes 的 size 必须是 0 ~ 1MiB 的整数')
        }
        return randomBytes(n)
      },
      aesEncrypt: (data: any, key: any, mode: string, iv?: any) => {
        const cipher = createCipheriv(mode, toBytes(key), iv ? toBytes(iv) : null)
        return Buffer.concat([cipher.update(toBytes(data)), cipher.final()])
      },
      aesDecrypt: (data: any, key: any, mode: string, iv?: any) => {
        const decipher = createDecipheriv(mode, toBytes(key), iv ? toBytes(iv) : null)
        return Buffer.concat([decipher.update(toBytes(data)), decipher.final()])
      }
    },
    buffer: {
      from: (data: any, encoding?: string) => toBuffer(data, (encoding as BufferEncoding) ?? 'utf8'),
      bufToString: (buf: any, encoding?: string) =>
        toBytes(buf).toString((encoding as BufferEncoding) ?? 'utf8'),
      concat: (list: any[]) => Buffer.concat((list ?? []).map((item) => toBytes(item)))
    },
    base64: {
      encode: (data: any) => toBytes(data).toString('base64'),
      decode: (data: string) => Buffer.from(String(data), 'base64').toString('utf-8')
    },
    zlib: {
      deflate: (data: any) => zlib.deflateSync(toBytes(data)),
      inflate: (data: any) => zlib.inflateSync(toBytes(data)),
      gzip: (data: any) => zlib.gzipSync(toBytes(data)),
      gunzip: (data: any) => zlib.gunzipSync(toBytes(data))
    }
  }

  const system = {
    /** 执行本地程序（不经过 shell，避免命令注入） */
    async exec(file: string, args: string[] = [], options?: { timeout?: number }) {
      requireGrant(ctx, 'system')
      if (typeof file !== 'string' || !file.trim()) throw new Error('exec 需要一个程序路径')
      if (!Array.isArray(args)) throw new Error('exec 的 args 必须是字符串数组')
      await confirmOrThrow('exec', `执行程序: ${file} ${args.join(' ')}`.trim())
      const timeout = Math.min(Math.max(options?.timeout ?? EXEC_TIMEOUT_MS, 1000), EXEC_TIMEOUT_MS)
      try {
        const { stdout, stderr } = await execFileAsync(file, args, {
          timeout,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024
        })
        return { code: 0, stdout, stderr }
      } catch (err: any) {
        return {
          code: typeof err?.code === 'number' ? err.code : 1,
          stdout: err?.stdout ?? '',
          stderr: err?.stderr ?? err?.message ?? String(err)
        }
      }
    },

    file: {
      async read(filePath: string) {
        requireGrant(ctx, 'system')
        await confirmOrThrow('fileRead', `读取文件: ${filePath}`)
        return fs.readFile(filePath, 'utf-8')
      },
      async write(filePath: string, content: string) {
        requireGrant(ctx, 'system')
        await confirmOrThrow('fileWrite', `写入文件: ${filePath}`)
        await fs.writeFile(filePath, String(content ?? ''), 'utf-8')
        return true
      },
      async exists(filePath: string) {
        requireGrant(ctx, 'system')
        return existsSync(filePath)
      },
      async listDir(dirPath: string) {
        requireGrant(ctx, 'system')
        return fs.readdir(dirPath)
      },
      async copy(src: string, dest: string) {
        requireGrant(ctx, 'system')
        await confirmOrThrow('fileWrite', `复制文件: ${src} → ${dest}`)
        await fs.copyFile(src, dest)
        return true
      },
      async delete(filePath: string) {
        requireGrant(ctx, 'system')
        await confirmOrThrow('fileDelete', `删除文件: ${filePath}`)
        await fs.unlink(filePath)
        return true
      }
    },

    /** 写入音频标签（标题/歌手/专辑/封面等） */
    async writeMeta(filePath: string, tags: Record<string, unknown>) {
      requireGrant(ctx, 'system')
      await confirmOrThrow('writeMeta', `写入音频标签: ${filePath}`)
      return ctx.writeAudioMeta(filePath, tags)
    }
  }

  const playlist = {
    async create(name: string, tracks?: unknown[]) {
      requireGrant(ctx, 'playlist')
      return callPlaylistOp(ctx, 'createPlaylist', { name, tracks: tracks ?? [] })
    },
    async add(playlistId: string, tracks: unknown[]) {
      requireGrant(ctx, 'playlist')
      return callPlaylistOp(ctx, 'addToPlaylist', { playlistId, tracks })
    },
    async updateSettings(playlistId: string, settings: Record<string, unknown>) {
      requireGrant(ctx, 'playlist')
      return callPlaylistOp(ctx, 'updatePlaylistSettings', { playlistId, ...settings })
    },
    async list() {
      requireGrant(ctx, 'playlist')
      return callPlaylistOp(ctx, 'listPlaylists', {})
    }
  }

  return { utils, system, playlist }
}

async function callPlaylistOp(
  ctx: SuchApiContext,
  action: Parameters<SuchApiContext['playlistOp']>[0]['action'],
  params: Record<string, unknown>
): Promise<unknown> {
  const res = await ctx.playlistOp({
    requestId: randomUUID(),
    pluginId: ctx.pluginId,
    pluginName: ctx.header.name,
    action,
    params
  })
  if (!res.success) throw new Error(res.error || '歌单操作失败')
  return res.result
}
