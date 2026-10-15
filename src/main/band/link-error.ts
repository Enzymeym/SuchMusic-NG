/**
 * SuchMusic 手环通信 · 链路失败分类（Windows 端 · 纯逻辑）
 *
 * 背景：Windows 只能经手机中继连接（§4.3）。握手失败在传输层表现为
 * 「WS 升级被拒 / 连接被拒 / 会话中断」，但**错误码只有 E_LINK 一种**（§3.7 冻结），
 * 用户无法据此判断到底是「中继没开」「地址写错」还是「令牌不对」。
 *
 * 本模块把这些传输层信号（HTTP 状态码 / WS 关闭码 / 底层错误消息 / 发生阶段）
 * 映射为**可操作的中文提示**，供 UI 展示（对应 §4.3「排查顺序」）。
 *
 * 重要事实（实测 Node 22 / Electron 主进程的全局 `WebSocket`，undici 实现）：
 * - **升级前**失败（连接被拒、HTTP 401/403/404 拒绝升级）→ 只触发一次 `error`，
 *   `error.message` 恒为 `Received network error or non-101 status code.`，**不暴露 HTTP 状态码**，
 *   且**不触发 `close` 事件**、`readyState` 停留在 CONNECTING；
 * - **升级后**失败（101 之后）→ 正常触发 `close`，可拿到 WS 关闭码。
 *
 * 因此：401/403/404 仅在传输层能提供 `httpStatus`（含单测注入）时可精确区分；
 * 否则退化为 `unreachable`（「连接未建立」综合排查提示）。分类结果**不含任何令牌内容**。
 *
 * 约束：纯函数、无副作用、无 Electron 依赖，可直接在 Node 下单测。
 */

/** 失败发生的阶段。 */
export type LinkFailurePhase = 'connect' | 'handshake' | 'session'

/** 传输层可提供的失败信号（全部可选，缺失即退化）。 */
export interface LinkFailureSignal {
  /** HTTP 状态码（若传输层可得：401 / 403 / 404 …）。 */
  httpStatus?: number
  /** WebSocket 关闭码（1006 异常 / 1008 策略关闭 …）。 */
  closeCode?: number
  /** WebSocket 关闭原因（服务端提供，可能为空）。 */
  closeReason?: string
  /** 底层错误消息（如 undici 的 non-101 文案）。 */
  errorMessage?: string
}

/** 分类输入：失败信号 + 阶段。 */
export interface LinkFailureInput extends LinkFailureSignal {
  phase: LinkFailurePhase
}

/** 失败的语义分类。 */
export type LinkFailureKind =
  /** 令牌缺失 / 错误（HTTP 401）。 */
  | 'token_rejected'
  /** 非局域网来源被拒（HTTP 403）。 */
  | 'non_private_source'
  /** 地址 / 路径错误（HTTP 404）。 */
  | 'path_not_found'
  /** 升级后握手被拒（如 5s 内未 `sys.hello` → 1008）。 */
  | 'handshake_rejected'
  /** 连接未建立（被拒 / 无监听 / 非 101 …，无法进一步区分）。 */
  | 'unreachable'
  /** 会话中链路中断。 */
  | 'session_lost'
  /** 其它未知异常。 */
  | 'unknown'

/** 分类结果。 */
export interface LinkFailureInfo {
  kind: LinkFailureKind
  /** 简短标题（用于 UI 标签 / 日志前缀）。 */
  title: string
  /** 可操作的中文提示（**不含令牌**）。 */
  hint: string
}

/** 可操作提示文案（集中管理，避免各处硬编码）。 */
const HINTS: Readonly<Record<LinkFailureKind, { title: string; hint: string }>> = {
  token_rejected: {
    title: '令牌校验失败',
    hint:
      '令牌错误：请核对手机端「手环 → 电脑控制（局域网）」显示的会话令牌；' +
      '重启中继后令牌会轮换，需重新复制并保存后再连接。'
  },
  non_private_source: {
    title: '来源被拒绝',
    hint:
      '来源被拒：手机端只接受同一局域网内的电脑连接；' +
      '请确认手机与电脑在同一 Wi-Fi / 网段，并关闭路由器的「AP 隔离 / 访客网络」。'
  },
  path_not_found: {
    title: '地址 / 路径错误',
    hint: '地址或路径错误：请核对手机上显示的 IP、端口（默认 8787）与 WebSocket 路径（默认 /suchmusic）。'
  },
  handshake_rejected: {
    title: '握手超时',
    hint: '握手超时：连接已建立但 5 秒内未完成 sys.hello，请检查网络稳定性或手机端中继是否被关闭。'
  },
  unreachable: {
    title: '无法连接到手机端',
    hint:
      '无法连接到手机端：请依次检查 ① 手机端已开启「电脑控制（局域网）」中继；' +
      '② 手机与电脑处于同一局域网；③ 填写的是手机上显示的 IP / 端口 / 路径；④ 会话令牌与手机端一致。'
  },
  session_lost: {
    title: '链路已断开',
    hint: '链路已断开：手机端中继可能被关闭或网络中断，将自动重连。'
  },
  unknown: {
    title: '链路异常',
    hint: '链路异常：请查看手机端中继状态与本面板「运行日志」。'
  }
}

/** 判断底层消息是否属于「连接未建立」类（被拒 / 网络不可达 / DNS 失败）。 */
function looksLikeUnreachable(message?: string): boolean {
  if (!message) return false
  return /non-101|network error|ECONNREFUSED|refused|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|getaddrinfo/i.test(
    message
  )
}

function info(kind: LinkFailureKind): LinkFailureInfo {
  const { title, hint } = HINTS[kind]
  return { kind, title, hint }
}

/**
 * 把传输层失败信号归类为可操作提示（纯函数）。
 *
 * 优先级：HTTP 状态码（最精确）→ 会话中断 → 握手关闭码 → 连接未建立 → 未知。
 */
export function classifyLinkFailure(input: LinkFailureInput): LinkFailureInfo {
  const { phase, httpStatus, closeCode, errorMessage } = input

  // 1) 传输层给出 HTTP 状态码（升级被拒）：可精确区分。
  if (typeof httpStatus === 'number') {
    switch (httpStatus) {
      case 401:
        return info('token_rejected')
      case 403:
        return info('non_private_source')
      case 404:
        return info('path_not_found')
      default:
        if (httpStatus >= 400) return info('handshake_rejected')
    }
  }

  // 2) 会话中掉线：只提示「已断开、将重连」，不误报为配置错误。
  if (phase === 'session') return info('session_lost')

  // 3) 升级后被服务端以策略码关闭（手机端 5s 未收到 sys.hello → 1008）。
  if (closeCode === 1008) return info('handshake_rejected')

  // 4) 升级前失败：undici 只给统一文案，无法区分 401/404/被拒 → 综合排查提示。
  if (phase === 'connect' || closeCode === 1006 || looksLikeUnreachable(errorMessage)) {
    return info('unreachable')
  }

  // 5) 其余情况（如握手阶段无明确信号）：归为未知。
  return info('unknown')
}
