import { existsSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import type { ProvisionCheck, ProvisionSurface } from '../driver.js';
import { codexHome } from './home.js';

/**
 * codex 的安装形态检查（init 环境备置消费）：codex 有**桌面端与 CLI 两副面孔**，
 * 共享 `~/.codex` 配置与 app-server daemon——daemon 版本落后于 CLI 时，旧 daemon
 * 用旧配置快照整体回写 config.toml，抹掉手改的 provider / hooks 信任哈希
 * （2026-10-25 实测三次）。检测答三件事：桌面 app 在不在、daemon 包在不在、
 * daemon 与 CLI 版本是否一致（`codex app-server daemon version` 的 JSON）。
 */

/** 桌面 app 的本机数据根（内嵌 CLI 与 runtimes；MSIX 本体在 WindowsApps 不探测——权限敏感且此目录必写）。 */
function desktopAppDir(home: string): string {
  return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'OpenAI', 'Codex');
}

/** 共享 daemon 包的 current junction（`daemon update --from-cli` 的落点）。 */
function daemonPkgDir(home: string): string {
  return path.join(codexHome(home), 'packages', 'app-server-daemon');
}

/**
 * `check` 的探测注入口：`daemonVersions` 跑 `codex app-server daemon version`
 * 并解析 JSON（daemon 未跑/未装时回 null——那时无人持有快照，无回写风险）。
 * 缺省真跑子进程；CLI 侧测试注入假实现。
 */
export type DaemonVersionProbe = () => Promise<{
  managedCodexVersion: string;
  cliVersion: string;
} | null>;

async function probeDaemonVersions(bin: string): Promise<{ managedCodexVersion: string; cliVersion: string } | null> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    let out = '';
    const child =
      process.platform === 'win32'
        ? spawn(`${bin} app-server daemon version`, { windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(bin, ['app-server', 'daemon', 'version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, 8000);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out) as { managedCodexVersion?: string; cliVersion?: string };
        if (typeof j.managedCodexVersion === 'string' && typeof j.cliVersion === 'string') {
          resolve({ managedCodexVersion: j.managedCodexVersion, cliVersion: j.cliVersion });
        } else resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
}

export async function codexProvisionCheck(
  bin: string,
  probe: DaemonVersionProbe = () => probeDaemonVersions(bin),
  home: string = osHomedir(),
): Promise<ProvisionCheck> {
  const warnings: string[] = [];
  const hints: string[] = [];
  const desktopApp = existsSync(desktopAppDir(home));
  const daemonPackage = existsSync(daemonPkgDir(home));
  if (desktopApp && !daemonPackage) {
    warnings.push(
      'codex desktop app detected without the shared app-server daemon package — the two faces share ~/.codex, and version skew makes the older side rewrite config.toml from its stale snapshot (wiping manual provider / hooks-trust edits)',
    );
    hints.push('codex app-server daemon update --from-cli --yes');
  }
  if (daemonPackage) {
    const v = await probe();
    if (v && v.managedCodexVersion !== v.cliVersion) {
      warnings.push(
        `codex shared daemon (${v.managedCodexVersion}) differs from CLI (${v.cliVersion}) — the older side rewrites ~/.codex/config.toml from its stale snapshot on startup, wiping manual edits`,
      );
      hints.push('codex app-server daemon update --from-cli --yes');
    }
  }
  return { desktopApp, daemonPackage, warnings, hints };
}

export const CODEX_PROVISION: ProvisionSurface = {
  harness: 'codex',
  check: codexProvisionCheck,
};
