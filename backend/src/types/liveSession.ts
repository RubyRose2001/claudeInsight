/**
 * 活跃会话（live session）相关类型
 * 仅在后端进程内存中维护，不做任何持久化
 */

export type LiveSessionStatus = 'running' | 'exited';

export interface LiveSessionInfo {
  /** 内部 ID，前端用来定位会话（uuid v4） */
  liveId: string;
  /** 传给 claude CLI 的 --session-id，等于 ~/.claude/projects 下 jsonl 文件名 */
  sessionUuid: string;
  /** pty 的工作目录（用户的真实代码目录） */
  projectPath: string;
  /** ~/.claude/projects/ 下对应的目录名（编码后） */
  encodedProjectPath: string;
  /** pty 子进程 pid */
  pid: number | null;
  cols: number;
  rows: number;
  /** ISO 时间字符串 */
  createdAt: string;
  status: LiveSessionStatus;
  exitCode?: number;
  /** 若是 resume 启动，记录原 sessionId */
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

/** WebSocket 下行消息（后端 → 前端） */
export type LiveSessionDownMessage =
  | { type: 'ready'; info: LiveSessionInfo }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number };

/** WebSocket 上行消息（前端 → 后端） */
export type LiveSessionUpMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };
