import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ptySpawnOf, shimEntryOf } from '../windows-bin-resolver.js';
import { resolvePosixCommand } from '../posix-bin-resolver.js';
import { InstanceManager } from '../instance-manager.js';
import { ipcPathFor, runtimePipeName, runtimePipePath } from '../protocol.js';
import type { PtyProcess } from '../adapters/windows-pty.js';

describe('shimEntryOf', () => {
  it('从 .cmd shim 文本里解析出绝对 JS 入口', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'weave-shim-'));
    const cli = path.join(dir, 'cli.js');
    writeFileSync(cli, '');
    const shim = path.join(dir, 'bin.cmd');
    writeFileSync(shim, `@echo off\r\nnode "%~dp0\\cli.js" %*\r\n`);
    expect(shimEntryOf(shim)).toBe(cli);
  });

  it('引号里的相对路径按 shim 所在目录解', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'weave-shim-'));
    const cli = path.join(dir, 'cli.js');
    writeFileSync(cli, '');
    const shim = path.join(dir, 'bin.ps1');
    // %~dp0 变量形态解析不出 → 回落相对字面量（bin.js 形）
    writeFileSync(shim, `node "cli.js" $args`);
    expect(shimEntryOf(shim)).toBe(cli);
  });

  it('没有 .js 字面量 = null（回落 cmd /c）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'weave-shim-'));
    const shim = path.join(dir, 'bin.cmd');
    writeFileSync(shim, '@echo off\r\nrem nothing here\r\n');
    expect(shimEntryOf(shim)).toBeNull();
  });

  it('ptySpawnOf 三形映射', () => {
    expect(ptySpawnOf({ kind: 'direct', command: 'C:/x/claude.exe', args: ['-a'] })).toEqual({
      file: 'C:/x/claude.exe',
      args: ['-a'],
    });
    expect(ptySpawnOf({ kind: 'node', entry: 'e:/cli.js', args: ['x'] })).toEqual({
      file: process.execPath,
      args: ['e:/cli.js', 'x'],
    });
    expect(ptySpawnOf({ kind: 'shell', args: ['/c', 'claude'] })).toEqual({
      file: 'cmd.exe',
      args: ['/c', 'claude'],
    });
  });
});

describe('runtimePipeName/Path', () => {
  it('pipe 名含 dataDir 哈希短码且形如 \\\\.\\pipe\\', () => {
    expect(runtimePipePath('D:/weave')).toMatch(/^\\\\\.\\pipe\\weave-runtime-host-[0-9a-f]{8}$/);
    expect(runtimePipeName('a')).not.toBe(runtimePipeName('b'));
  });

  it('POSIX 下 IPC 路径 = data 根下 cache/ 里的 unix socket 文件', () => {
    expect(ipcPathFor('D:/weave', 'linux')).toMatch(
      /^D:[\\/]weave[\\/]cache[\\/]weave-runtime-host-[0-9a-f]{8}\.sock$/,
    );
  });
});

describe('resolvePosixCommand', () => {
  it('带路径分隔符的 bin 直接 direct；which 命中即 direct', () => {
    expect(resolvePosixCommand('/usr/local/bin/claude', ['-x'], () => null)).toEqual({
      kind: 'direct',
      command: '/usr/local/bin/claude',
      args: ['-x'],
    });
    expect(resolvePosixCommand('claude', ['-x'], () => '/usr/bin/claude')).toEqual({
      kind: 'direct',
      command: '/usr/bin/claude',
      args: ['-x'],
    });
  });

  it('which 未命中回落 shell 形（args 已按 POSIX 拼好）', () => {
    const resolved = resolvePosixCommand('claude', ['--resume', 'a b'], () => null);
    expect(resolved).toEqual({ kind: 'shell', args: ['-c', `claude --resume 'a b'`] });
    const spawn = ptySpawnOf(resolved);
    expect(spawn.args).toEqual(['-c', `claude --resume 'a b'`]);
    expect(spawn.file).toBe(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
  });
});

/** 假 PTY：按需手动触发 onExit / 不真开进程。 */
function fakePty(pid: number): PtyProcess & { exitNow(code: number): void } {
  let dataCb: ((d: string) => void) | null = null;
  const exitCbs: Array<(e: { exitCode: number }) => void> = [];
  return {
    pid,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: (cb) => (dataCb = cb),
    onExit: (cb) => exitCbs.push(cb),
    exitNow(code) {
      exitCbs.forEach((cb) => cb({ exitCode: code }));
    },
    get dataOut(): (d: string) => void {
      return (d: string) => dataCb?.(d);
    },
  } as never;
}

describe('InstanceManager', () => {
  async function makeManager() {
    const events: Array<{ type: string; sequence?: number }> = [];
    const fake = fakePty(4242);
    const mgr = new InstanceManager(async () => fake, (e) => events.push(e as { type: string }));
    await mgr.spawn({
      instanceId: 'i1',
      command: 'claude',
      args: [],
      cwd: 'D:/repo',
      cols: 80,
      rows: 24,
      env: {},
    });
    return { mgr, fake, events };
  }

  it('spawn 起始事件带真实 pid，输出推进单调 sequence', async () => {
    const { mgr, fake, events } = await makeManager();
    expect(events[0]).toMatchObject({ type: 'instance.started', instanceId: 'i1', osPid: 4242 });
    fake.dataOut('a');
    fake.dataOut('b');
    const outs = events.filter((e) => e.type === 'terminal.output');
    expect(outs.map((o) => o.sequence)).toEqual([1, 2]);
    expect(mgr.summaries()).toMatchObject([{ id: 'i1', status: 'running', osPid: 4242, lastSequence: 2 }]);
    await mgr.killAll();
  });

  it('replayAfter 报缺口（gap 条目），不装完整', async () => {
    const { mgr, fake } = await makeManager();
    fake.dataOut('a'); // seq 1
    fake.dataOut('b'); // seq 2
    // 丢中间的（直接操纵 ring 模拟淘汰）
    mgr['instances'].get('i1')!.ring.shift();
    const replay = mgr.replayAfter('i1', 0);
    expect(replay.some((e) => e.kind === 'gap')).toBe(true);
    expect(replay.filter((e) => e.kind === 'output').map((e) => e.sequence)).toEqual([2]);
    await mgr.killAll();
  });

  it('onExit 落 exited 事件，activeCount 归零', async () => {
    const { mgr, fake, events } = await makeManager();
    fake.exitNow(0);
    expect(events.at(-1)).toMatchObject({ type: 'instance.exited', exitCode: 0 });
    expect(mgr.activeCount()).toBe(0);
    // 清单只报活实例（exited 行留 Map 供 replay；dashboard 的 liveHeadlessCounts
    // 同口径，否则 ack 的 N 与会话数恒差一枚）。
    expect(mgr.summaries()).toEqual([]);
  });
});
