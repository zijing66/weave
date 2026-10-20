/**
 * 每轮收尾事件上带的「这一轮最后说了什么」（`raw.last_assistant_message`）：claude 由
 * 宿主原样上报，codex 适配器按同一键形归一（`codex/event-source.ts`），故读侧只有这一
 * 处键形知识。非字符串 / 空 → null（空回合不摆空壳，调用方继续往前找）。
 */
export function turnOutputOf(raw: unknown): string | null {
  const text = (raw as { last_assistant_message?: unknown } | null)?.last_assistant_message;
  return typeof text === 'string' && text.trim() ? text : null;
}
