import { readdirSync, statSync, existsSync, readFileSync, openSync, readSync, closeSync } from 'fs';
import { createReadStream } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { pathService } from './pathService.js';
import type {
  SessionType,
  SessionInfo,
  SessionDetail,
  ProjectInfo,
  ParsedMessage,
  ContentBlock,
  JsonlMessage,
  MessageType,
  MessageImage,
  FlattenedEntry,
  SessionMetrics,
  ProjectMetrics,
} from '../types/session.js';

/**
 * UUID 正则匹配
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// 消息分类模式定义
// ============================================================================

/**
 * 用户中断信号模式 - 最高优先级
 */
const INTERRUPT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^\[Request interrupted by user/i, label: '用户中断' },
  { pattern: /^The user doesn't want to proceed/i, label: '用户拒绝' },
  { pattern: /^The user has rejected/i, label: '用户拒绝' },
  { pattern: /^was rejected.*STOP/i, label: '工具被拒' },
  { pattern: /tool use was rejected/i, label: '工具被拒' },
  { pattern: /^<task-notification>/i, label: '任务通知' },
  { pattern: /^<system-reminder>/i, label: '系统提醒' },
  { pattern: /^Task stopped/i, label: '任务停止' },
  { pattern: /^Background command.*completed/i, label: '后台完成' },
  { pattern: /^\[Task #\d+\]/i, label: '任务状态' },
  { pattern: /^Read the output file/i, label: '读取输出' },
];

/**
 * 系统注入指令模式
 */
const SYSTEM_INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^Entered plan mode/i, label: '进入计划模式' },
  { pattern: /^Exited plan mode/i, label: '退出计划模式' },
  { pattern: /^Plan mode note:/i, label: '计划模式说明' },
  { pattern: /^Use this tool proactively/i, label: '工具指令' },
  { pattern: /^When using this tool/i, label: '工具指令' },
  { pattern: /^You have access to/i, label: '权限说明' },
  { pattern: /^Tool usage policy/i, label: '工具策略' },
  { pattern: /^This tool provides/i, label: '工具说明' },
  { pattern: /^Toolkit for/i, label: '工具说明' },
  { pattern: /^Use this skill when/i, label: '技能说明' },
  { pattern: /^Use this tool whenever/i, label: '工具说明' },
  { pattern: /^Use this tool any time/i, label: '工具说明' },
  { pattern: /^IMPORTANT:/i, label: '重要提示' },
  { pattern: /^As you answer/i, label: '行为指令' },
  { pattern: /^You are Claude Code/i, label: '身份说明' },
  { pattern: /^You are an interactive CLI/i, label: '身份说明' },
  { pattern: /^I'm ready to help/i, label: '就绪提示' },
  { pattern: /^I cannot (browse|access|read|generate)/i, label: '能力限制' },
  { pattern: /^I don't have (access|the ability)/i, label: '能力限制' },
  { pattern: /^I apologize/i, label: '道歉' },
  { pattern: /^Let me (help|check|read|look)/i, label: '行动提示' },
  { pattern: /^Here is useful information/i, label: '上下文信息' },
  { pattern: /^Code References/i, label: '代码参考' },
  { pattern: /^Doing tasks/i, label: '任务说明' },
  { pattern: /^Asking questions as you work/i, label: '交互说明' },
  { pattern: /^The following skills are available/i, label: '技能列表' },
  { pattern: /^Guide for creating/i, label: '创建指南' },
  { pattern: /^Best practices for/i, label: '最佳实践' },
  { pattern: /^Analyzes video content/i, label: '工具说明' },
  { pattern: /^Diagnose and analyze/i, label: '工具说明' },
  { pattern: /^Extract and recognize/i, label: '工具说明' },
  { pattern: /^Convert UI screenshots/i, label: '工具说明' },
  { pattern: /^Compare two UI/i, label: '工具说明' },
  { pattern: /^Analyze and explain/i, label: '工具说明' },
  { pattern: /^Get the directory/i, label: '工具说明' },
  { pattern: /^Read the full/i, label: '工具说明' },
  { pattern: /^Search documentation/i, label: '工具说明' },
  { pattern: /^General-purpose image/i, label: '工具说明' },
  { pattern: /^Set of resources/i, label: '资源说明' },
  { pattern: /^Fetch and Convert/i, label: '工具说明' },
  { pattern: /^Search web information/i, label: '工具说明' },
];

/**
 * 工具调用结果特征
 */
const TOOL_RESULT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^Tool output:/i, label: '工具输出' },
  { pattern: /^function_results/i, label: '函数结果' },
  { pattern: /^tool_result/i, label: '工具结果' },
  { pattern: /^Result:$/i, label: '执行结果' },
  { pattern: /^Output:$/i, label: '输出' },
  { pattern: /^\s*\d+→/m, label: '文件内容' },
  { pattern: /^<persisted-output>/i, label: '工具输出' },
  { pattern: /Tool result saved to:/i, label: '工具输出' },
];

/**
 * 错误信息模式
 */
const ERROR_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^Error:/i, label: '错误' },
  { pattern: /^Failed to/i, label: '失败' },
  { pattern: /^Exception:/i, label: '异常' },
  { pattern: /^Cannot (read|find|open|parse)/i, label: '错误' },
];

/**
 * 检测消息类型
 */
