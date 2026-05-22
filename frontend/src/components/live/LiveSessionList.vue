<script setup lang="ts">
import { computed, ref } from 'vue';
import { Plus, Loader2, Zap } from 'lucide-vue-next';
import { useLiveSessionStore } from '@/stores/liveSessionStore';
import { useConversationStore } from '@/stores/conversationStore';
import type { LiveSessionInfo } from '@/types/liveSession';

const props = defineProps<{
  projectPath: string | null;
  encodedProjectPath: string | null;
}>();

const liveSessionStore = useLiveSessionStore();
const conversationStore = useConversationStore();

const creating = ref(false);
const createError = ref<string | null>(null);

interface MergedItem {
  sessionId: string;          // sessionUuid 或 history sessionId(同一值)
  title?: string;
  lastModified: string;
  live: LiveSessionInfo | null;
}

const mergedItems = computed<MergedItem[]>(() => {
  if (!props.encodedProjectPath) return [];

  const projectActive = liveSessionStore.liveSessions.filter(
    (s) => s.encodedProjectPath === props.encodedProjectPath,
  );
  const liveByUuid = new Map(projectActive.map((s) => [s.sessionUuid, s]));

  const fromHistory: MergedItem[] = [];
  for (const s of conversationStore.sessions) {
    const live = liveByUuid.get(s.sessionId) ?? null;
    fromHistory.push({
      sessionId: s.sessionId,
      title: s.title,
      lastModified: s.lastModified,
      live,
    });
    if (live) liveByUuid.delete(s.sessionId);
  }

  // 落单的活跃会话(历史里还没出现的新 pty)放最前
  const orphans: MergedItem[] = Array.from(liveByUuid.values()).map((live) => ({
    sessionId: live.sessionUuid,
    lastModified: live.createdAt,
    live,
  }));
  orphans.sort(
    (a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
  );
  fromHistory.sort(
    (a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
  );

  return [...orphans, ...fromHistory.slice(0, 50)];
});

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  return `${d}天前`;
}

function isActive(item: MergedItem): boolean {
  return !!item.live && item.live.liveId === liveSessionStore.activeLiveId;
}

async function activate(item: MergedItem) {
  if (item.live) {
    liveSessionStore.selectActive(item.live.liveId);
    return;
  }
  if (!props.projectPath || creating.value) return;
  creating.value = true;
  createError.value = null;
  const info = await liveSessionStore.create({
    projectPath: props.projectPath,
    encodedProjectPath: props.encodedProjectPath ?? undefined,
    resumeSessionId: item.sessionId,
  });
  creating.value = false;
  if (!info) {
    createError.value = liveSessionStore.error;
  }
}

async function createNew() {
  if (!props.projectPath || creating.value) return;
  creating.value = true;
  createError.value = null;
  const info = await liveSessionStore.create({
    projectPath: props.projectPath,
    encodedProjectPath: props.encodedProjectPath ?? undefined,
  });
  creating.value = false;
  if (!info) {
    createError.value = liveSessionStore.error;
  }
}
</script>

<template>
  <aside class="flex flex-col overflow-hidden">
    <div class="flex items-center justify-between px-3 py-2 border-b border-border">
      <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        会话
      </span>
      <button
        @click="createNew"
        :disabled="!projectPath || creating"
        class="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title="在此项目新建会话"
      >
        <Loader2 v-if="creating" class="w-3 h-3 animate-spin" />
        <Plus v-else class="w-3 h-3" />
        新建
      </button>
    </div>

    <div v-if="createError" class="px-3 py-2 text-xs text-destructive bg-destructive/10">
      {{ createError }}
    </div>

    <div
      v-if="!projectPath"
      class="flex-1 flex items-center justify-center text-xs text-muted-foreground p-4 text-center"
    >
      请先在左侧选择项目
    </div>

    <div v-else-if="mergedItems.length === 0" class="flex-1 flex items-center justify-center text-xs text-muted-foreground p-4 text-center">
      暂无会话,点上方"新建"
    </div>

    <div v-else class="flex-1 overflow-y-auto">
      <button
        v-for="item in mergedItems"
        :key="item.sessionId"
        @click="activate(item)"
        :disabled="creating"
        class="w-full flex items-start gap-2 px-3 py-2 text-left transition-colors border-l-2 disabled:opacity-50"
        :class="
          isActive(item)
            ? 'bg-primary/10 border-primary'
            : 'border-transparent hover:bg-muted'
        "
      >
        <!-- 状态点:running 绿、exited 灰、纯历史 透明占位 -->
        <span
          class="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
          :class="
            item.live
              ? item.live.status === 'running'
                ? 'bg-emerald-500'
                : 'bg-muted-foreground/40'
              : 'bg-transparent border border-muted-foreground/30'
          "
        ></span>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-medium truncate flex items-center gap-1.5">
            <span class="truncate">{{ item.title || shortId(item.sessionId) }}</span>
            <span
              v-if="isActive(item)"
              class="flex items-center gap-0.5 text-[10px] px-1 py-px rounded bg-primary/20 text-primary font-medium flex-shrink-0"
            >
              <Zap class="w-2.5 h-2.5" />
              激活
            </span>
          </div>
          <div class="text-[11px] text-muted-foreground">
            {{ relativeTime(item.lastModified) }}
            <span v-if="item.live && item.live.status === 'exited'">
              · exit {{ item.live.exitCode ?? '?' }}
            </span>
            <span v-else-if="item.live && item.live.resumedFrom"> · resumed </span>
          </div>
        </div>
      </button>
    </div>
  </aside>
</template>
