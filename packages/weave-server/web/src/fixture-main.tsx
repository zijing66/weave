/**
 * 隔离 fixture（dev-only，不进生产入口）：真实 TasksPanel + 四层 provider，
 * 全部数据面 mock 在浏览器内——不连真实 daemon（6420）、无真实凭据/会话。
 * vite serve `fixture.html` 即得；生产构建 rollupOptions.input 未含它（不影响）。
 */

// ---- 1. fetch mock（必须在 api 模块之前建立行为，但 import 顺序只需先于渲染）----

const NOW = new Date().toISOString();

type Json = Record<string, unknown>;

const PROJECT: Json = {
  id: 1,
  path: 'D:/fixture/demo',
  name: 'demo',
  token: 'demo',
  source: 'demo',
  registeredAt: NOW,
  lastSeenAt: NOW,
  meta: null,
  harnesses: [{ id: 'claude', canStartSession: true }],
};

const SESSIONS: Json[] = [
  {
    // live：有活 headless 实例 → 终端按钮进 TUI
    sessionId: 'sess-live-1111-1111',
    projectId: 1,
    title: 'Live TUI 会话',
    pendingTitle: null,
    lastSeenAt: NOW,
    createdAt: NOW,
    eventCount: 4,
    harness: 'claude',
    turnOpen: false,
    lastEventType: 'Stop',
    pidAlive: false,
    terminal: null,
    interruptedAt: null,
    model: 'claude-sonnet-4-5',
    modelAlias: null,
    mode: 'default',
    effort: null,
    contextTokens: 12345,
    autoDeleteAt: null,
    transcriptPresent: true,
    canOpenTerminal: true,
    webInstanceId: 'inst-live-0001',
  },
  {
    // resume：无实例、转录在 → 点了留对话面（resume），再点才进 TUI
    sessionId: 'sess-resume-2222-2222',
    projectId: 1,
    title: 'Resume 会话',
    pendingTitle: null,
    lastSeenAt: NOW,
    createdAt: NOW,
    eventCount: 2,
    harness: 'claude',
    turnOpen: false,
    lastEventType: 'Stop',
    pidAlive: false,
    terminal: null,
    interruptedAt: null,
    model: null,
    modelAlias: null,
    mode: null,
    effort: null,
    contextTokens: null,
    autoDeleteAt: null,
    transcriptPresent: true,
    canOpenTerminal: true,
    webInstanceId: null,
  },
];

let evSeq = 0;
function hookEvent(sessionId: string, eventType: string, raw: Json): Json {
  evSeq += 1;
  return {
    id: evSeq,
    projectId: 1,
    source: 'claude',
    eventType,
    sessionId,
    payload: JSON.stringify({ raw }),
    createdAt: NOW,
  };
}

const EVENTS: Json[] = [
  hookEvent('sess-live-1111-1111', 'UserPromptSubmit', { prompt: '你好，帮我看下构建' }),
  hookEvent('sess-live-1111-1111', 'Stop', { last_assistant_message: '构建没问题。' }),
  hookEvent('sess-resume-2222-2222', 'UserPromptSubmit', { prompt: '另一条会话的问题' }),
  hookEvent('sess-resume-2222-2222', 'Stop', { last_assistant_message: '另一个回答。' }),
];

const MESSAGING_CAPABILITY: Json = {
  harness: 'claude',
  discovery: true,
  prompt: true,
  inject: true,
  headless: true,
  watch: true,
  attachKinds: ['image', 'file'],
  pathRefs: true,
  pathRefLines: true,
  pathRefKinds: ['file', 'dir'],
  sideQuestion: true,
  unsupportedReasons: null,
};

