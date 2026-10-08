import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../db/db.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../settings.js';
import { applyLaunchOnLogin, relaunchArgs, syncLaunchOnLogin } from '../auto-start.js';

/** spy 用的 run 记录。 */
interface RunCall {
  command: string;
  args: string[];
}

describe('auto-start（开机自启 daemon，默认关）', () => {
  let home: string;
  let dataDir: string;
  let calls: RunCall[];
  const run = (command: string, args: string[]): { status: number | null } => {
    calls.push({ command, args });
    return { status: 0 };
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'weave-as-home-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'weave-as-data-'));
    calls = [];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const deps = (platform: NodeJS.Platform): Parameters<typeof applyLaunchOnLogin>[1] => ({
    platform,
    home,
    dataDir,
    run,
  });

  it('relaunchArgs 还原当前进程启动方式：node + execArgv + 绝对入口', () => {
    const args = relaunchArgs();
    expect(args[0]).toBe(process.execPath);
    expect(args.at(-1)).toBe(path.resolve(process.argv[1] ?? process.argv[0]));
    // vitest 自身的 execArgv（无 tsx）应原样透传
    expect(args.slice(1, -1)).toEqual(process.execArgv);
  });

  it('win32 开：Run 键指向 VBS（隐藏窗口），VBS 里是完整命令行', () => {
    applyLaunchOnLogin(true, deps('win32'));
    const vbsPath = path.join(dataDir, 'weave-autostart.vbs');
    expect(existsSync(vbsPath)).toBe(true);
    const vbs = readFileSync(vbsPath, 'utf8');
    // VBS 字符串里的引号翻倍转义；窗口风格 0 = 隐藏
    expect(vbs).toContain(', 0, False');
    expect(vbs).toContain(`""${process.execPath}""`);
    expect(vbs).toContain(`Run "`);

    expect(calls).toEqual([
      {
        command: 'reg',
        args: [
          'add',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
          '/v',
          'weave-daemon',
          '/t',
          'REG_SZ',
          '/d',
          `wscript.exe "${vbsPath}"`,
          '/f',
        ],
      },
    ]);
  });

  it('win32 关：删 Run 键值（不存在也不报错）+ 清 VBS', () => {
    applyLaunchOnLogin(true, deps('win32'));
    applyLaunchOnLogin(false, deps('win32'));
    expect(calls.at(-1)).toEqual({
      command: 'reg',
      args: [
        'delete',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v',
        'weave-daemon',
        '/f',
      ],
    });
    expect(existsSync(path.join(dataDir, 'weave-autostart.vbs'))).toBe(false);
  });

  it('darwin 开：写 LaunchAgent plist（ProgramArguments 数组）+ unload 后 load', () => {
    applyLaunchOnLogin(true, deps('darwin'));
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.weave.daemon.plist');
    const plist = readFileSync(plistPath, 'utf8');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    for (const arg of relaunchArgs()) {
      expect(plist).toContain(`<string>${arg.replace(/&/g, '&amp;')}</string>`);
    }
    expect(calls.map((c) => c.args[1])).toEqual([plistPath, plistPath]);
    expect(calls[0]).toEqual({ command: 'launchctl', args: ['unload', plistPath] });
    expect(calls[1]).toEqual({ command: 'launchctl', args: ['load', plistPath] });
  });

  it('darwin 关：unload + 删 plist', () => {
    applyLaunchOnLogin(true, deps('darwin'));
    applyLaunchOnLogin(false, deps('darwin'));
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.weave.daemon.plist');
    expect(calls.at(-1)).toEqual({ command: 'launchctl', args: ['unload', plistPath] });
    expect(existsSync(plistPath)).toBe(false);
  });

  it('linux 开：写 XDG autostart .desktop（Exec 带参数）', () => {
    applyLaunchOnLogin(true, deps('linux'));
    const desktopPath = path.join(home, '.config', 'autostart', 'weave-daemon.desktop');
    const entry = readFileSync(desktopPath, 'utf8');
    expect(entry).toContain('Type=Application');
    expect(entry).toContain('Exec=');
    for (const arg of relaunchArgs()) {
      // 引号只加在含空格参数外层，原串必然可见
      expect(entry).toContain(arg);
    }
  });

  it('linux 关：删 .desktop', () => {
    applyLaunchOnLogin(true, deps('linux'));
    applyLaunchOnLogin(false, deps('linux'));
    expect(existsSync(path.join(home, '.config', 'autostart', 'weave-daemon.desktop'))).toBe(
      false,
    );
  });

  it('run 抛错也不冒泡（自启失败不能拖垮设置保存/daemon 启动）', () => {
    expect(() =>
      applyLaunchOnLogin(true, {
        platform: 'win32',
        home,
        dataDir,
        run: () => {
          throw new Error('reg missing');
        },
      }),
    ).not.toThrow();
  });

  it('syncLaunchOnLogin 按设置对账：开着 → 注册；关着 → 清除', async () => {
    const db = openDatabase(':memory:');
    setDaemonSettingsDb(db);
    try {
      syncLaunchOnLogin(deps('linux'));
      expect(calls).toEqual([]); // 默认关：linux 无 run 调用，但也不留文件
      expect(existsSync(path.join(home, '.config', 'autostart'))).toBe(false);

      await writeDaemonSettings({
        terminal: { preset: 'auto', customCommand: '' },
        locale: 'zh-CN',
        hooks: { enabled: true },
        startup: { launchOnLogin: true },
      });
      syncLaunchOnLogin(deps('linux'));
      expect(existsSync(path.join(home, '.config', 'autostart', 'weave-daemon.desktop'))).toBe(
        true,
      );
    } finally {
      setDaemonSettingsDb(null);
      db.close();
    }
  });
});
