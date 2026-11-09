import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { WeaveServerDeps } from './server.js';
import { readJson, sendJson } from './http.js';
import type { PeerRepository, PeerRow } from '../repositories/peers.js';
import {
  FEDERATION_SERVICES,
  createOffer,
  consumeOffer,
  tofuVerdict,
  type PairingSession,
} from './federation.js';
import {
  readPeerToken,
  revokePeerToken,
  writePeerToken,
} from './peer-tokens.js';
import { tokenFileOf } from '../repositories/peers.js';
import { handleDiscoverRoute } from './mdns-advertiser.js';
import { handleFederationCall, readPeerTokenFromRequest } from './federation-call.js';
import { peerRequest, describePeerError, peerEndpointOf } from './federation-client.js';
import { withPeerNames } from '../rpg/invitations.js';

/**
 * /federation/* 的**全量面**（F1 起）：peer 注册表 CRUD + pairing 全链（出站
 * 接线）+ caps 互报 + call 服务门 + 心跳。认证口径：
 * - 管理面（peer CRUD / pairing 发起 / discover）走既有认证门（本会话内）；
 * - `/federation/pair`（对端来交换）、`/federation/heartbeat`、`/federation/call`
 *   只认 per-peer token（豁免段模式同 `/webhooks/orchestrate/`）——**绝不收
 *   本机 localToken**；`/federation/caps` 是互报读端点，同样挂 per-peer token 门
 *   （不外露给无凭据者）。
 */

const PeerBody = z
  .object({
    name: z.string().min(1).max(100),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65_535),
    fingerprint: z.string().regex(/^[0-9a-f]{1,64}$/i).max(64).optional(),
  })
  .strict();

const PairRequestBody = z
  .object({
    code: z.string().regex(/^\d{6}$/),
    name: z.string().min(1).max(100),
    fingerprint: z.string().regex(/^[0-9a-f]{1,64}$/i).max(64),
  })
  .strict();

const HeartbeatBody = z
  .object({ token: z.string().min(8).max(200) })
  .strict();

/** 活跃 pairing 要约（进程内存——重启即作废重开，短码本就是短命人工通道）。 */
let activePairing: PairingSession | null = null;

/** 对端 sessions.list 只读查询的短缓存（30s；federation 帧到即整表清空）。 */
const PEER_SESSIONS_CACHE_MS = 30_000;
const peerSessionsCache = new Map<
  string,
  { at: number; online: boolean; sessions: Array<{ sessionId: string; title: string | null; harness: string | null; turnOpen: boolean | null; lastSeenAt: string | null }> }
>();

export function resetPairingForTest(): void {
  activePairing = null;
}

/** per-peer token 门：对端来请求带的 token 换回本机的 peer 行（不存在/停用 = null）。 */
export function peerByToken(peers: PeerRepository, tokenDir: string | undefined, token: string): PeerRow | null {
  if (!tokenDir) return null;
  const row = peers.list().find((p) => readPeerToken(tokenDir, p.id, tokenFileOf)?.token === token);
  return row && row.enabled ? row : null;
}

