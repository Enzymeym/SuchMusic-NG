# 重构 Such 插件系统规格说明书

## 背景
目前的插件系统基于 Node.js `vm` 沙箱，使用 `module.exports` 导出且功能有限（主要是 `getMusicUrl`）。新的需求是基于 "Such" 音源文档标准（类似飞书文档中的描述）重构插件系统，采用 `window.source` 赋值模式，并直接在插件对象中包含 `search`、`checkUpdate` 等能力。这将使插件功能更加强大和标准化。

## 变更内容

### 1. 插件宿主重构 (`SuchMusicPluginHost.ts`)
- **沙箱环境增强**:
    - 在沙箱中添加 `window` 对象，用于捕获 `window.source` 的赋值。
    - 支持新的插件结构定义：
        ```javascript
        window.source = {
            id: "plugin_id",          // 插件唯一标识
            name: "Plugin Name",      // 插件名称
            version: "1.0.0",         // 版本号
            author: "Author",         // 作者
            source: ["platform_id_1", "platform_id_2"], // 支持的平台列表 (如 ["kw", "kg"])
            
            // 初始化函数
            initialization: function() { ... },
            
            // 搜索函数 (新增)
            search: async function(source, keyword, page, page_size) { 
                // 返回: { code: true/false, data: [{ music_name, music_id, ... }] }
            },
            
            // 获取播放链接函数 (签名变更)
            getMusicUrl: async function(source, music_id) { 
                // 返回: { code: true/false, url: "...", ... }
            },

            // 检查更新函数 (新增)
            checkUpdate: async function() {
                // 返回: { hasNew: boolean, version: string, url: string, changelog: string }
            }
        }
        ```
- **API 注入**:
    - 保持 `suchmusic` 工具类的注入（加密、请求等）。
    - **新增通知能力**: 在沙箱中暴露 `window.notify(message, type)` 或 `suchmusic.notify(...)`，用于插件向主程序发送通知。

### 2. 插件管理器 IPC 更新 (`pluginManager.ts`)
- **新增 IPC 处理**:
    - `plugin:search`: 处理搜索请求，调用插件的 `search` 方法。
    - `plugin:checkUpdate`: 处理检查更新请求，调用插件的 `checkUpdate` 方法。
- **信息解析**:
    - 更新解析逻辑，优先读取 `window.source` 中的元数据。

### 3. 插件 Store 更新 (`pluginStore.ts`)
- **新增 Action**:
    - `searchMusic(keyword, sources, page, limit)`: 聚合插件搜索结果。
    - `checkPluginUpdate(pluginId)`: 调用插件检查更新。
- **状态管理**:
    - 记录插件的更新状态。

### 4. 搜索 UI 集成 (`SearchView.vue`)
- **统一搜索**:
    - 修改 `SearchView.vue`，使其能够调用 `pluginStore` 进行搜索。
    - 将插件返回的结果合并到搜索列表中。

## 影响范围
- **受影响代码**:
    - `src/plugin/manager/SuchMusicPluginHost.ts` (核心重构)
    - `src/main/ipc/pluginManager.ts`
    - `src/renderer/src/stores/pluginStore.ts`
    - `src/renderer/src/views/SearchView.vue`

## 新增需求
### 需求：基于 Window 的插件加载
系统必须能够加载通过 `window.source` 赋值的插件脚本。

### 需求：插件搜索能力
系统必须支持通过插件进行音乐搜索，并标准化返回结果。

### 需求：插件检查更新
插件必须能够实现 `checkUpdate` 方法，系统需提供触发该检查的机制。

### 需求：插件发送通知
插件必须能够调用宿主提供的通知接口（如 `window.notify`）向用户发送消息。

## 修改需求
### 需求：插件执行环境
- **旧**: 执行 `module.exports`。
- **新**: 执行脚本并读取 `window.source`，同时保持对旧格式的兼容（如果可行）。
