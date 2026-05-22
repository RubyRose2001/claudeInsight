/**
 * LiveSessionManager - 活跃 pty 会话的内存管理器
 * 仅在后端进程内存中维护 pty 子进程清单，无持久化
 * 进程退出时（SIGINT/SIGTERM）所有 pty 都会被回收
 */

import { spawn as ptySpawn, IPty } from 'node-pty';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'fs';
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
 * 扫描 nvm/fnm/n 等 node 版本管理器下安装的 claude bin 目录。
 * 按目录 mtime 倒序返回（最近用过的版本优先）。仅作为登录 shell 探测失败后的兜底。
 */
function listNodeVersionManagerBins(home: string): string[] {
  const roots = [
    `${home}/.nvm/versions/node`,
    `${home}/.fnm/node-versions`,
    `${home}/.local/share/fnm/node-versions`,
    `${home}/Library/Application Support/fnm/node-versions`,
    `${home}/n/versions/node`,
    '/usr/local/n/versions/node',
  ];
  const found: { path: string; mtime: number }[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let versions: string[];
    try {
      versions = readdirSync(root);
    } catch {
      continue;
    }
    for (const v of versions) {
      // fnm 的目录结构是 versions/<v>/installation/bin，nvm/n 是 versions/<v>/bin
      const binCandidates = [join(root, v, 'bin'), join(root, v, 'installation', 'bin')];
      for (const bin of binCandidates) {
        if (!existsSync(bin)) continue;
        try {
          const st = statSync(bin);
          found.push({ path: bin, mtime: st.mtimeMs });
        } catch {
          // ignore
        }
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.map((x) => x.path);
}

/**
 * 一次性从用户登录 shell 中提取真实 PATH（缓存，避免每次 spawn 都跑 shell）。
 * 思路：让 zsh/bash/fish 以登录+交互模式启动并 echo 出 PATH，
 * 这样无论 claude 装在 nvm/fnm/volta/brew/npm-global 哪里，
 * 只要用户在终端能跑通 `claude`，这里都能解析到。
 *
 * 注意：用户 rc 文件可能很重（nvm/conda/starship 等），所以超时给到 8s，
 * 但只在第一次调用时跑一次，后续走 cache。
 * 失败时返回 null，外层会落到候选目录兜底，不影响功能。
 */
let cachedLoginPath: string | null | undefined;
function getLoginShellPath(): string | null {
  if (cachedLoginPath !== undefined) return cachedLoginPath;
  if (platform() === 'win32') {
    cachedLoginPath = null;
    return null;
  }
  const shell = process.env.SHELL || '/bin/zsh';
  const marker = '__CLAUDE_INSIGHT_PATH__';
  const cmd = `echo "${marker}$PATH${marker}"`;
  try {
    const out = execSync(`${shell} -ilc ${JSON.stringify(cmd)} </dev/null`, {
      encoding: 'utf-8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(new RegExp(`${marker}(.*?)${marker}`));
    if (m && m[1]) {
      cachedLoginPath = m[1];
      return cachedLoginPath;
    }
  } catch {
    // 登录 shell 不可用（容器、缺 SHELL、rc 卡死等），落到兜底
  }
  cachedLoginPath = null;
  return null;
}

/**
 * 给 pty 子进程构造增强的环境变量。
 * 优先把登录 shell 的真实 PATH 合并进来，让 backend 即便从 Electron/launchd 启动
 * （非登录 shell 环境），也能拿到用户终端里的完整 PATH。
 */
function buildSpawnEnv(): { [key: string]: string } {
  const env = { ...process.env } as { [key: string]: string };
  if (platform() === 'win32') return env;
  const home = env.HOME || '';
  const current = (env.PATH || '').split(':').filter(Boolean);
  const loginPath = (getLoginShellPath() || '').split(':').filter(Boolean);
  const fallbacks = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.bun/bin`,
    `${home}/.volta/bin`,
    ...listNodeVersionManagerBins(home),
  ];
  env.PATH = Array.from(new Set([...current, ...loginPath, ...fallbacks])).join(':');
  return env;
}

/**
 * 把 `claude` 解析成绝对路径，避免 node-pty 的 posix_spawnp 在某些情况下找不到二进制。
 * 解析顺序（结果缓存）：
 *   1) 在增强 env（含 nvm/brew/volta 候选）下用 /bin/sh 的 `command -v` —— 命中即返回，毫秒级
 *   2) 登录 shell 的 `command -v claude` —— 覆盖用户 alias 或非标准安装位置，但启动慢，作为兜底
 *   3) 硬编码候选目录 —— 用于 shell 完全不可用的场景
 * 都失败则返回字符串 `'claude'`，让 ptySpawn 自己再试一次。
 */
let cachedClaudeCmd: string | undefined;
function resolveClaudeCmd(env: { [key: string]: string }): string {
  if (cachedClaudeCmd !== undefined) return cachedClaudeCmd;
  if (platform() === 'win32') {
    cachedClaudeCmd = 'claude.cmd';
    return cachedClaudeCmd;
  }
  try {
    const out = execSync('command -v claude', {
      encoding: 'utf-8',
      env,
      shell: '/bin/sh',
    }).trim();
    if (out && existsSync(out)) {
      cachedClaudeCmd = out;
      return cachedClaudeCmd;
    }
  } catch {
    // 落到下一步
  }
  const shell = process.env.SHELL;
  if (shell) {
    try {
      const out = execSync(`${shell} -ilc 'command -v claude' </dev/null`, {
        encoding: 'utf-8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().split('\n').pop()?.trim() || '';
      if (out && existsSync(out)) {
        cachedClaudeCmd = out;
        return cachedClaudeCmd;
      }
    } catch {
      // 登录 shell 不可用，落到下一步
    }
  }
  const home = env.HOME || '';
  const staticCandidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${home}/.local/bin/claude`,
    `${home}/.npm-global/bin/claude`,
    `${home}/.bun/bin/claude`,
    `${home}/.volta/bin/claude`,
  ];
  const nvmCandidates = listNodeVersionManagerBins(home).map((bin) => join(bin, 'claude'));
  for (const p of [...staticCandidates, ...nvmCandidates]) {
    if (existsSync(p)) {
      cachedClaudeCmd = p;
      return cachedClaudeCmd;
    }
  }
  cachedClaudeCmd = 'claude';
  return cachedClaudeCmd;
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
