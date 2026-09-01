import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandParser } from './parser.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { daemonCommand } from './commands/daemon.js';
import { scanCommand } from './commands/scan.js';
import { statuslineCommand } from './commands/statusline.js';
import type { Command, CommandContext } from './parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function showHelp(parser: CommandParser): void {
  const version = readVersion();
  console.log(`weave v${version} — Claude Code harness tool\n`);
  console.log('Usage: weave <command> [options]\n');
  console.log('Commands:');
  for (const cmd of parser.getAllCommands()) {
    if (cmd.description) console.log(`  ${cmd.name.padEnd(12)}${cmd.description}`);
  }
  console.log('\nGlobal options:');
  for (const opt of parser.getGlobalOptions()) {
    const flag = opt.short ? `-${opt.short}, --${opt.name}` : `    --${opt.name}`;
    console.log(`  ${flag.padEnd(20)}${opt.description}`);
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
    this.parser.registerCommand(scanCommand);
    this.parser.registerCommand(statuslineCommand);
  }

  async run(argv: string[] = process.argv.slice(2)): Promise<void> {
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
      console.error(`Unknown command: ${result.command.join(' ')}`);
      showHelp(this.parser);
      process.exit(1);
    }

    const errors = this.parser.validateFlags(result.flags, cmd);
    if (errors.length > 0) {
      for (const e of errors) console.error(`Error: ${e}`);
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
