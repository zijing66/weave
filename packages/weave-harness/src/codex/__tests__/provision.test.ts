import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexProvisionCheck } from '../provision.js';

/** 临时 CODEX_HOME 树：可选落 daemon 包目录与桌面 app 目录；LOCALAPPDATA 恒隔离到临时树（本机真桌面目录会串扰）。 */
async function fakeHome(opts: { daemonPkg?: boolean; desktopApp?: boolean }): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'weave-codex-provision-'));
  if (opts.daemonPkg) {
    await mkdir(path.join(home, '.codex', 'packages', 'app-server-daemon', 'current', 'bin'), { recursive: true });
  }
  const local = path.join(home, 'AppData', 'Local');
  await mkdir(local, { recursive: true });
  process.env.LOCALAPPDATA = local;
  if (opts.desktopApp) {
    await mkdir(path.join(local, 'OpenAI', 'Codex', 'bin'), { recursive: true });
  }
  return home;
}

describe('codexProvisionCheck（桌面端/CLI 双形态冲突检查）', () => {
  afterEach(() => {
    delete process.env.LOCALAPPDATA;
  });

  it('只有 CLI（无桌面 app、无 daemon 包）→ 无警告', async () => {
    const home = await fakeHome({});
    try {
      const probe = async () => null;
      const check = await codexProvisionCheck('codex', probe, home);
      expect(check.desktopApp).toBe(false);
      expect(check.daemonPackage).toBe(false);
      expect(check.warnings).toEqual([]);
      expect(check.hints).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('桌面 app 在、daemon 包缺 → 警告快照回写风险 + 给统一命令', async () => {
    const home = await fakeHome({ desktopApp: true });
    try {
      const probe = async () => null;
      const check = await codexProvisionCheck('codex', probe, home);
      expect(check.desktopApp).toBe(true);
      expect(check.daemonPackage).toBe(false);
      expect(check.warnings).toHaveLength(1);
      expect(check.warnings[0]).toContain('stale snapshot');
      expect(check.hints).toEqual(['codex app-server daemon update --from-cli --yes']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('daemon 包在、版本一致 → 无警告', async () => {
    const home = await fakeHome({ daemonPkg: true });
    try {
      const probe = async () => ({ managedCodexVersion: '0.164.0', cliVersion: '0.164.0' });
      const check = await codexProvisionCheck('codex', probe, home);
      expect(check.daemonPackage).toBe(true);
      expect(check.warnings).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('daemon 包在、版本漂移 → 警告带双方版本 + 给统一命令', async () => {
    const home = await fakeHome({ daemonPkg: true });
    try {
      const probe = async () => ({ managedCodexVersion: '0.163.0', cliVersion: '0.164.0' });
      const check = await codexProvisionCheck('codex', probe, home);
      expect(check.warnings).toHaveLength(1);
      expect(check.warnings[0]).toContain('0.163.0');
      expect(check.warnings[0]).toContain('0.164.0');
      expect(check.hints).toEqual(['codex app-server daemon update --from-cli --yes']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('daemon 探测失败（未跑/超时）→ 不误报（无人持有快照即无回写风险）', async () => {
    const home = await fakeHome({ daemonPkg: true });
    try {
      const probe = async () => null;
      const check = await codexProvisionCheck('codex', probe, home);
      expect(check.warnings).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
