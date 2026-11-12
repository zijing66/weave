/**
 * 复制文本的唯一落点：手机经局域网 IP 用 HTTP 打开 dashboard 时没有安全上下文，
 * `navigator.clipboard` **整个不存在**（同 Notifications 的 insecure 成因）——直接调
 * 它会抛 TypeError、按钮看起来「点了没反应」。故：有 API 走 API（可能被权限/焦点
 * 拒绝），否则/失败回落 `document.execCommand('copy')`，两条路都不行才返回 false
 * 让调用方报出去（失败不静默）。`execCommand` 的文本回落仍然有效；**图片不走
 * 这条回落**（现代 Chromium 里它只落死标记，见 `copyImage`）。
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

/** 系统分享面板（Web Share）能不能发图片：移动端「把图发出去」的正路——
 *  Android 上 web 剪贴板写图片不可靠（write 拒 + execCommand 只落死 blob URL 标记），
 *  分享面板直接触达微信/保存到相册。 */
export function canShareImage(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  try {
    const probe = new File([new Blob()], 'weave.png', { type: 'image/png' });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * 复制图片（分享图片用）：吃**渲染函数**而非现成 Blob——`navigator.clipboard.write`
 * 必须在用户手势内落子，而激活窗口等不起慢渲染（手机上全选一开就是好几秒）；
 * `ClipboardItem` 允许值是 Promise，把渲染 promise 直接喂进去，write 在手势内
 * 先调、引擎自己等料（2026-11-10 实测：等渲染完再 write 会 NotAllowedError →
 * 掉进老式路，粘出来的就是 ￼）。
 *
 * 没有异步剪贴板（局域网 HTTP / 缺 ClipboardItem）→ **不渲染**直接如实报
 * （`insecure` / `unsupported`）——别让人白等十几秒再告诉他发不了。Android
 * Chromium 上图片 write 可能两连拒：如实报 `failed` 引导分享/下载，**绝不落
 * `execCommand` 老式路**——2026-11-10 实测它在 Chromium 156 已死透（落的是一枚
 * 已被撤销的 blob: URL 标记，粘贴即 ￼，而它还回 true 的假成功）。文本复制的
 * `execCommand` 回落不受影响（文本那路仍然有效）。渲染失败原样上抛（调用方
 * 另有文案），不算剪贴板的账。
 */
export async function copyImage(render: () => Promise<Blob>): Promise<CopyImageResult> {
  const insecure =
    globalThis.isSecureContext !== true || typeof navigator === 'undefined' || !navigator.clipboard;
  const clip = navigator.clipboard;
  if (insecure) return 'insecure';
  if (!clip?.write || typeof ClipboardItem === 'undefined') return 'unsupported';
  const renderP = render();
  try {
    await clip.write([new ClipboardItem({ 'image/png': renderP })]);
    return 'ok';
  } catch {
    /* promise 形被拒（激活过期 / 老引擎构造即抛）→ 先把料等出来再补一枪 */
  }
  let blob: Blob;
  try {
    blob = await renderP;
  } catch (e) {
    throw e; // 渲染失败：原样上抛，调用方按「生成图片失败」报
  }
  try {
    await clip.write([new ClipboardItem({ 'image/png': blob })]);
    return 'ok';
  } catch {
    return 'failed';
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
