# SuchMusic-NG · 手环通信（Windows 端）

> 本文只描述 **Windows 端（Electron + Vue）** 的实现与使用方法。
> 协议字段、方法名、事件名、错误码、分片参数均以设计文档
> `docs/ARCH-手环通信.md` §3 为准，本文不重复定义、也不新增。

---

## 1. 链路原理：为什么必须经手机中转

**手环无法被 Windows 直连**，这是硬约束：

- 手环与手机之间的通信使用小米 `system.interconnect` 通道（手环侧快应用）+ 手机侧官方
  `xms-wearable-lib` SDK；
- 该通道**只对「与手环完成配对、且包名 + 签名完全一致的 Android 伴侣 App」开放**；
- 小米只提供 **Android** 版 SDK，**没有 PC SDK**，也没有面向第三方的「电脑直连手环」BLE 通道。

因此数据必须经手机中转，链路为：

```
手环快应用  ↔  手机 SuchMusic 概念版（局域网 WebSocket 服务端）  ↔  Windows SuchMusic-NG（WebSocket 客户端）
   Vela JS              Flutter + Kotlin WearBridge                     Electron 主进程
```

本仓库只实现**右侧的客户端**部分（`src/main/band/`）；手机侧服务端由另一工程实现，
两端共用同一套信封与消息（`{v,id,type,method|event,payload,ts}`）。

```
Windows(Vue) → preload IPC → main ws-client → 手机 BandWsServer → BandRouter → AudioPlayerService
                    ↑                                                                   │
                    └──────────────── 事件反向推送（player.* / lyric.*） ────────────────┘
```

---

## 2. 代码落点

Windows 端在仓库既有结构内新增，**不重构、不改无关文件**：

| 路径 | 职责 |
|---|---|
| `src/main/band/protocol.ts` | 信封编解码/校验、错误码表、方法与事件清单、版本与能力协商、`PlayMode` 映射、id 生成（**纯逻辑，无 Electron 依赖**） |
| `src/main/band/chunk.ts` | CRC32、`header→data→end` 分片切分与组装、缺片列表（**纯逻辑**） |
| `src/main/band/dedup.ts` | `req.id` LRU(64) 幂等去重（**纯逻辑**） |
| `src/main/band/requests.ts` | 请求-响应登记、超时、同 id 重试策略（**纯逻辑**） |
| `src/main/band/config.ts` | 本地配置读写（`userData/band.json`）、URL 组装（**依赖 electron 的 `app.getPath`**） |
| `src/main/band/ws-client.ts` | WebSocket 连接/重连状态机、握手、请求-响应、事件分发、分片重传 |
| `src/main/band/band-bridge.ts` | WS ↔ IPC 转发，状态/事件推送到渲染进程 |
| `src/main/band/index.ts` | 模块导出入口 |
| `src/main/ipc/band.ts` | IPC 注册（遵循仓库 `src/main/ipc/` 约定） |
| `src/renderer/src/composables/useBand.ts` | Vue 侧订阅状态、派发命令 |
| `src/renderer/src/components/common/Settings/SettingsBandSection.vue` | 最小 UI 入口（设置 → 手环联动） |
| `src/main/band/*.test.ts` | 纯逻辑单元测试（vitest） |

集成点（各 1 行）：

- `src/main/index.ts`：`registerBandHandlers()`
- `src/renderer/src/components/common/SettingsModal.vue`：注册「手环联动」分区

---

## 3. 手机端：开启中继并取得地址 / 令牌

> 手机侧服务端由另一工程实现，此处只说明用户需要做的事。

1. 打开手机 SuchMusic 概念版，进入「设置 → 手环中继」，**开启中继**（默认关闭）。
2. 记下界面显示的 **局域网地址（IP）** 与 **端口**（默认 `8787`），以及 WebSocket 路径
   （默认 `/suchmusic`）。
3. 记下界面显示的 **6 位配对码**；配对成功后手机会签发 **会话令牌**，复制该令牌。
4. 确保**手机与电脑处于同一局域网**（同一 Wi-Fi / 网段），且手机未开启会阻断局域网访问的
   「AP 隔离 / 访客网络」。

---

## 4. Windows 端：连接步骤

