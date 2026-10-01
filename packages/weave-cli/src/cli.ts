import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandParser } from './parser.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { daemonCommand } from './commands/daemon.js';
import { dashboardCommand } from './commands/dashboard.js';
import { scanCommand } from './commands/scan.js';
import { statuslineCommand } from './commands/statusline.js';
import type { Command, CommandContext } from './parser.js';
import { initCliLocale, t } from './i18n/index.js';
import type { MessageKey } from './i18n/dict/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Help renders command/option `description` fields as dict keys. */
function showHelp(parser: CommandParser): void {
  const version = readVersion();
  console.log(`${t('help.tagline', { version })}\n`);
  console.log(`${t('help.usage')}\n`);
  console.log(t('help.commands'));
  for (const cmd of parser.getAllCommands()) {
    if (cmd.description) {
      console.log(`  ${cmd.name.padEnd(12)}${t(cmd.description as MessageKey)}`);
    }
  }
  console.log(`\n${t('help.globalOptions')}`);
  for (const opt of parser.getGlobalOptions()) {
    const flag = opt.short ? `-${opt.short}, --${opt.name}` : `    --${opt.name}`;
    console.log(`  ${flag.padEnd(20)}${t(opt.description as MessageKey)}`);
  }
}

export class CLI {
  private parser: CommandParser;

  constructor() {
    this.parser = new CommandParser();
    this.registerCommands();
  }

  private registerCommands(): void {
    this.parser.registerCommand(initCommand);
    this.parser.registerCommand(statusCommand);
    this.parser.registerCommand(daemonCommand);
    this.parser.registerCommand(dashboardCommand);
    this.parser.registerCommand(scanCommand);
    this.parser.registerCommand(statuslineCommand);
  }

  async run(argv: string[] = process.argv.slice(2)): Promise<void> {
    // 语言先于 help/错误解析：settings.json 的 locale（或 WEAVE_LOCALE）决定
    // 本次调用全部输出语言。
    await initCliLocale();
    const result = this.parser.parse(argv);

    // Global flags
    if (result.flags.version) {
      console.log(readVersion());
      return;
    }
    if (result.flags.help || result.command.length === 0) {
      showHelp(this.parser);
      return;
    }

    // Find the resolved command
    let cmd: Command | undefined;
    for (const name of result.command) {
      const next = cmd ? cmd.subcommands?.find(s => s.name === name || s.aliases?.includes(name)) : this.parser.getCommand(name);
      cmd = next ?? cmd;
    }

    if (!cmd?.action) {
      console.error(t('cli.unknownCommand', { command: result.command.join(' ') }));
      showHelp(this.parser);
      process.exit(1);
    }

    const errors = this.parser.validateFlags(result.flags, cmd);
    if (errors.length > 0) {
      for (const e of errors) console.error(t('cli.error', { error: e }));
      process.exit(1);
    }

    const context: CommandContext = {
      commandPath: result.command,
      flags: result.flags,
      positional: result.positional,
      raw: result.raw,
    };

    await cmd.action(context);
  }
}
