# 歌单广场详情页功能规格说明书 (Spec)

## 1. 目标
基于网易云音乐 API，实现“歌单广场”中在线歌单的详情展示功能。支持点击歌单卡片进入详情页，查看歌单信息、动态数据（播放量、收藏数等）以及分页加载歌单内的所有歌曲。

## 2. 涉及 API
- `/playlist/detail`：获取歌单基础信息（封面、标题、描述、创建者等）。
- `/playlist/track/all`：分页获取歌单内所有歌曲，突破默认接口只返回 10 首歌的限制。
- `/playlist/detail/dynamic`：获取歌单动态数据（如评论数、收藏数、播放数等）。

## 3. 核心功能与 UI 设计
1. **路由与导航**
   - 新增路由 `/netease-playlist/:id` 指向新的 `NeteasePlaylistDetailView.vue` 组件。
   - 在 `PlaylistSquareView.vue`、`ToplistView.vue`、`HomeView.vue` 等界面的 `playlist-card` 组件上增加点击事件，跳转至对应的歌单详情页。
2. **在线歌单详情页 (`NeteasePlaylistDetailView.vue`)**
   - **头部区域**：复用类似现有的 `classic` 或 `modern` 风格（可从 `PlaylistDetailView.vue` 中提炼或复制）。展示歌单封面、标题、描述、创建者信息以及来自动态接口的播放数、收藏数等。
   - **操作按钮**：“播放全部”（将所有已加载歌曲加入播放列表）。
   - **歌曲列表**：使用 `SongList` 组件展示歌曲。由于可能包含成百上千首歌曲，需要支持分页加载（基于 offset 和 limit）或滚动加载。
   - **数据获取**：
     - 组件挂载时请求 `detail` 和 `dynamic` 接口。
     - 同时请求第一页的 `track/all` 接口（如 limit=50, offset=0）。
     - 提供加载更多机制（如到底部自动加载下一页）。

## 4. 技术实现细节
- **API 封装**：在 `src/renderer/src/apis/netease/playlist/detail.ts` 中封装上述三个接口的请求函数，复用现有的 `fetch` / `axios` 逻辑（例如使用 `neteaseRequest` 或 `request`）。
- **数据转换**：将网易云返回的歌曲格式转换为应用内部的歌曲格式（`id, title, artist, album, cover, source: 'netease', sourceSongId` 等），以便 `SongList` 和 `PlayerStore` 能正常播放。
- **状态管理**：该视图的歌曲列表状态保存在组件内部，因为不需要像本地歌单那样持久化。