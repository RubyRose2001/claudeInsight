import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
    },
    {
      path: '/sessions',
      name: 'sessions',
      component: () => import('@/views/HistoryView.vue'),
    },
    {
      path: '/sessions/compare',
      name: 'session-compare',
      component: () => import('@/views/CompareView.vue'),
    },
    {
      path: '/tasks',
      name: 'tasks',
      component: () => import('@/views/TasksView.vue'),
    },
    {
      path: '/assets',
      name: 'assets',
      component: () => import('@/views/AssetsView.vue'),
    },
    {
      path: '/plugins',
      name: 'plugins',
      component: () => import('@/views/PluginsView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
    },
    {
      path: '/model-profiles',
      name: 'model-profiles',
      component: () => import('@/views/ModelProfilesView.vue'),
    },
    {
      path: '/live-sessions',
      name: 'live-sessions',
      component: () => import('@/views/LiveSessionsView.vue'),
    },
  ],
});

export default router;