1. 打开 Windows 应用 → 右上角 **设置** → 左侧 **手环联动**。
2. 打开 **启用手环联动** 开关。
3. 在 **手机端地址** 中填入：
   - *手机 IP / 主机名*：如 `192.168.1.5`
   - *端口*：`8787`
   - *路径*：`/suchmusic`
   - 点 **保存地址**
4. 在 **配对与令牌** 中填入手机显示的 **配对码**（6 位）与 **会话令牌**，点 **保存配对信息**。
5. 点 **连接**。状态标签变为 **已连接** 即握手成功（握手结果与错误会记录在 **运行日志**）。
6. 连接成功后，可用面板中的 **⏮ / ▶⏸ / ⏭ / 播放模式** 控制手机端播放，并查看 **当前歌曲**
   与 **歌词**。

**会话流程（协议层）**：连接 WS → 发 `sys.hello{role:"windows", proto:[1], caps:[...]}` →
收 `sys.hello_ack` → 协商版本与能力 → `state.get` 拉全量快照 → 之后 `sys.ping`（10s 保活）、
`state.get`（15s 兜底重同步）。

---

## 5. 排查顺序（自上而下）

1. **开关是否打开**：设置 → 手环联动 → 启用开关。关闭状态下不会发起任何连接。
2. **地址是否正确**：手机 IP 是否变更（DHCP）？端口/路径是否与手机端一致？
3. **是否同网段**：电脑与手机是否在同一局域网？路由器是否开启 AP 隔离？
4. **手机端中继是否开启**：手机侧服务是否在运行、是否监听局域网而非仅 127.0.0.1？
5. **配对码 / 令牌是否正确**：令牌过期或填错会在握手阶段被拒（日志出现 `错误` 行）。
6. **看运行日志**：面板底部「运行日志」会显示连接、握手、错误与分片结果。
7. **看主进程日志**：终端输出以 `[band]` 开头（**不含令牌**）。

常见错误码（§3.7）：

| code | 含义 | 处理 |
|---|---|---|
| `E_BADREQ` | 信封/JSON 非法 | 丢弃 + 记录，不重试 |
| `E_UNSUPPORTED` | 版本/方法/能力不支持 | 标记能力缺失，不再重试 |
| `E_TIMEOUT` | 处理超时 | 同 id 重试（≤2 次） |
| `E_LINK` | 链路断开/发送失败 | 自动进入重连 |
| `E_TOOLARGE` | 分片总量超上限（8KB） | 降级为增量模式 |
| `E_CRC` | 分片校验失败 | 自动 `xfer.nack` 请求重发缺失分片 |

---

## 6. 配置与安全

- 配置保存在 `userData/band.json`（Windows 一般为
  `%APPDATA%/such-pc-ng/band.json`）。
- **默认关闭**，不启用的用户不受任何影响，也不会发起网络行为。
- **仅局域网**：连接目标是用户填写的手机地址，不监听、不上传、不做公网/远程遥控。
- 会话令牌**明文**存本地（明文即可），但**不会写入日志**：连接 URL 中不携带令牌，
  令牌只经 `sys.hello.payload.token` 传递（URL 打印前已去除查询串）。

---

## 7. 已知限制与风险

| 项 | 说明 |
|---|---|
| 手环不可直连 | 拓扑决定必须经手机；手机不在 / 未开中继 → Windows 失联 |
| 手机是单点 | 手机侧服务端未实现或未开启时，本端无法独立工作 |
| 无官方 PC 通道 | 未来若小米开放 PC SDK，可替换传输层而不改协议层 |
| 分片上限为保守值 | 单包 900B 为保守取值（真实上限待验证 V2）；组装上限 8KB |
| 未接入本地播放器 | 本端为**手机播放会话的遥控与展示**，不改动本地 `playerStore`（保持克制，便于上游审阅） |
| 真机联调 | 握手、分片吞吐、重连时序需与手机端真机联调确认 |

---

## 8. 单元测试

纯逻辑模块不依赖 Electron，可直接在 Node 下测试：

```bash
pnpm test:unit          # vitest
```

覆盖：信封往返与非法输入、分片切分/组装与 CRC32、缺片重传、去重幂等、
版本/能力协商、`PlayMode` 映射、超时重试策略。
