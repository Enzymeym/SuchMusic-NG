# SuchMusic 插件系统

## 一、引言

### 1.1 系统目标

- 实现**主程序与音源解耦**，通过插件扩展支持任意音乐平台
- 提供**安全、轻量、高性能**的插件运行环境
- 支持**普通用户友好配置**，无需代码即可完成个性化设置

### 1.2 插件类型

| 类型 | 说明 |
| --- | --- |
| **原生插件（推荐）** | 基于方法导出的 CommonJS 模块，支持配置 UI |
| **LX 兼容插件** | 事件驱动格式，用于迁移现有生态 |

---

## 二、插件文件基础规范

### 2.1 文件要求

- 扩展名：`.js`
- 编码：UTF-8
- 语言：ES6+（运行于 Node.js 环境）

### 2.2 头部注释（必需）

```jsx
/**
 * @name 插件名称（≤24字符）
 * @description 简短描述（≤36字符，可选）
 * @version 语义化版本（可选）
 * @author 作者（可选）
 * @homepage 主页 URL（可选）
 */

```

---

## 三、原生插件核心结构

### 3.1 必需导出项

```jsx
module.exports = {
  pluginInfo,   // 插件元信息
  sources,      // 支持的音源列表
  musicUrl      // 获取音频直链（必需）
}

```

### 3.2 插件信息（`pluginInfo`）

```jsx
{
  name: "网易云增强",
  version: "1.2.0",
  author: "SuchDev",
  description: "支持无损音质与歌词"
}

```

### 3.3 音源定义（`sources`）

```jsx
{
  wy: { name: "网易云音乐", qualitys: ["128k", "320k", "flac"] },
  kw: { name: "酷我音乐", qualitys: ["128k", "320k", "flac"] }
}

```

> 字段名必须为 `qualitys`（注意拼写）
> 

### 3.4 核心方法

| 方法 | 参数 | 返回值 | 必需 |
| --- | --- | --- | --- |
| `musicUrl(source, musicInfo, quality)` | 音源ID、歌曲信息、音质 | 音频直链 URL (`string`) | ✅ |
| `getPic(source, musicInfo)` | — | 封面图 URL | ✅ |
| `getLyric(source, musicInfo)` | — | LRC 歌词文本 | ⚪ |

---

## 四、插件配置 UI 系统（新增）

### 4.1 配置项导出（可选）

插件可导出 `configUI` 数组，用于生成首次启用/配置时的表单：

```jsx
const configUI = [
  {
    id: "api_key",
    name: "API 密钥",
    description: "请从开发者平台获取",
    type: "input",
    defaultValue: "",
    emit: "onApiKeyChange"
  },
  {
    id: "enable_proxy",
    name: "启用代理",
    type: "switch",
    defaultValue: false
  },
  {
    id: "server_region",
    name: "服务器区域",
    type: "dropdown",
    dropdown: [
      { id: "cn", label: "中国大陆" },
      { id: "us", label: "美国" }
    ],
    defaultValue: "cn"
  }
];

```

### 4.2 配置项字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 配置键名，用于存储与读取 |
| `name` | `string` | 显示标题 |
| `description` | `string?` | 辅助说明文字 |
| `type` | `enum` | 控件类型：`input` / `switch` / `dropdown` / `default` |
| `dropdown` | `{ id, label }[]` | 仅 `type=dropdown` 时有效 |
| `defaultValue` | `string \| boolean` | 初始值或回显值 |
| `emit` | `string?` | 变更时调用的插件方法名（如 `"onServerChange"`） |

### 4.3 配置回调函数

