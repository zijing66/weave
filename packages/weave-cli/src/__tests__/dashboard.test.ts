import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { dashboardCommand, dashboardUrl } from '../commands/dashboard';
import { daemonCommand, waitForDaemon } from '../commands/daemon';
import { zh, en, type MessageKey } from '../i18n/dict';
import { makeT } from '../i18n/t';

/** 拿一个当下空闲的端口（listen 0 → 取号 → 立刻关掉）。 */
function freePort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const healthOnly = (): Server =>
  createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'weave-daemon' }));
  });

describe('waitForDaemon', () => {
  // `spawn` 返回的是子进程而非就绪的服务器：首启密码文件、auth.json 都在它启动
  // 过程中才写出，早一步问即扑空（`weave dashboard` 首次运行因此不打印密码）。
  it('等它真应答才返回（迟到的 /health 也等到）', async () => {
    const port = await freePort(createServer());
    const server = healthOnly();
    setTimeout(() => server.listen(port, '127.0.0.1'), 150);
    try {
      expect(await waitForDaemon(port, 5000)).toBe(true);
    } finally {
      server.close();
    }
  });

  it('没人应答就超时返回 false，不无限等', async () => {
    const port = await freePort(createServer());
    expect(await waitForDaemon(port, 300)).toBe(false);
  });
});

describe('dashboardUrl', () => {
  it('is the loopback origin on the given port', () => {
    expect(dashboardUrl(6420)).toBe('http://127.0.0.1:6420/');
  });

  it('uses the actual port, not the default', () => {
    expect(dashboardUrl(6421)).toContain(':6421/');
  });
});

describe('dashboardCommand', () => {
  it('is named dashboard with a dash alias', () => {
    expect(dashboardCommand.name).toBe('dashboard');
    expect(dashboardCommand.aliases).toContain('dash');
  });

  it('exposes a --no-open boolean flag defaulting to false', () => {
    const flag = dashboardCommand.options?.find((o) => o.name === 'no-open');
    expect(flag?.type).toBe('boolean');
    expect(flag?.default).toBe(false);
  });

  it('has an action', () => {
    expect(typeof dashboardCommand.action).toBe('function');
  });
});

describe('dashboard vs daemon split', () => {
  // The two commands overlap only in that both can start the daemon. Keep the
  // division explicit: `daemon` owns the process lifecycle, `dashboard` is the
  // way to the UI.
  it('daemon owns the lifecycle subcommands', () => {
    const names = daemonCommand.subcommands?.map((s) => s.name) ?? [];
    expect(names).toEqual(['start', 'stop', 'status']);
  });

  it('dashboard is not a lifecycle manager — no stop/status', () => {
    const names = dashboardCommand.subcommands?.map((s) => s.name) ?? [];
    expect(names).not.toContain('stop');
    expect(names).not.toContain('status');
  });

  it('each description points at the other command', () => {
    // description 字段是词典 key，断言渲染结果（zh 里含 weave dashboard 字面，
    // en 里含 starts the daemon）——见 cli.ts showHelp。
    const zhT = makeT(zh, zh);
    const enT = makeT(en, zh);
    const startDesc = daemonCommand.subcommands?.find((s) => s.name === 'start')?.description;
    expect(startDesc).toBeDefined();
    expect(zhT(startDesc as MessageKey)).toContain('weave dashboard');
    expect(enT(startDesc as MessageKey)).toContain('weave dashboard');
    expect(dashboardCommand.description).toBeDefined();
    expect(enT(dashboardCommand.description as MessageKey)).toContain('starts the daemon');
    expect(zhT(dashboardCommand.description as MessageKey)).toContain('守护进程');
  });
});
