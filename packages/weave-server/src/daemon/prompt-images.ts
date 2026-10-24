import type { Harness } from '@weavecode/core';
import type { UploadMediaType } from '../repositories/uploads.js';
import type { HookEventRow } from '../repositories/hook-events.js';
import { imagesSurfaceFor } from '../surfaces.js';

/**
 * 入站图补采（层外的一条读路径）：用户在**宿主终端**里粘的图，hook 载荷只有
 * `[Image #N]` 占位，图本身只在转录里。这里把转录里的图块搬进 `data/uploads`
 * （内容寻址，重复即 no-op）并挂到对应的开轮事件上——挂上之后对话气泡的缩略图、
 * lightbox、分享图片全都走既有路径，前端不认 harness、也不解析转录。
 *
 * 触发恒为**被动**（有人在看这段对话时才发现缺图）：不在 ingest 里扫——那时图
 * 可能还没落盘，且会拖慢事件管道。
 */

/** 宿主输入框给随图的占位记号（与 message-deliverer / web 的 `claims` 同一口径）。 */
const IMAGE_MARKER = /\[Image #\d+\]/gi;

/** 单次补采的账：超过就不搬了（多出来的留到下次 daemon 重启后的第一次补采）。 */
const MAX_IMAGES = 64;
const MAX_BYTES = 64 * 1024 * 1024;

/** 纯图消息（两侧正文都空）按时间兜底认领的窗口。 */
const EMPTY_TEXT_GAP_MS = 120_000;

export interface PromptImageDeps {
  hookEvents?: {
    listBySession(
      sessionId: string,
      limit?: number,
      beforeId?: number,
      types?: readonly string[],
    ): HookEventRow[];
  };
  uploads?: {
    save(input: {
      name: string;
      mediaType: UploadMediaType;
      bytes: Buffer;
      dir?: string | null;
    }): { id: string };
    linkToEvent(eventId: number, uploadIds: readonly string[]): void;
    imagesBySession(sessionId: string): Map<number, unknown[]>;
  };
  sessionProbe?: { transcriptPathOf(sessionId: string): string | null };
  /** 补采图的落盘目录（项目自定义存储；缺省 = 全局默认）。 */
  uploadDir?: string | null;
}

/** 一次补采里要认领的事件（正文归一后的比对形态）。 */
interface PendingEvent {
  eventId: number;
  at: string | null;
  text: string;
}

const normalize = (text: string): string =>
  text.replace(IMAGE_MARKER, '').replace(/\s+/g, ' ').trim();

const EXT_BY_MEDIA: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** 事件侧：该会话里「带占位记号、还没挂图」的开轮事件。 */
function pendingOf(
  deps: PromptImageDeps,
  sessionId: string,
  linked: Map<number, unknown[]>,
): PendingEvent[] {
  const rows = deps.hookEvents?.listBySession(sessionId, 2000, undefined, ['UserPromptSubmit']) ?? [];
  const out: PendingEvent[] = [];
  for (const row of rows) {
    if (linked.get(row.id)?.length) continue;
    const prompt = promptOf(row.payload);
    if (!prompt || !prompt.match(IMAGE_MARKER)) continue;
    out.push({ eventId: row.id, at: row.createdAt, text: normalize(prompt) });
  }
  return out;
}

function promptOf(payload: string): string | null {
  try {
    const raw = (JSON.parse(payload) as { raw?: { prompt?: unknown } }).raw;
    return typeof raw?.prompt === 'string' && raw.prompt ? raw.prompt : null;
  } catch {
    return null;
  }
}

/** 转录哪来：最新事件自己的 `transcriptPath`（重启后仍有），探针兜底。 */
function transcriptPathOf(deps: PromptImageDeps, sessionId: string, rows: HookEventRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    try {
      const path = (JSON.parse(rows[i]!.payload) as { transcriptPath?: unknown }).transcriptPath;
      if (typeof path === 'string' && path) return path;
    } catch {
      // 坏载荷跳过，继续往前找
    }
  }
  return deps.sessionProbe?.transcriptPathOf(sessionId) ?? null;
}

/**
 * 补采一次：把转录里有图、事件里没图的那几条挂上。返回新挂的图张数
 * （0 = 没什么可补）。读不了转录 / 匹配不上都不抛，静默当作「没有」。
 */
