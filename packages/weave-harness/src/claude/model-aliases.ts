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

/** 换模型落定那一对：切换前跑的、切完跑的（后者才是此刻）。 */
export interface ModelSwitchFact {
  from: string | null;
  to: string;
}

/**
 * 换模型**落定**的那条事件里的真名（`PostModelSwitch.to_model`，附带切换前的
 * `from_model`）。宿主答「No, go back」不发事件，故收到这条 = 已经换了；比转录条目
 * 早一步——转录只在 assistant 消息上照会模型，切完不跑一轮就什么都读不到。
 *
 * `from` 是给**重启后回读**用的：内存里那把闩丢了，只能拿它跟转录此刻照会的值
 * 比对，相同即「宿主还没跑过新一轮」。
 */
export function switchedModelOf(eventType: string, raw: unknown): ModelSwitchFact | null {
  if (eventType !== 'PostModelSwitch') return null;
  const entry = raw as { from_model?: unknown; to_model?: unknown } | null;
  const to = entry?.to_model;
  if (typeof to !== 'string' || !to) return null;
  const from = entry?.from_model;
  return { from: typeof from === 'string' && from ? from : null, to };
}

/**
 * 宿主开新会话 / `--resume` 重开时落的**默认模型**（用户实测：重开把模型落回默认，
 * 默认值就读全局配置文件）。解析序：env 块的 `ANTHROPIC_MODEL` → 顶层 `model` 键
 * （是别名就经 `ANTHROPIC_DEFAULT_<别名>_MODEL` 换真名，与 {@link modelAliasTargets}
 * 同一来源；非别名的自定义名照原样回落）→ 宿主内建默认 `sonnet` 档。
 */
export function defaultModelOf(
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromSettings = settingsEnvOf(homedir);
  const direct = fromSettings.ANTHROPIC_MODEL ?? env.ANTHROPIC_MODEL;
  if (direct) return direct;
  const configured = userSettingsOf(homedir)?.model;
  const chosen = typeof configured === 'string' && configured ? configured : 'sonnet';
  return modelAliasTargets([chosen], env, homedir)[0]!.actual;
}

/**
 * 会话开/恢复（`SessionStart`）上关于模型的话：startup / compact 带 `model` 就报得出
 * 真名；`source=resume` **不带**（实测）——但重开 = 宿主把模型落回默认，默认值就写
 * 在全局配置里（{@link defaultModelOf}），直接答它：不答的话转录里上一轮的旧照会
 * 会一直顶到第一轮新条目落地。这条事件与模型无关时返回 null。
 */
export function startedModelOf(
  eventType: string,
  raw: unknown,
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): { model: string | null } | null {
  if (eventType !== 'SessionStart') return null;
  const model = (raw as { model?: unknown } | null)?.model;
  if (typeof model === 'string' && model) return { model };
  return { model: defaultModelOf(homedir, env) };
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
 * 剥掉网关前缀（转录照会的是 `custom_openai/ftm`，事件里是 `ftm`）：两处说同一个
 * 模型，比对前先归一。
 */
export function bareModelName(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1);
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
  const bare = bareModelName(model);
  return targets.find((t) => t.actual === model || t.actual === bare)?.alias ?? null;
}

function userSettingsOf(homedir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_ASSETS.userConfigFile(homedir), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function settingsEnvOf(homedir: string): Record<string, string> {
  const parsed = userSettingsOf(homedir);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed?.env ?? {})) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
