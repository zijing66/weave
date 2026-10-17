import fs from 'node:fs';
import os from 'node:os';
import { CLAUDE_ASSETS } from './assets.js';

/** 别名 → 真名这一对（`/model` 收别名，跑起来的是真名）。 */
export interface ModelAliasTarget {
  /** 稳定别名（claude 的 default/opus/sonnet/haiku/fable），`/model` 收的就是它。 */
  alias: string;
  /** 该别名此刻真跑的模型 ID；等于 alias = 没被换过名。 */
  actual: string;
}

/**
 * 别名 → 真名。网关把 claude 的稳定别名换成自家模型 ID（本机 opus→ftm、
 * sonnet→deepseek-flash…），出处 = Claude Code 的 `ANTHROPIC_DEFAULT_<别名>_MODEL`
 * 约定。daemon 是独立进程、未必带着宿主那套 env，故先读 settings.json 的 env 块、
 * 进程 env 兜底；两处都没有就原样回落别名（`/model opus` 仍然认，只是看不出真名）。
 */
export function modelAliasTargets(
  aliases: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): ModelAliasTarget[] {
  const fromSettings = settingsEnvOf(homedir);
  return aliases.map((alias) => {
    const key = `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`;
    const actual =
      fromSettings[key] ?? fromSettings[`${key}_NAME`] ?? env[key] ?? env[`${key}_NAME`] ?? alias;
    return { alias, actual };
  });
}

/**
 * 真名 → 别名：转录里照会的是真名（`custom_openai/ftm`），下拉得认成别名那档。
 * 认不出返回 null，调用方回落显示真名——不猜。
 */
export function aliasOfModel(
  targets: readonly ModelAliasTarget[],
  model: string | null,
): string | null {
  if (!model) return null;
  const bare = model.slice(model.lastIndexOf('/') + 1);
  return targets.find((t) => t.actual === model || t.actual === bare)?.alias ?? null;
}

function settingsEnvOf(homedir: string): Record<string, string> {
  let parsed: { env?: Record<string, unknown> } | null = null;
  try {
    parsed = JSON.parse(fs.readFileSync(CLAUDE_ASSETS.userConfigFile(homedir), 'utf8'));
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed?.env ?? {})) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
