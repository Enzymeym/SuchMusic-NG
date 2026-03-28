# 任务分解 (Tasks)

1. **API 层开发**
   - [ ] 创建 `src/renderer/src/apis/netease/playlist/detail.ts`。
   - [ ] 实现 `fetchPlaylistDetail(id)` 方法，获取歌单基础信息。
   - [ ] 实现 `fetchPlaylistTracks(id, limit, offset)` 方法，分页获取歌单所有歌曲。
   - [ ] 实现 `fetchPlaylistDynamic(id)` 方法，获取歌单动态数据（播放量、评论数等）。

2. **路由配置**
   - [ ] 修改 `src/renderer/src/router/index.ts`，增加 `/netease-playlist/:id` 路由。

3. **视图组件开发**
   - [ ] 创建 `src/renderer/src/views/NeteasePlaylistDetailView.vue`。
   - [ ] 实现基础 UI 布局（包含头部信息区和下方的 `SongList`），可以复用或参考 `PlaylistDetailView.vue` 的样式。
   - [ ] 接入 API 数据，渲染封面、名称、描述、播放量、创建者等基础信息。
   - [ ] 实现歌曲列表的分页/无限滚动加载逻辑（使用 `IntersectionObserver` 或按钮加载更多）。
   - [ ] 实现“播放全部”以及点击单首歌曲播放的功能（注意与本地播放逻辑的一致性，确保能自动获取播放链接和歌词）。

4. **入口接入**
   - [ ] 修改 `PlaylistSquareView.vue`，给 `playlist-card` 添加点击事件跳转至 `/netease-playlist/:id`。
   - [ ] 修改 `ToplistView.vue`，给 `playlist-card` 添加点击事件跳转至详情页。
   - [ ] 修改 `HomeView.vue`，给 `playlist-card` 添加点击事件跳转至详情页。