- 被 `emit` 引用的函数**必须在 `module.exports` 中导出**
- 函数接收**当前配置值**作为唯一参数
- 示例：
    
    ```jsx
    async function onApiKeyChange(key) {
      if (!key) return;
      await suchmusic.request(`https://api.example.com/verify?key=${key}`);
    }
    
    ```
    

### 4.4 主程序支持 API

| API | 说明 |
| --- | --- |
| `suchmusic.getPluginConfig(pluginId, key)` | 读取插件配置 |
| `suchmusic.setPluginConfig(pluginId, key, value)` | 保存配置（自动持久化） |
| `suchmusic.NoticeCenter('config', { pluginId })` | 触发配置界面打开 |

### 4.5 配置触发时机

- 插件**首次启用**时自动弹出（若存在 `configUI`）
- 用户在插件管理界面点击“配置”按钮
- 插件通过 `NoticeCenter` 主动请求配置

---

## 五、运行时环境与 API

### 5.1 沙箱限制

- **允许**：`console`, `setTimeout`, `Buffer`, `JSON`, `suchmusic`
- **禁止**：`require()`, `fs`, `child_process`, `eval()` 等危险操作

### 5.2 提供的全局 API（`suchmusic.*`）

| API | 用途 |
| --- | --- |
| `request(url, options)` | 发起 HTTP 请求（自动处理代理/CORS） |
| `utils.buffer.from(...)` | Buffer 构造工具 |
| `utils.crypto.md5(str)` | 加密工具（MD5/AES/RSA） |
| `getPluginConfig / setPluginConfig` | 配置读写 |
| `NoticeCenter(type, data)` | 发送通知（更新/错误/配置） |

---

## 六、LX 兼容插件支持（可选）

### 6.1 基本结构

```jsx
globalThis.lx = { /* LX API */ };
lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
  if (action === 'musicUrl') return handleMusicUrl(info);
});
lx.send('inited', { sources: [...] });

```

### 6.2 注意事项

- 不支持 `configUI`（需自行实现配置逻辑）
- 无法使用 `suchmusic` API

---

## 七、安全与健壮性

### 7.1 安全策略

- 所有网络请求由主程序代理，插件无直接外联权限
- 配置值存储前进行类型校验（防止注入）
- 敏感字段未来支持 `type: "password"`（输入掩码）

### 7.2 错误处理

- 插件方法应抛出 `Error`，主程序统一捕获并记录
- 配置回调失败时，弹出友好提示而非崩溃

---

## 八、调试与日志

### 8.1 日志输出

- 使用 `console.log/warn/error`
- 日志路径：`~/.suchmusic/plugins/logs/<plugin_id>.txt`

### 8.2 调试建议

- 在 `configUI` 中加入“测试连接”按钮（通过 `emit` 触发）
- 使用 `suchmusic.request` 的 `timeout` 避免卡死

---

## 九、插件发布与维护

### 9.1 发布清单

- [ ]  头部注释完整
- [ ]  `configUI` 字段命名清晰、无敏感默认值
- [ ]  所有 `emit` 引用的方法均已导出
- [ ]  插件体积 ≤ 100KB（建议）

### 9.2 版本更新

- 通过 `suchmusic.NoticeCenter('update', {...})` 推送更新
- 配置数据向下兼容（避免升级后丢失）

---

## 十、附录：完整模板

```jsx
/**
 * @name MyCloud Music
 * @description 支持私有服务器的音乐源
 */
const pluginInfo = {
  name: "MyCloud Music",
  version: "1.0.0",
  author: "you",
  description: "需配置 API 地址"
};

const sources = {
  mc: { name: "MyCloud", qualitys: ["128k", "320k", "flac"] }
};

const configUI = [
  {
    id: "api_url",
    name: "API 地址",
    description: "例如: <https://api.mycloud.com>",
    type: "input",
    defaultValue: "<https://api.mycloud.com>",
    emit: "onApiUrlChange"
  }
];

async function onApiUrlChange(url) {
  await suchmusic.request(`${url}/health`);
}

async function musicUrl(source, musicInfo, quality) {
  const apiUrl = await suchmusic.getPluginConfig('mycloud', 'api_url');
  const resp = await suchmusic.request(`${apiUrl}/song?id=${musicInfo.id}&q=${quality}`);
  return resp.body.url;
}

module.exports = {
  pluginInfo,
  sources,
  musicUrl,
  configUI,
  onApiUrlChange
};

```

---