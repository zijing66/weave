import { TERMINAL_LOCATOR_ENV } from '@weavecode/core';
import { captureCommand } from './wezterm-mux.js';
import { PRESET_CANDIDATES, TerminalBackend, type TerminalLaunch } from './backend.js';

/**
 * iTerm2（macOS）：`ITERM_SESSION_ID`（`w0t0p0:<UUID>`）一条就唯一定位一个会话，
 * 文本走 AppleScript `write text`。**只有文本通道**——iTerm2 没有裸键序入口，
 * 中断/作答在这条路上诚实不支持（`sendKeys` 走基类拒绝，不假装能打）。
 * 同 Konsole：本机无法实机验证。
 */
export class ItermBackend extends TerminalBackend {
  constructor(platform: NodeJS.Platform) {
    super('iterm', false, platform, platform === 'darwin');
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    return PRESET_CANDIDATES.iterm(dir, run, this.platform);
  }

  override async locatePane(env: Record<string, string>): Promise<string | null> {
    return itermPaneFromEnv(env);
  }

  override ownsPaneId(paneId: string): boolean {
    return parseItermPaneId(paneId) !== null;
  }

  override async sendPromptText(paneId: string, text: string): Promise<void> {
    const sessionId = parseItermPaneId(paneId);
    if (!sessionId) throw new Error(`Invalid prompt pane "${paneId}"`);
    await itermWriteText(sessionId, text);
  }
}

/** iTerm2 的 pane id ↔ 会话 unique id；坏 id → null。 */
export function parseItermPaneId(paneId: string): string | null {
  const m = /^iterm:(w\d+t\d+p\d+:[0-9A-Fa-f-]+)$/.exec(paneId);
  return m ? m[1]! : null;
}

/** 上报的 pane env → iTerm2 的 pane id；不是 iTerm 会话（缺键）→ null。 */
export function itermPaneFromEnv(env: Record<string, string>): string | null {
  const [sessionKey] = TERMINAL_LOCATOR_ENV.iterm;
  const raw = env[sessionKey];
  if (!raw) return null;
  const id = `iterm:${raw}`;
  return parseItermPaneId(id) ? id : null;
}

/** AppleScript 字符串字面量转义（反斜杠先转，免把引号转义再转一遍）。 */
export function applescriptString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function itermWriteText(sessionId: string, text: string): Promise<void> {
  const script = `tell application "iTerm2"
repeat with w in windows
repeat with t in tabs of w
repeat with s in sessions of t
if unique id of s is "${sessionId}" then
tell s to write text "${applescriptString(text)}"
return "ok"
end if
end repeat
end repeat
end repeat
end tell`;
  const r = await captureCommand('osascript', ['-e', script], undefined, 8000);
  if (!r) throw new Error('osascript is unavailable — cannot send text into iTerm2');
  if (!r.ok || !r.out.includes('ok')) {
    throw new Error(`iTerm2 write text failed: ${r.err || r.out || 'unknown error'}`);
  }
}
