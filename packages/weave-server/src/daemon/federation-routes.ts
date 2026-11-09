import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { WeaveServerDeps } from './server.js';
import { readJson, sendJson } from './http.js';
import type { PeerRepository } from '../repositories/peers.js';
import {
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

/**
 * /federation/* 的**本批可用面**（E3）：peer 注册表 CRUD + pairing 交换 +
 * 心跳。`/federation/call`、`/federation/caps`、`/federation/invite` 坚决不做
 * ——那是 F1（联邦批）的门。认证口径：
 * - 管理面（peer CRUD / pairing 发起 / discover）走既有认证门（本会话内）；
 * - `/federation/pair`（对端来交换）与 `/federation/heartbeat` 只认 per-peer
 *   token（豁免段模式同 `/webhooks/orchestrate/`）——**绝不收本机 localToken**。
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
    const row = peers.list().find((p) => {
      if (!tokenDir) return false;
      return readPeerToken(tokenDir, p.id, tokenFileOf)?.token === body.token;
    });
    if (!row || !row.enabled) {
      sendJson(res, 403, { error: 'refused' });
      return true;
    }
    peers.heartbeat(row.id, new Date().toISOString());
    sendJson(res, 200, { ok: true });
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
      sendJson(res, 200, { peer: row });
      return true;
    }
    if (req.method === 'DELETE') {
      if (tokenDir) revokePeerToken(tokenDir, id, tokenFileOf);
      sendJson(res, 200, { ok: peers.delete(id) });
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

  // 发起方向对端发起 pairing 的客户端动作（本机作为 initiator）：带短码打对端。
  // 网络出口不在本批（call/转发坚决不做）——initiator 侧的 HTTP 出站留给 F1 接线，
  // 本端只落「对端证书指纹先记一行」的 TOFU 预登记。
  if (pathname === '/federation/pairing/initiate') {
    if (req.method !== 'POST') return true;
    const body = await parseBody(
      req,
      res,
      z
        .object({ name: z.string().min(1).max(100), fingerprint: z.string().regex(/^[0-9a-f]{1,64}$/i).max(64) })
        .strict(),
    );
    if (!body) return true;
    const row = peers.create({
      name: body.name,
      host: body.name,
      port: 0,
      fingerprint: body.fingerprint,
      source: 'pairing',
    });
    sendJson(res, 201, { peer: row });
    return true;
  }

  // 局域网 mDNS 浏览快照（发现 ≠ 可用）。
  if (pathname === '/federation/discover') {
    return await handleDiscoverRoute(req, res);
  }

  // 未知子路径（含 F1 的 call/caps/invite——本批坚决不做）：404，不是 200 空响应。
  sendJson(res, 404, { error: 'Not found' });
  return true;
}
