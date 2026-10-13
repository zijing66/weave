import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { isHarness } from '@weavecode/core';
import { WEAVE_VERSION } from '../version.js';
import type { WeaveServerDeps } from './server.js';
import { readJson, sendJson } from './http.js';
import { captureSurfaces } from '../surfaces.js';

/**
 * §6-2d user 档采集面路由（范式同 toolkit-routes）：
 *   GET /capture — 各 harness 的 user 档采集状态行
 *   PUT /capture — {harness, enabled} 安装/停用 user 档采集（安装即启用：
 *                 hooks 组存在即生效，无独立开关位）
 * 安装同时清掉已注册项目的 weave 采集组——宿主合并 user+project 两处 hooks，
 * 双注册 = 同一事件采两份；此后 init 侧「空即清光」语义跟进兜底。
 * 返回 false 表示未命中，主链继续分发。
 */

const CapturePutBody = z.object({
  harness: z.string(),
  enabled: z.boolean(),
});

export async function handleCaptureRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/capture') return false;

  if (req.method === 'GET') {
    const rows = await Promise.all(
      captureSurfaces().map(async ({ harness, surface }) => ({
        harness,
        ...(await surface.readUserCapture()),
      })),
    );
    sendJson(res, 200, { rows });
    return true;
  }

  if (req.method === 'PUT') {
    let body: z.infer<typeof CapturePutBody>;
    try {
      body = CapturePutBody.parse(await readJson(req));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    if (!isHarness(body.harness)) {
      sendJson(res, 400, { error: `Unknown harness: ${body.harness}` });
      return true;
    }
    const face = captureSurfaces().find((c) => c.harness === body.harness);
    if (!face) {
      sendJson(res, 400, { error: `No capture surface for harness: ${body.harness}` });
      return true;
    }
    try {
      if (body.enabled) {
        await face.surface.installUserCapture({ version: WEAVE_VERSION });
        for (const p of deps.projects.list()) {
          await face.surface.stripProjectCapture(p.path);
        }
      } else {
        await face.surface.uninstallUserCapture();
      }
      deps.dataBus?.emit({ key: 'capture' });
      sendJson(res, 200, { harness: face.harness, ...(await face.surface.readUserCapture()) });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Capture update failed' });
    }
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}
