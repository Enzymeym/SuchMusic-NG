# Tasks

* [x] Task 1: 增加“歌曲保存位置”设置项

  * [x] SubTask 1.1: 修改 `src/renderer/src/stores/settingsStore.ts` 的 `LocalSettings` 接口和默认状态，增加 `downloadDir?: string` 字段。

  * [x] SubTask 1.2: 修改 `src/main/ipc/system.ts`，增加 `system:choose-dir` IPC 方法，使用 `dialog.showOpenDialog` 选择目录并返回。

  * [x] SubTask 1.3: 在 `src/renderer/src/components/common/Settings/SettingsLocalSection.vue` 中添加“歌曲保存位置” UI，允许用户选择和查看当前保存目录。

* [x] Task 2: 在主进程中添加下载功能 IPC 接口

  * [x] SubTask 2.1: 在 `src/main/ipc/system.ts` 中引入 `path`, `axios` 和 `fs.createWriteStream`。

  * [x] SubTask 2.2: 注册 `system:download-music` 的 IPC 处理器，接收 `{ url, filename, dir }`。如果 `dir` 为空则默认使用系统的 `music` 目录。

  * [x] SubTask 2.3: 使用 `axios` 以 stream 方式下载文件到指定目录，并处理下载完成和错误事件。

* [x] Task 3: 在前端增加下载通用逻辑及 UI 入口

  * [x] SubTask 3.1: 编写通用下载逻辑，获取当前歌曲的 `source` 和 `sourceSongId`，使用 `runSnowdropGetMusicUrl` 获取链接，并获取 `settingsStore.local.downloadDir`，然后调用 `system:download-music`。

  * [x] SubTask 3.2: 在 `src/renderer/src/components/layout/PlayerBar.vue` 的播放列表 item-actions 中添加一个下载按钮（使用 `mgc_download_line` 图标），点击触发下载逻辑。

  * [x] SubTask 3.3: 在 `src/renderer/src/components/layout/PlayerPage.vue` 的左侧底栏（footer-left）区域也添加一个下载按钮，点击触发当前播放歌曲的下载逻辑。

# Task Dependencies

* Task 2 depends on Task 1

* Task 3 depends on Task 2

