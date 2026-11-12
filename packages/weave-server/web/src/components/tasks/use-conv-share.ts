import { canShareImage, copyImage, copyText, type CopyImageResult } from '@/lib/clipboard';
import { api } from '@/lib/api';
import {
  downloadBlob,
  imageFileName,
  renderConversationImage,
} from '@/lib/conv-image';
import { conversationHtml, htmlFileName } from '@/lib/conv-html';
import { parseMarkdown } from '@/lib/conv-markdown';
import { renderMermaidSvg } from '@/lib/mermaid';
import { errorText, type ActionFeedback } from '@/lib/action-feedback';
import { cssPx } from '@/lib/font-scale';
import {
  exportConversationMarkdown,
  exportConversationText,
  exportStamp,
  markdownFileName,
  activeHtmlHead,
  imageDataUrl,
  toImageEntries,
} from './conv-export';
import { isImageUpload } from './attach';
import { MENU_H, type ConvMenu } from './conv-widgets';
import type { ConvEntry } from './conv-model';
import type { Theme } from '@/lib/theme';
import type { TFunc } from '@/i18n/t';

/**
 * 对话分享/导出域：复制纯文本、canvas 图片（复制/下载）、单页 HTML（样式/图片/
 * mermaid 全内联）。三个动作都吃同一份勾选集（pickedEntries），反馈键共用
 * `convImg:<sessionId>`（同一枚按钮上转圈，两个动作不会同时跑）。
 */
export function useConvShare(deps: {
  sessionId: string;
  /** 会话显示名（导出文件名）。 */
  label: string;
  /** 勾上的条目（顺序 = 对话序）。 */
  pickedEntries: () => ConvEntry[];
  /** 弹出菜单状态（分享动作落定即收）。 */
  setMenu: (m: ConvMenu | null) => void;
  theme: Theme;
  fb: ActionFeedback;
  t: TFunc;
  show: (kind: 'success' | 'error', msg: string) => void;
}) {
  const { sessionId, label, pickedEntries, setMenu, theme, fb, t, show } = deps;

const copyPicked = (): void => {
  const chosen = pickedEntries();
  if (chosen.length === 0) return;
  const text = exportConversationText(chosen, {
    user: t('tasks.convRoleUser'),
    assistant: t('tasks.convRoleAssistant'),
    plan: t('tasks.convPlan'),
  });
  // 通知权限那类失败不静默：复制失败要让用户看得见（还可手动选文本）。
  void copyText(text).then((ok) =>
    show(
      ok ? 'success' : 'error',
      ok ? t('tasks.convCopyOk', { n: chosen.length }) : t('tasks.convCopyFailed'),
    ),
  );
};

/** 对话 → 图片：canvas 文本卡片，复制到剪贴板 / 系统分享面板 / 下载 PNG。生成
 *  失败与「浏览器不给写剪贴板」都当失败报出去（后者引导分享/下载）。复制路径把
 *  **渲染函数**交给 `copyImage`——write 要在用户手势内先落子，渲染 promise 直接
 *  喂 ClipboardItem；分享路径渲染后走 `navigator.share`（移动端正路：直接进
 *  微信/相册，绕开剪贴板写图片在 Android 上不可靠的那段）。 */
const shareImage = (to: 'clipboard' | 'share' | 'download'): void => {
  const chosen = pickedEntries();
  if (chosen.length === 0) return;
  setMenu(null);
  void fb.run(
    `convImg:${sessionId}`,
    async () => {
      const render = (): Promise<Blob> =>
        renderConversationImage(
          toImageEntries(chosen, t('tasks.convPlan')),
          { stamp: exportStamp, theme },
          (path) => api.visualizationFragment(path).then((r) => r.html ?? ''),
        );
      if (to === 'share') {
        let blob: Blob;
        try {
          blob = await render();
        } catch (e) {
          throw new Error(t('tasks.convImgFailed', { error: errorText(e) }));
        }
        try {
          // 用户取消面板（AbortError）不报错不邀功：面板本身就是反馈
          await navigator.share({
            files: [new File([blob], imageFileName(label), { type: 'image/png' })],
          });
        } catch (e) {
          if ((e as DOMException)?.name !== 'AbortError') throw e;
        }
      } else if (to === 'download') {
        let blob: Blob;
        try {
          blob = await render();
        } catch (e) {
          throw new Error(t('tasks.convImgFailed', { error: errorText(e) }));
        }
        downloadBlob(blob, imageFileName(label));
        show('success', t('tasks.convImgSaved'));
      } else {
        let copied: CopyImageResult;
        try {
          copied = await copyImage(render);
        } catch (e) {
          throw new Error(t('tasks.convImgFailed', { error: errorText(e) }));
        }
        if (copied === 'ok') show('success', t('tasks.convImgOk', { n: chosen.length }));
        else if (copied === 'insecure') throw new Error(t('tasks.convImgCopyInsecure'));
        else throw new Error(t('tasks.convImgCopyFailed'));
      }
    },
    { fail: errorText },
  );
};

/** 分享菜单里给不给「分享」项：交给系统分享面板（微信/相册）的能力探测。 */
const shareViaSheet = canShareImage;

/** 导出为**单页 HTML**：样式/图片（base64）/mermaid（SVG）全内联，自定义头按设置页
 *  「当前使用」那一份原样注入。取不到设置或某张图/某块图渲染失败都只降级、不中断。 */
const exportHtml = (): void => {
  const chosen = pickedEntries();
  if (chosen.length === 0) return;
  setMenu(null);
  void fb.run(
    // 与图片分享共用一个反馈键：同一枚按钮上转圈，两个动作不会同时跑
    `convImg:${sessionId}`,
    async () => {
      const head = await activeHtmlHead();

      const assets = new Map<string, string>();
      for (const entry of chosen) {
        for (const a of entry.attachments ?? []) {
          if (!isImageUpload(a) || assets.has(a.id)) continue;
          const data = await imageDataUrl(a.id);
          if (data) assets.set(a.id, data);
        }
      }

      const diagrams = new Map<string, string>();
      for (const entry of chosen) {
        if (entry.role === 'compaction') continue;
        for (const block of parseMarkdown(entry.text)) {
          if (block.kind !== 'code' || block.lang !== 'mermaid') continue;
          const code = block.lines.join('\n');
          if (!code.trim() || diagrams.has(code)) continue;
          try {
            diagrams.set(code, await renderMermaidSvg(code, theme));
          } catch {
            // 渲染不出就不进表：导出里它是普通代码块
          }
        }
      }

      const html = conversationHtml(chosen, {
        title: label,
        labels: {
          user: t('tasks.convRoleUser'),
          assistant: t('tasks.convRoleAssistant'),
          plan: t('tasks.convPlan'),
        },
        head,
        assets,
        diagrams,
      });
      downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), htmlFileName(label));
      show('success', t('tasks.convHtmlSaved', { n: chosen.length }));
    },
    { fail: (e) => t('tasks.convHtmlFailed', { error: errorText(e) }) },
  );
};

