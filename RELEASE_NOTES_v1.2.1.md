# Such Music NG v1.2.1

## 🔥 重要修复 · 恢复发布版缺失的原生能力

**现象**：v1.2.0 安装包内不含任何 `.node` 原生模块 —— 播放设置页提示「Windows 音频会话 API 不可用（WASAPI 原生模块不可用）」，任务栏播控、标签读取等能力降级。

**根因**：`.gitignore` 中存在一条**未锚定**的 `native` 规则。gitignore 的裸目录名会匹配任意层级的同名目录，因此 `resources/native/`（预编译原生模块）被一并忽略；CI 检出后该目录不存在，构建脚本静默跳过原生模块，`extraResources` 也无内容可拷贝。

**修复**：

- `.gitignore`：`native` → `/native`，`symphonia-napi-decoder` → `/symphonia-napi-decoder`，锚定仓库根目录；同时忽略 `resources/native/debug/` 等 cargo 构建缓存。
- 4 个预编译原生模块正式纳入版本控制：`audio_napi` / `media_control_napi` / `music_tag_reader` / `symphonia_napi_decoder`。
- 新增 `.gitattributes`（`*.node` / `*.dll` / `*.so` / `*.dylib` 标记为 `binary`），杜绝行尾/编码转换污染二进制产物。
- 新增 `src/main/services/nativeModuleLoader.ts`：统一候选路径探测、导出校验与可操作的错误信息；修复 wasapiService 中「首次加载失败被缓存成固定文案」导致的误导性报错，并移除永远无法 `require` 的 `.dll` 候选。
- 设置页告警文案改为「不影响正常听歌」+ 具体原因，并新增「重新检测」按钮（`AudioOutputModeManager.resetWasapiProbe()`）。
- **安装包体积优化**：`electron-builder.yml` 去除原生模块的重复打包（`!resources/native/**`，`extraResources` filter 仅保留 `*.node`），App 体积 **533MB → 447MB**。

## 🛡️ 构建与 CI 门禁

- 新增 `scripts/verify-native.mjs`（`npm run verify:native`，`--strict` 为硬门禁模式），已接入 `npm run build` 与 GitHub Actions 每个平台的打包前校验 —— 此类静默缺失问题今后会**直接构建失败**，不再流入发布包。
- 修复 `scripts/build-native.ps1` 两处致命缺陷：
  - `Test-Path $null` 属**终止性**错误，在 `$ErrorActionPreference='Stop'` 下会中断整条构建链；新增 `Remove-StaleArtifact` / `Copy-NativeArtifact` 做空值兜底与 best-effort 处理，拷贝/删除失败只告警不中断。
  - 脚本写回时丢失 UTF-8 BOM，会被 Windows PowerShell 5.1 按 GB2312 解码，中文注释中的引号错位导致脚本整体无法解析执行；现固定为 UTF-8 with BOM。

## 🔊 音频引擎 / DSP

- **等响度拆分为两套互相独立的处理**：
  1. **EQ 响度补偿** —— 调整 EQ 后保持整体响度一致（按 PEQ 曲线加权反向输出增益）。
  2. **低音量高低频补偿** —— Fletcher-Munson 近似，低音量下自动提升高低频，基准可跟随系统音量。
- **信号链顺序调整**：Loudness 整块从「限幅器之后」前移至「EQ 之后、Compressor 之前」，避免低音量补偿（最多 +15dB）被限幅器削顶。
  新链序：`EQ → Loudness → Compressor → Limiter → VirtualBass → SoftClipper → Balance → Output`。
- **限幅器**补全 `attack` / `release` / `ratio` / `threshold` / `postGain` 全参数，并新增 makeup gain 节点。
- **声道平衡**改为单个滑块（`-100` 全左 / `0` 居中 / `+100` 全右），采用线性幅度衰减；旧 `balanceL/balanceR` 持久化数据自动折算兼容。
- **低音增强**波形改为单调归一化 `tanh` 塑形，虚拟低频 wet gain 下调，消除「增强异常/爆音」。
- **接线修复**：等响度整体增益、限幅器参数、声道平衡、音量记忆等此前多为纯本地 ref、**从未真正下发到引擎**（表现为「全部无效」），现全部改为写入引擎单例。

## 🎚️ 音效设置

- 均衡器统一为单一 **PEQ**，移除重复的 EQ/预 EQ 分栏与强度单选模式；曲线图与拖动交互同步。
- 修复「平坦 / 重置预设会把均衡器整块禁用」的问题。
- **PEQ 强度改为基于基准曲线重算**，不再在当前增益上累乘，消除多次调节后的曲线漂移/塌陷。
- 删除重复的「重置」按钮（保留顶部导航处那个）。

## 🎵 歌词与播放

- 修复**单曲循环时无歌词**：新增 `resolveSongLyrics`，缓存未命中且为同一首歌时回退复用上一首歌词。
- 修复纯歌词模式**高亮行未居中**。
- 修复歌词过长、音乐回忆卡片错位等布局问题。

## 🖥️ 界面与布局

- 修复音量条在 100% 时**宽度不一致**。
- 修复可视化区域高度不足，改为按尺寸计算并精确铺满容器。
- 修复**任务栏播控窗口「消失又出现」的闪烁**：`assertAlwaysOnTop` 增加 `moveTop()` 真正抢占 z 序、置顶轮询 1000ms → 250ms、窗口宽度下限 120 → 176px。
- 修复任务栏歌词飞出容器（`overflow: hidden; contain: paint`）。
- 辅助窗口判定扩展为「桌面歌词 + 任务栏播控」，避免启动画面盖住任务栏区域。
- 修复输出设置排版错乱与「默认输出设备显示为平坦」。
- **更新弹窗 `UpdateNotification` 重写**：状态徽标 + 版本号 chip（旧→新，含「预发布」标签）、细圆角滚动区、大号进度显示，全面改用 naive-ui 组件 + MingCute 图标。

## 📊 音乐回忆（统计页）改版

- 删除原头部大卡片，改为**三段式**版式：
  1. **5 张指标卡** —— 歌曲 / 专辑 / 歌手 / 总时长 / 总大小；
  2. **三块面板** —— 聆听足迹热力图（13 周）/ 24 小时播放时段 / 音频格式分布；
  3. **三张 TOP 1 卡** —— 最常听的歌曲 / 专辑 / 歌手，可点击回放。
- 新增 IPC `local-music:sizes`：按需批量 `stat` 文件大小，避免拖慢整库扫描。
- 响应式改用**容器查询**（侧边栏折叠导致视口宽度与可用宽度方向相反，`@media` 无法正确表达）。
- 修复 TOP 卡封面恒为空：新增 `resolveLiveCover`，按 `filePath` / 专辑 / 歌手回查曲库实时封面，并为 `<img>` 增加 `@error` 兜底。

**完整变更记录**：`git log v1.2.0..v1.2.1`
