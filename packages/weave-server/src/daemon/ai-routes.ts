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
/** 拉模型列表的连接超时（设置页动作，短平快）。 */
const MODELS_TIMEOUT_MS = 15_000;
/** 模型列表上限（有的网关会返回几百条，UI 侧够用即可）。 */
const MAX_MODELS = 500;
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

  // 模型列表：设置页配置 url + key 后由服务端拉（GET {baseUrl}/models，OpenAI 兼容）。
  // 请求体可带 `baseUrl`/`apiKey` 覆盖——用户在表单里刚填还没保存时也能先拉一次；
  // 缺省用已存配置（key 从 ai.json 读，**不经浏览器回传**）。
  if (pathname === '/ai/models' && req.method === 'POST') {
    let body: { baseUrl?: unknown; apiKey?: unknown };
    try {
      body = (await readJson(req)) as { baseUrl?: unknown; apiKey?: unknown };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const baseUrl =
      typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '' ? body.baseUrl.trim() : ai.baseUrl;
    const apiKey =
      typeof body.apiKey === 'string' && body.apiKey !== ''
        ? body.apiKey
        : readAiKey(deps.aiKeyPath);
    if (baseUrl === '' || apiKey === null) {
      sendJson(res, 409, { error: 'AI assistant is not configured' });
      return true;
    }
    const result = await fetchModels(baseUrl, apiKey);
    if (!result.ok) {
      // 用 502 而不是透传上游状态：上游 401 不能当成我们的 401（前端会把 401 当登录失效跳登录页）
      sendJson(res, 502, { error: result.error });
      return true;
    }
    sendJson(res, 200, { models: result.models });
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

/** 供应商响应里取正文（流式在 delta、非流式在 message）。 */
interface ChatCompletionPayload {
  choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
}

function completionText(payload: unknown): string | null {
  const choices = (payload as ChatCompletionPayload | null)?.choices;
  const first = choices?.[0];
  const content = first?.delta?.content ?? first?.message?.content;
  return typeof content === 'string' && content !== '' ? content : null;
}

/**
 * 流式能力记忆（短期，进程内）：网关/模型能不能吃 `stream:true`，试过一次就记住——
 * 记「不行」的这段时间里直接走非流式，省掉每次白等一个失败往返（LiteLLM 这类网关
 * 每次都甩 500）。**TTL 到期自动忘掉、再试一次流式** = 周期性试探；一旦试通就持续
 * 走流式。刻意不落库：daemon 重启即忘，正好顺带重探，且不留过期状态要维护。
 */
export const STREAM_MEMO_TTL_MS = 24 * 60 * 60 * 1000;
const streamMemo = new Map<string, { streaming: boolean; checkedAt: number }>();

/** 记忆键：网关地址 + 模型（同一网关不同模型的流式支持可以不同）。 */
export function streamMemoKey(url: string, model: string): string {
  return `${url}#${model}`;
}

/** 该键现在是否值得先试流式：无记忆 / 记忆过期 / 记忆说能用 → true。 */
export function streamSupported(key: string, now: number = Date.now()): boolean {
  const memo = streamMemo.get(key);
  if (!memo) return true;
  if (now - memo.checkedAt > STREAM_MEMO_TTL_MS) return true;
  return memo.streaming;
}

/** 记一次探测结果（能力变化时打一行日志，便于排查）。 */
export function rememberStreamSupport(
  key: string,
  streaming: boolean,
  now: number = Date.now(),
): void {
  const previous = streamMemo.get(key);
  if (previous !== undefined && previous.streaming !== streaming) {
    console.log(
      `[weave] ai gateway ${streaming ? 'supports' : 'rejects'} streaming: ${key}`,
    );
  }
  streamMemo.set(key, { streaming, checkedAt: now });
}

/** 清空记忆（测试隔离用）。 */
export function resetStreamMemory(): void {
  streamMemo.clear();
}

/** 供应商 `/models` 列表（OpenAI 兼容形状 `{ data: [{ id }] }`）。 */
async function fetchModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        error: `upstream ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      };
    }
    const payload = (await res.json().catch(() => null)) as {
      data?: Array<{ id?: unknown }>;
    } | null;
    const models = [
      ...new Set(
        (payload?.data ?? [])
          .map((item) => item?.id)
          .filter((id): id is string => typeof id === 'string' && id !== ''),
      ),
    ].sort();
    if (models.length === 0) return { ok: false, error: 'upstream returned no models' };
    return { ok: true, models: models.slice(0, MAX_MODELS) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 非流式补一次（`stream:false`）：有的网关对 `stream:true` 直接报错
 * （实测 LiteLLM 会甩 `'async for' requires … got ModelResponse` 的 500），
 * 退一次整段返回，体验退化为「一次性」，但可用。
 */
async function completeOnce(args: {
  url: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  signal: AbortSignal;
}): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(args.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${args.apiKey}` },
      body: JSON.stringify({ model: args.model, stream: false, messages: args.messages }),
      signal: args.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `upstream ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}` };
    }
    const content = completionText(await res.json().catch(() => null));
    return content === null ? { ok: false, error: 'upstream returned no content' } : { ok: true, content };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const payloadMessages = [{ role: 'system', content: system }, ...messages];
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
  let finished = false;
  const frame = (payload: unknown): void => {
    if (finished) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // 客户端已断开：写失败无所谓，别把整轮炸掉
    }
  };
  const finish = (): void => {
    if (finished) return;
    finished = true;
    try {
      res.write('data: {"done":true}\n\n');
      res.end();
    } catch {
      // 同上
    }
  };

  const memoKey = streamMemoKey(url, model);
  const upstreamArgs = { url, apiKey, model, messages: payloadMessages, signal: controller.signal };

  try {
    if (!streamSupported(memoKey)) {
      // 短期记忆：这个网关/模型吃不下流式 → 直接整段，省掉每次白试的失败往返。
      const direct = await completeOnce(upstreamArgs);
      if (direct.ok) frame({ delta: direct.content });
      else frame({ error: direct.error });
      return;
    }

    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, stream: true, messages: payloadMessages }),
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      const retry = await completeOnce(upstreamArgs);
      if (retry.ok) {
        rememberStreamSupport(memoKey, false); // 记：流式不行，TTL 内直接走非流式
        frame({ delta: retry.content });
      } else {
        frame({ error: `upstream ${upstream.status}${detail ? `: ${detail.slice(0, 300)}` : ''}` });
      }
      return;
    }

    // 网关忽略 stream:true、直接回整段 JSON（content-type 不是 SSE）→ 同样记「不支持流式」。
    if (!(upstream.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const content = completionText(await upstream.json().catch(() => null));
      rememberStreamSupport(memoKey, false);
      if (content === null) frame({ error: 'upstream returned no content' });
      else frame({ delta: content });
      return;
    }

    rememberStreamSupport(memoKey, true); // 流式通道建起来了 → 记住这条路能用
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
        if (payload === '[DONE]') return; // done 帧由 finish() 统一发
        try {
          const delta = completionText(JSON.parse(payload));
          if (delta !== null) frame({ delta });
        } catch {
          // 坏行忽略（供应商偶发非 JSON 行不该中断整条回答）
        }
      }
    }
  } catch (e) {
    frame({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
    finish();
  }
}
