#!/usr/bin/env node
/**
 * pnpm 安装 node-pty 时偶发会丢失 prebuilds/*/spawn-helper 的执行权限，
 * 导致 macOS/Linux 上 spawn 全部 `posix_spawnp failed`。
 * 这里在 postinstall 时把所有平台目录下的 spawn-helper 都补上 +x。
 *
 * 静默退出（不抛错），避免 CI 上的非 unix 环境破坏安装流程。
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