async function parseBody<T extends z.ZodTypeAny>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: T,
): Promise<z.infer<T> | null> {
  let raw: unknown;
  try {
    raw = await readJson(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
    return null;
  }
  return parsed.data as z.infer<T>;
}

export async function handleFederationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/federation')) return false;
  const peers: PeerRepository | undefined = deps.peers;
  if (!peers) {
    sendJson(res, 503, { error: 'Federation unavailable' });
    return true;
  }
  const tokenDir = deps.peerTokensDir;
  const certPem = deps.ownCertPem ?? '';
  const hostname = deps.ownHostname ?? '';

  // federation 帧既是对端的失效信号，也是本端缓存的：心跳/call/管理面一动就整表清
  // （对端 sessions.list 的 30s 短缓存随之失效——不靠计时器）。
  const federate = (): void => {
    peerSessionsCache.clear();
    deps.dataBus?.emit({ key: 'federation' });
  };

  // --- per-peer token 门内（豁免既有认证门）：对端来心跳 ---
  if (pathname === '/federation/heartbeat') {
    if (req.method !== 'POST') return true;
    const body = await parseBody(req, res, HeartbeatBody);
    if (!body) return true;
    const row = peerByToken(peers, tokenDir, body.token);
    if (!row) {
      sendJson(res, 403, { error: 'refused' });
      return true;
    }
    peers.heartbeat(row.id, new Date().toISOString());
    federate();
    sendJson(res, 200, { ok: true });
    return true;
  }

  // --- per-peer token 门内（豁免既有认证门）：互报 / 服务调用（F1）---
  if (pathname === '/federation/caps' || pathname === '/federation/call') {
    const token = readPeerTokenFromRequest(req);
    const row = token ? peerByToken(peers, tokenDir, token) : null;
    if (!row) {
      sendJson(res, 403, { error: 'refused: per-peer token required' });
      return true;
    }
    // 心跳副带：能过 token 门的请求就是对端活着的证据。
    peers.heartbeat(row.id, new Date().toISOString());
    federate();
    if (pathname === '/federation/caps') {
      if (req.method !== 'GET') return true;
      sendJson(res, 200, {
        hostname,
        fingerprint: deps.ownFingerprint ?? null,
        services: FEDERATION_SERVICES,
      });
      return true;
    }
    if (req.method !== 'POST') return true;
    await handleFederationCall(req, res, deps, { id: row.id, name: row.name });
    return true;
  }

  // --- 对端来交换（短码已由本机用户口头交给对方）：同样豁免认证门 ---
  if (pathname === '/federation/pair') {
    if (req.method !== 'POST') return true;
    const body = await parseBody(req, res, PairRequestBody);
    if (!body) return true;
    if (!activePairing || !consumeOffer(activePairing, body.code)) {
      sendJson(res, 403, { error: 'refused: pairing offer missing, expired or already used' });
      return true;
    }
    // TOFU：对端指纹与既有记录不一致即拒（证书变更 = 重新 pairing——裁决 15④）。
    const existing = peers.list().find((p) => p.host === body.name || p.name === body.name);
    if (existing?.fingerprint) {
      const verdict = tofuVerdict(existing.fingerprint, body.fingerprint);
      if (verdict === 'mismatch') {
        sendJson(res, 409, { error: 'refused: certificate fingerprint mismatch, re-pair' });
        return true;
      }
    }
    const peer =
      existing ??
      peers.create({
        name: body.name,
        host: body.name,
        port: 0,
        fingerprint: body.fingerprint,
        source: 'pairing',
      });
    peers.update(peer.id, { fingerprint: body.fingerprint });
    const token = randomBytes(24).toString('hex');
    if (tokenDir) {
      writePeerToken(
        tokenDir,
        peer.id,
        { token, fingerprint: peer.fingerprint ?? body.fingerprint, issuedAt: new Date().toISOString() },
        tokenFileOf,
      );
    }
    sendJson(res, 200, {
      peerId: peer.id,
      token,
      fingerprint: activePairing.offer.fingerprint,
      hostname,
    });
    return true;
  }

  // --- 以下全在既有认证门内（dashboard 会话/本机令牌）---

  if (pathname === '/federation/peers') {
    if (req.method === 'GET') {
      sendJson(res, 200, { peers: peers.list() });
      return true;
    }
    if (req.method === 'POST') {
      const body = await parseBody(req, res, PeerBody);
      if (!body) return true;
      const row = peers.create({
        name: body.name,
        host: body.host,
        port: body.port,
        fingerprint: body.fingerprint ?? null,
        source: 'manual',
      });
      federate();
      sendJson(res, 201, { peer: row });
      return true;
    }
    return true;
  }

  const peerMatch = pathname.match(/^\/federation\/peers\/([\w-]+)$/);
  if (peerMatch) {
    const id = peerMatch[1]!;
    if (req.method === 'GET') {
      const row = peers.getById(id);
      if (!row) {
        sendJson(res, 404, { error: 'Not found' });
        return true;
      }
      sendJson(res, 200, { peer: row });
      return true;
    }
    if (req.method === 'PATCH') {
      const body = await parseBody(req, res, PeerBody.partial());
      if (!body) return true;
      const row = peers.update(id, {
        ...(body.name != null ? { name: body.name } : {}),
        ...(body.host != null ? { host: body.host } : {}),
        ...(body.port != null ? { port: body.port } : {}),
        ...(body.fingerprint !== undefined ? { fingerprint: body.fingerprint ?? null } : {}),
      });
      if (!row) {
        sendJson(res, 404, { error: 'Not found' });
        return true;
      }
      federate();
      sendJson(res, 200, { peer: row });
      return true;
    }
    if (req.method === 'DELETE') {
      if (tokenDir) revokePeerToken(tokenDir, id, tokenFileOf);
      const ok = peers.delete(id);
      federate();
      sendJson(res, 200, { ok });
      return true;
    }
    return true;
  }

  // pairing 发起：生成本批短码要约（人工把短码交给对端 / 在对端 dashboard 输入）。
  if (pathname === '/federation/pairing/offer') {
    if (req.method !== 'POST') return true;
    if (!certPem || !hostname) {
      sendJson(res, 503, { error: 'certificate unavailable' });
      return true;
    }
    activePairing = createOffer({ fingerprint: deps.ownFingerprint ?? '', hostname });
    sendJson(res, 200, { code: activePairing.offer.code, expiresAt: activePairing.offer.expiresAt });
    return true;
  }

  // 发起方向对端发起 pairing 的客户端动作（本机作为 initiator，F1 接线）：
  // 带短码打对端 `POST https://<host>:<port>/federation/pair`，收对端签发的
  // per-peer token 落本机 peer-tokens 目录；对端指纹 TOFU 对齐（mismatch 即拒
  // 并明说要重 pairing）。出站恒 HTTPS（裁决 15⑤），证书按指纹 pin。
  if (pathname === '/federation/pairing/initiate') {
    if (req.method !== 'POST') return true;
    const body = await parseBody(
      req,
      res,
      z
        .object({
          name: z.string().min(1).max(100),
          host: z.string().min(1).max(255).optional(),
          port: z.number().int().min(1).max(65_535),
          code: z.string().regex(/^\d{6}$/),
          fingerprint: z.string().regex(/^[0-9a-f]{1,64}$/i).max(64).optional(),
        })
        .strict(),
    );
    if (!body) return true;
    const host = body.host ?? body.name;
    // TOFU 预检：已登记指纹与用户报的指纹不一致 = 配错机器，直接拒。
    const existing = peers.list().find((p) => p.name === body.name || p.host === host);
    if (existing?.fingerprint && body.fingerprint) {
      if (tofuVerdict(existing.fingerprint, body.fingerprint) === 'mismatch') {
        sendJson(res, 409, { error: 'fingerprint mismatch with recorded peer — re-pair required' });
        return true;
      }
    }
    const endpoint = peerEndpointOf({
      ...{ id: existing?.id ?? '', name: body.name, host, port: body.port, fingerprint: existing?.fingerprint ?? body.fingerprint ?? null, source: 'pairing', lastSeenAt: null, enabled: true, createdAt: '' },
    });
    if (!endpoint) {
      sendJson(res, 400, { error: 'peer endpoint unavailable' });
      return true;
    }
    let pairBody: string;
    try {
      const r = await peerRequest(endpoint, {
        method: 'POST',
        path: '/federation/pair',
        body: { code: body.code, name: hostname || body.name, fingerprint: deps.ownFingerprint ?? '' },
      });
      pairBody = r.body;
      if (r.status === 409 || /mismatch/.test(r.body)) {
        sendJson(res, 409, { error: 'peer rejected: certificate fingerprint mismatch — re-pair required' });
        return true;
      }
      if (r.status === 403) {
        sendJson(res, 403, { error: 'peer refused the pairing code (missing, expired or already used)' });
        return true;
      }
      if (r.status >= 400) {
        sendJson(res, 502, { error: `peer pairing failed: HTTP ${r.status}` });
        return true;
      }
    } catch (err) {
      const { reason, message } = describePeerError(err);
      sendJson(res, reason === 'refused' ? 409 : 502, { error: `peer pairing failed (${reason}): ${message}` });
      return true;
    }
    let parsed: { peerId?: string; token?: string; fingerprint?: string; hostname?: string };
    try {
      parsed = JSON.parse(pairBody) as typeof parsed;
    } catch {
      sendJson(res, 502, { error: 'peer pairing response was not JSON' });
      return true;
    }
    if (!parsed.token) {
      sendJson(res, 502, { error: 'peer pairing response missing token' });
      return true;
    }
    // TOFU 定案：响应对端指纹（短码配对后对端报来的身份）与预登记严格比对。
    const peerFp = parsed.fingerprint ?? body.fingerprint ?? null;
    if (existing?.fingerprint && peerFp && tofuVerdict(existing.fingerprint, peerFp) === 'mismatch') {
      sendJson(res, 409, { error: 'peer fingerprint mismatch — re-pair required' });
      return true;
    }
    const row = existing ?? peers.create({ name: body.name, host, port: body.port, fingerprint: peerFp, source: 'pairing' });
    peers.update(row.id, {
      host,
      port: body.port,
      ...(peerFp ? { fingerprint: peerFp } : {}),
    });
    // 对端签给本机的 per-peer token 落本机 peer-tokens 目录（0600）——之后出站
    // 心跳与 call 都凭它。
    if (tokenDir) {
      writePeerToken(
        tokenDir,
        row.id,
        { token: parsed.token, fingerprint: peerFp ?? '', issuedAt: new Date().toISOString() },
        tokenFileOf,
      );
    }
    federate();
    sendJson(res, 200, { peer: peers.getById(row.id) });
    return true;
  }

  // --- RPG 跨机邀请（F2，HITL）：发起 = 打对端 call rpg.invite；收到的待办 =
  // rpg_invitations 表（接受/拒绝必须手动点）。列表惰性跑一次 48h 过期扫。
  if (pathname === '/federation/invitations' && req.method === 'GET') {
    if (!deps.rpgInvitations) {
      sendJson(res, 503, { error: 'RPG invitations subsystem unavailable' });
      return true;
    }
    deps.rpgInvitations.expireOverdue();
    federate();
    sendJson(res, 200, { invitations: withPeerNames(deps.rpgInvitations.list(), peers) });
    return true;
  }

  const inviteDecision = pathname.match(/^\/federation\/invitations\/(\d+)\/(accept|decline)$/);
  if (inviteDecision && req.method === 'POST') {
    if (!deps.rpgInvitations) {
      sendJson(res, 503, { error: 'RPG invitations subsystem unavailable' });
      return true;
    }
    const id = Number(inviteDecision[1]);
    const status = inviteDecision[2] === 'accept' ? 'accepted' : 'declined';
    // HITL 铁律：决定只能由用户手动发起——decided_by 恒 manual（自动模式默认关，
    // v1 不给自动接受的写入口）。
    const ok = deps.rpgInvitations.decide(id, status, 'manual');
    if (!ok) {
      sendJson(res, 409, { error: 'invitation is not pending (already decided or expired)' });
      return true;
    }
    federate();
    sendJson(res, 200, { invitation: withPeerNames([deps.rpgInvitations.getById(id)!], peers)[0] });
    return true;
  }

  // 邀请发起（本机协调者视角）：选一个已配对在线 peer → 选团队/场景 → 经
  // federation-client 打对端 /federation/call 的 rpg.invite 行（对端落一条待确认
  // 记录；对端不可达/拒绝如实回错）。
  if (pathname === '/federation/invitations/send' && req.method === 'POST') {
    const body = await parseBody(
      req,
      res,
      z
        .object({
          peerId: z.string().min(1).max(100),
          team: z.string().min(1).max(200),
          scene: z.string().max(200).optional(),
          roles: z
            .array(z.object({ role: z.string().min(1).max(200), module: z.string().max(200).optional() }).strict())
            .max(50)
            .optional(),
          message: z.string().max(2_000).optional(),
        })
        .strict(),
    );
    if (!body) return true;
    const peer = peers.getById(body.peerId);
    if (!peer || !peer.enabled) {
      sendJson(res, 404, { error: `Unknown peer: ${body.peerId}` });
      return true;
    }
    const endpoint = peerEndpointOf(peer);
    if (!endpoint) {
      sendJson(res, 400, { error: 'peer endpoint unavailable (host/port missing)' });
      return true;
    }
    const tokenDir = deps.peerTokensDir;
    const token = tokenDir ? readPeerToken(tokenDir, peer.id, tokenFileOf)?.token : undefined;
    if (!token) {
      sendJson(res, 409, { error: 'no per-peer token for this peer — pair first' });
      return true;
    }
    let r;
    try {
      r = await peerRequest(endpoint, {
        method: 'POST',
        path: '/federation/call',
        token,
        body: {
          service: 'rpg.invite',
          params: {
            team: body.team,
            ...(body.scene != null ? { scene: body.scene } : {}),
            ...(body.roles != null ? { roles: body.roles } : {}),
            ...(body.message != null ? { message: body.message } : {}),
          },
        },
      });
    } catch (err) {
      const { reason, message } = describePeerError(err);
      sendJson(res, reason === 'refused' ? 409 : 502, { error: `peer invite failed (${reason}): ${message}` });
      return true;
    }
    if (!r.ok) {
      sendJson(res, 502, { error: `peer rejected invite: HTTP ${r.status} ${r.body.slice(0, 200)}` });
      return true;
    }
    sendJson(res, 200, { ok: true, peer: peer.name });
    return true;
  }

  // 对端只读会话清单（F2 跨机角色卡/跨机看板的数据源）：经 call sessions.list
  // 查对端，30s 内存缓存 + federation 帧失效——不每渲染打一次。只读、绝不写远端。
  const peerSessions = pathname.match(/^\/federation\/peers\/([\w-]+)\/sessions$/);
  if (peerSessions && req.method === 'GET') {
    const peer = peers.getById(peerSessions[1]!);
    if (!peer || !peer.enabled) {
      sendJson(res, 404, { error: 'Unknown peer' });
      return true;
    }
    const endpoint = peerEndpointOf(peer);
    if (!endpoint) {
      sendJson(res, 200, { peer: peer.name, online: false, sessions: [] });
      return true;
    }
    const cached = peerSessionsCache.get(peer.id);
    if (cached && Date.now() - cached.at < PEER_SESSIONS_CACHE_MS) {
      sendJson(res, 200, { peer: peer.name, online: cached.online, sessions: cached.sessions });
      return true;
    }
    const tokenDir = deps.peerTokensDir;
    const token = tokenDir ? readPeerToken(tokenDir, peer.id, tokenFileOf)?.token : undefined;
    if (!token) {
      sendJson(res, 409, { error: 'no per-peer token for this peer — pair first' });
      return true;
    }
    let online = false;
    let sessions: Array<{ sessionId: string; title: string | null; harness: string | null; turnOpen: boolean | null; lastSeenAt: string | null }> = [];
    try {
      const r = await peerRequest(endpoint, {
        method: 'POST',
        path: '/federation/call',
        token,
        body: { service: 'sessions.list', params: { limit: 100 } },
      });
      if (r.ok) {
        const parsed = JSON.parse(r.body) as { sessions?: typeof sessions };
        sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
        online = true;
      }
    } catch {
      /* 对端不可达 = 如实给空账 + online:false */
    }
    peerSessionsCache.set(peer.id, { at: Date.now(), online, sessions });
    sendJson(res, 200, { peer: peer.name, online, sessions });
    return true;
  }

  // 局域网 mDNS 浏览快照（发现 ≠ 可用）。
  if (pathname === '/federation/discover') {
    return await handleDiscoverRoute(req, res);
  }

  // 未知子路径（默认拒绝：服务表里没有就不可触达）：404。
  sendJson(res, 404, { error: 'Not found' });
  return true;
}
