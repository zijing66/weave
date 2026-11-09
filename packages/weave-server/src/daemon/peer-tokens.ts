import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/**
 * per-peer token 落盘（E3）：`<local>/peer-tokens/<peerId>.json`（0600）——
 * 与 localToken / ai.json 同口径：凭据绝不进 settings 表、绝不跨机发本机
 * localToken。peer 行只记 peerId（tokenFileOf 由 id 派生）。
 */

export interface PeerTokenFile {
  /** 本机签发给该 peer 的联邦凭据（对端拿它打 /federation/* 与心跳）。 */
  token: string;
  /** 签发时刻本机证书指纹（对端 TOFU 首见的记录源）。 */
  fingerprint: string;
  issuedAt: string;
}

export function readPeerToken(
  dir: string,
  peerId: string,
  tokenFileOf: (id: string) => string,
): PeerTokenFile | null {
  const file = path.join(dir, tokenFileOf(peerId));
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PeerTokenFile>;
    if (typeof parsed.token !== 'string' || parsed.token === '') return null;
    return {
      token: parsed.token,
      fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : '',
      issuedAt: typeof parsed.issuedAt === 'string' ? parsed.issuedAt : '',
    };
  } catch {
    return null;
  }
}

export function writePeerToken(
  dir: string,
  peerId: string,
  value: PeerTokenFile,
  tokenFileOf: (id: string) => string,
): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, tokenFileOf(peerId));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // 平台不支持时忽略（Windows）
  }
}

/** 吊销 = 删文件（pairing 重开时先删后写）。 */
export function revokePeerToken(
  dir: string,
  peerId: string,
  tokenFileOf: (id: string) => string,
): void {
  rmSync(path.join(dir, tokenFileOf(peerId)), { force: true });
}
