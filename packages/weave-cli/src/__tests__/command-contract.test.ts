import { describe, it, expect } from 'vitest';
import { initCommand } from '../commands/init';
import { uninstallCommand } from '../commands/uninstall';
import { statusCommand } from '../commands/status';
import { daemonCommand } from '../commands/daemon';
import { dashboardCommand } from '../commands/dashboard';
import { scanCommand } from '../commands/scan';
import { chpassCommand } from '../commands/chpass';
import { doctorCommand } from '../commands/doctor';
import { zh, en, type MessageKey } from '../i18n/dict';
import { makeT } from '../i18n/t';
import type { Command } from '../parser';

/** 与 CLI.registerCommands 同集——注册表变动时这里必须跟着改。 */
const COMMANDS: Command[] = [
  initCommand,
  uninstallCommand,
  statusCommand,
  daemonCommand,
  dashboardCommand,
  scanCommand,
  chpassCommand,
  doctorCommand,
];

const zhT = makeT(zh, zh);
const enT = makeT(en, zh);

/** description 是词典 key：两语言都渲染出非 key 文本才算「有说明」。 */
function hasRenderedDescription(desc?: string): boolean {
  if (!desc) return false;
  return zhT(desc as MessageKey) !== desc && enT(desc as MessageKey) !== desc;
}

describe('command registry contract', () => {
  it('every command has a description resolving in both locales', () => {
    for (const cmd of COMMANDS) {
      expect(hasRenderedDescription(cmd.description), cmd.name).toBe(true);
    }
  });

  it('every subcommand has a description and an action (no dead-end parents)', () => {
    for (const cmd of COMMANDS) {
      for (const sub of cmd.subcommands ?? []) {
        expect(hasRenderedDescription(sub.description), `${cmd.name} ${sub.name}`).toBe(true);
        expect(typeof sub.action, `${cmd.name} ${sub.name}`).toBe('function');
      }
    }
  });

  it('only chpass accepts positionals — stray args are CLI errors everywhere else', () => {
    // cli.ts 的叶子命令按 maxPositionals（缺省 0）拒绝多余位置参数；
    // 唯一例外是 chpass 的新密码位置参数。
    for (const cmd of COMMANDS) {
      if (cmd === chpassCommand) {
        expect(cmd.maxPositionals).toBe(1);
      } else {
        expect(cmd.maxPositionals, cmd.name).toBeUndefined();
      }
    }
  });
});