/** 导出 Markdown 文件：单条 = 纯正文（不带文档头），多条 = 对话记录（带头）。
 *  气泡菜单传单条、分享菜单传勾选集，同一份函数按条数分流。 */
const exportMarkdown = (entries: readonly ConvEntry[]): void => {
  if (entries.length === 0) return;
  setMenu(null);
  const md = exportConversationMarkdown(entries, {
    user: t('tasks.convRoleUser'),
    assistant: t('tasks.convRoleAssistant'),
    plan: t('tasks.convPlan'),
    title: label,
  });
  downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), markdownFileName(label));
};

/** 分享菜单像 select 一样择向：下方放得下（视口底边距按钮底 ≥ 菜单上限）就向下弹，
 *  否则向上弹。右沿对齐按钮右沿（箭头在按钮右端，菜单跟着它走）、留 4px 缝；
 *  右边贴住视口时夹回 8px。按 right 定位与菜单实际宽度无关（菜单是内容自适应宽，
 *  硬编码宽度夹逼会把菜单从按钮边上推开）。 */
const openShareMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
  const r = e.currentTarget.getBoundingClientRect();
  const roomBelow = window.innerHeight - r.bottom;
  const up = roomBelow < MENU_H + 8;
  setMenu({
    kind: 'share',
    // 视觉 px 落 style 前经 cssPx 除回 CSS 值（根 zoom 会把 fixed 的 CSS 值再乘一次）。
    right: cssPx(Math.max(8, window.innerWidth - r.right)),
    ...(up
      ? { bottom: cssPx(window.innerHeight - r.top + 4) }
      : { top: cssPx(r.bottom + 4) }),
    up,
  });
};

  return { copyPicked, shareImage, shareViaSheet, exportHtml, exportMarkdown, openShareMenu };
}
