import { createRouter, createWebHashHistory } from 'vue-router'
import MainLayout from '../layout/MainLayout.vue'

// 路由懒加载
const StatisticsView = () => import('../views/StatisticsView.vue')
const LocalMusicView = () => import('../views/LocalMusicView.vue')
const PlaylistView = () => import('../views/PlaylistView.vue')
const PlaylistDetailView = () => import('../views/PlaylistDetailView.vue')
const RecentPlayView = () => import('../views/RecentPlayView.vue')
const SearchView = () => import('../views/SearchView.vue')
const SingerView = () => import('../views/SingerView.vue')
const AlbumView = () => import('../views/AlbumView.vue')
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
          name: 'statistics',
          component: StatisticsView
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
          path: 'recent',
          name: 'recent',
          component: RecentPlayView
        },
        {
          path: 'singer',
          name: 'singer',
          component: SingerView
        },
        {
          path: 'album',
          name: 'album',
          component: AlbumView
        },
        {
          path: 'search',
          name: 'search',
          component: SearchView
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
