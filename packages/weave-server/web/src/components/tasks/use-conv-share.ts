import { copyImage, copyText } from '@/lib/clipboard';
import {
  downloadBlob,
  imageFileName,
  renderConversationImage,
} from '@/lib/conv-image';
import { conversationHtml, htmlFileName } from '@/lib/conv-html';
import { parseMarkdown } from '@/lib/conv-markdown';
import { renderMermaidSvg } from '@/lib/mermaid';
import { errorText, type ActionFeedback } from '@/lib/action-feedback';
import { exportConversationText, exportStamp, activeHtmlHead, imageDataUrl, toImageEntries } from './conv-export';
import { isImageUpload } from './attach';
import { MENU_W, type ConvMenu } from './conv-widgets';
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

/** 对话 → 图片：canvas 文本卡片，复制到剪贴板或下载 PNG。生成失败与「浏览器
 *  不给写剪贴板」都当失败报出去（后者引导走下载）。 */
const shareImage = (to: 'clipboard' | 'download'): void => {
  const chosen = pickedEntries();
  if (chosen.length === 0) return;
  setMenu(null);
  void fb.run(
    `convImg:${sessionId}`,
    async () => {
      let blob: Blob;
      try {
        blob = await renderConversationImage(toImageEntries(chosen, t('tasks.convPlan')), {
          stamp: exportStamp,
          theme,
        });
      } catch (e) {
        throw new Error(t('tasks.convImgFailed', { error: errorText(e) }));
      }
      if (to === 'download') {
        downloadBlob(blob, imageFileName(label));
        show('success', t('tasks.convImgSaved'));
      } else if (await copyImage(blob)) {
        show('success', t('tasks.convImgOk', { n: chosen.length }));
      } else {
        throw new Error(t('tasks.convImgCopyFailed'));
      }
    },
    { fail: errorText },
  );
};

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

/** 分享菜单往上开：底栏在下沿，向下没有可用的地方。 */
const openShareMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
  const r = e.currentTarget.getBoundingClientRect();
  // 左沿对齐按钮左沿、右上角留 4px 缝；右边放不下就整体左移（夹进视口）
  setMenu({
    kind: 'share',
    left: Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 8)),
    bottom: window.innerHeight - r.top + 4,
  });
};

  return { copyPicked, shareImage, exportHtml, openShareMenu };
}
