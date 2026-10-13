import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: HomeView },
    { path: '/item/:id', component: () => import('./views/ItemView.vue') },
    { path: '/item/:id/history', component: () => import('./views/HistoryView.vue') },
    { path: '/edit/:id?', component: () => import('./views/EditView.vue') },
    { path: '/trash', component: () => import('./views/TrashView.vue') },
    { path: '/settings', component: () => import('./views/SettingsView.vue') },
    { path: '/settings/sync', component: () => import('./views/SyncView.vue') },
    { path: '/settings/password', component: () => import('./views/PasswordView.vue') },
    { path: '/settings/about', component: () => import('./views/AboutView.vue') },
    { path: '/settings/autofill', component: () => import('./views/AutofillView.vue') },
    { path: '/:rest(.*)', redirect: '/' },
  ],
  scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
})
