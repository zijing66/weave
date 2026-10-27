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

/**
 * 转录尾部最后一条 assistant 的上下文窗口占用（`message.usage` 四项之和：
 * input + cache_read + cache_creation + output——实测与宿主 SessionStart 的
 * `context_tokens` 交叉吻合）。
 *
 * 语义是「**上一轮完成时**的占用」：正在跑的那轮要等它写出 assistant 记录才
 * 更新——与模型/模式的「最后已知」同口径。没有 usage 的行（合成条目等）跳过。
 */
export function currentContextTokensAt(tail: string): number | null {
  let newest: number | null = null;
  for (const line of tail.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = raw as { message?: { usage?: Record<string, unknown> } };
    const usage = entry?.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const num = (k: string): number =>
      typeof usage[k] === 'number' && Number.isFinite(usage[k]) ? (usage[k] as number) : 0;
    const sum =
      num('input_tokens') +
      num('output_tokens') +
      num('cache_read_input_tokens') +
      num('cache_creation_input_tokens');
    if (sum <= 0) continue;
    newest = sum; // 尾部按时间顺序，最后一条即最新
  }
  return newest;
}

/**
 * 转录尾部最后一条阻塞工具调用（AskUserQuestion / ExitPlanMode）**之前**的
 * assistant 正文——模型提问前写给用户看的说明（「先答中途的问题，再汇报……」）。
 *
 * 为什么绕到转录：阻塞提问不发 Stop，hook 事件里只有工具三元组，这段话没有任何
 * 事件照会。claude 把一条 assistant 消息拆成相邻多行（同 `message.id`），正文与
 * 工具调用常在同一消息里——所以定位按「最后一条阻塞工具所在消息」收，正文取该
 * 消息（含其前同 id 的相邻行）里全部 text 分区的拼接。
 */
export function preQuestionTextAt(tail: string): { at: string; text: string } | null {
  const BLOCKING = /"(?:AskUserQuestion|ExitPlanMode)"/;
  const lines = tail.split('\n');
  let anchorId: string | null = null;
  let anchorAt = '';
  // 倒着找最后一条阻塞工具调用，记住它所属的 message.id
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!BLOCKING.test(line)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = raw as {
      type?: unknown;
      timestamp?: unknown;
      message?: { id?: unknown; content?: unknown };
    };
    if (entry?.type !== 'assistant') continue;
    const hasTool = (entry.message?.content as Array<{ type?: unknown; name?: unknown }> | undefined)?.some(
      (part) => part?.type === 'tool_use' && (part.name === 'AskUserQuestion' || part.name === 'ExitPlanMode'),
    );
    if (!hasTool) continue;
    anchorId = typeof entry.message?.id === 'string' ? entry.message.id : null;
    anchorAt = typeof entry.timestamp === 'string' ? entry.timestamp : '';
    break;
  }
  if (anchorId === null) return null;
  // 正着收集该消息（含其前同 id 的相邻行）里的全部 text 分区
  const parts: string[] = [];
  let at = anchorAt;
  for (const line of lines) {
    if (!line.includes(anchorId)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = raw as {
      type?: unknown;
      timestamp?: unknown;
      message?: { id?: unknown; content?: unknown };
    };
    if (entry?.type !== 'assistant' || entry.message?.id !== anchorId) continue;
    for (const part of (entry.message?.content as Array<{ type?: unknown; text?: unknown }> | undefined) ?? []) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        parts.push(part.text);
        if (typeof entry.timestamp === 'string') at = entry.timestamp;
      }
    }
  }
  const text = parts.join('').trim();
  if (!text) return null;
  return { at, text };
}
