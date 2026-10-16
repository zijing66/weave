import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CLAUDE_PROMPT_INBOX } from '@weavecode/harness';
import {
  InboxSocketRegistry,
  deliverViaInboxSocket,
  inboxSocketPathOf,
} from '../inbox-socket.js';

/**
 * inbox socket 直投回归：两行线格式（auth + user）、平台差异（win32 必带 auth）、
 * 失败必 reject（调用方靠它回落）。
 */

const tmpPath = (): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\weave-test-${randomBytes(8).toString('hex')}`
    : `/tmp/weave-test-${randomBytes(8).toString('hex')}.sock`;

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** 起一个假 inbox：把收到的所有数据回调出去。 */
const fakeInbox = (path: string, onData: (text: string) => void): Promise<void> =>
  new Promise((resolve) => {
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (c) => {
        buf += String(c);
      });
      conn.on('end', () => onData(buf));
    });
    servers.push(server);
    server.listen(path, () => resolve());
  });

describe('deliverViaInboxSocket（claude inbox spec 驱动）', () => {
  it('写入两行（auth + user）后关连接；uds: 前缀被剥掉', async () => {
    const path = tmpPath();
    let got = '';
    await fakeInbox(path, (t) => {
      got = t;
    });

    await deliverViaInboxSocket(CLAUDE_PROMPT_INBOX, { socket: path, token: 'tok-1' }, 'hello 注入');
    await new Promise((r) => setTimeout(r, 50));

    const lines = got.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'auth', token: 'tok-1' });
    expect(JSON.parse(lines[1]!)).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello 注入' },
    });

    // uds: 前缀（/status 的 Peer address 形态）同样可投
    const path2 = tmpPath();
    let got2 = '';
    await fakeInbox(path2, (t) => {
      got2 = t;
    });
    await deliverViaInboxSocket(
      CLAUDE_PROMPT_INBOX,
      { socket: `uds:${path2}`, token: 'tok-2' },
      'second',
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(got2.trim().split('\n')[1]!)).toMatchObject({ type: 'user' });
  });

  it('win32 缺 token → reject（文档：Windows 必带 auth 行）；POSIX 缺 token 照发', async () => {
    await expect(
      deliverViaInboxSocket(CLAUDE_PROMPT_INBOX, { socket: tmpPath(), token: null }, 'x', {
        platform: 'win32',
      }),
    ).rejects.toThrow(/requires a token/);

    const path = tmpPath();
    let got = '';
    await fakeInbox(path, (t) => {
      got = t;
    });
    await deliverViaInboxSocket(CLAUDE_PROMPT_INBOX, { socket: path, token: null }, 'no-auth', {
      platform: 'linux',
    });
    await new Promise((r) => setTimeout(r, 50));
    const lines = got.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'user' });
  });

  it('连不上（地址不存在）→ reject，不挂死', async () => {
    await expect(
      deliverViaInboxSocket(CLAUDE_PROMPT_INBOX, { socket: tmpPath(), token: 't' }, 'x', {
        timeoutMs: 500,
      }),
    ).rejects.toThrow();
  });
});

describe('helpers', () => {
  it('claude spec：仅 win32 要求 auth 行', () => {
    expect(CLAUDE_PROMPT_INBOX.requiresAuthOn('win32')).toBe(true);
    expect(CLAUDE_PROMPT_INBOX.requiresAuthOn('linux')).toBe(false);
    expect(CLAUDE_PROMPT_INBOX.requiresAuthOn('darwin')).toBe(false);
  });

  it('inboxSocketPathOf 只剥 uds: 前缀', () => {
    expect(inboxSocketPathOf('uds:/tmp/x.sock')).toBe('/tmp/x.sock');
    expect(inboxSocketPathOf('\\\\.\\pipe\\LOCAL\\cc-msg-abc')).toBe('\\\\.\\pipe\\LOCAL\\cc-msg-abc');
  });

  it('注册表：覆盖写取最新；socket 空即清；forget 单会话', () => {
    const reg = new InboxSocketRegistry();
    reg.set('s1', { socket: 'a', token: 't1' });
    reg.set('s1', { socket: 'b', token: 't2' });
    expect(reg.get('s1')).toEqual({ socket: 'b', token: 't2' });
    reg.set('s2', { socket: 'c', token: null });
    reg.set('s2', null);
    expect(reg.get('s2')).toBeUndefined();
    reg.forget('s1');
    expect(reg.get('s1')).toBeUndefined();
  });
});

describe('InboxSocketRegistry 落盘（daemon 重启后仍可直投）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-inbox-targets-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('上报即落盘、新实例读回；forget 连盘上一起清', () => {
    const file = join(dir, 'inbox-targets.json');
    const first = new InboxSocketRegistry(file);
    first.set('s1', { socket: 'a', token: 't1' });
    first.set('s2', { socket: 'b', token: null });

    const second = new InboxSocketRegistry(file);
    expect(second.get('s1')).toEqual({ socket: 'a', token: 't1' });
    expect(second.get('s2')).toEqual({ socket: 'b', token: null });

    second.forget('s1');
    expect(new InboxSocketRegistry(file).get('s1')).toBeUndefined();
    expect(new InboxSocketRegistry(file).get('s2')).toEqual({ socket: 'b', token: null });
  });

  it('缺失 / 坏文件 / 形状不像凭据 → 一律当没有，不抛', () => {
    const file = join(dir, 'inbox-targets.json');
    expect(new InboxSocketRegistry(file).get('s1')).toBeUndefined();

    writeFileSync(file, '{ not json');
    expect(new InboxSocketRegistry(file).get('s1')).toBeUndefined();

    writeFileSync(file, JSON.stringify({ s1: { token: 't' }, s2: { socket: 'ok' } }));
    const reg = new InboxSocketRegistry(file);
    expect(reg.get('s1')).toBeUndefined();
    expect(reg.get('s2')).toEqual({ socket: 'ok', token: null });
  });
});
