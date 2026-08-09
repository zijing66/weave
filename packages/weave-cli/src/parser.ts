/**
 * Inspired by ruflo (claude-flow v3.34.0) parser.
 * MIT License, Copyright (c) 2024-2026 ruvnet — see THIRD_PARTY_NOTICES.md.
 */
/** Flag definition for a command option */
export interface CommandOption {
  name: string;
  short?: string;
  description: string;
  type: 'boolean' | 'string' | 'number' | 'array';
  /** Default value applied when flag is absent */
  default?: unknown;
  /** Restrict to these values */
  choices?: string[];
  /** Set to true when flag is mandatory */
  required?: boolean;
  /** Custom validator: return true or an error string */
  validate?: (value: unknown) => true | string;
}

/** A registered command (or subcommand) */
export interface Command {
  name: string;
  description?: string;
  aliases?: string[];
  options?: CommandOption[];
  subcommands?: Command[];
  /** Called when this command is matched */
  action?: (context: CommandContext) => Promise<void> | void;
}

/** Context passed to a command's action handler */
export interface CommandContext {
  /** Resolved command path, e.g. ['swarm', 'start'] */
  commandPath: string[];
  /** Parsed flags (keyed by camelCase name) */
  flags: Record<string, unknown>;
  /** Positional arguments */
  positional: string[];
  /** Raw argv */
  raw: string[];
}

export interface ParseResult {
  command: string[];
  flags: Record<string, unknown> & { _: string[] };
  positional: string[];
  raw: string[];
}

/** CommandParser — tokenises argv into commands, flags, and positionals.
 *
 *  Supports:
 *  - Long flags:   `--preset full`, `--force`, `--key=value`, `--no-flag`
 *  - Short flags:  `-f`, `-abc` (combined booleans), `-n 3`
 *  - Nested subcommands: up to 3 levels deep
 *  - Default values propagated from global/custom options
 *  - Choice validation and custom validators
 */
export class CommandParser {
  private commands: Map<string, Command> = new Map();
  private globalOptions: CommandOption[] = [];

  constructor() {
    this.initGlobalOptions();
  }

  private initGlobalOptions(): void {
    this.globalOptions = [
      {
        name: 'help',
        short: 'h',
        description: 'Show help',
        type: 'boolean',
        default: false,
      },
      {
        name: 'version',
        short: 'V',
        description: 'Show version',
        type: 'boolean',
        default: false,
      },
      {
        name: 'verbose',
        short: 'v',
        description: 'Verbose output',
        type: 'boolean',
        default: false,
      },
      {
        name: 'quiet',
        short: 'q',
        description: 'Suppress non-essential output',
        type: 'boolean',
        default: false,
      },
    ];
  }

