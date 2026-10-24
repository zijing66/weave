import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHarness } from '@weavecode/core';
import type { MessagingSurface } from '@weavecode/harness';
import type { WeaveServerDeps } from '../server.js';
import { readJson, sendJson } from '../http.js';
import { messagingSurfaceFor } from '../../surfaces.js';
import { DEFAULT_WATCH_ON } from '../../repositories/session-watches.js';

/** 会话订阅：watcherSessionId 缺省 null = dashboard 订阅（fire 走 toast + 浏览器通知）；
 *  on = 触发类型集（缺省 idle，批 2 语义）。 */
const CreateWatchBody = z.object({
  watcherSessionId: z.string().min(1).nullable().optional(),
  notify: z.string().min(1).max(20_000).nullable().optional(),
  on: z.array(z.enum(['idle', 'turnEnd', 'messageFailed'])).min(1).optional(),
  /** 提醒次数：1..100；null = 持久化（不自动失效）；缺省 1（一次）。 */
  times: z.number().int().min(1).max(100).nullable().optional(),
});

const DeleteWatchBody = z.object({ watchId: z.number().int().positive() });

/** Web Push 订阅注册：endpoint = 浏览器推送服务分配的绝对 URL；keys = 载荷加密密钥对。 */
const SubscribePushBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

const UnsubscribePushBody = z.object({ endpoint: z.string().url() });

/** prompt 通道可用性（与投递裁决同口径）：宿主队列 || 层① 原生中继 || 层② 终端 send-text 兜底。 */
function promptChannelOf(surface: MessagingSurface, terminalChannel: boolean): boolean {
  return surface.queuedPrompt !== null || surface.prompt !== null || terminalChannel;
}

/**
 * 提醒域路由：空闲订阅（one-shot「空闲时提醒我」）+ Web Push（提醒第三条腿）。
 * 返回 true = 本路由认领；false = 未命中，主链继续。
 */