function classifyMessage(content: string, recordType: string, role: string): {
  messageType: MessageType;
  isNoise: boolean;
  subType?: string;
} {
  const trimmedContent = content.trim();

  if (recordType === 'tool_use' || recordType === 'tool_result') {
    return { messageType: 'tool_action', isNoise: true, subType: 'tool_call' };
  }

  for (const { pattern, label } of INTERRUPT_PATTERNS) {
    if (pattern.test(trimmedContent)) {
      return { messageType: 'interrupt', isNoise: true, subType: label };
    }
  }

  for (const { pattern, label } of SYSTEM_INJECTION_PATTERNS) {
    if (pattern.test(trimmedContent)) {
      return { messageType: 'system_event', isNoise: true, subType: label };
    }
  }

  for (const { pattern, label } of TOOL_RESULT_PATTERNS) {
    if (pattern.test(trimmedContent)) {
      return { messageType: 'tool_action', isNoise: true, subType: label };
    }
  }

  for (const { pattern, label } of ERROR_PATTERNS) {
    if (pattern.test(trimmedContent)) {
      return { messageType: 'error', isNoise: true, subType: label };
    }
  }

  const codeBlockCount = (trimmedContent.match(/```/g) || []).length;
  if (codeBlockCount >= 4 && trimmedContent.length > 1000) {
    return { messageType: 'tool_action', isNoise: true, subType: '代码输出' };
  }

  const lines = trimmedContent.split('\n');
  const instructionLines = lines.filter(line =>
    /^(IMPORTANT|NOTE|WARNING|TIP|INFO):/i.test(line.trim()) ||
    /^Use (this|the) (tool|skill)/i.test(line.trim()) ||
    /^When (using|you)/i.test(line.trim()) ||
    /^You (have|can|should|must|are)/i.test(line.trim())
  );

  if (lines.length > 0 && instructionLines.length / lines.length > 0.5) {
    return { messageType: 'system_event', isNoise: true, subType: '指令聚合' };
  }

  if (role === 'user') {
    return { messageType: 'user_text', isNoise: false };
  } else {
    return { messageType: 'assistant_text', isNoise: false };
  }
}

/**
 * FileScanner - 文件系统扫描服务
 */
export class FileScanner {
  private static instance: FileScanner;

  private constructor() {}

  static getInstance(): FileScanner {
    if (!FileScanner.instance) {
      FileScanner.instance = new FileScanner();
    }
    return FileScanner.instance;
  }

  /**
   * 解码项目路径
   * -Users-mac-Desktop----claudeManage → /Users/mac/Desktop/项目/claudeManage
   *
   * 注意：Claude CLI 编码会把所有非字母数字字符（含中文、冒号、下划线、点、反斜杠）
   * 都替换成 `-`，因此解码是 lossy 的。仅在没有更可靠来源（sessions-index.json
   * 或 jsonl 的 cwd 字段）时回退使用。
   */
  decodeProjectPath(encoded: string): string {
    // 移除开头的 -
    let decoded = encoded.replace(/^-/, '/');
    // 将 - 替换为 /
    decoded = decoded.replace(/-/g, '/');
    // 修复连续斜杠
    return decoded.replace(/\/+/g, '/');
  }

  /**
   * 从 jsonl 文件起始处同步读取若干 KB，解析出第一条记录的 cwd 字段
   * 用于恢复 decodeProjectPath 无法还原的真实路径（含中文 / Windows 盘符 / 下划线等）
   */
  private extractCwdFromJsonlSync(filePath: string): string | null {
    let fd: number | null = null;
    try {
      fd = openSync(filePath, 'r');
      const buffer = Buffer.alloc(32 * 1024);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      if (bytesRead <= 0) return null;

      const text = buffer.subarray(0, bytesRead).toString('utf-8');
      const lines = text.split('\n');
      // 最后一行可能被截断，只在读满 buffer 时丢弃
      const completeLines = bytesRead === buffer.length && lines.length > 1
        ? lines.slice(0, -1)
        : lines;

      for (const line of completeLines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (typeof obj.cwd === 'string' && obj.cwd.length > 0) {
            return obj.cwd;
          }
        } catch {
          // 跳过无法解析的行
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  /**
   * 同步从项目目录下任一 jsonl 文件提取 cwd（用于回退恢复原始路径）
   */
  private extractCwdFromProjectDirSync(projectDir: string): string | null {
    if (!existsSync(projectDir)) return null;

    let entries: string[];
    try {
      entries = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return null;
    }

    for (const file of entries) {
      const cwd = this.extractCwdFromJsonlSync(join(projectDir, file));
      if (cwd) return cwd;
    }
    return null;
  }

  /** 项目编码目录 → 真实原始路径 的进程内缓存 */
  private originalPathCache = new Map<string, string>();

  /**
   * 统一的项目原始路径解析入口
   * 优先级：缓存 > sessions-index.json.originalPath > jsonl.cwd > 朴素 decodeProjectPath
   */
  private resolveOriginalPath(projectDir: string, encodedPath: string): string {
    const cached = this.originalPathCache.get(encodedPath);
    if (cached) return cached;

    // 1. sessions-index.json
    const indexPath = join(projectDir, 'sessions-index.json');
    try {
      if (existsSync(indexPath)) {
        const indexData = JSON.parse(readFileSync(indexPath, 'utf-8'));
        if (typeof indexData.originalPath === 'string' && indexData.originalPath) {
          this.originalPathCache.set(encodedPath, indexData.originalPath);
          return indexData.originalPath;
        }
      }
    } catch {
      // ignore
    }

    // 2. jsonl 的 cwd 字段
    const cwd = this.extractCwdFromProjectDirSync(projectDir);
    if (cwd) {
      this.originalPathCache.set(encodedPath, cwd);
      return cwd;
    }

    // 3. lossy 解码（最后兜底）
    return this.decodeProjectPath(encodedPath);
  }

  /**
   * 获取正确的项目路径（支持中文路径 / Windows 盘符 / 下划线等）
   */
  resolveProjectPath(encodedPath: string): string {
    const projectsPath = pathService.getHistoryPath();
    return this.resolveOriginalPath(join(projectsPath, encodedPath), encodedPath);
  }

  /**
   * 编码项目路径
   * /Users/mac/Desktop/项目/claudeManage → -Users-mac-Desktop----claudeManage
   */
  encodeProjectPath(path: string): string {
    // 匹配 Claude CLI 的编码规则：非 ASCII 字母数字字符全部替换为 -
    return path.replace(/[^a-zA-Z0-9]/g, '-');
  }

  /**
   * 扫描所有项目
   */
  scanProjects(): ProjectInfo[] {
    const projectsPath = pathService.getHistoryPath();

    if (!existsSync(projectsPath)) {
      return [];
    }

    const entries = readdirSync(projectsPath, { withFileTypes: true });
    const projects: ProjectInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }

      const projectDir = join(projectsPath, entry.name);
      const originalPath = this.resolveOriginalPath(projectDir, entry.name);

      // 扫描项目下的会话
      const sessions = this.scanProjectSessions(projectDir, originalPath);

      if (sessions.length > 0) {
        // 计算最后活跃时间
        const lastModified = sessions.reduce((latest, session) => {
          const sessionTime = new Date(session.lastModified);
          return sessionTime > latest ? sessionTime : latest;
        }, new Date(0));

        projects.push({
          path: originalPath,
          encodedPath: entry.name,
          sessionCount: sessions.length,
          lastActivityAt: lastModified,
        });
      }
    }

    // 按最后活跃时间排序
    projects.sort((a, b) => {
      const aTime = a.lastActivityAt?.getTime() || 0;
      const bTime = b.lastActivityAt?.getTime() || 0;
      return bTime - aTime;
    });

    return projects;
  }

  /**
   * 扫描项目下的会话（主从解耦 + 遗留兼容）
   *
   * 去重核心：以 UUID 为唯一键，一个 UUID 只产生一条记录。
   *
   * 扫描策略（两轮）：
   *   第一轮：扫描所有 [UUID].jsonl 文件（主要来源）
   *           - 同名 [UUID]/ 目录是支线数据，不重复计入
   *   第二轮：扫描仅有 [UUID]/ 目录（含 subagents/）但无 .jsonl 的遗留会话
   *
   * 标题延迟加载，lastModified 使用文件系统 mtime。
   * 完全忽略 sessions-index.json。
   */
  scanProjectSessions(projectDir: string, projectPath: string): SessionInfo[] {
    const sessions: SessionInfo[] = [];

    if (!existsSync(projectDir)) {
      return sessions;
    }

    const entries = readdirSync(projectDir, { withFileTypes: true });

    // 收集已有 .jsonl 文件的 UUID，用于第二轮去重
    const knownUUIDs = new Set<string>();

    // 第一轮：扫描 [UUID].jsonl 文件（主要来源）
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      const sessionId = entry.name.replace('.jsonl', '');
      if (!UUID_REGEX.test(sessionId)) {
        continue;
      }

      knownUUIDs.add(sessionId);

      const entryPath = join(projectDir, entry.name);
      const stats = statSync(entryPath);

      // 判断是否存在同名支线目录
      const subagentsDir = join(projectDir, sessionId, 'subagents');
      const hasSubagents = existsSync(subagentsDir);

      sessions.push({
        sessionId,
        type: hasSubagents ? 'multi-agent' : 'single-file',
        title: '',
        lastModified: stats.mtime,
        rawPath: entryPath,  // 指向 .jsonl 文件
        projectPath,
      });
    }

    // 第二轮：扫描仅有 UUID 目录（无对应 .jsonl）的遗留会话
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_REGEX.test(entry.name)) {
        continue;
      }

      // 已有 .jsonl 的不重复加入
      if (knownUUIDs.has(entry.name)) {
        continue;
      }

      const sessionDir = join(projectDir, entry.name);
      const subagentsDir = join(sessionDir, 'subagents');

      // 必须包含 subagents/ 才是有效会话目录
      if (!existsSync(subagentsDir) || !statSync(subagentsDir).isDirectory()) {
        continue;
      }

      // 必须含有非 prompt_suggestion 的真实 agent 文件，否则跳过
      const subEntries = readdirSync(subagentsDir, { withFileTypes: true });
      const hasRealAgent = subEntries.some(
        sub => sub.isFile()
          && sub.name.endsWith('.jsonl')
          && !sub.name.includes('prompt_suggestion')
      );
      if (!hasRealAgent) {
        continue;
      }

      const stats = statSync(sessionDir);

      sessions.push({
        sessionId: entry.name,
        type: 'multi-agent',
        title: '',
        lastModified: stats.mtime,
        rawPath: sessionDir,  // 遗留会话指向目录
        projectPath,
      });
    }

    // 按最后修改时间降序排序
    sessions.sort((a, b) => {
      const aTime = new Date(a.lastModified).getTime();
      const bTime = new Date(b.lastModified).getTime();
      return bTime - aTime;
    });

    return sessions;
  }

  /**
   * 格式化标题
   * - 去除首尾空格
   * - 只取第一行
   * - 截取前 40 个字符
   * - 超过 40 字符添加 "..."
   * - 空字符串返回 "空会话"
   */
  private formatTitle(text: string | undefined | null): string {
    if (!text) {
      return '空会话';
    }

    // 去除首尾空格
    let title = text.trim();

    // 只取第一行
    const newlineIndex = title.indexOf('\n');
    if (newlineIndex > 0) {
      title = title.substring(0, newlineIndex);
    }

    // 去除首尾空格（再次清理）
    title = title.trim();

    // 空字符串
    if (!title) {
      return '空会话';
    }

    // 截取前 40 个字符
    if (title.length > 40) {
      return title.substring(0, 40) + '...';
    }

    return title;
  }

  /**
   * 流式读取会话标题
   *
   * - 当 rawPath 指向 .jsonl 文件时，直接从中提取
   * - 当 rawPath 指向目录（遗留会话）时，从 subagents/ 中最早的文件提取
   */
  async getSessionTitle(rawPath: string, type: SessionType): Promise<string> {
    // .jsonl 文件 → 直接提取
    if (rawPath.endsWith('.jsonl')) {
      return this.extractTitleFromJsonl(rawPath);
    }

    // 遗留目录型会话 → 从 subagents/ 中最早的文件提取
    if (type === 'multi-agent') {
      return this.extractTitleFromSubagents(rawPath);
    }

    return '空会话';
  }

  /**
   * 从 subagents/ 目录中提取标题（用于遗留的目录型会话）
   * 选取 birthtimeMs 最早的 .jsonl 文件，跳过 prompt_suggestion
   */
  private async extractTitleFromSubagents(sessionDir: string): Promise<string> {
    const subagentsDir = join(sessionDir, 'subagents');

    if (!existsSync(subagentsDir)) {
      return '空会话';
    }

    const entries = readdirSync(subagentsDir, { withFileTypes: true });
    const jsonlFiles: { path: string; birthtime: number }[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      if (entry.name.includes('prompt_suggestion')) {
        continue;
      }

      const filePath = join(subagentsDir, entry.name);
      const stats = statSync(filePath);
      const birthtime = stats.birthtimeMs || stats.ctimeMs;
      jsonlFiles.push({ path: filePath, birthtime });
    }

    if (jsonlFiles.length === 0) {
      return '空会话';
    }

    jsonlFiles.sort((a, b) => a.birthtime - b.birthtime);
    return this.extractTitleFromJsonl(jsonlFiles[0].path);
  }

  /**
   * 从单文件 JSONL 提取标题（流式读取）
   *
   * 规则：
   * 1. 找到第一条 role=user 且非 isMeta 的消息
   * 2. 提取其文本内容（字符串或 content[] 中第一个 text 块）
   * 3. 跳过无意义的消息（中断信号、CLI 命令、系统标签等）
   * 4. 去除首尾空格，只取第一行
   * 5. 截取前 40 字符，超长追加 "..."
   * 6. 文件为空或解析失败返回 "空会话"
   */
  private extractTitleFromJsonl(filePath: string): Promise<string> {
    return new Promise((resolve) => {
      if (!existsSync(filePath)) {
        resolve('空会话');
        return;
      }

      const stream = createReadStream(filePath, { encoding: 'utf-8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      let resolved = false;

      rl.on('line', (line) => {
        if (resolved) return;

        try {
          const record: JsonlMessage = JSON.parse(line);

          // 只关注 type=user 的记录
          if (record.type !== 'user' || !record.message?.content) {
            return;
          }

          // 跳过 isMeta（系统注入的技能提示等）
          if (record.isMeta) {
            return;
          }

          const rawText = this.extractText(record.message.content);
          if (!rawText || !rawText.trim()) {
            return;
          }

          const trimmed = rawText.trim();

          // 跳过无意义的首条消息，继续寻找下一条
          if (this.isTitleNoise(trimmed)) {
            return;
          }

          resolved = true;
          rl.close();
          resolve(this.formatTitle(trimmed));
        } catch {
          // 跳过解析失败的行
        }
      });

      rl.on('close', () => {
        if (!resolved) {
          resolve('空会话');
        }
      });

      stream.on('error', () => {
        if (!resolved) {
          resolve('空会话');
        }
      });
    });
  }

  /**
   * 判断文本是否为不适合作标题的噪音内容
   */
  private isTitleNoise(text: string): boolean {
    // 中断信号
    if (/^\[Request interrupted/i.test(text)) return true;
    // XML/HTML 系统标签
    if (/^<(command-name|system-reminder|task-notification|local-command-stdout|user-prompt-submit-hook|persisted-output)>/i.test(text)) return true;
    // 用户拒绝/中断
    if (/^The user (doesn't want|has rejected)/i.test(text)) return true;
    // 工具被拒
    if (/tool use was rejected/i.test(text)) return true;
    if (/^was rejected.*STOP/i.test(text)) return true;
    // 任务停止/后台完成
    if (/^Task stopped/i.test(text)) return true;
    if (/^Background command.*completed/i.test(text)) return true;
    // 工具输出结果（非用户真实输入）
    if (/^Searched for \d+ pattern/i.test(text)) return true;
    if (/^Read the output file/i.test(text)) return true;
    if (/^\[\d+ lines? omitted/i.test(text)) return true;
    if (/^\[Task #\d+\]/i.test(text)) return true;

    return false;
  }

  /**
   * 提取消息文本内容（仅提取 type=text 的内容块）
   *
   * 对于 content[] 数组，只取 type=text 的块。
   * 如果数组中全是 tool_result / tool_use 而没有 text，返回空字符串。
   * 这确保标题提取不会把工具结果当作用户输入。
   */
  private extractText(content: string | ContentBlock[]): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const textBlock = content.find(b => b.type === 'text');
      return textBlock?.text || '';
    }

    return '';
  }

  /**
   * 获取会话详情（主干与支线缝合 + 遗留兼容）
   *
   * 核心逻辑：
   *   情况 A（有 .jsonl 文件）：
   *     1. 读取主干 [UUID].jsonl
   *     2. 读取支线 [UUID]/subagents/（如果存在）
   *     3. 合并为统一时间线
   *   情况 B（仅有目录，遗留会话）：
   *     1. 直接读取 [UUID]/subagents/ 下的所有 agent 文件
   *
   * 两种情况都过滤 prompt_suggestion 文件，按时间戳正序排列。
   */
  async getSessionDetail(sessionId: string, projectPath: string): Promise<SessionDetail | null> {
    let projectDir = this.resolveProjectDir(projectPath);

    // 如果通过 projectPath 找不到项目目录，尝试通过 sessionId 查找
    if (!projectDir) {
      const found = this.findProjectBySessionId(sessionId);
      if (found) {
        projectDir = join(pathService.getHistoryPath(), found.encodedPath);
        // 更新 projectPath 为正确的路径
        projectPath = found.projectPath;
      }
    }

    if (!projectDir) {
      return null;
    }

    const mainJsonlPath = join(projectDir, `${sessionId}.jsonl`);
    const sessionDir = join(projectDir, sessionId);
    const subagentsDir = join(sessionDir, 'subagents');
    const hasMainFile = existsSync(mainJsonlPath);
    const hasSubagents = existsSync(subagentsDir);

    // 既无 .jsonl 也无 subagents → 无效会话
    if (!hasMainFile && !hasSubagents) {
      return null;
    }

    // 1. 读取主干（如果存在）
    const trunkMessages: ParsedMessage[] = [];
    if (hasMainFile) {
      const trunkParsed = await this.parseJsonlFile(mainJsonlPath, projectPath);
      if (trunkParsed) {
        trunkMessages.push(...trunkParsed.messages);
      }
    }

    // 2. 读取支线（如果存在）
    const sidechainMessages: ParsedMessage[] = [];
    if (hasSubagents) {
      const entries = readdirSync(subagentsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          continue;
        }

        // 关键过滤：忽略 prompt_suggestion 文件
        if (entry.name.includes('prompt_suggestion')) {
          continue;
        }

        const filePath = join(subagentsDir, entry.name);
        const agentName = entry.name.replace('.jsonl', '');
        const parsed = await this.parseJsonlFile(filePath, projectPath, agentName);

        if (parsed) {
          sidechainMessages.push(...parsed.messages);
        }
      }
    }

    // 3. 全局聚合与排序：合并主干 + 支线，按时间戳正序排列
    const allMessages = [...trunkMessages, ...sidechainMessages];
    allMessages.sort((a, b) => {
      const aTime = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const bTime = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return aTime - bTime;
    });

    // 计算时间范围
    let firstMessageAt: Date | null = null;
    let lastMessageAt: Date | null = null;
    for (const msg of allMessages) {
      if (msg.timestamp) {
        const t = new Date(msg.timestamp);
        if (!firstMessageAt || t < firstMessageAt) firstMessageAt = t;
        if (!lastMessageAt || t > lastMessageAt) lastMessageAt = t;
      }
    }

    // 确定标题和元数据来源
    const rawPath = hasMainFile ? mainJsonlPath : sessionDir;
    const sessionType = hasSubagents ? 'multi-agent' : 'single-file';
    const title = await this.getSessionTitle(rawPath, sessionType);
    const stats = statSync(rawPath);

    // 计算 Session 级 metrics 聚合
    const metrics = this.calculateSessionMetrics(allMessages);

    return {
      sessionId,
      type: sessionType,
      title,
      lastModified: stats.mtime,
      rawPath,
      projectPath,
      messages: allMessages,
      messageCount: allMessages.length,
      firstMessageAt,
      lastMessageAt,
      metrics,
    };
  }

  /**
   * 计算会话级别的 Token 聚合指标
   */
  private calculateSessionMetrics(messages: ParsedMessage[]): SessionMetrics {
    const metrics: SessionMetrics = {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheCreationTokens: 0,
      modelsUsed: [],
    };

    const modelSet = new Set<string>();

    for (const msg of messages) {
      if (msg.tokenUsage) {
        const { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } = msg.tokenUsage;

        metrics.inputTokens += input_tokens || 0;
        metrics.outputTokens += output_tokens || 0;
        metrics.cacheCreationTokens += cache_creation_input_tokens || 0;
        metrics.cacheHitTokens += cache_read_input_tokens || 0;
      }

      if (msg.model) {
        modelSet.add(msg.model);
      }
    }

    // 计算总 Token（输入 + 输出 + 缓存命中）
    metrics.totalTokens = metrics.inputTokens + metrics.outputTokens + metrics.cacheHitTokens;
    metrics.modelsUsed = Array.from(modelSet);

    return metrics;
  }

  /**
   * 将消息的 content 数组拍平为独立的 FlattenedEntry 列表
   * 每个 tool_use / tool_result / text / thinking / image 成为独立条目
   */
  private flattenContentBlocks(
    message: JsonlMessage['message']
  ): FlattenedEntry[] {
    if (!message?.content) return [];

    // 字符串内容 → 单条 text
    if (typeof message.content === 'string') {
      return [{ type: 'text', content: message.content }];
    }

    if (!Array.isArray(message.content)) return [];

    const entries: FlattenedEntry[] = [];

    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text) {
            entries.push({ type: 'text', content: block.text });
          }
          break;

        case 'tool_use':
        case 'server_tool_use':
          entries.push({
            type: 'tool_use',
            content: block.input ? JSON.stringify(block.input, null, 2) : '',
            tool_name: block.name,
            tool_input: block.input as Record<string, unknown> | undefined,
            // tool_use 块的 ID 字段可能是 id 或 tool_use_id
            tool_use_id: block.id || block.tool_use_id,
          });
          break;

        case 'tool_result': {
          let resultContent = '';
          const images: MessageImage[] = [];

          if (typeof block.content === 'string') {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            for (const nested of block.content) {
              if (nested.type === 'text' && nested.text) {
                resultContent += (resultContent ? '\n' : '') + nested.text;
              } else if (nested.type === 'image' && nested.source) {
                const source = nested.source as {
                  type?: string; data?: string; url?: string; media_type?: string;
                };
                let imageSource = '';
                if (source.type === 'base64' && source.data && source.media_type) {
                  imageSource = `data:${source.media_type};base64,${source.data}`;
                } else if (source.url) {
                  imageSource = source.url;
                }
                if (imageSource) {
                  images.push({ type: 'image', source: imageSource, media_type: source.media_type });
                }
              }
            }
          }

          entries.push({
            type: 'tool_result',
            content: resultContent,
            tool_use_id: block.tool_use_id,
            images: images.length > 0 ? images : undefined,
          });
          break;
        }

        case 'thinking':
          if (block.thinking) {
            entries.push({ type: 'thinking', content: block.thinking });
          }
          break;

        case 'image':
          if (block.source) {
            const source = block.source as {
              type?: string; data?: string; url?: string; media_type?: string;
            };
            let imageSource = '';
            if (source.type === 'base64' && source.data && source.media_type) {
              imageSource = `data:${source.media_type};base64,${source.data}`;
            } else if (source.url) {
              imageSource = source.url;
            }
            if (imageSource) {
              entries.push({
                type: 'image',
                content: '',
                images: [{ type: 'image', source: imageSource, media_type: source.media_type }],
              });
            }
          }
          break;
      }
    }

    return entries;
  }

  /**
   * 检测 tool_result 内容是否被截断，并提取完整输出文件的相对路径
   */
  private detectTruncatedOutput(content: string): { hasFullOutput: boolean; fullOutputPath?: string } {
    if (!content) return { hasFullOutput: false };

    // 匹配多种截断提示模式
    const patterns = [
      /(?:saved to|written to|output at|full output[^]*?)\s+(tool-results\/[\w./-]+)/i,
      /<persisted-output>\s*(tool-results\/[\w./-]+)/i,
      /Tool result saved to:\s*(tool-results\/[\w./-]+)/i,
      /(tool-results\/[\w./-]+\.(?:txt|log|json|md))/,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match?.[1]) {
        return { hasFullOutput: true, fullOutputPath: match[1] };
      }
    }

    return { hasFullOutput: false };
  }

  /**
   * 解析单文件 JSONL（拍平版本）
   * 每个 content block 被拍平为独立的 ParsedMessage
   */
  private async parseJsonlFile(
    filePath: string,
    _projectPath: string,
    agentName?: string
  ): Promise<Omit<SessionDetail, 'sessionId' | 'type' | 'title' | 'lastModified' | 'rawPath' | 'projectPath' | 'metrics'> | null> {
    return new Promise((resolve) => {
      const stream = createReadStream(filePath, { encoding: 'utf-8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      const messages: ParsedMessage[] = [];
      let firstMessageAt: string | null = null;
      let lastMessageAt: string | null = null;

      rl.on('line', (line) => {
        if (!line.trim()) return;

        try {
          const record: JsonlMessage = JSON.parse(line);

          // 跳过纯系统事件记录
          if (record.type === 'system') {
            return;
          }

          // 处理有 message 字段的记录
          if (record.message && (record.type === 'user' || record.type === 'assistant')) {
            const timestamp = record.timestamp;
            const isMeta = record.isMeta === true;

            // 将 content 拍平为独立条目
            const entries = this.flattenContentBlocks(record.message);

            // 提取 model 和 usage 字段（所有条目共享）
            const messageModel = record.message.model || record.model;
            const messageUsage = record.message.usage || record.usage;
            const tokenUsage = messageUsage ? {
              input_tokens: messageUsage.input_tokens || 0,
              output_tokens: messageUsage.output_tokens || 0,
              cache_creation_input_tokens: messageUsage.cache_creation_input_tokens,
              cache_read_input_tokens: messageUsage.cache_read_input_tokens,
            } : undefined;

            // 用户消息（非 meta）：将 text 和 image 合并为单条消息，避免被拆成多个气泡
            if (record.type === 'user' && !isMeta) {
              let mergedContent = '';
              const mergedImages: MessageImage[] = [];
              const otherEntries: typeof entries = [];

              for (const entry of entries) {
                if (entry.type === 'text') {
                  mergedContent += (mergedContent ? '\n' : '') + (entry.content || '');
                } else if (entry.type === 'image' && entry.images?.length) {
                  mergedImages.push(...entry.images);
                } else {
                  otherEntries.push(entry);
                }
              }

              // 推入合并后的用户消息
              if (mergedContent || mergedImages.length) {
                const classification = classifyMessage(mergedContent, record.type, record.message.role);
                messages.push({
                  role: record.message.role,
                  content: mergedContent,
                  timestamp,
                  message_type: classification.messageType,
                  is_system_noise: classification.isNoise,
                  sub_type: classification.subType,
                  images: mergedImages.length > 0 ? mergedImages : undefined,
                  agent_name: agentName,
                  model: messageModel,
                  tokenUsage,
                });

                if (timestamp) {
                  if (!firstMessageAt || timestamp < firstMessageAt) firstMessageAt = timestamp;
                  if (!lastMessageAt || timestamp > lastMessageAt) lastMessageAt = timestamp;
                }
              }

              // 其他条目（如 tool_result）仍单独处理
              for (const entry of otherEntries) {
                let messageType: MessageType;
                let isNoise: boolean;
                let subType: string | undefined;

                if (entry.type === 'tool_result') {
                  messageType = 'tool_action';
                  isNoise = true;
                  subType = '工具结果';
                } else {
                  messageType = 'system_event';
                  isNoise = true;
                  subType = entry.type;
                }

                let hasFullOutput: boolean | undefined;
                let fullOutputPath: string | undefined;
                if (entry.type === 'tool_result') {
                  const truncation = this.detectTruncatedOutput(entry.content);
                  if (truncation.hasFullOutput) {
                    hasFullOutput = true;
                    fullOutputPath = truncation.fullOutputPath;
                  }
                }

                if (entry.content || entry.images?.length || entry.tool_name) {
                  messages.push({
                    role: record.message.role,
                    content: entry.content || '',
                    timestamp,
                    message_type: messageType,
                    is_system_noise: isNoise,
                    sub_type: subType,
                    images: entry.images,
                    tool_names: entry.tool_name ? [entry.tool_name] : undefined,
                    tool_name: entry.tool_name,
                    tool_input: entry.tool_input,
                    tool_use_id: entry.tool_use_id,
                    has_full_output: hasFullOutput,
                    full_output_path: fullOutputPath,
                    agent_name: agentName,
                    model: messageModel,
                    tokenUsage,
                  });
                }
              }

              // 跳过下面的通用循环
              return;
            }

            // 助手消息 / meta 消息：按条目逐个处理（保持原有逻辑）
            for (const entry of entries) {
              let messageType: MessageType;
              let isNoise: boolean;
              let subType: string | undefined;

              if (isMeta) {
                // isMeta 消息全部归为系统事件噪音
                messageType = 'system_event';
                isNoise = true;
                subType = '技能注入';
              } else if (entry.type === 'tool_use') {
                messageType = 'tool_action';
                isNoise = true;
                subType = `调用: ${entry.tool_name || '工具'}`;
              } else if (entry.type === 'tool_result') {
                messageType = 'tool_action';
                isNoise = true;
                subType = '工具结果';
              } else if (entry.type === 'thinking') {
                messageType = 'system_event';
                isNoise = true;
                subType = '思考过程';
              } else if (entry.type === 'image') {
                messageType = 'chat';
                isNoise = false;
                subType = '图片消息';
              } else {
                // text 内容 → 使用分类器判断
                const classification = classifyMessage(
                  entry.content || '',
                  record.type,
                  record.message.role
                );
                messageType = classification.messageType;
                isNoise = classification.isNoise;
                subType = classification.subType;
              }

              // 检测截断的工具输出
              let hasFullOutput: boolean | undefined;
              let fullOutputPath: string | undefined;
              if (entry.type === 'tool_result') {
                const truncation = this.detectTruncatedOutput(entry.content);
                if (truncation.hasFullOutput) {
                  hasFullOutput = true;
                  fullOutputPath = truncation.fullOutputPath;
                }
              }

              // 只有有实质内容的条目才加入
              if (entry.content || entry.images?.length || entry.tool_name) {
                messages.push({
                  role: record.message.role,
                  content: entry.content || '',
                  timestamp,
                  message_type: messageType,
                  is_system_noise: isNoise,
                  sub_type: subType,
                  images: entry.images,
                  tool_names: entry.tool_name ? [entry.tool_name] : undefined,
                  tool_name: entry.tool_name,
                  tool_input: entry.tool_input,
                  tool_use_id: entry.tool_use_id,
                  has_full_output: hasFullOutput,
                  full_output_path: fullOutputPath,
                  agent_name: agentName,
                  model: messageModel,
                  tokenUsage,
                });

                if (timestamp) {
                  if (!firstMessageAt || timestamp < firstMessageAt) {
                    firstMessageAt = timestamp;
                  }
                  if (!lastMessageAt || timestamp > lastMessageAt) {
                    lastMessageAt = timestamp;
                  }
                }
              }
            }
          }
        } catch {
          // 跳过解析失败的行
        }
      });

      rl.on('close', () => {
        if (messages.length === 0) {
          resolve(null);
          return;
        }

        resolve({
          messages,
          messageCount: messages.length,
          firstMessageAt: firstMessageAt ? new Date(firstMessageAt) : null,
          lastMessageAt: lastMessageAt ? new Date(lastMessageAt) : null,
        });
      });

      stream.on('error', () => {
        resolve(null);
      });
    });
  }

  /**
   * 批量获取会话标题（并行加载）
   */
  async loadSessionTitles(sessions: SessionInfo[]): Promise<void> {
    await Promise.all(
      sessions.map(async (session) => {
        if (!session.title) {
          session.title = await this.getSessionTitle(session.rawPath, session.type);
        }
      })
    );
  }

  /**
   * 获取项目会话列表（带分页和标题加载）
   */
  async getProjectSessions(
    encodedPath: string,
    page = 1,
    pageSize = 20
  ): Promise<{ data: SessionInfo[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
    const projectsPath = pathService.getHistoryPath();
    const projectDir = join(projectsPath, encodedPath);

    // 解析项目真实路径（支持中文/Windows 盘符/下划线等 decodeProjectPath 无法还原的情况）
    const projectPath = this.resolveOriginalPath(projectDir, encodedPath);

    const sessions = this.scanProjectSessions(projectDir, projectPath);

    const total = sessions.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const paginatedSessions = sessions.slice(offset, offset + pageSize);

    // 并行加载标题
    await this.loadSessionTitles(paginatedSessions);

    return {
      data: paginatedSessions,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    };
  }

  /**
   * 获取全局时间轴（所有项目的会话按时间排序）
   */
  async getTimeline(page = 1, pageSize = 20): Promise<{ data: SessionInfo[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
    const projects = this.scanProjects();
    const allSessions: SessionInfo[] = [];

    for (const project of projects) {
      const projectsPath = pathService.getHistoryPath();
      const projectDir = join(projectsPath, project.encodedPath);
      const sessions = this.scanProjectSessions(projectDir, project.path);
      allSessions.push(...sessions);
    }

    // 按最后修改时间排序
    allSessions.sort((a, b) => {
      const aTime = new Date(a.lastModified).getTime();
      const bTime = new Date(b.lastModified).getTime();
      return bTime - aTime;
    });

    const total = allSessions.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const paginatedSessions = allSessions.slice(offset, offset + pageSize);

    // 并行加载标题
    await this.loadSessionTitles(paginatedSessions);

    return {
      data: paginatedSessions,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    };
  }

  /**
   * 解析会话所在的项目目录
   * 支持多种查找策略：
   * 1. 通过 sessions-index.json 中的 originalPath 精确匹配
   * 2. 通过编码路径回退匹配
   * 3. 通过目录名模糊匹配（处理中文路径编码问题）
   */
  resolveProjectDir(projectPath: string): string | null {
    const projectsPath = pathService.getHistoryPath();

    if (!existsSync(projectsPath)) {
      return null;
    }

    const entries = readdirSync(projectsPath, { withFileTypes: true });

    // 策略1: 通过 sessions-index.json 中的 originalPath 精确匹配
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      const indexPath = join(projectsPath, entry.name, 'sessions-index.json');
      try {
        if (existsSync(indexPath)) {
          const indexContent = readFileSync(indexPath, 'utf-8');
          const indexData = JSON.parse(indexContent);
          if (indexData.originalPath === projectPath) {
            return join(projectsPath, entry.name);
          }
        }
      } catch {
        // 忽略
      }
    }

    // 策略2: 通过编码路径回退匹配
    const encodedPath = this.encodeProjectPath(projectPath);
    const fallbackDir = join(projectsPath, encodedPath);
    if (existsSync(fallbackDir)) {
      return fallbackDir;
    }

    // 策略3: 模糊匹配 - 处理中文路径编码差异
    // 例如: projectPath="/Users/mac/Desktop/项目/704yunzhi_xinch_10.0-master/seeyon/m3/apps/v5/collaboration/html"
    // 编码后可能变成: -Users-mac-Desktop----704yunzhi-xinch-10-0-master-seeyon-m3-apps-v5-collaboration-html
    // 我们尝试将路径中的关键部分与目录名进行匹配
    const pathParts = projectPath.split(/[/\\]/).filter(p => p.length > 0);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      // 跳过已经检查过的目录
      const entryPath = join(projectsPath, entry.name);
      if (existsSync(join(entryPath, 'sessions-index.json'))) {
        continue; // 已经在策略1中处理过
      }

      // 检查目录名是否与项目路径的关键部分匹配
      // 提取目录名中的关键部分（如项目名）
      const projectName = pathParts[pathParts.length - 1];
      if (projectName && entry.name.toLowerCase().includes(projectName.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
        // 检查该目录下是否有会话文件
        const subEntries = readdirSync(entryPath);
        const hasSession = subEntries.some(f =>
          f.endsWith('.jsonl') || (f.endsWith('.json') && f !== 'sessions-index.json')
        );
        if (hasSession) {
          return entryPath;
        }
      }
    }

    return null;
  }

  /**
   * 读取 tool-results 目录下的完整输出文件
   * @param sessionId 会话 ID
   * @param projectPath 项目路径
   * @param filePath 相对路径 (如 tool-results/xxx.txt)
   * @returns 文件内容字符串，或 null
   */
  readToolResult(sessionId: string, projectPath: string, filePath: string): string | null {
    // 安全检查：防止路径遍历攻击
    if (filePath.includes('..') || filePath.startsWith('/')) {
      return null;
    }

    const projectDir = this.resolveProjectDir(projectPath);
    if (!projectDir) return null;

    // 多智能体会话: [UUID]/tool-results/xxx.txt
    const multiAgentPath = join(projectDir, sessionId, filePath);
    if (existsSync(multiAgentPath)) {
      try {
        return readFileSync(multiAgentPath, 'utf-8');
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * 获取统计数据
   */
  getStats(): { totalProjects: number; totalSessions: number } {
    const projects = this.scanProjects();
    const totalSessions = projects.reduce((sum, p) => sum + p.sessionCount, 0);
    return {
      totalProjects: projects.length,
      totalSessions,
    };
  }

  /**
   * 获取全局 Token 统计（所有项目汇总）
   */
  async getGlobalTokenMetrics(): Promise<{
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
    cacheCreationTokens: number;
  }> {
    const projects = this.scanProjects();
    const metrics = {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheCreationTokens: 0,
    };

    // 并行获取所有项目的 metrics
    const projectMetricsPromises = projects.map(p => this.getProjectMetrics(p.path));
    const projectMetricsResults = await Promise.all(projectMetricsPromises);

    for (const pm of projectMetricsResults) {
      metrics.totalTokens += pm.totalTokens;
      metrics.inputTokens += pm.inputTokens;
      metrics.outputTokens += pm.outputTokens;
      metrics.cacheHitTokens += pm.cacheHitTokens;
      metrics.cacheCreationTokens += pm.cacheCreationTokens;
    }

    return metrics;
  }

  /**
   * 获取全局消息统计（所有会话的消息总数）
   */
  async getGlobalMessageStats(): Promise<{ totalMessages: number }> {
    const projects = this.scanProjects();
    let totalMessages = 0;

    // 并行获取所有项目的会话详情
    for (const project of projects) {
      const projectDir = this.resolveProjectDir(project.path);
      if (!projectDir) continue;

      const sessions = this.scanProjectSessions(projectDir, project.path);

      // 并行获取每个会话的消息数
      const sessionDetailsPromises = sessions.map(s => this.getSessionDetail(s.sessionId, project.path));
      const sessionDetails = await Promise.all(sessionDetailsPromises);

      for (const detail of sessionDetails) {
        if (detail) {
          totalMessages += detail.messageCount;
        }
      }
    }

    return { totalMessages };
  }

  /**
   * 获取项目级别的聚合指标
   * 汇总该项目下所有会话的 Token 消耗数据
   */
  async getProjectMetrics(projectPath: string): Promise<ProjectMetrics> {
    const projectDir = this.resolveProjectDir(projectPath);
    if (!projectDir) {
      return {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        cacheCreationTokens: 0,
        modelsUsed: [],
        sessionsWithMetrics: 0,
      };
    }

    const sessions = this.scanProjectSessions(projectDir, projectPath);
    const metrics: ProjectMetrics = {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheCreationTokens: 0,
      modelsUsed: [],
      sessionsWithMetrics: 0,
    };

    const modelSet = new Set<string>();

    // 并行加载所有会话的 metrics
    const sessionMetricsPromises = sessions.map(async (session) => {
      const detail = await this.getSessionDetail(session.sessionId, projectPath);
      return detail?.metrics || null;
    });

    const sessionMetricsResults = await Promise.all(sessionMetricsPromises);

    for (const sessionMetrics of sessionMetricsResults) {
      if (sessionMetrics) {
        metrics.totalTokens += sessionMetrics.totalTokens;
        metrics.inputTokens += sessionMetrics.inputTokens;
        metrics.outputTokens += sessionMetrics.outputTokens;
        metrics.cacheHitTokens += sessionMetrics.cacheHitTokens;
        metrics.cacheCreationTokens += sessionMetrics.cacheCreationTokens;
        metrics.sessionsWithMetrics++;

        for (const model of sessionMetrics.modelsUsed) {
          modelSet.add(model);
        }
      }
    }

    metrics.modelsUsed = Array.from(modelSet);
    return metrics;
  }

  /**
   * 批量获取会话 metrics（用于列表展示，延迟加载）
   * 只解析必要的 metadata 而不加载全部消息
   */
  async loadSessionMetrics(sessions: SessionInfo[]): Promise<void> {
    await Promise.all(
      sessions.map(async (session) => {
        if (!session.metrics) {
          const detail = await this.getSessionDetail(session.sessionId, session.projectPath);
          if (detail) {
            session.metrics = detail.metrics;
          }
        }
      })
    );
  }

  /**
   * 全局搜索会话内容
   * @param query 搜索关键词
   * @param page 页码
   * @param pageSize 每页数量
   * @param projectPath 可选，限定在某个项目内搜索
   */
  async search(
    query: string,
    page = 1,
    pageSize = 20,
    projectPath?: string
  ): Promise<{
    data: Array<{
      sessionId: string;
      title: string;
      projectPath: string;
      snippet: string;
      rank: number;
    }>;
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
    query: string;
  }> {
    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery) {
      return {
        data: [],
        pagination: { page, pageSize, total: 0, totalPages: 0 },
        query,
      };
    }

    // 分词，支持多关键词搜索
    const keywords = normalizedQuery.split(/\s+/).filter(k => k.length > 0);

    // 获取所有会话
    let sessions: SessionInfo[] = [];
    if (projectPath) {
      const projectDir = this.resolveProjectDir(projectPath);
      if (projectDir) {
        sessions = this.scanProjectSessions(projectDir, projectPath);
      }
    } else {
      const projects = this.scanProjects();
      const projectsPath = pathService.getHistoryPath();
      for (const project of projects) {
        const projectDir = join(projectsPath, project.encodedPath);
        const projectSessions = this.scanProjectSessions(projectDir, project.path);
        sessions.push(...projectSessions);
      }
    }

    // 搜索结果
    interface SearchResult {
      sessionId: string;
      title: string;
      projectPath: string;
      snippet: string;
      rank: number;
    }

    // 并行搜索会话
    const searchPromises = sessions.map(async (session) => {
      let rank = 0;
      let snippet = '';
      const titleLower = (session.title || '').toLowerCase();
      const projectNameLower = session.projectPath.split(/[/\\]/).pop()?.toLowerCase() || '';

      // 检查标题匹配
      for (const keyword of keywords) {
        if (titleLower.includes(keyword)) {
          rank += 10; // 标题匹配权重最高
        }
        if (projectNameLower.includes(keyword)) {
          rank += 5; // 项目名匹配
        }
      }

      // 搜索会话内容
      const detail = await this.getSessionDetail(session.sessionId, session.projectPath);
      if (detail && detail.messages.length > 0) {
        const matchedSnippets: string[] = [];
        let contentMatchCount = 0;

        for (const msg of detail.messages) {
          const contentLower = (msg.content || '').toLowerCase();
          let msgMatch = false;

          for (const keyword of keywords) {
            if (contentLower.includes(keyword)) {
              rank += 1;
              contentMatchCount++;
              msgMatch = true;
            }
          }

          // 提取匹配的片段
          if (msgMatch && matchedSnippets.length < 3) {
            const content = msg.content || '';
            // 找到第一个关键词的位置，提取上下文
            for (const keyword of keywords) {
              const idx = contentLower.indexOf(keyword);
              if (idx !== -1) {
                const start = Math.max(0, idx - 50);
                const end = Math.min(content.length, idx + keyword.length + 100);
                let snip = content.slice(start, end);
                if (start > 0) snip = '...' + snip;
                if (end < content.length) snip = snip + '...';
                // 高亮关键词
                for (const kw of keywords) {
                  const regex = new RegExp(`(${this.escapeRegex(kw)})`, 'gi');
                  snip = snip.replace(regex, '<<HIGHLIGHT>>$1<</HIGHLIGHT>>');
                }
                matchedSnippets.push(snip);
                break;
              }
            }
          }
        }

        if (contentMatchCount > 0) {
          rank += Math.min(contentMatchCount, 10); // 内容匹配次数加成，最多10分
        }

        snippet = matchedSnippets.join('\n\n');
      }

      // 如果有匹配，加入结果
      if (rank > 0) {
        return {
          sessionId: session.sessionId,
          title: session.title || '无标题会话',
          projectPath: session.projectPath,
          snippet: snippet || (session.title ? `标题匹配: ${session.title}` : ''),
          rank,
        };
      }

      return null;
    });

    const searchResults = await Promise.all(searchPromises);

    // 过滤并排序
    const validResults = searchResults
      .filter((r): r is SearchResult => r !== null)
      .sort((a, b) => b.rank - a.rank);

    // 分页
    const total = validResults.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const paginatedResults = validResults.slice(offset, offset + pageSize);

    return {
      data: paginatedResults,
      pagination: { page, pageSize, total, totalPages },
      query,
    };
  }

  /**
   * 转义正则表达式特殊字符
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ==================== Session -> Project 反向查找 ====================

  private sessionProjectCache: Map<string, { projectPath: string; encodedPath: string }> | null = null;

  /**
   * 从 sessionId 反向查找所属项目
   */
  findProjectBySessionId(sessionId: string): { projectPath: string; encodedPath: string } | null {
    // 尝试从缓存中查找
    if (this.sessionProjectCache) {
      return this.sessionProjectCache.get(sessionId) || null;
    }

    // 首次调用时构建缓存
    this.sessionProjectCache = new Map();
    const projectsPath = pathService.getHistoryPath();
    if (!existsSync(projectsPath)) return null;

    try {
      const projectDirs = readdirSync(projectsPath, { withFileTypes: true });
      for (const dir of projectDirs) {
        if (!dir.isDirectory() || dir.name.startsWith('.')) continue;
        const projectDir = join(projectsPath, dir.name);
        const projectPath = this.resolveProjectPath(dir.name);

        try {
          const entries = readdirSync(projectDir);
          for (const entry of entries) {
            if (entry.endsWith('.jsonl')) {
              const sid = entry.replace('.jsonl', '');
              this.sessionProjectCache.set(sid, { projectPath, encodedPath: dir.name });
            }
          }
        } catch {
          // skip
        }
      }
    } catch {
      // ignore
    }

    return this.sessionProjectCache.get(sessionId) || null;
  }

  /**
   * 清除 session->project 缓存（当需要刷新时调用）
   */
  clearSessionProjectCache(): void {
    this.sessionProjectCache = null;
  }
}

export const fileScanner = FileScanner.getInstance();
