/**
 * 文件系统浏览路由
 * GET /api/fs/browse?path=...
 *   - 返回该绝对路径下的子目录列表 + 解析后的当前路径 + 父目录
 *   - Windows 下 path 为空 / "/" / 仅盘符占位时,返回所有可用盘符
 *   - 非 Windows path 为空时,默认从 os.homedir() 开始
 *
 * 仅暴露目录(不返回文件),给前端"选择目录"的 picker 用。
 */

import { FastifyPluginAsync } from 'fastify';
import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { resolve, dirname, sep, parse } from 'path';

interface BrowseEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  /** 解析后的绝对路径(Windows 上盘符列表时为空字符串) */
  cwd: string;
  /** 父目录的绝对路径;到达盘符 / 根目录时为 null */
  parent: string | null;
  /** 子目录列表 */
  entries: BrowseEntry[];
  /** 是否为 Windows 盘符列表视图 */
  isDriveList: boolean;
  /** 当前平台 */
  platform: NodeJS.Platform;
  /** 默认起步目录(供前端 "回到 Home" 用) */
  home: string;
}

/** Windows 下探测 A:\ ~ Z:\ 中可读取的盘符 */
function listWindowsDrives(): BrowseEntry[] {
  const drives: BrowseEntry[] = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    if (existsSync(root)) {
      drives.push({ name: `${letter}:`, path: root });
    }
  }
  return drives;
}

/** Windows 上判断给定绝对路径是否是盘符根(如 C:\) */
function isWindowsRoot(p: string): boolean {
  const parsed = parse(p);
  return parsed.root === p;
}

const fsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { path?: string; showHidden?: string } }>(
    '/browse',
    async (request, reply) => {
      const isWin = platform() === 'win32';
      const showHidden = request.query.showHidden === 'true';
      const rawPath = (request.query.path ?? '').trim();

      // Windows: 空路径 → 盘符列表
      if (isWin && (rawPath === '' || rawPath === '/' || rawPath === '\\')) {
        const drives = listWindowsDrives();
        const resp: BrowseResponse = {
          cwd: '',
          parent: null,
          entries: drives,
          isDriveList: true,
          platform: 'win32',
          home: homedir(),
        };
        return resp;
      }

      // 非 Windows 空路径 → 默认 home
      const startPath = rawPath === '' ? homedir() : rawPath;
      const absPath = resolve(startPath);

      if (!existsSync(absPath)) {
        reply.code(404);
        return { error: `path not found: ${absPath}` };
      }

      let st;
      try {
        st = await stat(absPath);
      } catch (e) {
        reply.code(400);
        return {
          error: `cannot stat path: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      if (!st.isDirectory()) {
        reply.code(400);
        return { error: `not a directory: ${absPath}` };
      }

      let names: string[];
      try {
        names = await readdir(absPath);
      } catch (e) {
        reply.code(403);
        return {
          error: `cannot read directory: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      // 并行 stat 每个 entry,过滤出目录;权限不足或链接断裂的整条跳过
      const statResults = await Promise.all(
        names.map(async (name) => {
          if (!showHidden && name.startsWith('.')) return null;
          const full = absPath.endsWith(sep) ? `${absPath}${name}` : `${absPath}${sep}${name}`;
          try {
            const s = await stat(full);
            if (!s.isDirectory()) return null;
            return { name, path: full };
          } catch {
            return null;
          }
        }),
      );

      const entries: BrowseEntry[] = statResults
        .filter((e): e is BrowseEntry => e !== null)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      // 计算 parent:
      // - Windows 在盘符根(C:\)时,parent = "" → 前端再请求一次能拿到盘符列表
      // - 其它平台到达 "/" 时 parent = null
      let parent: string | null;
      if (isWin && isWindowsRoot(absPath)) {
        parent = '';
      } else {
        const up = dirname(absPath);
        parent = up === absPath ? null : up;
      }

      const resp: BrowseResponse = {
        cwd: absPath,
        parent,
        entries,
        isDriveList: false,
        platform: platform(),
        home: homedir(),
      };
      return resp;
    },
  );
};

export default fsRoutes;
