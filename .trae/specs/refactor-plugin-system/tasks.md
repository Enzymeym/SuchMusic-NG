# 任务列表

- [x] 任务 1: 重构插件宿主与类型定义
    - [x] 在 `src/plugin/types.ts` 中定义匹配 `window.source` 结构的 `SuchPluginNew` 接口。
    - [x] 修改 `SuchMusicPluginHost.ts`，创建包含 `window` 对象的沙箱。
    - [x] 实现 `window.source` 赋值捕获逻辑。
    - [x] 实现 `window.notify` 或 `suchmusic.notify` 注入，供插件发送通知。
    - [x] 实现 `search` 和 `checkUpdate` 方法的调用封装。
    - [x] 适配新的 `getMusicUrl` 签名。

- [x] 任务 2: 更新 IPC 与插件管理器
    - [x] 更新 `pluginManager.ts` 中的 `parsePlugin` 函数，支持解析 `window.source`。
    - [x] 添加 `plugin:search` IPC 处理器。
    - [x] 添加 `plugin:checkUpdate` IPC 处理器。
    - [x] 确保 `plugin:call` 能兼容新旧方法调用。

- [x] 任务 3: 更新前端 Store
    - [x] 在 `src/renderer/src/types/plugin.d.ts` 中更新 `Plugin` 接口。
    - [x] 在 `pluginStore.ts` 中添加 `searchMusic` action。
    - [x] 在 `pluginStore.ts` 中添加 `checkUpdate` action。

- [x] 任务 4: 集成搜索 UI
    - [x] 更新 `SearchView.vue`，集成插件搜索结果。
    - [x] 验证插件返回的歌曲能否正常播放（调用新的 `getMusicUrl`）。

- [x] 任务 5: 验证与测试
    - [x] 创建一个符合新规范的测试插件（包含搜索、播放、检查更新功能）。
    - [x] 验证插件加载、搜索、播放流程。
    - [x] 验证检查更新和通知功能。
