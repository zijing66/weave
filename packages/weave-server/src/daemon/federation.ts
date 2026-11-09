import { createHash } from 'node:crypto';
import { X509Certificate } from 'node:crypto';

/**
 * mTCP 发现与联邦数据面（E3）的纯函数层：广播载荷、TOFU 指纹、pairing 状态机、
 * 心跳判离线。路由与 bonjour 装配各自落文件，只消费这里——F1（联邦批）复用
 * 本层做 caps 握手与路由，接口从这里拿准。
 */

/** mDNS 服务类型（RPG 稿 §六：`_weave-mcp._tcp`）。 */
export const MDNS_SERVICE_TYPE = 'weave-mcp';
export const MDNS_SERVICE_DOMAIN = 'tcp';

/** 心跳节奏（裁决 15⑥）：30s 心跳、90s 判离线。 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const OFFLINE_AFTER_MS = 90_000;
/** pairing 短码有效期：人工输入的窗口，过期作废重开。 */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

/**
 * TXT 记录：版本 + capabilities 摘要 + 可读机器名。值全是短 ASCII（mDNS 单串
 * 上限 255 字节，capabilities 只放摘要不放清单——完整互报是 F1 的 caps 端点）。
 */
export interface WeaveMdnsTxt {
  /** weave 版本（语义版本字符串）。 */
  ver: string;
  /** capabilities 摘要：本批恒 'mcp'；F1 握手后扩为注册表外露行的哈希短码。 */
  caps: string;
  /** 可读机器名（os.hostname，截 60 字符）。 */
  name: string;
  /** 本机证书指纹前 16 hex（供发现列表预判对端身份，权威比对在 pairing）。 */
  fp: string;
}

/** 广播端点：恒 HTTPS（裁决 15⑤ HTTP 降级档 v1 不做）——tlsPort 未开不广播。 */
export interface WeaveMdnsEndpoint {
  tlsPort: number;
  txt: WeaveMdnsTxt;
}

/** 实例名：`weave-<机器名>`，mDNS 非法字符压成 '-'，总长截 63。 */
export function mdnsInstanceName(hostname: string): string {
  const safe = hostname.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'host';
  const label = `weave-${safe}`.slice(0, 63);
  return label.endsWith('-') ? label.slice(0, -1) : label;
}

/** TXT 载荷构造（广播侧唯一出口；单测锁定字段）。 */
export function mdnsTxt(input: {
  version: string;
  hostname: string;
  certPem: string;
}): WeaveMdnsTxt {
  return {
    ver: input.version,
    caps: 'mcp',
    name: input.hostname.slice(0, 60),
    fp: (certFingerprint(input.certPem) ?? '').slice(0, 16),
  };
}

/** 广播完整性判据：tlsPort 开着才算可广播端点（HTTPS + TOFU 唯一形态）。 */
export function advertisable(tlsPort: number | undefined): boolean {
  return typeof tlsPort === 'number' && tlsPort > 0;
}

// ---- TOFU 指纹（纯函数，F1 直接消费）----

/** 证书 SHA-256 指纹（hex 小写）；坏 PEM 返回 null，不抛。 */
export function certFingerprint(certPem: string): string | null {
  try {
    const cert = new X509Certificate(certPem);
    return createHash('sha256').update(cert.raw).digest('hex');
  } catch {
    return null;
  }
}

export type TofuVerdict = 'first-use' | 'match' | 'mismatch';

/**
 * TOFU 指纹对齐（裁决 15④）：首见即信任并记录；已记录则严格等值——
 * 不匹配即拒（证书变更 = 重新 pairing），调用方据此走 pairing 重开。
 */
export function tofuVerdict(expected: string | null | undefined, actual: string): TofuVerdict {
  const want = expected?.toLowerCase() ?? null;
  if (!want) return 'first-use';
  return want === actual.toLowerCase() ? 'match' : 'mismatch';
}

// ---- pairing 状态机（纯函数）----

export interface PairingOffer {
  /** 6 位数字短码（人工输入通道）。 */
  code: string;
  /** 本机对外身份（pairing 交换给对端）。 */
  fingerprint: string;
  hostname: string;
  expiresAt: number;
}

export interface PairingExchange {
  /** 对端报来的身份。 */
  peerName: string;
  peerFingerprint: string;
  /** 本机签发给该 peer 的 per-peer token（落 token 文件 + peer 行）。 */
  peerToken: string;
  /** 本机身份（对端据此落自己的 peer 行）。 */
  fingerprint: string;
  hostname: string;
}

/** pairing 生成 peer uuid（裁决 15④）。 */
export type PeerState = 'online' | 'offline' | 'never-seen';

/** 心跳判离线：90s 内有心跳 = online；有过心跳但超窗 = offline；从无 = never-seen。 */
export function peerLiveness(
  lastSeenAt: string | null | undefined,
  now: number = Date.now(),
): PeerState {
  if (!lastSeenAt) return 'never-seen';
  const at = Date.parse(lastSeenAt);
  if (!Number.isFinite(at)) return 'never-seen';
  return now - at <= OFFLINE_AFTER_MS ? 'online' : 'offline';
}

export interface PairingSession {
  offer: PairingOffer;
  /** 短码被对端核销后置 true：同一短码只许交换一次。 */
  consumed: boolean;
}

/** 生成一份 pairing 要约（短码 + 有效期）；digits 固定 6 位。 */
export function createOffer(input: {
  fingerprint: string;
  hostname: string;
  now?: number;
  ttlMs?: number;
  random?: (len: number) => string;
}): PairingSession {
  const now = input.now ?? Date.now();
  const code = input.random
    ? input.random(6)
    : String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return {
    offer: {
      code,
      fingerprint: input.fingerprint,
      hostname: input.hostname,
      expiresAt: now + (input.ttlMs ?? PAIRING_CODE_TTL_MS),
    },
    consumed: false,
  };
}

/** 短码核销（对端 POST /federation/pair 命中时）：对上号且未过期未核销才放行。 */
export function consumeOffer(
  session: PairingSession,
  code: string,
  now: number = Date.now(),
): boolean {
  if (session.consumed) return false;
  if (now > session.offer.expiresAt) return false;
  if (session.offer.code !== code) return false;
  session.consumed = true;
  return true;
}

/** 错误形状（裁决 15③ 的本地侧映射：pairing 阶段只用到 unreachable/refused）。 */
export type PairingError = 'unreachable' | 'refused' | 'timeout';