export async function handleWatchRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
): Promise<boolean> {
  // ---- 空闲订阅域（session-orchestration 批 2）：one-shot「空闲时提醒我」 ----
  const watchMatch = pathname.match(/^\/sessions\/([^/]+)\/watch$/);
  if (watchMatch) {
    const sessionId = decodeURIComponent(watchMatch[1]!);
    if (req.method === 'POST') {
      if (!deps.sessionWatches || !deps.hookSessions || !deps.hookEvents) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      let body: z.infer<typeof CreateWatchBody>;
      try {
        body = CreateWatchBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      const target = deps.hookSessions.getBySessionId(sessionId);
      if (!target) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }
      // 目标 harness = 最新事件 source（与 open-terminal / 消息投递同口径）
      const latest = deps.hookEvents.listBySession(sessionId, 1);
      const targetSrc = latest[latest.length - 1]?.source;
      if (!isHarness(targetSrc)) {
        sendJson(res, 400, { error: 'Session has no hook events to determine its harness' });
        return true;
      }
      const targetSurface = messagingSurfaceFor(targetSrc);
      const on = body.on ?? [...DEFAULT_WATCH_ON];
      // 按订阅类型逐个验通道：空闲/回合结束要 idleSignals（批 2 判据）；
      // 投递失败要该会话「可被投递」（prompt 列 || inject/headless），否则永不可达。
      if ((on.includes('idle') || on.includes('turnEnd')) && targetSurface.idleSignals.length === 0) {
        sendJson(
          res,
          409,
          { error: targetSurface.unsupportedReasons?.watch ?? `Harness "${targetSrc}" does not support idle watching` },
        );
        return true;
      }
      if (on.includes('messageFailed')) {
        const messageable =
          promptChannelOf(targetSurface, deps.messageDeliverer?.hasTerminalChannel() ?? false) ||
          targetSurface.inject !== null ||
          targetSurface.headless !== null;
        if (!messageable) {
          sendJson(res, 409, {
            error:
              targetSurface.unsupportedReasons?.prompt ??
              `Harness "${targetSrc}" supports no messaging channel`,
          });
          return true;
        }
      }
      // 会话订阅方：通知注入它的 inject 通道必须在场（否则 fire 时必然无声丢弃）
      if (body.watcherSessionId) {
        const watcher = deps.hookSessions.getBySessionId(body.watcherSessionId);
        if (!watcher) {
          sendJson(res, 404, { error: 'Watcher session not found' });
          return true;
        }
        const watcherLatest = deps.hookEvents.listBySession(body.watcherSessionId, 1);
        const watcherSrc = watcherLatest[watcherLatest.length - 1]?.source;
        if (!isHarness(watcherSrc)) {
          sendJson(res, 400, { error: 'Watcher session has no hook events to determine its harness' });
          return true;
        }
        const watcherSurface = messagingSurfaceFor(watcherSrc);
        if (!watcherSurface.inject) {
          sendJson(
            res,
            409,
            { error: watcherSurface.unsupportedReasons?.inject ?? `Harness "${watcherSrc}" cannot receive watch notifications` },
          );
          return true;
        }
      }
      // dashboard 订阅（watcherSessionId null）按「每目标至多一行」upsert：同目标
      // 已有 pending dashboard 行 → 原行改写类型集/次数（id/createdAt 不动），不再
      // 插影子行——否则旧行在 UI 里不可见但仍会 fire。会话订阅方多行合法，走 insert。
      const times = body.times === undefined ? 1 : body.times;
      const existing =
        (body.watcherSessionId ?? null) === null
          ? deps.sessionWatches
              .listPendingByTarget(sessionId)
              .find((w) => w.watcherSessionId === null)
          : undefined;
      const updated = existing
        ? deps.sessionWatches.updateById(existing.id, { onEvents: on, remaining: times })
        : undefined;
      // existing 在读取到写入之间恰好落定（并发 fire 改了 fired_at）→ 退回新订阅
      const watch = updated ??
        deps.sessionWatches.insert({
          watcherSessionId: body.watcherSessionId ?? null,
          targetSessionId: sessionId,
          notify: body.notify ?? null,
          onEvents: on,
          times,
        });
      // 目标此刻已空闲 → 立即 fire（不等下一拍；one-shot 语义即「答案就是现在」）
      deps.watchEngine?.created(watch);
      sendJson(res, updated ? 200 : 201, { ok: true, watchId: watch.id, watch });
      return true;
    }
    if (req.method === 'DELETE') {
      if (!deps.sessionWatches) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      let body: z.infer<typeof DeleteWatchBody>;
      try {
        body = DeleteWatchBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      const row = deps.sessionWatches.getById(body.watchId);
      if (!row || row.targetSessionId !== sessionId || row.firedAt !== null) {
        sendJson(res, 404, { error: 'Watch not found' });
        return true;
      }
      deps.sessionWatches.deleteById(body.watchId);
      sendJson(res, 200, { ok: true, watchId: body.watchId });
      return true;
    }
  }

  // ---- 订阅面查询：pending 全量（web 按 watcherSessionId 过滤 dashboard 行） ----
  if (pathname === '/messaging/watches' && req.method === 'GET') {
    if (!deps.sessionWatches) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    sendJson(res, 200, { watches: deps.sessionWatches.listPending() });
    return true;
  }

  // ---- Web Push（提醒第三条腿）：applicationServerKey + 浏览器订阅注册/撤销 ----
  if (pathname === '/messaging/push/key' && req.method === 'GET') {
    if (!deps.pushNotifier) {
      sendJson(res, 503, { error: 'Push subsystem unavailable' });
      return true;
    }
    sendJson(res, 200, { publicKey: deps.pushNotifier.publicKey() });
    return true;
  }

  if (pathname === '/messaging/push/subscribe' && req.method === 'POST') {
    if (!deps.pushSubscriptions) {
      sendJson(res, 503, { error: 'Push subsystem unavailable' });
      return true;
    }
    try {
      const body = SubscribePushBody.parse(await readJson(req));
      const subscription = deps.pushSubscriptions.upsert({
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent: req.headers['user-agent'] ?? null,
      });
      sendJson(res, 201, { ok: true, subscription });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
    }
    return true;
  }

  if (pathname === '/messaging/push/unsubscribe' && req.method === 'POST') {
    if (!deps.pushSubscriptions) {
      sendJson(res, 503, { error: 'Push subsystem unavailable' });
      return true;
    }
    try {
      const body = UnsubscribePushBody.parse(await readJson(req));
      deps.pushSubscriptions.deleteByEndpoint(body.endpoint);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
    }
    return true;
  }

  return false;
}
