import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthService, LOCAL_TOKEN_HEADER, SESSION_COOKIE } from '../dashboard-auth.js';

describe('AuthService', () => {
  let dir: string;
  let authPath: string;
  let markerPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'weave-auth-'));
    authPath = path.join(dir, 'auth.json');
    markerPath = path.join(dir, 'initial-password');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('首启生成随机初始密码并写标记文件；再次构造不再生成', () => {
    const auth = new AuthService({ authPath, initialPasswordPath: markerPath });
    expect(auth.initialPassword).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    expect(readFileSync(markerPath, 'utf8').trim()).toBe(auth.initialPassword);
    expect(auth.isPasswordSet()).toBe(true);
    expect(auth.verifyPassword(auth.initialPassword!)).toBe(true);

    const again = new AuthService({ authPath, initialPasswordPath: markerPath });
    expect(again.initialPassword).toBeNull();
    expect(again.verifyPassword(auth.initialPassword!)).toBe(true);
    expect(again.getLocalToken()).toBe(auth.getLocalToken());
  });

  it('口令材料不进明文：auth.json 里没有初始密码', () => {
    const auth = new AuthService({ authPath, initialPasswordPath: markerPath });
    expect(auth.verifyPassword('not-the-password')).toBe(false);
    expect(readFileSync(authPath, 'utf8')).not.toContain(auth.initialPassword!);
  });

  it('会话签名：有效通过、篡改/过期失效', () => {
    let clock = 1_700_000_000_000;
    const auth = new AuthService({ authPath, initialPasswordPath: markerPath, now: () => clock });
    const session = auth.issueSession();
    expect(auth.verifySession(session)).toBe(true);
    expect(auth.verifySession(`${session}tampered`)).toBe(false);
    expect(auth.verifySession('')).toBe(false);
    expect(auth.verifySession('abc.def')).toBe(false);
    clock += 31 * 24 * 60 * 60 * 1000;
    expect(auth.verifySession(session)).toBe(false);
  });

  it('本机令牌与请求级判定（两种凭据都认）', () => {
    const auth = new AuthService({ authPath, initialPasswordPath: markerPath });
    const token = auth.getLocalToken();
    expect(auth.verifyLocalToken(token)).toBe(true);
    expect(auth.verifyLocalToken('nope')).toBe(false);
    expect(auth.verifyLocalToken(undefined)).toBe(false);
    expect(auth.isAuthenticated({ [LOCAL_TOKEN_HEADER]: token })).toBe(true);
    expect(auth.isAuthenticated({ cookie: `${SESSION_COOKIE}=${auth.issueSession()}` })).toBe(true);
    expect(auth.isAuthenticated({ cookie: `${SESSION_COOKIE}=bogus` })).toBe(false);
    expect(auth.isAuthenticated({})).toBe(false);
  });

  it('改密：新口令生效、旧会话失效（轮换密钥）、标记文件清掉', () => {
    const auth = new AuthService({ authPath, initialPasswordPath: markerPath });
    const oldSession = auth.issueSession();
    expect(existsSync(markerPath)).toBe(true);

    auth.setPassword('new-secret-pw');

    expect(auth.verifyPassword('new-secret-pw')).toBe(true);
    expect(auth.verifyPassword(auth.initialPassword!)).toBe(false);
    expect(auth.verifySession(oldSession)).toBe(false);
    expect(auth.verifySession(auth.issueSession())).toBe(true);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('坏 auth.json 按缺失重生成（不抛）', () => {
    writeFileSync(authPath, '{ not json', 'utf8');
    const auth = new AuthService({ authPath, initialPasswordPath: markerPath });
    expect(auth.initialPassword).not.toBeNull();
    expect(auth.verifyPassword(auth.initialPassword!)).toBe(true);
  });
});
