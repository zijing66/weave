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
