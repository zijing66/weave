import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../db/db.js';
import { PeerRepository, tokenFileOf } from '../peers.js';
import {
  readPeerToken,
  revokePeerToken,
  writePeerToken,
} from '../../daemon/peer-tokens.js';

/** 联邦 peer 注册表：CRUD、心跳派生、per-peer token 落盘（0600）。 */

let db: DatabaseSync;
let repo: PeerRepository;
let tokenDir: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new PeerRepository(db);
  tokenDir = mkdtempSync(path.join(tmpdir(), 'weave-peer-tokens-'));
});

afterEach(() => {
  db.close();
  rmSync(tokenDir, { recursive: true, force: true });
});

describe('PeerRepository', () => {
  it('创建（manual 基础口径）/ 取回 / 列表 / 删除', () => {
    const row = repo.create({ name: 'B 机', host: '10.0.0.2', port: 6443 });
    expect(row.id).toBeTruthy();
    expect(row.source).toBe('manual');
    expect(row.enabled).toBe(true);
    expect(row.fingerprint).toBeNull();
    expect(row.lastSeenAt).toBeNull();
    expect(repo.getById(row.id)!.host).toBe('10.0.0.2');
    expect(repo.list()).toHaveLength(1);
    expect(repo.delete(row.id)).toBe(true);
    expect(repo.getById(row.id)).toBeUndefined();
  });

  it('pairing 来源带指纹；update 可改 host/port/fingerprint/enabled', () => {
    const fp = 'a'.repeat(64);
    const row = repo.create({
      name: 'peer-x',
      host: 'x.local',
      port: 6443,
      fingerprint: fp,
      source: 'pairing',
    });
    expect(row.source).toBe('pairing');
    const updated = repo.update(row.id, { host: '10.0.0.9', port: 7443, enabled: false });
    expect(updated!.host).toBe('10.0.0.9');
    expect(updated!.port).toBe(7443);
    expect(updated!.enabled).toBe(false);
    expect(updated!.fingerprint).toBe(fp);
  });

  it('心跳落地 last_seen_at；离线判定由 peerLiveness 派生不存列', () => {
    const row = repo.create({ name: 'p', host: 'h', port: 1 });
    expect(repo.heartbeat(row.id, '2026-11-07T00:00:00.000Z')).toBe(true);
    expect(repo.getById(row.id)!.lastSeenAt).toBe('2026-11-07T00:00:00.000Z');
    expect(repo.heartbeat('no-such-id', 'x')).toBe(false);
  });

  it('tokenFileOf 由 peerId 派生（行内不存 token）', () => {
    const row = repo.create({ name: 'p', host: 'h', port: 1 });
    expect(tokenFileOf(row.id)).toBe(`${row.id}.json`);
  });
});

describe('per-peer token 落盘（0600）', () => {
  it('写读往返；revoke 删文件', () => {
    const peerId = 'abc-123';
    writePeerToken(
      tokenDir,
      peerId,
      { token: 'tok-xyz', fingerprint: 'f'.repeat(64), issuedAt: 'now' },
      tokenFileOf,
    );
    const read = readPeerToken(tokenDir, peerId, tokenFileOf);
    expect(read!.token).toBe('tok-xyz');
    expect(read!.fingerprint).toBe('f'.repeat(64));
    revokePeerToken(tokenDir, peerId, tokenFileOf);
    expect(readPeerToken(tokenDir, peerId, tokenFileOf)).toBeNull();
  });

  it('文件 0600；坏 JSON 返回 null（不抛）', () => {
    const peerId = 'bad-json';
    writeFileSync(path.join(tokenDir, tokenFileOf(peerId)), '{oops');
    expect(readPeerToken(tokenDir, peerId, tokenFileOf)).toBeNull();
    if (process.platform !== 'win32') {
      const peerId2 = 'perm';
      writePeerToken(
        tokenDir,
        peerId2,
        { token: 't', fingerprint: '', issuedAt: '' },
        tokenFileOf,
      );
      expect(statSync(path.join(tokenDir, tokenFileOf(peerId2))).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(path.join(tokenDir, tokenFileOf('missing')))).toBe(false);
  });

  it('读缺失文件 = null', () => {
    expect(readPeerToken(tokenDir, 'none', tokenFileOf)).toBeNull();
  });
});
