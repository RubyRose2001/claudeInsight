<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useAppStore } from './stores/appStore';
import { useProjectStore } from './stores/projectStore';
import { useModelProfileStore } from './stores/modelProfileStore';
import GlobalSearch from './components/search/GlobalSearch.vue';
const globalSearchRef = ref<InstanceType<typeof GlobalSearch> | null>(null);
import { LayoutDashboard, History, Zap, Settings, Search, Cpu, ChevronDown, Check, X, FolderOpen, Terminal } from 'lucide-vue-next';
import { computed } from 'vue';

const route = useRoute();
const appStore = useAppStore();
const projectStore = useProjectStore();
const modelProfileStore = useModelProfileStore();

const showProfileDropdown = ref(false);
const showSyncToast = ref(false);
const syncMessage = ref('');

onMounted(async () => {
  // 设置暗色主题
  document.documentElement.classList.add('dark');

  // 加载统计数据
  appStore.fetchStats();

  // 加载项目列表
  projectStore.fetchProjects();

  // 加载模型配置
  try {
    await modelProfileStore.initialize();
  } catch (e) {
    console.error('Failed to load model profiles:', e);
  }
});

const activeProfileName = computed(() => modelProfileStore.activeProfileName);

async function activateProfile(profileId: string) {
  try {
    const result = await modelProfileStore.activateProfile(profileId);
    if (result.success) {
      syncMessage.value = result.message;
      showSyncToast.value = true;
      setTimeout(() => {
        showSyncToast.value = false;
      }, 3000);
    }
    showProfileDropdown.value = false;
  } catch (e) {
    console.error('Failed to activate profile:', e);
  }
}
</script>

