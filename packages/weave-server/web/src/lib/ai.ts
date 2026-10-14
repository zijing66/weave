import { API_BASE } from './api';

/**
 * AI 助手的客户端半程：状态探询 + 流式对话。
 *
 * 流式走 `fetch` + `body.getReader()` 手工解析 SSE 帧（`EventSource` 只支持 GET，
 * 这里要 POST 带会话历史），所以**全站只有这一处**流式解析——别处要流式请复用它。
 * 帧形与 daemon 侧（`daemon/ai-routes.ts`）成对：`{delta}` / `{done}` / `{error}`。
 */

export interface AiStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  /** docs 是否命中（false = 只注入了技能，UI 给一句提示）。 */
  docsFound: boolean;
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function aiStatus(): Promise<AiStatus> {
  const res = await fetch(`${API_BASE}/ai/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AiStatus;
}

/**
 * 发一轮对话并把增量交给 `onDelta`；返回即本轮结束（`{done}` 帧或流自然结束）。
 * `signal` 用于「停止生成」（前端 AbortController）；错误帧与 HTTP 错误都 throw。
 */
export async function streamChat(
  messages: readonly AiChatMessage[],
  handlers: { onDelta: (text: string) => void; signal?: AbortSignal },
): Promise<void> {
  const res = await fetch(`${API_BASE}/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
    ...(handlers.signal ? { signal: handlers.signal } : {}),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let frame: { delta?: unknown; done?: unknown; error?: unknown };
      try {
        frame = JSON.parse(payload) as typeof frame;
      } catch {
        continue; // 半行/坏行：留在缓冲里等下一块（拼接由上面的 line 切分兜住）
      }
      if (typeof frame.error === 'string' && frame.error !== '') throw new Error(frame.error);
      if (typeof frame.delta === 'string') handlers.onDelta(frame.delta);
      if (frame.done === true) return;
    }
  }
}
