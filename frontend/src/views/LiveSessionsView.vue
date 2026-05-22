<script setup lang="ts">
import { onMounted, computed, watch, ref } from 'vue';
import { useProjectStore } from '@/stores/projectStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useLiveSessionStore } from '@/stores/liveSessionStore';
import LiveSessionList from '@/components/live/LiveSessionList.vue';
import TerminalPanel from '@/components/live/TerminalPanel.vue';
import DirectoryPickerModal from '@/components/live/DirectoryPickerModal.vue';
import { Terminal, FolderOpen, Plus, X, FolderPlus } from 'lucide-vue-next';
import type { LiveSessionInfo } from '@/types/liveSession';

const projectStore = useProjectStore();
const conversationStore = useConversationStore();
const liveSessionStore = useLiveSessionStore();

const currentEncodedPath = ref<string | null>(null);
const pickerOpen = ref(false);
const newProjectError = ref<string | null>(null);

const currentProject = computed(() =>
  currentEncodedPath.value
    ? projectStore.projects.find((p) => p.encodedPath === currentEncodedPath.value) ?? null
    : null,
);

onMounted(async () => {
  await Promise.all([
    projectStore.fetchProjects(),
    liveSessionStore.fetchList(),
  ]);
  // 默认选第一个有活跃 pty 的项目；否则第一个项目
  const firstActive = liveSessionStore.liveSessions[0];
  if (firstActive) {
    currentEncodedPath.value = firstActive.encodedProjectPath;
    liveSessionStore.selectActive(firstActive.liveId);
  } else if (projectStore.projects.length > 0) {
    currentEncodedPath.value = projectStore.projects[0].encodedPath;
  }
});

watch(currentEncodedPath, async (encoded) => {
  if (encoded) {
    await conversationStore.fetchProjectSessions(encoded);
  } else {
    conversationStore.sessions = [];
  }
});

// 当 activeLiveId 变化时(例如外部新建/关闭),联动左侧项目选中态
watch(
  () => liveSessionStore.activeLiveId,
  (id) => {
    if (!id) return;
    const ls = liveSessionStore.liveSessions.find((s) => s.liveId === id);
    if (ls && ls.encodedProjectPath !== currentEncodedPath.value) {
      currentEncodedPath.value = ls.encodedProjectPath;
    }
  },
);

function selectProject(encodedPath: string | null) {
  currentEncodedPath.value = encodedPath;
}

function tabTitle(ls: LiveSessionInfo): string {
  const proj = projectStore.projects.find((p) => p.encodedPath === ls.encodedProjectPath);
  const name =
    proj?.name ?? ls.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? 'session';
  const sameProject = liveSessionStore.liveSessions.filter(
    (x) => x.encodedProjectPath === ls.encodedProjectPath,
  );
  if (sameProject.length > 1) {
    const idx = sameProject.findIndex((x) => x.liveId === ls.liveId) + 1;
    return `${name} #${idx}`;
  }
  return name;
}

function selectTab(ls: LiveSessionInfo) {
  currentEncodedPath.value = ls.encodedProjectPath;
  liveSessionStore.selectActive(ls.liveId);
}

async function closeTab(ls: LiveSessionInfo) {
  await liveSessionStore.kill(ls.liveId);
}

async function newSessionInCurrentProject() {
  if (!currentProject.value) return;
  await liveSessionStore.create({
    projectPath: currentProject.value.path,
    encodedProjectPath: currentProject.value.encodedPath,
  });
}

/**
 * 用户从 DirectoryPickerModal 选中一个目录后:
 *   1. 在该目录创建 live session(后端会 spawn claude,首条 jsonl 写出后 ~/.claude/projects/<encoded>/ 才存在)
 *   2. 重新拉一次项目列表,新项目就会出现在左侧栏
 *   3. 选中这个新项目
 * 这里不预先 fileScanner.encodeProjectPath —— 后端 liveSessionManager 会自己 encode。
 */
async function createSessionInNewDirectory(projectPath: string) {
  newProjectError.value = null;
  const info = await liveSessionStore.create({ projectPath });
  if (!info) {
    newProjectError.value = liveSessionStore.error ?? '创建失败';
    return;
  }
  // 项目目录在 claude 首次写 jsonl 后才出现,先尝试刷一次;
  // 即便此刻还没出现,liveSessionStore 已经把活跃会话挂在 encodedProjectPath 上,
  // tab 栏可见,后续刷新会补齐项目栏。
  await projectStore.fetchProjects();
  currentEncodedPath.value = info.encodedProjectPath;
}
</script>