/** 路由表：前缀匹配按声明序，先中先得。 */
const ROUTES: Array<[RegExp, Json | ((url: URL, m: RegExpMatchArray) => Json)]> = [
  [/^\/auth\/status$/, { authenticated: true }],
  [
    /^\/settings$/,
    {
      settings: {
        terminal: { preset: 'web', customCommand: '' },
        locale: 'zh-CN',
        hooks: { enabled: true },
        sessions: { idleDays: 7, archiveDays: 5 },
        htmlExport: { activeId: null, profiles: [] },
      },
      presets: [],
      platform: 'win32',
      urls: [],
    },
  ],
  [/^\/projects$/, { projects: [PROJECT] }],
  [/^\/projects\/archived$/, { projects: [] }],
  [/^\/projects\/1\/hooks$/, (url) => {
    const sid = url.searchParams.get('sessionId');
    return { events: sid ? EVENTS.filter((e) => e.sessionId === sid) : EVENTS };
  }],
  [/^\/projects\/1\/agent-instances$/, { instances: [] }],
  [/^\/sessions$/, { sessions: SESSIONS, modelCatalog: {} }],
  [/^\/hooks\/dispatches(\?.*)?$/, { dispatches: [] }],
  [/^\/hooks\/rules$/, { rules: [] }],
  [/^\/messaging\/capabilities$/, { capabilities: [MESSAGING_CAPABILITY], promptLimits: { maxChars: 32000, pasteThreshold: 8000 } }],
  [/^\/messaging\/questions$/, { questions: [] }],
  [/^\/messaging\/watches$/, { watches: [] }],
  [/^\/federation\/peers$/, { peers: [] }],
  // live 会话的 open-terminal：带 instanceId（web preset 唯一入口的回执）
  [/^\/sessions\/([^/]+)\/open-terminal$/, (_url, m) => ({ ok: true, command: 'claude', instanceId: `inst-${m[1].slice(5, 9)}` })],
  // 各会话只读面：conversation 开轮/收尾 + 空表兜底
  [/^\/sessions\/([^/]+)\/hooks$/, (url) => {
    const sid = url.searchParams.get('sessionId') ?? '';
    return { events: EVENTS.filter((e) => e.sessionId === sid), limit: 10, total: 0 };
  }],
  [/^\/sessions\/([^/]+)\/messages$/, { messages: [] }],
  [/^\/sessions\/([^/]+)\/commands$/, { supported: true, commands: [], inputModes: [{ kind: 'slash', sigil: '/', named: false }] }],
  [/^\/sessions\/([^/]+)\/command-executions(\?.*)?$/, { supported: true, executions: [], nextBefore: null }],
  [/^\/sessions\/([^/]+)\/plan$/, { plan: null }],
  [/^\/sessions\/([^/]+)\/pre-question$/, { preQuestion: null }],
  [/^\/sessions\/([^/]+)\/answers$/, { answers: [] }],
  [/^\/sessions\/([^/]+)\/narration$/, { supported: true, narration: null }],
  [/^\/sessions\/([^/]+)\/rewinds$/, { supported: true, rewinds: null }],
  [/^\/sessions\/([^/]+)\/activity$/, { supported: false, agents: null, tasks: null, shells: null }],
  [/^\/sessions\/([^/]+)\/uploads(\?.*)?$/, { uploads: [], total: 0, orphanBytes: 0 }],
  [/^\/sessions\/([^/]+)\/usage(\?.*)?$/, { supported: true, usage: null }],
  [/^\/sessions\/([^/]+)\/edits(\?.*)?$/, { files: null, reason: 'fixture' }],
  [/^\/projects\/1\/statusline(\?.*)?$/, { config: { lines: [] }, script: '', globalConfig: { lines: [] }, facts: null }],
  [/^\/projects\/1\/extensions\/bindings(\?.*)?$/, { bindings: [] }],
  [/^\/extensions\/executions(\?.*)?$/, { executions: [], nextBefore: null }],
];

let installed = false;

/** 幂等安装：mock fetch + EventSource（SSE 静默空流）+ WebSocket（终端帧）。 */
export function installFixtureMocks(): void {
  if (installed) return;
  installed = true;

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = raw.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
    const [p, qs] = path.split('?');
    const url = new URL(raw, location.origin);
    for (const [re, handler] of ROUTES) {
      const m = p.match(re);
      if (!m) continue;
      const body = typeof handler === 'function' ? handler(url, m) : handler;
      void init;
      void qs;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  // SSE：立即空流，不给任何帧（boot-requests 的连接态一路，静默即可）。
  class FixtureEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    close(): void {}
    constructor(_url?: string) {
      void _url;
      setTimeout(() => this.onopen?.(), 0);
    }
  }
  (window as unknown as { EventSource: unknown }).EventSource = FixtureEventSource;

  // 终端 WS：attach → attached + 一段输出 + lease.granted。
  class FixtureWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private handlers = new Map<string, Set<EventListener>>();

    addEventListener(type: string, fn: EventListener): void {
      if (!this.handlers.has(type)) this.handlers.set(type, new Set());
      this.handlers.get(type)!.add(fn);
    }

    removeEventListener(type: string, fn: EventListener): void {
      this.handlers.get(type)?.delete(fn);
    }

    private fire(type: string, ev?: MessageEvent): void {
      for (const fn of this.handlers.get(type) ?? []) (fn as (e: unknown) => void)(ev);
    }
    constructor(_url?: string | URL) {
      void _url;
      setTimeout(() => {
        this.readyState = 1;
        this.fire('open');
        this.onopen?.();
      }, 0);
    }
    send(msg: string): void {
      try {
        const frame = JSON.parse(msg) as { type: string; instanceId?: string };
        const id = frame.instanceId ?? 'inst-x';
        if (frame.type === 'attach') {
          this.emit({ type: 'attached', instanceId: id, lastSequence: 0, mode: 'interactive' });
          this.emit({ type: 'terminal.output', instanceId: id, sequence: 1, data: '\x1b[32mfixture TUI screen\x1b[0m\r\n' });
          setTimeout(() => this.emit({ type: 'lease.granted', instanceId: id, leaseId: 'lease-f1', expiresAt: Date.now() + 15000 }), 30);
        }
      } catch {
        // 坏帧忽略
      }
    }
    private emit(frame: Json): void {
      setTimeout(() => {
        const ev = new MessageEvent('message', { data: JSON.stringify(frame) });
        this.fire('message', ev);
        this.onmessage?.(ev);
      }, 0);
    }
    close(): void {
      this.readyState = 3;
      this.fire('close');
      this.onclose?.();
    }
  }
  (window as unknown as { WebSocket: unknown }).WebSocket = FixtureWebSocket;
}

// ---- 2. 挂载真实 TasksPanel ----

import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPanel } from './components/tasks/TasksPanel';
import { I18nProvider } from './i18n/I18nProvider';
import { SessionStatusProvider } from './components/tasks/session-status-store';
import { ToastProvider } from './components/Toast';
import { refreshAuth } from './lib/auth';
import './index.css';

installFixtureMocks();
void refreshAuth();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: false } },
});

void refreshAuth().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <SessionStatusProvider>
            <div className="flex h-dvh flex-col">
              <TasksPanel
                projectId={1}
                projectLabel="demo"
                harnesses={[{ id: 'claude', canStartSession: true }]}
              />
            </div>
          </SessionStatusProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
});
