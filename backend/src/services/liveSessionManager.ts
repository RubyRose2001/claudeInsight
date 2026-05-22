/**
 * LiveSessionManager - 活跃 pty 会话的内存管理器
 * 仅在后端进程内存中维护 pty 子进程清单，无持久化
 * 进程退出时（SIGINT/SIGTERM）所有 pty 都会被回收
 */

import { spawn as ptySpawn, IPty } from 'node-pty';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { createReadStream, existsSync, readdirSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { platform } from 'os';
import { fileScanner } from './fileScanner.js';
import { pathService } from './pathService.js';
import type {
  LiveSessionInfo,
  CreateLiveSessionRequest,
} from '../types/liveSession.js';

interface PtyHandle {
  pty: IPty;
  info: LiveSessionInfo;
  emitter: EventEmitter;
  /** 近期 pty 输出的滚动缓冲，给后续接入的 WS 连接 replay 用 */
  outputBuffer: string;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
/** 单会话输出缓冲上限（字节）。够覆盖几屏 TUI 全量重绘 + 启动模式序列。 */
const OUTPUT_BUFFER_LIMIT = 256 * 1024;

/**
 * 给 pty 子进程构造增强的环境变量。
 * macOS 上若 backend 不是从登录 shell 启动（例如 Electron 双击启动），
 * PATH 通常很短，找不到通过 brew / npm / volta / bun 安装的 `claude`，
 * 进而触发 `posix_spawnp failed.`。这里把常见安装目录补进 PATH。
 */
function buildSpawnEnv(): { [key: string]: string } {
  const env = { ...process.env } as { [key: string]: string };
  if (platform() === 'win32') return env;
  const home = env.HOME || '';
  const extras = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.bun/bin`,
    `${home}/.volta/bin`,
  ];
  const current = (env.PATH || '').split(':').filter(Boolean);
  env.PATH = Array.from(new Set([...current, ...extras])).join(':');
  return env;
}

/**
 * 把 `claude` 解析成绝对路径，避免 node-pty 的 posix_spawnp 找不到二进制。
 * 找不到时回退到字符串 `claude`，让 ptySpawn 自己再试一次。
 */
function resolveClaudeCmd(env: { [key: string]: string }): string {
  if (platform() === 'win32') return 'claude.cmd';
  try {
    const out = execSync('command -v claude', {
      encoding: 'utf-8',
      env,
      shell: '/bin/sh',
    }).trim();
    if (out && existsSync(out)) return out;
  } catch {
    // 落到候选路径
  }
  const home = env.HOME || '';
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${home}/.local/bin/claude`,
    `${home}/.npm-global/bin/claude`,
    `${home}/.bun/bin/claude`,
    `${home}/.volta/bin/claude`,
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'claude';
}

export class LiveSessionManager {
  private static instance: LiveSessionManager;
  private sessions = new Map<string, PtyHandle>();

  private constructor() {}

  static getInstance(): LiveSessionManager {
    if (!LiveSessionManager.instance) {
      LiveSessionManager.instance = new LiveSessionManager();
    }
    return LiveSessionManager.instance;
  }

  /**
   * 从 ~/.claude/projects/<encoded>/ 下任意 jsonl 中提取 cwd 字段
   * 用于 projectPath 无效时的回退（前端拿到的 path 因 decodeProjectPath 不可逆，
   * 在含中文/冒号的真实路径上往往无效）。
   */
  private async resolveCwdFromJsonl(encodedProjectPath: string): Promise<string | null> {
    const dir = join(pathService.getHistoryPath(), encodedProjectPath);
    if (!existsSync(dir)) return null;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return null;
    }
    for (const file of entries) {
      const fullPath = join(dir, file);
      const cwd = await this.extractCwdFromFile(fullPath);
      if (cwd && existsSync(cwd)) return cwd;
    }
    return null;
  }

  private extractCwdFromFile(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (v: string | null) => {
        if (resolved) return;
        resolved = true;
        try {
          rl.close();
          stream.destroy();
        } catch {
          // ignore
        }
        resolve(v);
      };
      const stream = createReadStream(filePath, { encoding: 'utf-8' });
      const rl = createInterface({ input: stream });
      let linesRead = 0;
      rl.on('line', (line) => {
        linesRead++;
        try {
          const obj = JSON.parse(line);
          if (typeof obj.cwd === 'string' && obj.cwd.length > 0) {
            done(obj.cwd);
            return;
          }
        } catch {
          // ignore
        }
        // 只看前 10 行，cwd 通常在最早的 user 消息里
        if (linesRead >= 10) done(null);
      });
      rl.on('close', () => done(null));
      stream.on('error', () => done(null));
    });
  }

  /**
   * 创建一个新的 pty，执行 `claude` 命令
   * - 新建：仅传 --session-id <uuid>
   * - Resume：传 --resume <oldId>，sessionUuid 即 oldId（继续写入原 jsonl）
   */
  async create(opts: CreateLiveSessionRequest): Promise<LiveSessionInfo> {
    const { projectPath, resumeSessionId, encodedProjectPath } = opts;

    if (!projectPath) {
      throw new Error('projectPath is required');
    }

    // cwd 解析：优先信任 projectPath，失败则用 encodedProjectPath 从历史 jsonl 解析
    let cwd = projectPath;
    if (!existsSync(cwd)) {
      const encoded = encodedProjectPath || fileScanner.encodeProjectPath(projectPath);
      const fallback = await this.resolveCwdFromJsonl(encoded);
      if (fallback) {
        cwd = fallback;
      } else {
        throw new Error(
          `projectPath not found on disk: ${projectPath}. ` +
          `Hint: this project's encoded directory has no usable jsonl to recover the real path. ` +
          `Please provide an absolute existing path.`,
        );
      }
    }

    const liveId = randomUUID();
    const cols = opts.cols && opts.cols > 0 ? opts.cols : DEFAULT_COLS;
    const rows = opts.rows && opts.rows > 0 ? opts.rows : DEFAULT_ROWS;
    const encodedPath = fileScanner.encodeProjectPath(cwd);

    // 决定 sessionUuid 与 argv
    let sessionUuid: string;
    const argv: string[] = [];
    if (resumeSessionId) {
      sessionUuid = resumeSessionId;
      argv.push('--resume', resumeSessionId);
    } else {
      sessionUuid = randomUUID();
      argv.push('--session-id', sessionUuid);
    }

    const spawnEnv = buildSpawnEnv();
    const resolvedCmd = resolveClaudeCmd(spawnEnv);

    let pty: IPty;
    try {
      pty = ptySpawn(resolvedCmd, argv, {
        name: 'xterm-color',
        cols,
        rows,
        cwd,
        env: spawnEnv,
      });
    } catch (e) {
      const orig = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to launch claude CLI. ` +
        `Tried command: ${resolvedCmd}. ` +
        `Make sure 'claude' is installed (e.g. via npm i -g @anthropic-ai/claude-code) ` +
        `and that the binary is on PATH. ` +
        `Original error: ${orig}`,
      );
    }

    const emitter = new EventEmitter();
    emitter.setMaxListeners(0); // 多个 WS 连接同一会话时不告警

    const info: LiveSessionInfo = {
      liveId,
      sessionUuid,
      projectPath: cwd,
      encodedProjectPath: encodedPath,
      pid: pty.pid,
      cols,
      rows,
      createdAt: new Date().toISOString(),
      status: 'running',
      resumedFrom: resumeSessionId,
    };

    const handle: PtyHandle = { pty, info, emitter, outputBuffer: '' };
    this.sessions.set(liveId, handle);

    pty.onData((data) => {
      // 累加到滚动缓冲；超出上限时只保留后半段。
      // 切 tab 时新连接的 WS 会 replay 这份缓冲，让 xterm 把屏幕（光标位置、
      // alt buffer、mouse reporting 等模式）追到 Claude Code 当前的状态。
      handle.outputBuffer += data;
      if (handle.outputBuffer.length > OUTPUT_BUFFER_LIMIT) {
        handle.outputBuffer = handle.outputBuffer.slice(-OUTPUT_BUFFER_LIMIT);
      }
      emitter.emit('data', data);
    });

    pty.onExit(({ exitCode }) => {
      info.status = 'exited';
      info.exitCode = exitCode;
      info.pid = null;
      emitter.emit('exit', exitCode);
    });

    return info;
  }

  list(): LiveSessionInfo[] {
    return Array.from(this.sessions.values()).map((h) => h.info);
  }

  get(liveId: string): PtyHandle | null {
    return this.sessions.get(liveId) ?? null;
  }

  getInfo(liveId: string): LiveSessionInfo | null {
    return this.sessions.get(liveId)?.info ?? null;
  }

  resize(liveId: string, cols: number, rows: number): boolean {
    const handle = this.sessions.get(liveId);
    if (!handle || handle.info.status !== 'running') return false;
    try {
      handle.pty.resize(cols, rows);
      handle.info.cols = cols;
      handle.info.rows = rows;
      return true;
    } catch {
      return false;
    }
  }

  write(liveId: string, data: string): boolean {
    const handle = this.sessions.get(liveId);
    if (!handle || handle.info.status !== 'running') return false;
    handle.pty.write(data);
    return true;
  }

  /**
   * 终止 pty。如果已经退出则只清理映射。
   * 删除前会触发 onExit，由 onExit 标记 status
   */
  kill(liveId: string): boolean {
    const handle = this.sessions.get(liveId);
    if (!handle) return false;
    if (handle.info.status === 'running') {
      try {
        handle.pty.kill();
      } catch {
        // ignore
      }
    }
    this.sessions.delete(liveId);
    return true;
  }

  /**
   * 进程退出时统一回收所有 pty
   */
  killAll(): void {
    for (const [liveId, handle] of this.sessions) {
      if (handle.info.status === 'running') {
        try {
          handle.pty.kill();
        } catch {
          // ignore
        }
      }
      this.sessions.delete(liveId);
    }
  }
}

export const liveSessionManager = LiveSessionManager.getInstance();
