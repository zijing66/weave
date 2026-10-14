import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { writeAiKey } from '../daemon/ai-config.js';
import { setDaemonSettingsDb, writeDaemonSettings, type DaemonSettings } from '../daemon/settings.js';
import { createWeaveServer } from '../daemon/server.js';

/** AI 助手路由：未配置面 / 流式转发 / 供应商错误 / key 只写不回显。 */

const encoder = new TextEncoder();

/** 客户端用真实 fetch（stub 只换「daemon 调供应商」那一路，否则会把测试自己的请求也劫走）。 */
const realFetch = globalThis.fetch;

/** 假供应商：把给定 SSE 分片打成流式 Response。 */
function sseResponse(frames: string[], status = 200): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  );
}

const settingsBase = (): DaemonSettings =>
  ({
    terminal: { preset: 'auto', customCommand: '' },
    locale: 'zh-CN',
    hooks: { enabled: true },
  }) as DaemonSettings;

const withAi = (baseUrl: string, model: string): DaemonSettings => ({
  ...settingsBase(),
  ai: { baseUrl, model },
});

describe('daemon ai routes', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let dir: string;
  let keyPath: string;

  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
  const chat = (body: unknown): Promise<Response> =>
    realFetch(url('/ai/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    db = openDatabase(':memory:');
    setDaemonSettingsDb(db);
    dir = mkdtempSync(path.join(tmpdir(), 'weave-ai-srv-'));
    keyPath = path.join(dir, 'ai.json');
    const projects = new ProjectRepository(db);
    projects.register({ path: dir, name: 'test', token: 'ptoken', source: 'init' });
    server = createWeaveServer({ projects, port: 0, aiKeyPath: keyPath });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('未配置：status 报 false，chat 409', async () => {
    await writeDaemonSettings(settingsBase());
    writeAiKey(null, keyPath);

    const status = (await (await fetch(url('/ai/status'))).json()) as {
      configured: boolean;
      apiKeySet: boolean;
    };
    expect(status).toMatchObject({ configured: false, apiKeySet: false });

    const res = await chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(409);
  });

  it('配置齐：按 OpenAI 兼容协议流式转发增量帧', async () => {
    await writeDaemonSettings(withAi('https://llm.example/v1', 'test-model'));
    writeAiKey('sk-test-key', keyPath);

    const seen: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init: RequestInit) => {
        seen.push({
          url: String(input),
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
          auth: String((init.headers as Record<string, string>)['authorization']),
        });
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }),
    );

    const res = await chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"delta":"你"');
    expect(text).toContain('"delta":"好"');
    expect(text).toContain('"done":true');

    expect(seen[0]!.url).toBe('https://llm.example/v1/chat/completions');
    expect(seen[0]!.auth).toBe('Bearer sk-test-key');
    expect(seen[0]!.body['model']).toBe('test-model');
    expect(seen[0]!.body['stream']).toBe(true);
    const messages = seen[0]!.body['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('weave');
    expect(messages[1]).toMatchObject({ role: 'user', content: 'hi' });
  });

  it('供应商报错：错误帧且不透 key', async () => {
    await writeDaemonSettings(withAi('https://llm.example/v1', 'test-model'));
    writeAiKey('sk-secret', keyPath);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"invalid api key"}', { status: 401 })),
    );

    const text = await (await chat({ messages: [{ role: 'user', content: 'hi' }] })).text();
    expect(text).toContain('upstream 401');
    expect(text).not.toContain('sk-secret');
  });

  it('流式被上游拒绝（如 LiteLLM 对 stream:true 报 500）→ 自动退一次非流式，整段当单帧发出', async () => {
    await writeDaemonSettings(withAi('https://llm.example/v1', 'test-model'));
    writeAiKey('sk-test-key', keyPath);

    const calls: Array<{ stream: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { stream?: unknown };
        calls.push({ stream: body.stream });
        if (body.stream === true) {
          return new Response(
            JSON.stringify({
              error: { message: "'async for' requires an object with __aiter__ method, got ModelResponse" },
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '整段回答' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const text = await (await chat({ messages: [{ role: 'user', content: 'hi' }] })).text();
    expect(calls.map((c) => c.stream)).toEqual([true, false]); // 先流式、失败后退非流式
    expect(text).toContain('"delta":"整段回答"');
    expect(text).toContain('"done":true');
  });

  it('上游无视 stream:true 直接回整段 JSON → 也当单帧发出', async () => {
    await writeDaemonSettings(withAi('https://llm.example/v1', 'test-model'));
    writeAiKey('sk-test-key', keyPath);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: '非流式正文' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const text = await (await chat({ messages: [{ role: 'user', content: 'hi' }] })).text();
    expect(text).toContain('"delta":"非流式正文"');
    expect(text).toContain('"done":true');
  });

  it('messages 形状非法 → 400', async () => {
    const bad = await chat({ messages: [{ role: 'system', content: 'x' }] });
    expect(bad.status).toBe(400);
    const empty = await chat({ messages: [] });
    expect(empty.status).toBe(400);
  });

  it('PUT /settings 的 ai.apiKey 只写：响应与 GET 都不回显，文件里才有', async () => {
    const put = await fetch(url('/settings'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...settingsBase(),
        ai: { baseUrl: 'https://llm.example/v1', model: 'm1', apiKey: 'sk-put-test' },
      }),
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { ai: Record<string, unknown> };
    expect(putBody.ai).toMatchObject({ baseUrl: 'https://llm.example/v1', apiKeySet: true });
    expect(JSON.stringify(putBody)).not.toContain('sk-put-test');

    expect((JSON.parse(readFileSync(keyPath, 'utf8')) as { apiKey: string }).apiKey).toBe(
      'sk-put-test',
    );

    const get = (await (await fetch(url('/settings'))).json()) as {
      settings: { ai: Record<string, unknown> };
    };
    expect(get.settings.ai).toMatchObject({ baseUrl: 'https://llm.example/v1', apiKeySet: true });
    expect(JSON.stringify(get)).not.toContain('sk-put-test');

    // 清空：apiKey=null → 文件删除，apiKeySet 回落 false
    const cleared = await fetch(url('/settings'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...settingsBase(),
        ai: { baseUrl: 'https://llm.example/v1', model: 'm1', apiKey: null },
      }),
    });
    expect(((await cleared.json()) as { ai: { apiKeySet: boolean } }).ai.apiKeySet).toBe(false);
  });
});
