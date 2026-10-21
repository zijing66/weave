import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, ProjectRepository, registerProject } from '@weavecode/server';
import { doctorCommand } from '../commands/doctor';
import type { CommandContext } from '../parser';

const hoisted = vi.hoisted(() => ({ dbPath: '', daemonRunning: false }));

vi.mock('@weavecode/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weavecode/server')>();
  return {
    ...actual,
    getDbPath: () => hoisted.dbPath,
    openDatabase: (p?: string) => actual.openDatabase(p ?? hoisted.dbPath),
    readDaemonState: () => null,
  };
});

// probeDaemon 会真发 HTTP——本机 daemon 在跑会让结果随环境漂移，固定成可控值。
vi.mock('../commands/daemon', () => ({
  probeDaemon: async () => hoisted.daemonRunning,
}));

let projDir: string;
let srvDir: string;

const run = async (dir: string): Promise<string> => {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  try {
    await doctorCommand.action!({
      flags: { dir },
      commandPath: ['doctor'],
      positional: [],
      raw: [],
    } as unknown as CommandContext);
  } finally {
    spy.mockRestore();
  }
  return logs.join('\n');
};

const writeLocalToken = (dir: string, value: string) =>
  writeFile(path.join(dir, '.weave', 'token'), value + '\n', 'utf-8');

beforeEach(async () => {
  projDir = await mkdtemp(path.join(os.tmpdir(), 'weave-doctor-proj-'));
  srvDir = await mkdtemp(path.join(os.tmpdir(), 'weave-doctor-srv-'));
  hoisted.dbPath = path.join(srvDir, 'weave.db');
  hoisted.daemonRunning = false;
});

afterEach(async () => {
  await rm(projDir, { recursive: true, force: true });
  await rm(srvDir, { recursive: true, force: true });
});

describe('weave doctor', () => {
  it('未注册：带着 weave 文件却不在本机注册表 → 报未注册并给出 weave init 建议', async () => {
    const out = await run(projDir);
    expect(out).toContain('不在本机注册表里');
    expect(out).toContain('却没有注册进本机 weave server');
    expect(out).toContain('weave init');
    expect(out).toContain('缺失（.weave/token 不存在）');
  });

  it('已注册且令牌一致 → 正常', async () => {
    registerProject(projDir, 'init', hoisted.dbPath);
    const out = await run(projDir);
    expect(out).toContain('是（id');
    expect(out).toContain('正常——这条检出已注册，令牌一致。');
  });

  it('已注册但 .weave/token 属于另一次检出 → 报令牌过期', async () => {
    registerProject(projDir, 'init', hoisted.dbPath);
    await writeLocalToken(projDir, 'stale-token');
    const out = await run(projDir);
    expect(out).toContain('属于另一次检出');
  });

  it('已注册但归档 → 提示去 dashboard 恢复', async () => {
    const { id } = registerProject(projDir, 'init', hoisted.dbPath);
    const db = openDatabase();
    try {
      new ProjectRepository(db).setArchived(id, true);
    } finally {
      db.close();
    }
    const out = await run(projDir);
    expect(out).toContain('已归档（id');
    expect(out).toContain('在 dashboard 里恢复');
  });

  it('本地有令牌但项目未注册 → 报令牌存在而项目未注册', async () => {
    const { id } = registerProject(projDir, 'init', hoisted.dbPath);
    // 抹掉注册行、保留 .weave/token（旧 dataDir / 注册表被清过的情形）。
    const db = openDatabase();
    try {
      new ProjectRepository(db).remove(id);
    } finally {
      db.close();
    }
    const out = await run(projDir);
    expect(out).toContain('存在，但项目未注册');
  });
});

// ---- 投递诊断节（GET /messaging/diagnostics）：daemon 的应答由 fetch stub 顶替 ----

/** 一条三层全灭的会话：旧脚本 + 无 pane 通道 + 无 peer name = VDI 那个现场。 */
const diagPayload = (id: number) => ({
  daemon: {
    version: '0.1.0',
    platform: 'win32',
    terminalPreset: 'wt',
    terminalTextChannel: false,
  },
  projects: [
    {
      id,
      captures: [
        {
          harness: 'claude',
          source: 'project',
          present: true,
          weaveOwned: true,
          generatedVersion: '0.0.1',
          reportsInbox: false,
          reportsPaneEnv: false,
        },
      ],
    },
  ],
  sessions: [
    {
      sessionId: 'abcdef1234567890',
      title: 'weave',
      alive: true,
      eventCount: 4,
      lastEventType: 'Stop',
      channels: {
        inbox: { status: 'unavailable', reason: 'no-credentials' },
        queue: { status: 'unavailable', reason: 'no-mechanism' },
        relay: { status: 'unavailable', reason: 'no-peer-name' },
        terminal: { status: 'unavailable', reason: 'no-backend' },
      },
      queue: { pending: 2, stalled: false },
      reachable: false,
      hints: ['hook-script-stale', 'no-peer-name', 'terminal-no-backend'],
    },
  ],
});

describe('weave doctor 投递诊断', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubDaemon = (body: unknown, ok = true) =>
    vi.stubGlobal('fetch', async () => ({ ok, status: ok ? 200 : 401, json: async () => body }));

  it('daemon 在跑 + 已注册 → 打出通道矩阵与修法码', async () => {
    const { id } = registerProject(projDir, 'init', hoisted.dbPath);
    hoisted.daemonRunning = true;
    stubDaemon(diagPayload(id));

    const out = await run(projDir);
    expect(out).toContain('消息投递诊断');
    expect(out).toContain('preset wt（无文本注入通道）');
    expect(out).toContain('project 档 · 版本 0.0.1 · 凭据上报 否');
    expect(out).toContain('abcdef12「weave」');
    expect(out).toContain('不可用（没有凭据）');
    expect(out).toContain('不可用（注册表里没有 peer name）');
    expect(out).toContain('不可用（该终端 preset 没有文本注入后端）');
    expect(out).toContain('队列 2 条');
    expect(out).toContain('hook 脚本是旧版 weave 生成的');
  });

  it('daemon 拒答 → 只降级这一节，接线结论照旧', async () => {
    registerProject(projDir, 'init', hoisted.dbPath);
    hoisted.daemonRunning = true;
    stubDaemon({}, false);

    const out = await run(projDir);
    expect(out).toContain('投递诊断不可用（HTTP 401）');
    expect(out).toContain('正常——这条检出已注册，令牌一致。');
  });
});
