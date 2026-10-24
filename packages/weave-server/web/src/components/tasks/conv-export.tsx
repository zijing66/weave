import { API_BASE, api } from '@/lib/api';
import { isImageUpload } from './attach';
import { isRemotePrompt, type ConvEntry } from './conv-model';
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
      const body = [e.text, files].filter(Boolean).join('\n');
      return `[${exportStamp(e.at)}] ${role(e)}\n${body}`;
    })
    .join('\n\n');
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
 *  （weave 来源 / 发送方 / 计划）照面板带过去——出图与窗口看到的是同一件事。 */
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
