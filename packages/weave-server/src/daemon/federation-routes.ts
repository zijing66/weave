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
    deps.dataBus?.emit({ key: 'federation' });
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
    deps.dataBus?.emit({ key: 'federation' });
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
    await handleFederationCall(req, res, deps);
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
      deps.dataBus?.emit({ key: 'federation' });
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
      deps.dataBus?.emit({ key: 'federation' });
      sendJson(res, 200, { peer: row });
      return true;
    }
    if (req.method === 'DELETE') {
      if (tokenDir) revokePeerToken(tokenDir, id, tokenFileOf);
      const ok = peers.delete(id);
      deps.dataBus?.emit({ key: 'federation' });
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
    deps.dataBus?.emit({ key: 'federation' });
    sendJson(res, 200, { peer: peers.getById(row.id) });
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
