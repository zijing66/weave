import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDataDir } from '../db/paths.js';
import { DEFAULT_AI_SETTINGS, readDaemonSettings } from './settings.js';
import { hasAiKey, readAiKey } from './ai-config.js';
import { buildSystemPrompt, findDocsDir } from './ai-context.js';
import { readJson, sendJson } from './http.js';
import type { WeaveServerDeps } from './server.js';

/**
 * `/ai/*` 路由——dashboard AI 助手的服务端半程（OpenAI 兼容协议，见 AI 设计拍板）。
 * 走服务端代理：API key 只落本机（`<dataDir>/ai.json` 0600），不经浏览器；
 * 顺带免掉浏览器直连的 CORS/混合内容问题。门内路由（认证用户才能用）。
 */

/** 单次生成上限（含流式全程）：长回答也要跑得完，2 分钟。 */
const AI_TIMEOUT_MS = 120_000;
/** 会话条数与单条长度上限：防误用把整个仓库塞进请求。 */
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 20_000;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 请求体校验：只收 user/assistant 文本消息，条数与长度双限。 */
export function normalizeMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null;
  const out: ChatMessage[] = [];
  for (const item of raw) {
    const message = item as { role?: unknown; content?: unknown };
    if (message?.role !== 'user' && message?.role !== 'assistant') return null;
    const content = message.content;
    if (typeof content !== 'string' || content === '' || content.length > MAX_MESSAGE_CHARS) {
      return null;
    }
    out.push({ role: message.role, content });
  }
  return out;
}

/** 配置齐（地址 + 模型 + key）= 助手可用；dashboard 的按钮可见性也用它。 */
export function aiConfigured(baseUrl: string, model: string, keySet: boolean): boolean {
  return baseUrl !== '' && model !== '' && keySet;
}

export async function handleAiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/ai' && !pathname.startsWith('/ai/')) return false;

  const settings = await readDaemonSettings();
  const ai = settings.ai ?? DEFAULT_AI_SETTINGS;
  const keySet = hasAiKey(deps.aiKeyPath);

  if (pathname === '/ai/status' && req.method === 'GET') {
    sendJson(res, 200, {
      configured: aiConfigured(ai.baseUrl, ai.model, keySet),
      baseUrl: ai.baseUrl,
      model: ai.model,
      apiKeySet: keySet,
      // docs 命中与否：给 UI 一句「本次只注入了技能」的提示（只探目录，不读文件）。
      docsFound: findDocsDir(process.cwd()) !== null,
    });
    return true;
  }

  if (pathname === '/ai/chat' && req.method === 'POST') {
    const apiKey = readAiKey(deps.aiKeyPath);
    if (!aiConfigured(ai.baseUrl, ai.model, keySet) || apiKey === null) {
      sendJson(res, 409, { error: 'AI assistant is not configured' });
      return true;
    }
    let body: { messages?: unknown };
    try {
      body = (await readJson(req)) as { messages?: unknown };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const messages = normalizeMessages(body.messages);
    if (!messages) {
      sendJson(res, 400, { error: 'Invalid messages' });
      return true;
    }

    const context = buildSystemPrompt({
      dataDir: deps.libraries?.dataDir ?? getDataDir(),
    });
    await streamChat({ req, res, baseUrl: ai.baseUrl, model: ai.model, apiKey, messages, system: context.prompt });
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}

/** 调供应商并把增量转发成自家帧：`{delta}` … `{done:true}` / `{error}`。 */
async function streamChat(args: {
  req: IncomingMessage;
  res: ServerResponse;
  baseUrl: string;
  model: string;
  apiKey: string;
  messages: ChatMessage[];
  system: string;
}): Promise<void> {
  const { req, res, baseUrl, model, apiKey, messages, system } = args;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  // 客户端断开 → 一并中止上游（花的是机主的钱，不能白烧）。
  req.on('close', () => controller.abort());

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const frame = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const upstream = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      frame({ error: `upstream ${upstream.status}${detail ? `: ${detail.slice(0, 300)}` : ''}` });
      return;
    }

    const reader = upstream.body.getReader();
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
        if (payload === '[DONE]') {
          frame({ done: true });
          return;
        }
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: unknown } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) frame({ delta });
        } catch {
          // 坏行忽略（供应商偶发非 JSON 行不该中断整条回答）
        }
      }
    }
    frame({ done: true });
  } catch (e) {
    frame({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
    res.end();
  }
}