<template>
  <div class="h-screen bg-background text-foreground overflow-hidden flex flex-col">
    <!-- Top Navigation Bar -->
    <header class="h-12 flex-shrink-0 border-b border-border bg-card/50 flex items-center justify-between px-4">
      <!-- Logo & Nav -->
      <div class="flex items-center gap-1">
        <RouterLink
          to="/"
          class="flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors"
          :class="route.path === '/' ? 'bg-primary/10 text-primary' : 'hover:bg-muted'"
        >
          <LayoutDashboard class="w-4 h-4" />
          <span class="text-sm font-medium">概览</span>
        </RouterLink>
        <RouterLink
          to="/sessions"
          class="flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors"
          :class="route.path === '/sessions' ? 'bg-primary/10 text-primary' : 'hover:bg-muted'"
        >
          <History class="w-4 h-4" />
          <span class="text-sm font-medium">会话</span>
        </RouterLink>
        <RouterLink
          to="/live-sessions"
          class="flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors"
          :class="route.path === '/live-sessions' ? 'bg-primary/10 text-primary' : 'hover:bg-muted'"
        >
          <Terminal class="w-4 h-4" />
          <span class="text-sm font-medium">活跃会话</span>
        </RouterLink>
        <RouterLink
          to="/assets"
          class="flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors"
          :class="route.path.startsWith('/assets') ? 'bg-primary/10 text-primary' : 'hover:bg-muted'"
        >
          <FolderOpen class="w-4 h-4" />
          <span class="text-sm font-medium">资产</span>
        </RouterLink>
        <!-- Model Profile Selector -->
        <div class="relative">
          <button
            @click="showProfileDropdown = !showProfileDropdown"
            class="flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors"
            :class="route.path === '/model-profiles' ? 'bg-primary/10 text-primary' : 'hover:bg-muted'"
          >
            <Cpu class="w-4 h-4" />
            <span class="text-sm font-medium">{{ activeProfileName }}</span>
            <ChevronDown class="w-3 h-3 text-muted-foreground" />
          </button>

          <!-- Dropdown -->
          <Transition
            enter-active-class="transition ease-out duration-100"
            enter-from-class="transform opacity-0 scale-95"
            enter-to-class="transform opacity-100 scale-100"
            leave-active-class="transition ease-in duration-75"
            leave-from-class="transform opacity-100 scale-100"
            leave-to-class="transform opacity-0 scale-95"
          >
            <div
              v-if="showProfileDropdown"
              class="absolute left-0 mt-1 w-48 bg-card border border-border rounded-lg shadow-lg z-50 overflow-hidden"
            >
              <div class="max-h-48 overflow-y-auto">
                <button
                  v-for="profile in modelProfileStore.profiles"
                  :key="profile.id"
                  @click="activateProfile(profile.id)"
                  :disabled="modelProfileStore.activating"
                  class="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-muted transition-colors disabled:opacity-50"
                  :class="{ 'bg-primary/5': profile.isActive }"
                >
                  <div class="w-4 h-4 flex items-center justify-center">
                    <Check v-if="profile.isActive" class="w-3.5 h-3.5 text-primary" />
                  </div>
                  <span class="truncate flex-1">{{ profile.name }}</span>
                </button>
              </div>
              <div class="border-t border-border">
                <RouterLink
                  to="/model-profiles"
                  @click="showProfileDropdown = false"
                  class="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-muted transition-colors"
                >
                  <Settings class="w-4 h-4" />
                  <span>管理配置</span>
                </RouterLink>
              </div>
            </div>
          </Transition>

          <!-- Backdrop -->
          <div
            v-if="showProfileDropdown"
            class="fixed inset-0 z-40"
            @click="showProfileDropdown = false"
          />
        </div>
        <RouterLink
          to="/plugins"
          class="flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors"
          :class="route.path === '/plugins' ? 'bg-primary/10 text-primary' : 'hover:bg-muted'"
        >
          <Zap class="w-4 h-4" />
          <span class="text-sm font-medium">技能管理</span>
        </RouterLink>
        <RouterLink
          to="/settings"
          class="flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors"
          :class="route.path === '/settings' ? 'bg-primary/10 text-primary' : 'hover:bg-muted'"
        >
          <Settings class="w-4 h-4" />
          <span class="text-sm font-medium">设置</span>
        </RouterLink>
      </div>

      <!-- Search -->
      <button
        @click="globalSearchRef?.openSearch()"
        class="flex items-center gap-2 px-3 py-1.5 text-muted-foreground hover:text-foreground rounded-md hover:bg-muted transition-colors"
      >
        <Search class="w-4 h-4" />
        <span class="text-sm">搜索...</span>
        <kbd class="text-xs bg-muted px-1.5 py-0.5 rounded">⌘K</kbd>
      </button>
    </header>

    <!-- Main Content -->
    <main class="flex-1 overflow-hidden">
      <RouterView />
    </main>

    <!-- Global Search Modal -->
    <GlobalSearch ref="globalSearchRef" />

    <!-- Sync Toast -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition ease-out duration-300"
        enter-from-class="transform translate-y-full opacity-0"
        enter-to-class="transform translate-y-0 opacity-100"
        leave-active-class="transition ease-in duration-200"
        leave-from-class="transform translate-y-0 opacity-100"
        leave-to-class="transform translate-y-full opacity-0"
      >
        <div
          v-if="showSyncToast"
          class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-primary text-primary-foreground px-4 py-3 rounded-lg shadow-lg flex items-center gap-3"
        >
          <span class="text-sm font-medium">{{ syncMessage }}</span>
          <button
            @click="showSyncToast = false"
            class="p-1 hover:bg-primary-foreground/20 rounded transition-colors"
          >
            <X class="w-4 h-4" />
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style>
/* 全局样式优化 */
html {
  font-family:
    'Inter',
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    Roboto,
    'Helvetica Neue',
    Arial,
    sans-serif;
}

/* 确保代码使用等宽字体 */
pre,
code,
kbd,
samp {
  font-family:
    'JetBrains Mono',
    'Fira Code',
    'SF Mono',
    Monaco,
    'Cascadia Code',
    Consolas,
    'Liberation Mono',
    Menlo,
    monospace;
}
</style>
