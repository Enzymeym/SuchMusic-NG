import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import LocalMusicView from '../views/LocalMusicView.vue'
import PlaylistView from '../views/PlaylistView.vue'
import PlaylistDetailView from '../views/PlaylistDetailView.vue'
import RecentPlayView from '../views/RecentPlayView.vue'
import PlaylistSquareView from '../views/PlaylistSquareView.vue'
import ToplistView from '../views/ToplistView.vue'
import SearchView from '../views/SearchView.vue'
import DesktopLyricView from '../views/DesktopLyricView.vue'
import TaskbarLyricView from '../views/TaskbarLyricView.vue'
import MainLayout from '../layout/MainLayout.vue'

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
