import path from 'node:path';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fsp } from 'node:fs';
import { HARNESS_DIRS, VISUALIZATION_PROTOCOL } from '@weavecode/core';
import type { WeaveServerDeps } from '../server.js';
import { sendJson } from '../http.js';
import { isInsideDir } from '../../market/resolve.js';

/**
 * 渲染块只读端点：按绝对路径回读 HTML fragment（JSON 包裹）。路径必须落在
 * 白名单根内（codex 官方线程目录 / claude·codex 用户目录 / codex 插件缓存 /
 * weave 的临时目录 / 已注册项目根）——fragment 是模型产物，绝不能变成任意文件读取口。
 */

/**
 * 白名单根集（每次请求现算：项目表会变，家目录派生项恒定）。
 * 临时目录只放 `<tmp>/weave` 这个专属子目录：整个 `%TEMP%` 里任何 .html 都能被
 * 引用行拉进 iframe，边界没必要放宽到那一步。
 */
function whitelistRoots(deps: WeaveServerDeps): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, HARNESS_DIRS.codex.userDir, 'visualizations'),
    path.join(home, HARNESS_DIRS.claude.userDir),
    path.join(home, HARNESS_DIRS.codex.userDir, 'plugins'),
    path.join(os.tmpdir(), 'weave'),
  ];
  for (const project of deps.projects.list()) roots.push(project.path);
  return roots;
}

export async function handleVisualizationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  if (pathname !== '/visualizations/fragment' || req.method !== 'GET') return false;
  const raw = url.searchParams.get('path') ?? '';
  const abs = path.resolve(raw);
  if (!raw || !path.isAbsolute(raw)) {
    sendJson(res, 400, { error: 'Missing or relative "path" query parameter' });
    return true;
  }

  const roots = whitelistRoots(deps);
  if (!roots.some((root) => isInsideDir(abs, root))) {
    sendJson(res, 403, {
      error: `Fragment path is outside the allowed roots: ${roots.join(', ')}`,
    });
    return true;
  }
  if (path.extname(abs).toLowerCase() !== '.html') {
    sendJson(res, 403, { error: 'Only .html fragments are served' });
    return true;
  }

  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(abs);
  } catch {
    sendJson(res, 404, { error: 'Fragment file not found' });
    return true;
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: 'Fragment path is not a file' });
    return true;
  }
  if (stat.size > VISUALIZATION_PROTOCOL.maxFragmentBytes) {
    sendJson(res, 413, { error: 'Fragment exceeds the 1 MB size limit' });
    return true;
  }

  const html = await fsp.readFile(abs, 'utf8');
  // fragment 是活文件（模型随时重写）：不缓存，跨机访问才拿得到当下快照
  res.setHeader('cache-control', 'no-store');
  sendJson(res, 200, { html });
  return true;
}
