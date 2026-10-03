import { describe, it, expect } from 'vitest';
import { toolkitCommand } from '../commands/toolkit.js';
import { CommandParser } from '../parser.js';
import { zh, en } from '../i18n/dict/index.js';

/**
 * 批 10：`weave toolkit` 命令族注册 + i18n 描述键齐全（zh/en 对齐）+
 * 解析器对子命令与 --project flag 的解析。
 */
describe('weave toolkit 命令', () => {
  it('注册 5 个子命令，描述与选项键全部在 zh/en 词典中', () => {
    expect(toolkitCommand.subcommands?.map((s) => s.name)).toEqual([
      'list',
      'enable',
      'disable',
      'add-dir',
      'remove-dir',
    ]);
    expect(zh).toHaveProperty(toolkitCommand.description!);
    expect(en).toHaveProperty(toolkitCommand.description!);
    for (const sub of toolkitCommand.subcommands ?? []) {
      expect(sub.description, sub.name).toBeTruthy();
      expect(zh, sub.name).toHaveProperty(sub.description!);
      expect(en, sub.name).toHaveProperty(sub.description!);
      for (const opt of sub.options ?? []) {
        expect(zh).toHaveProperty(opt.description);
        expect(en).toHaveProperty(opt.description);
      }
    }
  });

  it('解析：toolkit enable <id> --project <path>', () => {
    const parser = new CommandParser();
    parser.registerCommand(toolkitCommand);
    const result = parser.parse(['toolkit', 'enable', 'docs-reminder', '--project', 'D:\\proj']);
    expect(result.command).toEqual(['toolkit', 'enable']);
    expect(result.positional).toEqual(['docs-reminder']);
    expect(result.flags['project']).toBe('D:\\proj');
    const enable = toolkitCommand.subcommands!.find((s) => s.name === 'enable')!;
    expect(parser.validateFlags(result.flags, enable)).toEqual([]);
  });

  it('解析：toolkit add-dir <path>（无 flag）', () => {
    const parser = new CommandParser();
    parser.registerCommand(toolkitCommand);
    const result = parser.parse(['toolkit', 'add-dir', 'D:\\tools']);
    expect(result.command).toEqual(['toolkit', 'add-dir']);
    expect(result.positional).toEqual(['D:\\tools']);
  });
});