<template>
  <div class="flex h-full">
      <!-- 项目栏（复用现有 projectStore） -->
      <aside
        class="w-56 flex-shrink-0 border-r border-border bg-card/30 flex flex-col overflow-hidden"
      >
        <div class="flex items-center justify-between p-3 border-b border-border">
          <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            项目
          </span>
          <button
            @click="pickerOpen = true"
            class="p-1 rounded-md hover:bg-muted text-muted-foreground transition-colors"
            title="新建项目(选择一个目录)"
          >
            <FolderPlus class="w-4 h-4" />
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-2 space-y-0.5">
          <button
            v-for="project in projectStore.projects"
            :key="project.encodedPath"
            @click="selectProject(project.encodedPath)"
            class="w-full flex items-start gap-2 px-2 py-1.5 rounded-md transition-colors text-left group"
            :class="
              currentEncodedPath === project.encodedPath
                ? 'bg-primary/10 text-primary'
                : 'hover:bg-muted'
            "
          >
            <FolderOpen class="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate">{{ project.name }}</div>
              <div class="text-xs text-muted-foreground">
                {{ project.sessionCount }} 个会话
              </div>
            </div>
          </button>
          <div
            v-if="projectStore.projects.length === 0 && !projectStore.loading"
            class="text-xs text-muted-foreground px-2 py-4 text-center"
          >
            暂无项目,点击右上角 + 选择目录开始
          </div>
        </div>
        <div
          v-if="newProjectError"
          class="mx-2 mb-2 px-2 py-1.5 rounded-md bg-destructive/10 text-destructive text-xs break-all"
        >
          {{ newProjectError }}
        </div>
      </aside>

      <!-- 会话列表（活跃 + 历史） -->
      <LiveSessionList
        class="w-72 flex-shrink-0 border-r border-border bg-card/20"
        :project-path="currentProject?.path ?? null"
        :encoded-project-path="currentEncodedPath"
      />

      <!-- 终端区:tab 栏 + 终端 -->
      <main class="flex flex-col flex-1 overflow-hidden bg-background">
        <!-- Tab 栏(跨项目活跃会话),贴在终端正上方 -->
        <div
          v-if="liveSessionStore.liveSessions.length > 0"
          class="flex-shrink-0 border-b border-border bg-card/30 px-2 py-1.5 flex items-center gap-1 overflow-x-auto"
        >
          <button
            v-for="ls in liveSessionStore.liveSessions"
            :key="ls.liveId"
            @click="selectTab(ls)"
            class="group flex items-center gap-2 px-3 py-1.5 rounded-md text-sm whitespace-nowrap transition-colors border max-w-[240px]"
            :class="
              ls.liveId === liveSessionStore.activeLiveId
                ? 'bg-primary/10 text-primary border-primary/30'
                : 'hover:bg-muted text-muted-foreground border-transparent'
            "
          >
            <span
              class="w-1.5 h-1.5 rounded-full flex-shrink-0"
              :class="ls.status === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/40'"
            ></span>
            <span class="truncate">{{ tabTitle(ls) }}</span>
            <X
              class="w-3.5 h-3.5 opacity-50 hover:opacity-100 hover:text-destructive flex-shrink-0"
              @click.stop="closeTab(ls)"
            />
          </button>
          <button
            v-if="currentProject"
            @click="newSessionInCurrentProject"
            class="p-1.5 rounded-md hover:bg-muted text-muted-foreground flex-shrink-0"
            title="在当前项目新建会话"
          >
            <Plus class="w-4 h-4" />
          </button>
        </div>

        <div class="flex-1 overflow-hidden">
          <TerminalPanel
            v-if="liveSessionStore.activeLiveId"
            :key="liveSessionStore.activeLiveId"
            :live-id="liveSessionStore.activeLiveId"
          />
          <div
            v-else
            class="h-full flex flex-col items-center justify-center text-muted-foreground"
          >
            <Terminal class="w-12 h-12 mb-3 opacity-30" />
            <div class="text-sm">从左侧选择或新建一个会话</div>
          </div>
        </div>
      </main>
    </div>

    <DirectoryPickerModal
      v-model:open="pickerOpen"
      @select="createSessionInNewDirectory"
    />
</template>
