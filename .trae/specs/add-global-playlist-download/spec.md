# 在全局播放列表中添加歌曲下载功能

## Why
目前全局播放列表（PlayerBar 侧边抽屉）以及播放页（PlayerPage）中的歌曲无法直接下载，用户需要繁琐的操作才能获取自己喜欢的歌曲文件。为了提升用户体验，增加直接下载歌曲至本地的功能，并且允许用户在设置中自定义下载保存路径。

## What Changes
- 在“本地与下载”设置（`SettingsLocalSection.vue`）中新增“歌曲保存位置”配置项，允许用户选择默认下载目录。
- 在 `settingsStore.ts` 的 `LocalSettings` 中新增 `downloadDir` 字段保存用户配置。
- 在全局播放列表（`PlayerBar.vue`）的每首歌曲操作区增加“下载”按钮。
- 在播放页（`PlayerPage.vue`）左侧底栏区域也添加“下载”按钮。
- 在主进程 `system.ts` 中新增 IPC 通信处理程序 `system:download-music` 和 `system:choose-dir`。
- 当用户点击下载按钮时，根据当前音源平台和对应歌曲 ID，使用 `runSnowdropGetMusicUrl` 获取下载链接，然后静默或提示下载到指定的 `downloadDir` 中。

## Impact
- Affected specs: 歌曲下载功能及本地设置
- Affected code:
  - `src/renderer/src/stores/settingsStore.ts`
  - `src/renderer/src/components/common/Settings/SettingsLocalSection.vue`
  - `src/renderer/src/components/layout/PlayerBar.vue`
  - `src/renderer/src/components/layout/PlayerPage.vue`
  - `src/main/ipc/system.ts`

## ADDED Requirements
### Requirement: 歌曲下载功能与路径设置
系统应当允许用户在“本地与下载”设置中配置歌曲下载路径，并在全局播放列表和播放页中提供下载入口。

#### Scenario: 设置下载路径
- **WHEN** 用户进入“本地与下载”设置界面
- **THEN** 看到“歌曲保存位置”设置项。
- **THEN** 点击“更改目录”按钮，可以弹出系统的文件夹选择框，选择后保存到设置中。

#### Scenario: 成功下载一首歌曲
- **WHEN** 用户在全局播放列表或播放页中点击“下载”图标
- **THEN** 系统会通过对应渠道接口获取到歌曲的实际下载链接。
- **THEN** 系统将文件下载到用户设置的“歌曲保存位置”（如未设置则默认下载到系统音乐目录）。
- **THEN** 下载完成后，在界面上弹出“下载完成”的提示。如果下载失败，弹出对应的错误提示。