export async function importPromptImages(
  deps: PromptImageDeps,
  sessionId: string,
  harness: Harness | null,
): Promise<number> {
  const surface = harness ? imagesSurfaceFor(harness) : null;
  if (!surface || !deps.hookEvents || !deps.uploads) return 0;
  const linked = deps.uploads.imagesBySession(sessionId);
  const pending = pendingOf(deps, sessionId, linked);
  if (pending.length === 0) return 0;
  const rows = deps.hookEvents.listBySession(sessionId);
  const prompts = await surface.sessionImages({
    sessionId,
    transcriptPath: transcriptPathOf(deps, sessionId, rows),
  });
  if (!prompts?.length) return 0;

  let count = 0;
  let bytes = 0;
  for (const prompt of prompts) {
    if (count >= MAX_IMAGES || bytes >= MAX_BYTES) break;
    const match = claim(pending, prompt.text, prompt.at);
    if (!match) continue;
    const ids: string[] = [];
    for (const image of prompt.images) {
      if (count >= MAX_IMAGES || bytes >= MAX_BYTES) break;
      const ext = EXT_BY_MEDIA[image.mediaType];
      if (!ext) continue;
      const bytesIn = Buffer.from(image.bytes);
      const row = deps.uploads.save({
        name: `pasted-${count + 1}${ext}`,
        mediaType: image.mediaType as UploadMediaType,
        bytes: bytesIn,
        dir: deps.uploadDir ?? null,
      });
      if (!ids.includes(row.id)) ids.push(row.id);
      count += 1;
      bytes += bytesIn.length;
    }
    if (ids.length > 0) deps.uploads.linkToEvent(match.eventId, ids);
  }
  return count;
}

/**
 * 认领：归一后全等的优先级最高（取时间最近的那条）；正文都空的纯图消息按
 * 时间窗口兜底。认到即从待认列表摘掉——一条转录记录只能对一条事件。
 */
function claim(pending: PendingEvent[], text: string, at: string | null): PendingEvent | null {
  const want = normalize(text);
  // 纯图（两侧正文皆空）在事件侧同样归一成空串，但它本身没有可比的正文——
  // 必须按时间窗口兜底，不能走「正文全等」这条无限期的路。
  const same = want === '' ? [] : pending.filter((e) => e.text === want);
  const pool = same.length > 0 ? same : want === '' ? pending.filter((e) => e.text === '') : [];
  if (pool.length === 0) return null;
  const wantAt = at ? Date.parse(at) : NaN;
  let best: PendingEvent | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const candidate of pool) {
    const gap =
      Number.isNaN(wantAt) || !candidate.at ? Number.POSITIVE_INFINITY : Math.abs(Date.parse(candidate.at) - wantAt);
    if (gap < bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  if (!best) return null;
  // 纯图兜底要够近才算同一条；正文全等的只按时间挑最近的，不受窗口限制
  if (same.length === 0 && !(bestGap <= EMPTY_TEXT_GAP_MS)) return null;
  pending.splice(pending.indexOf(best), 1);
  return best;
}

/** 这一页事件里有没有「带占位、还没挂图」的开轮事件——有才值得去扫转录。 */
export function needsImageImport(
  events: readonly HookEventRow[],
  linked: Map<number, unknown[]> | undefined,
): boolean {
  return events.some((e) => {
    if (e.eventType !== 'UserPromptSubmit' || linked?.get(e.id)?.length) return false;
    const prompt = promptOf(e.payload);
    return !!prompt && /\[Image #\d+\]/i.test(prompt);
  });
}

/** 进程内只试一次（读不了转录的会话别每次取数都重扫一遍）。 */
const attempted = new Set<string>();

/**
 * 补采一次（同一会话进程内只扫一次）；true = 这次确实搬进了图。
 * 调用方**等它一拍**：历史会话不会再来事件帧，后台补完之后前端没有刷新时机，
 * 图会一直不出现直到重开对话。代价是第一次打开这段对话多扫一遍转录。
 */
export async function importPromptImagesOnce(
  deps: PromptImageDeps,
  sessionId: string,
  harness: Harness | null,
): Promise<boolean> {
  if (attempted.has(sessionId)) return false;
  attempted.add(sessionId);
  try {
    return (await importPromptImages(deps, sessionId, harness)) > 0;
  } catch {
    return false;
  }
}
