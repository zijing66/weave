/**
 * 输入框 `#` 引用胶囊的序列化形（web `serializeDraft` 产出）：
 * `#<会话 id>「<会话名>」`（名字可缺，缺 = 裸 `#<id>`）。
 * 发送前据此拉起未启动的目标会话——引用只是收件人标注，代投仍归宿主模型；
 * 这里只保证「标注指向的会话在 TUI 里活着」，好让那一步 SendMessage 送得到。
 */
const SESSION_REF_RE =
  /#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:「[^」]*」)?/g;

/** 正文里出现的引用目标（去重、保持出现顺序）。 */
export function referencedSessionIds(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(SESSION_REF_RE)) {
    const id = m[1]!;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
