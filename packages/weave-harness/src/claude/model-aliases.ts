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
 * 换模型**落定**的那条事件里的真名（`PostModelSwitch.to_model`）。宿主答
 * 「No, go back」不发事件，故收到这条 = 已经换了；比转录条目早一步——转录只在
 * assistant 消息上照会模型，切完不跑一轮就什么都读不到。
 */
export function switchedModelOf(eventType: string, raw: unknown): string | null {
  if (eventType !== 'PostModelSwitch') return null;
  const to = (raw as { to_model?: unknown } | null)?.to_model;
  return typeof to === 'string' && to ? to : null;
}

/**
 * 会话开/恢复（`SessionStart`）上关于模型的话：startup / compact 带 `model` 就报得出
 * 真名；`source=resume` **不带**（实测：重开时宿主把模型落回默认，且这一拍转录里还
 * 只有上一轮的照会）——故 model 为 null 不是「不知道」，是「旧答案作废、得重新读」。
 * 这条事件与模型无关时返回 null。
 */
export function startedModelOf(
  eventType: string,
  raw: unknown,
): { model: string | null } | null {
  if (eventType !== 'SessionStart') return null;
  const model = (raw as { model?: unknown } | null)?.model;
  return { model: typeof model === 'string' && model ? model : null };
}

/**
 * 推理档位（`effort.level`）：工具/回合类 hook 事件都带，与生成脚本填 `thinking`
 * 块读的 stdin `effort.level` 是同一个事实、同一个键形。
 */
export function effortLevelOf(raw: unknown): string | null {
  const level = (raw as { effort?: { level?: unknown } } | null)?.effort?.level;
  return typeof level === 'string' && level ? level : null;
}

/**
 * 执行模式（`permission_mode`）：**每条** hook 事件都带，答的是「此刻」。转录里最后
 * 一条 `permissionMode` 只能追到上一次写条目的那一刻——Shift+Tab 切换模式既不落
 * 转录、也没有专门的事件（二进制里只有 `Pre/PostModelSwitch`，没有权限模式那对）。
 */
export function permissionModeOf(raw: unknown): string | null {
  const mode = (raw as { permission_mode?: unknown } | null)?.permission_mode;
  return typeof mode === 'string' && mode ? mode : null;
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
