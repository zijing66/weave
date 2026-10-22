/**
 * 转录（`~/.claude/projects/<slug>/<sessionId>.jsonl`）里与「已中断」有关的唯一知识：
 * 用户按 ESC 打断这一轮后，claude 会补一条 user 消息 `[Request interrupted by user]`
 * （工具调用进行中被中断则是 `… for tool use`）。
 *
 * 为什么绕到转录：hook 域**没有**中断事件——实测 45 次中断里 41 次连 Stop 都不发，
 * 事件流直接静默，会话于是永远停在「生成中」。转录这条标记是唯一真相来源；
 * server 只读它、不解析格式。
 */

const INTERRUPT_TEXT = '[Request interrupted by user';

/** 消息 content（字符串或分区数组）的纯文本。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const text = (part as { text?: unknown } | null)?.text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/** 转录尾部文本里最后一条中断标记的时刻（ms）；没有/解析不出 → null。 */
export function interruptMarkerAt(tail: string): number | null {
  let newest: number | null = null;
  for (const line of tail.split('\n')) {
    if (!line.includes(INTERRUPT_TEXT)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // 尾部常常切在行中间——那半行不是标记
    }
    const entry = raw as {
      type?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown };
    };
    if (entry?.type !== 'user') continue;
    if (!contentText(entry.message?.content).startsWith(INTERRUPT_TEXT)) continue;
    const at = Date.parse(String(entry.timestamp));
    if (!Number.isFinite(at)) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}

/** 合成条目不跑模型——它是宿主代笔的提示行，不是一次真实推理。 */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * 转录尾部最后一次**真跑过**的模型（assistant 的 `message.model`）。
 *
 * 为什么绕到转录：hook 事件只在 `SessionStart` 带 `raw.model`，之后换模型没有
 * 任何事件照会——实时态只在转录里。宿主的 `/model <名>` 切换是会话级、不落盘，
 * 故这里只答「最近这一轮用的是什么」，不猜配置。
 */
export function currentModelAt(tail: string): string | null {
  let newest: string | null = null;
  for (const line of tail.split('\n')) {
    if (!line.includes('"model"')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = raw as { message?: { model?: unknown }; model?: unknown };
    const model = entry?.message?.model ?? entry?.model;
    if (typeof model !== 'string' || !model || model === SYNTHETIC_MODEL) continue;
    newest = model; // 尾部按时间顺序，最后一条即最新
  }
  return newest;
}

/**
 * 转录尾部最后一次上报的推理档位（assistant 条目顶层的 `effort`）。
 *
 * 为什么绕到转录：hook 事件带的 `effort.level` 只出现在工具/回合类事件上
 * （Notification / SessionStart 这些不带），而 daemon 重启会清掉内存里的「最后
 * 已知」——不清的话，重启后这个会话会一直显「未知」，直到下一次工具调用。
 * 转录里这份与 `message.model` 同位，重启后立刻读得到。
 */
export function currentEffortAt(tail: string): string | null {
  let newest: string | null = null;
  for (const line of tail.split('\n')) {
    if (!line.includes('"effort"')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const effort = (raw as { effort?: unknown })?.effort;
    if (typeof effort !== 'string' || !effort) continue;
    newest = effort; // 尾部按时间顺序，最后一条即最新
  }
  return newest;
}

/**
 * 转录尾部最后一次的执行模式（条目上的 `permissionMode`）。
 *
 * 同模型一样绕到转录：Shift+Tab **不发任何 hook 事件、不写任何转录条目**——模式
 * 只在之后的条目上照会，故这答的永远是「最后一次活动时是什么模式」，不是此刻。
 * 宿主自己算下一个模式（还会被计划提案、auto 闸插手），这里只读不猜。
 */
export function currentModeAt(tail: string): string | null {
  let newest: string | null = null;
  for (const line of tail.split('\n')) {
    if (!line.includes('permissionMode')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const mode = (raw as { permissionMode?: unknown })?.permissionMode;
    if (typeof mode !== 'string' || !mode) continue;
    newest = mode; // 尾部按时间顺序，最后一条即最新
  }
  return newest;
}
