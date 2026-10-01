import { describe, it, expect } from 'vitest';
import { dashboardCommand, dashboardUrl } from '../commands/dashboard';
import { daemonCommand } from '../commands/daemon';

describe('dashboardUrl', () => {
  it('carries the token as a query param', () => {
    expect(dashboardUrl(6420, 'abc123')).toBe('http://127.0.0.1:6420/?token=abc123');
  });

  it('omits the param when there is no token', () => {
    expect(dashboardUrl(6420, '')).toBe('http://127.0.0.1:6420/');
  });

  it('encodes tokens that need escaping', () => {
    expect(dashboardUrl(7000, 'a b&c')).toBe('http://127.0.0.1:7000/?token=a%20b%26c');
  });

  it('uses the actual port, not the default', () => {
    expect(dashboardUrl(6421, 't')).toContain(':6421/');
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
    expect(daemonCommand.subcommands?.find((s) => s.name === 'start')?.description).toContain(
      'weave dashboard',
    );
    expect(dashboardCommand.description).toContain('starts the daemon');
  });
});
