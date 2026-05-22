#!/usr/bin/env node
//
// pnpm 安装 node-pty 时偶发会丢失 prebuilds 下各平台 spawn-helper 的执行权限，
// 导致 macOS/Linux 上 spawn 全部 `posix_spawnp failed`。
// 这里在 postinstall 时把所有平台目录下的 spawn-helper 都补上 +x。
//
// 注意：注释一律用 //，避免路径里出现的 "*/" 提前关闭块注释。
// Windows 用的是 ConPTY，不依赖 spawn-helper，所以直接退出。
//
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

if (platform() === 'win32') {
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const prebuildsDir = join(here, '..', 'node_modules', 'node-pty', 'prebuilds');

if (!existsSync(prebuildsDir)) {
  process.exit(0);
}

let fixed = 0;
for (const platDir of readdirSync(prebuildsDir)) {
  const helper = join(prebuildsDir, platDir, 'spawn-helper');
  if (!existsSync(helper)) continue;
  try {
    const mode = statSync(helper).mode;
    if ((mode & 0o111) !== 0o111) {
      chmodSync(helper, mode | 0o755);
      fixed++;
    }
  } catch {
    // ignore
  }
}

if (fixed > 0) {
  console.log(`[fix-node-pty-perms] restored +x on ${fixed} spawn-helper(s)`);
}
