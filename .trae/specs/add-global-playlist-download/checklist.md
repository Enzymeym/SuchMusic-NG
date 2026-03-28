* [x] `settingsStore.ts` 中成功添加了 `downloadDir` 配置项。

* [x] 在“本地与下载”设置页面可以正确选择和保存“歌曲保存位置”。

* [x] `system:choose-dir` 和 `system:download-music` IPC 接口已经成功注册，并在主进程中能够正常流式下载文件到指定目录。

* [x] 在 `PlayerBar.vue` 全局播放列表抽屉中，每首歌的右侧操作区都显示有下载图标按钮。

* [x] 在 `PlayerPage.vue` 的左下角底栏操作区显示有下载图标按钮。

* [x] 点击下载按钮能够通过当前的音源平台（source）和对应的 song ID 获取音乐播放链接，并将文件下载到用户设置的目录中。

* [x] 下载过程中、下载完成后界面能够弹出正确的提示信息。

