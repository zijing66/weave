import { API_BASE, api } from '@/lib/api';
import { isImageUpload } from './attach';
import { isRemotePrompt, stripVisualizeRefs, type ConvEntry } from './conv-model';
import type { ConvImageEntry, ConvImageTag } from '@/lib/conv-image';

/** 导出用的时刻戳：本地 `YYYY-MM-DD HH:mm:ss`。展示用的 `formatStamp` 是给人扫的
 *  短形（当天只给时分秒），粘到别处会失去日期，导出单独一份。 */
export function exportStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 角色文案由调用方给（i18n 不写进纯函数），条目间空行分隔。压缩分隔不是对话
 *  内容，导出时略过（复制/导出的是「说了什么」，不是时间线排版）。随附图没法进
 *  纯文本，按 claude 自己的占位形态列在正文后（`[Image #N] 文件名`）。**取原文
 *  全量**（气泡里收着的也照全文），计划条目的角色行带上计划 tag。 */
export function exportConversationText(
  entries: readonly ConvEntry[],
  labels: { user: string; assistant: string; plan: string },
): string {
  const role = (e: ConvEntry): string => {
    const base = e.role === 'user' ? labels.user : labels.assistant;
    return e.plan === true ? `${base} · ${labels.plan}` : base;
  };
  return entries
    .filter((e) => e.role !== 'compaction')
    .map((e) => {
      // 图片按宿主占位形态编号（`[Image #N]`），普通文件标 `[File]`
      let imgN = 0;
      const files = (e.attachments ?? [])
        .map((a) => (isImageUpload(a) ? `[Image #${++imgN}] ${a.name}` : `[File] ${a.name}`))
        .join('\n');
      const body = [stripVisualizeRefs(e.text), files].filter(Boolean).join('\n');
      return `[${exportStamp(e.at)}] ${role(e)}\n${body}`;
    })
    .join('\n\n');
}

/** 对话 → Markdown 文档：正文原样（本来就是 markdown），随附图按宿主占位形态列在
 *  各条正文后。单条 = 纯正文不带文档头（导出的是「这段话本身」）；多条 = 对话记录，
 *  带文档头（标题+时刻+条数，与 HTML 导出的 .doc 头同形）。压缩分隔不是对话内容，
 *  导出时略过。 */
export function exportConversationMarkdown(
  entries: readonly ConvEntry[],
  labels: { user: string; assistant: string; plan: string; title: string },
): string {
  const shown = entries.filter((e) => e.role !== 'compaction');
  const body = shown
    .map((e) => {
      const files = (e.attachments ?? [])
        .map((a) => (isImageUpload(a) ? `[Image] ${a.name}` : `[File] ${a.name}`))
        .join('\n');
      const text = [stripVisualizeRefs(e.text), files].filter(Boolean).join('\n\n');
      if (shown.length === 1) return text;
      const base = e.role === 'user' ? labels.user : labels.assistant;
      const role = e.plan === true ? `${base} · ${labels.plan}` : base;
      return `### [${exportStamp(e.at)}] ${role}\n\n${text}`;
    })
    .join('\n\n');
  if (shown.length === 1) return body;
  return `# ${labels.title}\n\n${exportStamp(new Date().toISOString())} · ${shown.length}\n\n${body}`;
}

/** 导出文件名：`<safe>-YYYYMMDD-HHmmss.md`（与图片/HTML 导出同形，无 weave 前缀）。 */
export function markdownFileName(label: string, at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const safe = label.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const ts =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${safe || 'conversation'}-${ts}.md`;
}

/** 设置页「当前使用」的自定义头；读不到设置就当没有（导出不该被设置面挡住）。 */
export async function activeHtmlHead(): Promise<string | null> {
  try {
    const { settings } = await api.getDaemonSettings();
    const cfg = settings.htmlExport;
    if (!cfg?.activeId) return null;
    return cfg.profiles.find((p) => p.id === cfg.activeId)?.head ?? null;
  } catch {
    return null;
  }
}

/** 上传件 → data URL（单页导出要内联）；取不到即 null，调用方写占位文本。 */
export async function imageDataUrl(id: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/images/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** 进图片的条目：正文原样全量（气泡里收着的也照全文；剥运输装饰是展示层的事，
 *  这里就是气泡里那串文本）。压缩分隔不是对话内容，不进图。气泡上的那几枚 tag
 *  （weave 来源 / 发送方 / 计划）照面板带过去——出图与窗口看到的是同一件事。
 *  渲染块引用行**不剥**——`frags` 位图按序内联（取不到才回落占位行）。 */
export const toImageEntries = (entries: readonly ConvEntry[], planLabel: string): ConvImageEntry[] =>
  entries
    .filter((e) => e.role !== 'compaction')
    .map((e) => {
      const tags: ConvImageTag[] = [];
      if (e.role === 'user' && e.fromWeave === true) tags.push({ kind: 'weave', text: 'weave' });
      if (isRemotePrompt(e)) tags.push({ kind: 'name', text: e.fromName! });
      if (e.plan === true) tags.push({ kind: 'plan', text: planLabel });
      return {
        role: e.role as ConvImageEntry['role'],
        at: e.at,
        text: e.text,
        ...(tags.length > 0 ? { tags } : {}),
        ...(e.pipe !== undefined ? { viaWeave: true } : {}),
        ...(e.failed === true ? { failed: true } : {}),
      };
    });
