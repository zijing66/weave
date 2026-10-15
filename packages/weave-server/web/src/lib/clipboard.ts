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
