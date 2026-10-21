import { homedir } from 'node:os';
import path from 'node:path';

/**
 * 宿主的配置根（`CODEX_HOME` 缺省 `~/.codex`）——rollout 落盘根与 hooks.json 都在
 * 它下面，两处共用这一份解析。给了 `home` 就只认它：测试注入主目录时必须绕开本机
 * 真实的 `CODEX_HOME`，否则写到用户目录里。
 */
export function codexHome(home?: string): string {
  if (home) return path.join(home, '.codex');
  const env = process.env.CODEX_HOME;
  return env && env.trim() ? path.resolve(env) : path.join(homedir(), '.codex');
}
