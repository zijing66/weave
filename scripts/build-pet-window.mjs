#!/usr/bin/env node
// 构建 weave-pet-window.exe（WebView2 宠物窗宿主）并把发布产物拷进
// packages/weave-server/res/pet-window/ 随 npm 包分发。
// 需要 dotnet 8 SDK；产物已入库，日常开发不需要重跑本脚本。
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projDir = path.join(repoRoot, 'tools', 'pet-window');
const outDir = path.join(repoRoot, 'packages', 'weave-server', 'res', 'pet-window');

const probe = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8', shell: process.platform === 'win32' });
if (probe.status !== 0) {
  console.error('[build-pet-window] dotnet 8 SDK not found — skipping (prebuilt binaries are committed).');
  process.exit(0);
}

console.log('[build-pet-window] dotnet publish...');
const publish = spawnSync(
  'dotnet',
  ['publish', projDir, '-c', 'Release', '-o', path.join(projDir, 'publish')],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
if (publish.status !== 0) process.exit(publish.status ?? 1);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(path.join(projDir, 'publish'), outDir, { recursive: true });
// xml 是 API 文档（~780KB）、pdb 是调试符号，分发都不需要
for (const f of await readdir(outDir)) {
  if (f.endsWith('.xml') || f.endsWith('.pdb')) await rm(path.join(outDir, f));
}
const files = await readdir(outDir);
console.log(`[build-pet-window] ${files.length} files -> ${path.relative(repoRoot, outDir)}`);
