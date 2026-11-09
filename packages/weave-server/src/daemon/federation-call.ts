import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { readJson } from './http.js';
import { FEDERATION_SERVICES } from './federation.js';
import type { WeaveServerDeps } from './server.js';
import { readPeerToken } from './peer-tokens.js';
import { tokenFileOf } from '../repositories/peers.js';

/**
 * `POST /federation/call` —— 对端服务调用门（F1）。请求 `{service, params}`，
 * per-peer token 门已在路由侧过完（这里只做服务裁决）。**默认拒绝**：服务表
 * （FEDERATION_SERVICES）里没有的 service 一律 404——路由层不许变成任意远程
 * 执行通道；副作用行一期只放投递类（inject-only，D8 红线）。
 *
 * 只读行直调本机仓储的最小字段集（不透出 UI 专用状态——与 MCP 策展同口径）；
 * inject 行走 MessageDeliverer（本地直调 = 「对端收到 call 走自己的本地路由器
 * 直调既有 service」的本地半边）。
 */

const CallBody = z
  .object({
    service: z.string().min(1).max(100),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const InjectParams = z
  .object({
    sessionId: z.string().min(1),
    text: z.string().min(1).max(100_000),
    fromPeerName: z.string().max(200).optional(),
  })
  .strict();

const SessionsListParams = z
  .object({ limit: z.number().int().min(1).max(200).optional() })
  .strict();

const SessionEventsParams = z
  .object({
    sessionId: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

/** `rpg.invite` 参数（F2）：只落一条待确认记录——不执行任何动作（不违反 inject-only）。 */
const InviteParams = z
  .object({
    team: z.string().min(1).max(200),
    scene: z.string().max(200).optional(),
    roles: z
      .array(z.object({ role: z.string().min(1).max(200), module: z.string().max(200).optional() }).strict())
      .max(50)
      .optional(),
    message: z.string().max(2_000).optional(),
  })
  .strict();

/** per-peer token 请求读取（门内共用）：`Authorization: Bearer <token>`。 */
export function readPeerTokenFromRequest(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1]! : null;
}

export async function handleFederationCall(
  req: IncomingMessage,
  res: {
    end: (data: string) => void;
    statusCode: number;
    setHeader: (name: string, value: string) => void;
  },
  deps: WeaveServerDeps,
  /** 已过 token 门的调用方 peer（federation-routes 解析；invite 落记录要记来源）。 */
  callerPeer?: { id: string; name: string },
): Promise<void> {
  const json = (status: number, payload: unknown): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  };
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    json(400, { error: 'Invalid JSON body' });
    return;
  }
  const parsed = CallBody.safeParse(body);
  if (!parsed.success) {
    json(400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
    return;
  }
  const service = parsed.data.service;
  const params = parsed.data.params ?? {};
  // 默认拒绝：服务表里没有的 service = 不可触达（404 不是 403——表就是白名单）。
  const row = FEDERATION_SERVICES.find((s) => s.service === service);
  if (!row) {
    json(404, { error: `Unknown service: ${service}` });
    return;
  }

  if (service === 'inject') {
    if (!deps.messageDeliverer) {
      json(503, { error: 'Messaging subsystem unavailable' });
      return;
    }
    const p = InjectParams.safeParse(params);
    if (!p.success) {
      json(400, { error: p.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    const result = await deps.messageDeliverer.send({
      toSessionId: p.data.sessionId,
      text: p.data.text,
      // D8 一期 inject-only：跨机投递恒走 inject 通道（写入 outbox，fire-and-forget）
      mode: 'inject',
      fromKind: 'session',
      fromSessionId: p.data.fromPeerName ?? 'peer',
      oneWay: true,
    });
    if (!result.ok) {
      json(result.status, { error: result.error });
      return;
    }
    json(202, { ok: true, messageId: result.messageId, status: result.status });
    return;
  }

  if (service === 'rpg.invite') {
    if (!deps.rpgInvitations) {
      json(503, { error: 'RPG invitations subsystem unavailable' });
      return;
    }
    if (!callerPeer) {
      json(403, { error: 'invite requires a caller peer identity' });
      return;
    }
    const p = InviteParams.safeParse(params);
    if (!p.success) {
      json(400, { error: p.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    // 只落一条待确认记录（HITL：接受/拒绝由本机用户手动点）——绝不执行任何动作。
    const row = deps.rpgInvitations.create({
      peerId: callerPeer.id,
      team: p.data.team,
      scene: p.data.scene ?? null,
      roles: p.data.roles ?? null,
      message: p.data.message ?? null,
    });
    deps.dataBus?.emit({ key: 'federation' });
    json(201, { ok: true, invitationId: row.id, status: row.status });
    return;
  }

  if (service === 'sessions.list') {
    if (!deps.hookSessions) {
      json(503, { error: 'Hooks subsystem unavailable' });
      return;
    }
    const p = SessionsListParams.safeParse(params);
    if (!p.success) {
      json(400, { error: p.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    const rows = deps.hookSessions.listWithCounts(undefined, undefined);
    const limit = p.data.limit ?? 100;
    // 联邦子集：最小字段（策展原则，同 MCP list_sessions 先例）。
    json(200, {
      sessions: rows.slice(0, limit).map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        harness: s.harness ?? null,
        turnOpen: s.turnOpen ?? null,
        lastSeenAt: s.lastSeenAt,
      })),
    });
    return;
  }

  if (service === 'sessions.events') {
    if (!deps.hookEvents) {
      json(503, { error: 'Hooks subsystem unavailable' });
      return;
    }
    const p = SessionEventsParams.safeParse(params);
    if (!p.success) {
      json(400, { error: p.error.issues.map((i) => i.message).join('; ') });
      return;
    }
    const events = deps.hookEvents.listBySession(p.data.sessionId, p.data.limit ?? 50);
    json(200, {
      events: events.map((e) => ({
        id: e.id,
        type: e.eventType,
        at: e.createdAt,
      })),
    });
    return;
  }

  json(404, { error: `Unknown service: ${service}` });
}

/** token 门复核（路由侧已过一次；call 内部不重复读文件——留位给未来的按服务 scope）。 */
export function peerTokenIssuedFor(
  tokenDir: string | undefined,
  peerId: string,
): string | null {
  if (!tokenDir) return null;
  return readPeerToken(tokenDir, peerId, tokenFileOf)?.token ?? null;
}
