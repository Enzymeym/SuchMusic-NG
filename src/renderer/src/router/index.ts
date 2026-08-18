import { createRouter, createWebHashHistory } from 'vue-router'
import MainLayout from '../layout/MainLayout.vue'

// 路由懒加载
const HomeView = () => import('../views/HomeView.vue')
const StatisticsView = () => import('../views/StatisticsView.vue')
const LocalMusicView = () => import('../views/LocalMusicView.vue')
const PlaylistView = () => import('../views/PlaylistView.vue')
const PlaylistDetailView = () => import('../views/PlaylistDetailView.vue')
const RecentPlayView = () => import('../views/RecentPlayView.vue')
const SearchView = () => import('../views/SearchView.vue')
const SingerView = () => import('../views/SingerView.vue')
const SingerDetailView = () => import('../views/SingerDetailView.vue')
const AlbumView = () => import('../views/AlbumView.vue')
const AlbumDetailView = () => import('../views/AlbumDetailView.vue')
const DesktopLyricView = () => import('../views/DesktopLyricView.vue')
const TaskbarControlView = () => import('../views/TaskbarControlView.vue')

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
          path: 'song',
          name: 'song',
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
          path: 'singer/:name',
          name: 'singer-detail',
          component: SingerDetailView
        },
        {
          path: 'album',
          name: 'album',
          component: AlbumView
        },
        {
          path: 'album/:name',
          name: 'album-detail',
          component: AlbumDetailView
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
      path: '/taskbar-control',
      name: 'taskbar-control',
      component: TaskbarControlView
    }
  ]
})

export default router
