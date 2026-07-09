<div align="center">

<img src="build/icon.png" alt="SuchMusic-NG Icon" width="128">

## Such Music for PC

[![GitHub License](https://img.shields.io/github/license/Enzymeym/SuchMusic-NG?color=red&label=License&logo=agpl)](https://github.com/Enzymeym/SuchMusic-NG/blob/main/LICENSE)
[![Electron](https://img.shields.io/badge/Electron-32.x-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3.x-4FC08D?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-9cf?logo=windows&logoColor=white)](https://electronjs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/Enzymeym/SuchMusic-NG/pulls)
[![Beta](https://img.shields.io/badge/status-BETA-yellow?logo=github)](https://github.com/Enzymeym/SuchMusic-NG)

**一款简洁、美观的跨平台音乐播放器，提供优雅的桌面音乐体验。**

基于 Vue 3 + Electron + TypeScript 构建，采用模块化插件架构，支持自定义音乐源、歌词渲染与可视化背景。

</div>

---

## ⚖️ 法律声明

> **本软件仅提供插件框架与播放功能，**  
> **不直接存储、提供任何音乐源文件。**  
> 用户需通过自行选择、安装合规插件获取音乐相关数据。  
> 项目旨在为开发者提供桌面应用实践与学习案例，  
> 为用户提供合规的音乐播放工具。

---
> [!IMPORTANT]
>
>请务必遵守 **GNU Affero General Public License (AGPL-3.0)** 许可协议：
>
>- 在您的修改、演绎、分发或派生项目中，**必须同样采用 AGPL-3.0 许可协议**，并在适当的位置包含本项目的许可和版权信息。
>- 若您用于售卖或其他盈利用途，**必须提供本项目的源代码及原项目链接**。另外由于本项目涉及第三方，售卖后可能遭受法律或诉讼风险。
>- 如若发现违反许可协议，作者保留追究法律责任的权利。
>- **禁止在二开项目中修改程序原版权信息**（您可以添加二开作者信息）。

>感谢您的尊重与理解。

### 开发环境要求

- **技术栈**：Vue 3 + TypeScript + Naive UI + Electron
- **Node.js 版本**：`>= 20`
- **包管理器**：`pnpm >= 10`

### 平台支持

- **支持网页端与客户端**。由于设备有限，目前仅保证 **Windows** 系统的适配，其他平台如遇问题可以提 Issue，或自行解决后提 PR。

### 欢迎 Star

欢迎各位大佬 **😍 Star** 支持！

---

## 📦 技术架构

| 技术栈 | 说明 |
|--------|------|
| **Vue 3** | 前端框架 |
| **TypeScript** | 类型安全的开发体验 |
| **Electron** | 跨平台桌面应用框架 |
| **Naive UI** | 基于 Vue 3 的组件库 |
| **Pinia** | 轻量级状态管理 |
| **Vite** | 现代化的前端构建工具 |
| **AMLL** | 流体背景渲染与歌词组件 |
| **Such Plugin** | 高扩展性的插件运行环境 |
| **Rodium** | 基于 ffmpeg 和 wasapi 的音频播放器，使用 Rust 编写 |

---

## ✨ 功能特性

- 🎵 **优雅的音乐播放体验** — 简洁美观的界面设计，专注音乐本身
- 🔌 **插件化架构** — 支持自定义功能扩展，灵活可控
- 🎨 **流体视觉背景** — 基于 WebGL 的动态视觉效果，增强沉浸感
- 📜 **歌词同步显示** — 支持多种歌词格式解析与实时同步
- 🖥️ **跨平台支持** — 基于 Electron，覆盖 Windows / macOS / Linux
- 🧩 **可扩展性强** — 模块化设计，便于二次开发与功能集成

---

## 📸 预览

> *应用截图待补充*

---

## 🚀 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 10

### 安装与运行

```bash
# 克隆项目
git clone https://github.com/Enzymeym/SuchMusic-NG.git
cd SuchMusic-NG

# 安装依赖
pnpm install

# 启动开发环境
pnpm run dev
```

---

## 🛠️ 开发指南

### 项目结构

```
SuchMusic-NG/
├── src/               # 主应用源码
├── native/            # 原生模块（含 Rodium）
├── build/             # 构建配置
├── resources/         # 资源文件
├── packages/          # 子包（如 lyric-kit）
└── ...
```

### 插件开发

项目提供插件运行环境，允许开发者扩展音乐源功能。如需开发插件，请参考后续插件开发文档。

> ⚠️ 插件仅提供框架接口，不包含任何默认音乐插件。

### 常用命令

```bash
pnpm run dev          # 启动开发服务器
pnpm run build        # 构建生产版本
pnpm run preview      # 预览构建结果
pnpm run lint         # 代码检查
```

---

## 📦 构建与打包

使用 Electron Builder 构建桌面应用：

```bash
pnpm run build
```

构建产物将输出至 `dist/` 目录。

---

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request。

在提交 PR 前，请确保：

- 代码通过 ESLint 检查
- 遵循项目的代码规范
- 为新增功能编写必要的文档

---

## 👥 开发者

（排名不分先后，以下内容实时更新，更新日期：2026.6.8）

- **酶游明** ([GitHub](https://github.com/Enzymeym)) — 插件系统、音频系统、UI 设计/开发

---

## 📄 开源协议

本项目采用 [AGPL v3](https://github.com/Enzymeym/SuchMusic-NG/blob/main/LICENSE) 开源协议。

---

## 💬 交流与反馈

如有问题或建议，欢迎通过 GitHub Issues 进行反馈。

---

## 📌 后续计划

- [ ] 完善插件开发文档
- [ ] 增加更多主题与自定义选项

---

## 🙏 致谢

- [AMLL](https://github.com/amll-dev/applemusic-like-lyrics) — 歌词与流体背景组件
- [Naive UI](https://www.naiveui.com) — 优雅的 Vue 3 组件库
- [Electron](https://www.electronjs.org) — 跨平台桌面应用框架