  registerCommand(cmd: Command): void {
    this.commands.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        this.commands.set(alias, cmd);
      }
    }
  }

  getCommand(name: string): Command | undefined {
    return this.commands.get(name);
  }

  getAllCommands(): Command[] {
    const seen = new Set<Command>();
    return Array.from(this.commands.values()).filter(c => {
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    });
  }

  parse(args: string[]): ParseResult {
    const result: ParseResult = {
      command: [],
      flags: { _: [] },
      positional: [],
      raw: [...args],
    };

    // Resolve command + subcommands (up to 3 levels)
    let cmd: Command | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('-')) break;
      if (result.command.length === 0 && this.commands.has(arg)) {
        cmd = this.commands.get(arg);
        result.command.push(arg);
        continue;
      }
      if (result.command.length === 1 && cmd?.subcommands) {
        const sub = cmd.subcommands.find(s => s.name === arg || s.aliases?.includes(arg));
        if (sub) {
          cmd = sub;
          result.command.push(arg);
          continue;
        }
      }
      if (result.command.length === 2 && cmd?.subcommands) {
        const sub = cmd.subcommands.find(s => s.name === arg || s.aliases?.includes(arg));
        if (sub) {
          cmd = sub;
          result.command.push(arg);
          continue;
        }
      }
      break;
    }

    // Build alias map — resolved command options override globals
    const aliases = this.buildAliases(cmd);
    const booleanSet = this.booleanFlags(cmd);

    let parsingFlags = true;
    let i = result.command.length; // skip past resolved command tokens

    while (i < args.length) {
      const arg = args[i];

      if (arg === '--') {
        parsingFlags = false;
        i++;
        continue;
      }

      if (parsingFlags && arg.startsWith('-')) {
        const pr = this.parseFlag(args, i, aliases, booleanSet);
        Object.assign(result.flags, pr.flags);
        i = pr.nextIndex;
        continue;
      }

      result.positional.push(arg);
      result.flags._.push(arg);
      i++;
    }

    this.applyDefaults(result.flags, cmd);
    return result;
  }

  validateFlags(flags: Record<string, unknown>, cmd?: Command): string[] {
    const errors: string[] = [];
    const allOptions = [...this.globalOptions, ...(cmd?.options ?? [])];

    for (const opt of allOptions) {
      const key = this.normalizeKey(opt.name);
      if (opt.required && flags[key] === undefined) {
        errors.push(`Missing required option: --${opt.name}`);
      }
      if (opt.choices && flags[key] !== undefined) {
        const v = String(flags[key]);
        if (!opt.choices.includes(v)) {
          errors.push(`Invalid value for --${opt.name}: "${v}". Choices: ${opt.choices.join(', ')}`);
        }
      }
      if (opt.validate && flags[key] !== undefined) {
        const r = opt.validate(flags[key]);
        if (r !== true) errors.push(r);
      }
    }
    return errors;
  }

  getGlobalOptions(): CommandOption[] {
    return [...this.globalOptions];
  }

  // ---- internal helpers ----

  private parseFlag(
    args: string[],
    index: number,
    aliases: Record<string, string>,
    booleanSet: Set<string>,
  ): { flags: Record<string, unknown>; nextIndex: number } {
    const flags: Record<string, unknown> = {};
    const arg = args[index];
    let nextIndex = index + 1;

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        flags[this.normalizeKey(key)] = this.parseValue(arg.slice(eq + 1));
      } else if (arg.startsWith('--no-')) {
        const key = arg.slice(5);
        flags[this.normalizeKey(key)] = false;
      } else {
        const key = arg.slice(2);
        const nk = this.normalizeKey(key);
        if (booleanSet.has(nk)) {
          if (nextIndex < args.length && this.isBooleanLiteral(args[nextIndex])) {
            flags[nk] = args[nextIndex].toLowerCase() === 'true';
            nextIndex++;
          } else {
            flags[nk] = true;
          }
        } else if (nextIndex < args.length && this.isFlagValue(args[nextIndex])) {
          flags[nk] = this.parseValue(args[nextIndex]);
          nextIndex++;
        } else {
          flags[nk] = true;
        }
      }
    } else if (arg.startsWith('-')) {
      const chars = arg.slice(1);
      if (chars.length === 1) {
        const key = aliases[chars] || chars;
        const nk = this.normalizeKey(key);
        if (booleanSet.has(nk)) {
          if (nextIndex < args.length && this.isBooleanLiteral(args[nextIndex])) {
            flags[nk] = args[nextIndex].toLowerCase() === 'true';
            nextIndex++;
          } else {
            flags[nk] = true;
          }
        } else if (nextIndex < args.length && this.isFlagValue(args[nextIndex])) {
          flags[nk] = this.parseValue(args[nextIndex]);
          nextIndex++;
        } else {
          flags[nk] = true;
        }
      } else {
        for (const c of chars) {
          const key = aliases[c] || c;
          flags[this.normalizeKey(key)] = true;
        }
      }
    }
    return { flags, nextIndex };
  }

  private isFlagValue(arg: string): boolean {
    if (!arg.startsWith('-')) return true;
    return /^-\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(arg);
  }

  private isBooleanLiteral(arg: string): boolean {
    const a = arg.toLowerCase();
    return a === 'true' || a === 'false';
  }

  private parseValue(v: string): string | number | boolean {
    if (v.toLowerCase() === 'true') return true;
    if (v.toLowerCase() === 'false') return false;
    const num = Number(v);
    if (!isNaN(num) && v.trim() !== '') return num;
    return v;
  }

  private normalizeKey(key: string): string {
    return key.replace(/-([a-z])/g, (_, l: string) => l.toUpperCase());
  }

  private buildAliases(cmd?: Command): Record<string, string> {
    const aliases: Record<string, string> = {};
    for (const opt of this.globalOptions) {
      if (opt.short) aliases[opt.short] = opt.name;
    }
    if (cmd?.options) {
      for (const opt of cmd.options) {
        if (opt.short) aliases[opt.short] = opt.name;
      }
    }
    return aliases;
  }

  private booleanFlags(cmd?: Command): Set<string> {
    const flags = new Set<string>();
    for (const opt of this.globalOptions) {
      if (opt.type === 'boolean') flags.add(this.normalizeKey(opt.name));
    }
    if (cmd?.options) {
      for (const opt of cmd.options) {
        if (opt.type === 'boolean') flags.add(this.normalizeKey(opt.name));
        else if (opt.type) flags.delete(this.normalizeKey(opt.name));
      }
    }
    return flags;
  }

  private applyDefaults(flags: Record<string, unknown>, cmd?: Command): void {
    const layers: CommandOption[][] = [];
    if (cmd?.options) layers.push(cmd.options);
    layers.push(this.globalOptions);
    for (const layer of layers) {
      for (const opt of layer) {
        const key = this.normalizeKey(opt.name);
        if (flags[key] === undefined && opt.default !== undefined) {
          flags[key] = opt.default;
        }
      }
    }
  }
}
