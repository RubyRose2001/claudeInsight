/** 活跃会话类型，与后端 backend/src/types/liveSession.ts 对应 */

export type LiveSessionStatus = 'running' | 'exited';

export interface LiveSessionInfo {
  liveId: string;
  sessionUuid: string;
  projectPath: string;
  encodedProjectPath: string;
  pid: number | null;
  cols: number;
  rows: number;
  createdAt: string;
  status: LiveSessionStatus;
  exitCode?: number;
  resumedFrom?: string;
}

export interface CreateLiveSessionRequest {
  projectPath: string;
  /** 可选：~/.claude/projects/ 下的编码目录名，用于 cwd 解析回退 */
  encodedProjectPath?: string;
  resumeSessionId?: string;
  cols?: number;
  rows?: number;
}

export type LiveSessionDownMessage =
  | { type: 'ready'; info: LiveSessionInfo }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number };

export type LiveSessionUpMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };
