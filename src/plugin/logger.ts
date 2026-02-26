import path from 'path'
import fsPromise from 'fs/promises'
import { app } from 'electron'

function getAppDirPath(): string {
  return app.getPath('userData')
}

function remove_empty_strings(arr: string[]): string[] {
  return arr.filter((s) => s && s.trim() !== '')
}

function getLogPath(pluginId: string): string {
  return path.join(getAppDirPath(), 'plugins', 'logs', `${pluginId}.txt`)
}

enum WriteMode {
  APPEND,
  OVERWRITE
}

function selectWriteFunc(mode: WriteMode) {
  return async (filePath: string, content: string) => {
    // 简单实现写入
    if (mode === WriteMode.APPEND) {
      await fsPromise.appendFile(filePath, content, 'utf-8')
    } else {
      await fsPromise.writeFile(filePath, content, 'utf-8')
    }
  }
}

async function writeLog(filePath: string, content: string, mode: WriteMode) {
  // 简单实现，忽略锁机制
  try {
    const writer = selectWriteFunc(mode)
    await writer(filePath, content)
  } catch (e) {
    console.error('Write log failed', e)
  }
}

class Logger {
  private readonly logFilePath: string
  constructor(pluginId: string) {
    this.logFilePath = getLogPath(pluginId)
    fsPromise.mkdir(path.dirname(this.logFilePath), { recursive: true }).then()
  }

  log(...args: any[]): void {
    this.write(`log ${parseArgs(args)}\n`)
  }

  info(...args: any[]): void {
    this.write(`info ${parseArgs(args)}\n`)
  }

  warn(...args: any[]): void {
    this.write(`warn ${parseArgs(args)}\n`)
  }

  error(...args: any[]): void {
    this.write(`error ${parseArgs(args)}\n`)
  }

  group(...args: any[]): void {
    args.unshift('groupStart---------')
    this.write(`start ${parseArgs(args)}\n`)
  }
  groupEnd(...args: any[]): void {
    this.write(`end ${parseArgs(args)}\n`)
  }

  private write(msg: string): void {
    writeLog(this.logFilePath, msg, WriteMode.APPEND)
  }
}

function parseArgs(args) {
  return args
    .map((arg) => {
      if (typeof arg === 'object') {
        return JSON.stringify(arg)
      }

      return arg
    })
    .join(' ')
}

async function getLog(pluginId: string) {
  const logFilePath: string = getLogPath(pluginId)
  try {
    const content: string = await fsPromise.readFile(logFilePath, 'utf-8')
    const last200Lines: string[] = remove_empty_strings(content.split('\n')).slice(-200)
    await selectWriteFunc(WriteMode.OVERWRITE)(logFilePath, last200Lines.join('\n'))
    return last200Lines
  } catch {
    return []
  }
}

const pluginLog = new Logger('plugin-system')

export default Logger
export { Logger, getLog, pluginLog }
