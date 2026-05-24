import { createRouter, createWebHashHistory } from 'vue-router'
import MainLayout from '../layout/MainLayout.vue'

// 路由懒加载
const HomeView = () => import('../views/HomeView.vue')
const LocalMusicView = () => import('../views/LocalMusicView.vue')
const PlaylistView = () => import('../views/PlaylistView.vue')
const PlaylistDetailView = () => import('../views/PlaylistDetailView.vue')
const NeteasePlaylistDetailView = () => import('../views/NeteasePlaylistDetailView.vue')
const RecentPlayView = () => import('../views/RecentPlayView.vue')
const PlaylistSquareView = () => import('../views/PlaylistSquareView.vue')
const ToplistView = () => import('../views/ToplistView.vue')
const SearchView = () => import('../views/SearchView.vue')
const StatisticsView = () => import('../views/StatisticsView.vue')
const DesktopLyricView = () => import('../views/DesktopLyricView.vue')
const TaskbarLyricView = () => import('../views/TaskbarLyricView.vue')

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      component: MainLayout,
      children: [
        {
          path: '',
          name: 'home',
          component: HomeView
        },
        {
          path: 'local',
          name: 'local',
          component: LocalMusicView
        },
        {
          path: 'playlist',
          name: 'playlist',
          component: PlaylistView
        },
        {
          path: 'playlist/:id',
          name: 'playlist-detail',
          component: PlaylistDetailView
        },
        {
          path: 'netease-playlist/:id',
          name: 'netease-playlist-detail',
          component: NeteasePlaylistDetailView
        },
        {
          path: 'recent',
          name: 'recent',
          component: RecentPlayView
        },
        {
          path: 'playlist-square',
          name: 'playlist-square',
          component: PlaylistSquareView
        },
        {
          path: 'toplist',
          name: 'toplist',
          component: ToplistView
        },
        {
          path: 'search',
          name: 'search',
          component: SearchView
        },
        {
          path: 'statistics',
          name: 'statistics',
          component: StatisticsView
        }
      ]
    },
    {
      path: '/desktop-lyric',
      name: 'desktop-lyric',
      component: DesktopLyricView
    },
    {
      path: '/taskbar-lyric',
      name: 'taskbar-lyric',
      component: TaskbarLyricView
    }
  ]
})

export default router
