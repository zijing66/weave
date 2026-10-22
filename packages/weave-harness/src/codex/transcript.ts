/**
 * codex 转录（rollout JSONL）里与「已中断」有关的唯一知识：用户按 ESC 打断这一轮
 * 后，codex 往 rollout 追一条 `event_msg` / `turn_aborted`（实测 0.163：
 * `{"timestamp":…,"type":"event_msg","payload":{"type":"turn_aborted",
 * "reason":"interrupted",…}}`）。与 claude 的 `[Request interrupted by user]`
 * 标记同职——「停没停」的文件证据；格式两套各写各的（claude 见
 * `claude/transcript.ts`），server 只读不解析。
 */

/** rollout 尾部文本里最后一条中断记录的时刻（ms）；没有/解析不出 → null。 */
export function codexInterruptMarkerAt(tail: string): number | null {
  let newest: number | null = null;
  for (const line of tail.split('\n')) {
    if (!line.includes('"turn_aborted"')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // 尾部常常切在行中间——那半行不是标记
    }
    const entry = raw as {
      timestamp?: unknown;
      payload?: { type?: unknown };
    };
    if (entry?.payload?.type !== 'turn_aborted') continue;
    const at = Date.parse(String(entry.timestamp ?? ''));
    if (!Number.isFinite(at)) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}
