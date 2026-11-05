/**
 * 复制文本的唯一落点：手机经局域网 IP 用 HTTP 打开 dashboard 时没有安全上下文，
 * `navigator.clipboard` **整个不存在**（同 Notifications 的 insecure 成因）——直接调
 * 它会抛 TypeError、按钮看起来「点了没反应」。故：有 API 走 API（可能被权限/焦点
 * 拒绝），否则/失败回落 `document.execCommand('copy')`，两条路都不行才返回 false
 * 让调用方报出去（失败不静默）。
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒 / 非用户手势 — 再试老路
    }
  }
  return legacyCopy(text);
}

/** 复制图片的结果：区分「地址不安全」与「浏览器不支持」——两者文案不同。 */
export type CopyImageResult = 'ok' | 'insecure' | 'unsupported' | 'failed';

/**
 * 复制图片（分享图片用）：先走异步剪贴板，不行再走老式的「选中一枚 `<img>` 再
 * `execCommand('copy')`」——Chromium / Firefox 的「复制图片」就是后者，剪贴板里
 * 落的是 image/png（**它不受安全上下文限制**，`execCommand` 没有那层门）。
 *
 * 三条路依次：`navigator.clipboard.write`（安全上下文才有，可能被权限拒）→ 老式
 * 图片复制 → 如实报原因。**局域网 HTTP 下 `navigator.clipboard` 整个不存在**（非
 * 安全上下文），以前这里直接报「换 HTTPS」；现在多数浏览器老式路能成，只有它也
 * 不行才让用户去换 HTTPS 地址。
 */
export async function copyImage(blob: Blob): Promise<CopyImageResult> {
  const insecure =
    globalThis.isSecureContext !== true || typeof navigator === 'undefined' || !navigator.clipboard;
  const clip = insecure ? null : navigator.clipboard;
  if (clip?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await clip.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      return 'ok';
    } catch {
      // 权限被拒 / 非用户手势 —— 再试老路
    }
  }
  if (await legacyCopyImage(blob)) return 'ok';
  if (insecure) return 'insecure';
  return clip?.write && typeof ClipboardItem !== 'undefined' ? 'failed' : 'unsupported';
}

/**
 * 老式图片复制：把 `<img>` 摆进一枚离屏可编辑容器、选中它整个节点再 `execCommand`。
 * img 必须先解码——没加载出来的 `<img>` 复制出去只有 URL、没有位图。收尾无论成败
 * 都撤销选区、摘容器、releaseObjectURL。
 */
async function legacyCopyImage(blob: Blob): Promise<boolean> {
  if (
    typeof document === 'undefined' ||
    typeof window === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return false;
  }
  const url = URL.createObjectURL(blob);
  const holder = document.createElement('div');
  holder.contentEditable = 'true';
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;';
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  holder.appendChild(img);
  document.body.appendChild(holder);
  try {
    await img.decode?.().catch(() => {});
    const range = document.createRange();
    range.selectNode(img);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    window.getSelection()?.removeAllRanges();
    holder.remove();
    URL.revokeObjectURL(url);
  }
}

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  // 不设 readonly：iOS 上 readonly 的 textarea 选不中，复制必然失败
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  document.body.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}
