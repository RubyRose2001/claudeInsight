const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';

export interface FsBrowseEntry {
  name: string;
  path: string;
}

export interface FsBrowseResponse {
  /** 解析后的绝对路径(盘符列表视图时为空) */
  cwd: string;
  /** 父目录的绝对路径;无更高一层时为 null;Windows 盘符上层为 "" */
  parent: string | null;
  entries: FsBrowseEntry[];
  isDriveList: boolean;
  platform: string;
  /** 用户 home 目录,供 "回到 Home" 用 */
  home: string;
}

/**
 * 浏览目录。path 为空时:Windows 返回盘符列表,其它平台默认 home。
 * 失败时把后端返回的 error 字段作为 Error.message 抛出。
 */
async function browse(path: string, showHidden = false): Promise<FsBrowseResponse> {
  const params = new URLSearchParams();
  params.set('path', path);
  if (showHidden) params.set('showHidden', 'true');
  const res = await fetch(`${API_BASE}/api/fs/browse?${params.toString()}`);
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
  return parsed as FsBrowseResponse;
}

export const fsApi = { browse };
