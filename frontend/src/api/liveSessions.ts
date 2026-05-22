import { api } from './index';
import type {
  LiveSessionInfo,
  CreateLiveSessionRequest,
} from '../types/liveSession';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';

/** 创建活跃会话，失败时把后端 JSON 里的 error 字段作为 Error.message 抛出 */
async function createLiveSession(body: CreateLiveSessionRequest): Promise<LiveSessionInfo> {
  const res = await fetch(`${API_BASE}/api/live-sessions`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // ignore
  }
  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return parsed as LiveSessionInfo;
}

export const liveSessionsApi = {
  list: () => api.get<LiveSessionInfo[]>('/api/live-sessions'),
  get: (id: string) => api.get<LiveSessionInfo>(`/api/live-sessions/${id}`),
  create: createLiveSession,
  kill: (id: string) =>
    api.delete<{ success: boolean }>(`/api/live-sessions/${id}`),
};

/** 打开 WebSocket 连接到指定 live session */
export function openLiveSessionWs(liveId: string): WebSocket {
  const base = API_BASE.replace(/^http/, 'ws');
  return new WebSocket(`${base}/api/live-sessions/${liveId}/ws`);
}

