import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WeaveServerDeps } from '../server.js';
import { readJson, sendJson } from '../http.js';
import {
  isNotifyChannelKind,
  type NotifyChannelConfig,
} from '../../repositories/notify-channels.js';
import { sendToChannel } from '../../hooks/notify-channels.js';

/** config 是平台凭据的并集；按 kind 校验必填项（写入口直接拒，不让坏通道落库）。 */
const ConfigBody = z
  .object({
    url: z.string().max(2_000).optional(),
    secret: z.string().max(400).optional(),
    host: z.string().max(300).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    secure: z.boolean().optional(),
    user: z.string().max(300).optional(),
    pass: z.string().max(1_000).optional(),
    from: z.string().max(300).optional(),
    to: z.string().max(1_000).optional(),
    sendKey: z.string().max(300).optional(),
    token: z.string().max(300).optional(),
  })
  .strict();

const ChannelBody = z.object({
  kind: z.string().refine(isNotifyChannelKind, { message: 'unknown channel kind' }),
  name: z.string().min(1).max(100),
  config: ConfigBody,
  enabled: z.boolean().optional(),
});

const ChannelPatchBody = ChannelBody.partial();

/** 每类通道的必填字段——只答「这个 kind 至少要有哪些键」。 */
function configProblem(kind: string, config: NotifyChannelConfig): string | null {
  if (kind === 'email') {
    return config.host && config.to ? null : 'email channel needs host and to';
  }
  if (kind === 'serverchan') return config.sendKey ? null : 'serverchan channel needs sendKey';
  if (kind === 'pushplus') return config.token ? null : 'pushplus channel needs token';
  return config.url ? null : `${kind} channel needs url`;
}

export async function handleNotifyChannelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  _url: URL,
): Promise<boolean> {
  if (!pathname.startsWith('/notify/channels')) return false;
  const repo = deps.notifyChannels;
  if (!repo) {
    sendJson(res, 503, { error: 'Notify channels unavailable' });
    return true;
  }
  const send = deps.notifySend ?? sendToChannel;

  if (pathname === '/notify/channels') {
    if (req.method === 'GET') {
      sendJson(res, 200, { channels: repo.list() });
      return true;
    }
    if (req.method === 'POST') {
      const parsed = await parseOr400(req, res, ChannelBody);
      if (!parsed) return true;
      const problem = configProblem(parsed.kind, parsed.config);
      if (problem) {
        sendJson(res, 400, { error: problem });
        return true;
      }
      sendJson(res, 201, {
        channel: repo.create({
          kind: parsed.kind,
          name: parsed.name,
          config: parsed.config,
          enabled: parsed.enabled,
        }),
      });
      return true;
    }
  }

  const match = /^\/notify\/channels\/([^/]+)(\/test)?$/.exec(pathname);
  if (!match) return false;
  const id = decodeURIComponent(match[1]!);
  const isTest = Boolean(match[2]);

  if (isTest && req.method === 'POST') {
    const channel = repo.getById(id);
    if (!channel) {
      sendJson(res, 404, { error: 'Notify channel not found' });
      return true;
    }
    const result = await send(channel, {
      title: 'weave',
      body: 'Test notification from weave',
      tag: 'weave-test',
      url: '/',
    });
    sendJson(res, result.ok ? 200 : 502, { result });
    return true;
  }

  if (req.method === 'PUT') {
    if (!repo.getById(id)) {
      sendJson(res, 404, { error: 'Notify channel not found' });
      return true;
    }
    const parsed = await parseOr400(req, res, ChannelPatchBody);
    if (!parsed) return true;
    const current = repo.getById(id)!;
    const problem = configProblem(parsed.kind ?? current.kind, parsed.config ?? current.config);
    if (problem) {
      sendJson(res, 400, { error: problem });
      return true;
    }
    sendJson(res, 200, { channel: repo.update(id, parsed) });
    return true;
  }

  if (req.method === 'DELETE') {
    if (!repo.delete(id)) {
      sendJson(res, 404, { error: 'Notify channel not found' });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function parseOr400<T extends z.ZodTypeAny>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: T,
): Promise<z.infer<T> | null> {
  let raw: unknown;
  try {
    raw = await readJson(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
    return null;
  }
  return parsed.data as z.infer<T>;
}
