import { defineStore } from 'pinia';
import { ref } from 'vue';
import { liveSessionsApi } from '../api/liveSessions';
import type {
  LiveSessionInfo,
  CreateLiveSessionRequest,
} from '../types/liveSession';

/**
 * 活跃 pty 会话的前端状态（纯内存，不写 localStorage）
 * 后端是单一事实来源，前端只缓存视图。
 */
export const useLiveSessionStore = defineStore('liveSession', () => {
  const liveSessions = ref<LiveSessionInfo[]>([]);
  const activeLiveId = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchList() {
    loading.value = true;
    error.value = null;
    try {
      liveSessions.value = await liveSessionsApi.list();
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch live sessions';
    } finally {
      loading.value = false;
    }
  }

  async function create(body: CreateLiveSessionRequest): Promise<LiveSessionInfo | null> {
    error.value = null;
    try {
      const info = await liveSessionsApi.create(body);
      // 直接 push 到本地列表，避免再拉一次
      liveSessions.value = [info, ...liveSessions.value];
      activeLiveId.value = info.liveId;
      return info;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create live session';
      return null;
    }
  }

  async function kill(liveId: string) {
    try {
      await liveSessionsApi.kill(liveId);
    } catch {
      // 即便后端 404，前端也清理掉
    }
    liveSessions.value = liveSessions.value.filter((s) => s.liveId !== liveId);
    if (activeLiveId.value === liveId) {
      activeLiveId.value = liveSessions.value[0]?.liveId ?? null;
    }
  }

  function selectActive(liveId: string | null) {
    activeLiveId.value = liveId;
  }

  /** 在 WS 收到 exit 帧后，把会话标为 exited（不立即从列表移除，由用户主动关闭） */
  function markExited(liveId: string, code: number) {
    const s = liveSessions.value.find((x) => x.liveId === liveId);
    if (s) {
      s.status = 'exited';
      s.exitCode = code;
      s.pid = null;
    }
  }

  return {
    liveSessions,
    activeLiveId,
    loading,
    error,
    fetchList,
    create,
    kill,
    selectActive,
    markExited,
  };
});
