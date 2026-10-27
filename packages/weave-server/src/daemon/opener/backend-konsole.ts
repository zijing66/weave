import { TERMINAL_LOCATOR_ENV } from '@weavecode/core';
import { captureCommand, type CaptureResult } from './wezterm-mux.js';
import { PRESET_CANDIDATES, TerminalBackend, type TerminalLaunch } from './backend.js';

/**
 * Konsole（KDE/Linux）：每个会话一条 D-Bus 路径（`KONSOLE_DBUS_SERVICE` +
 * `KONSOLE_DBUS_SESSION`），文本/键序走 `sendText` / `sendKey`。本机无法实机
 * 验证（Linux 专属），通道按官方文档实现。
 */
export class KonsoleBackend extends TerminalBackend {
  constructor(platform: NodeJS.Platform) {
    super('konsole', false, platform, platform === 'linux');
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    return PRESET_CANDIDATES.konsole(dir, run, this.platform);
  }

  override async locatePane(env: Record<string, string>): Promise<string | null> {
    return konsolePaneFromEnv(env);
  }

  override ownsPaneId(paneId: string): boolean {
    return parseKonsolePaneId(paneId) !== null;
  }

  override async sendPromptText(paneId: string, text: string): Promise<void> {
    const target = parseKonsolePaneId(paneId);
    if (!target) throw new Error(`Invalid prompt pane "${paneId}"`);
    if (text) await konsoleCall(target, 'sendText', text);
    await konsoleCall(target, 'sendKey', String(QT_KEY_RETURN));
  }

  override async sendKeys(paneId: string, keys: string): Promise<void> {
    const target = parseKonsolePaneId(paneId);
    if (!target) throw new Error(`Invalid prompt pane "${paneId}"`);
    for (const ch of keys) await konsoleCall(target, 'sendKey', String(qtKeyOf(ch)));
  }
}

/** Konsole 的 pane id ↔ (D-Bus 服务名, 会话路径)；坏 id → null。 */
export function parseKonsolePaneId(id: string): { service: string; session: string } | null {
  const m = /^konsole:([\w.:-]+)\|(\/[\w/]+)$/.exec(id);
  return m ? { service: m[1]!, session: m[2]! } : null;
}

/** 上报的 pane env → Konsole 的 pane id；不是 Konsole 会话（缺键）→ null。 */
export function konsolePaneFromEnv(env: Record<string, string>): string | null {
  const [serviceKey, sessionKey] = TERMINAL_LOCATOR_ENV.konsole;
  const service = env[serviceKey];
  const session = env[sessionKey];
  if (!service || !session) return null;
  const id = `konsole:${service}|${session}`;
  return parseKonsolePaneId(id) ? id : null;
}

/** Qt::Key_Return（Konsole 的 sendKey 吃 Qt 键值）。 */
const QT_KEY_RETURN = 0x01000004;

/** 字符 → Qt 键值：控制键给真值，其余用码位（ASCII 与 Qt::Key 一致）。 */
export function qtKeyOf(ch: string): number {
  switch (ch) {
    case '\x1b':
      return 0x01000000;
    case '\r':
    case '\n':
      return QT_KEY_RETURN;
    case '\t':
      return 0x01000001;
    case '\b':
      return 0x01000003;
    default:
      return ch.codePointAt(0) ?? 0;
  }
}

/**
 * 调 Konsole 会话的 D-Bus 方法：先试 Qt 自带的 `qdbus(6/5)`（参数原样走 argv、
 * 无需拼引号），再回落到 dbus 本身的 `dbus-send`（`string:` 形参）。
 */
async function konsoleCall(
  target: { service: string; session: string },
  method: 'sendText' | 'sendKey',
  arg: string,
): Promise<void> {
  const attempts: Array<{ command: string; args: string[] }> = [
    ...['qdbus6', 'qdbus5', 'qdbus'].map((command) => ({
      command,
      args: [target.service, target.session, method, arg],
    })),
    {
      command: 'dbus-send',
      args: [
        '--session',
        '--type=method_call',
        `--dest=${target.service}`,
        target.session,
        `org.kde.konsole.Session.${method}`,
        `string:${arg}`,
      ],
    },
  ];
  let last: CaptureResult | null = null;
  for (const attempt of attempts) {
    const r = await captureCommand(attempt.command, attempt.args, undefined, 5000);
    if (r?.ok) return;
    last = r;
  }
  const detail = last ? last.err || last.out || 'unknown error' : 'no qdbus / dbus-send on PATH';
  throw new Error(`Konsole D-Bus call "${method}" failed: ${detail}`);
}
