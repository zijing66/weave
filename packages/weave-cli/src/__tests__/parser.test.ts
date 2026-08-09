import { describe, it, expect } from 'vitest';
import { CommandParser, type Command } from '../parser';

const initCmd: Command = {
  name: 'init',
  description: 'Init',
  options: [
    { name: 'preset', short: 'p', description: 'Preset', type: 'string', default: 'default', choices: ['minimal', 'default', 'full'] },
    { name: 'force', short: 'f', description: 'Force', type: 'boolean', default: false },
    { name: 'dir', short: 'd', description: 'Dir', type: 'string' },
  ],
};

const swarmCmd: Command = {
  name: 'swarm',
  description: 'Swarm',
  subcommands: [
    {
      name: 'start',
      options: [
        { name: 'agents', short: 'a', description: 'Agents', type: 'number', default: 3 },
        { name: 'parallel', description: 'Parallel', type: 'boolean', default: false },
      ],
    },
  ],
};

function makeParser(): CommandParser {
  const p = new CommandParser();
  p.registerCommand(initCmd);
  p.registerCommand(swarmCmd);
  return p;
}

describe('CommandParser', () => {
  it('resolves a top-level command', () => {
    const r = makeParser().parse(['init']);
    expect(r.command).toEqual(['init']);
  });

  it('resolves a nested subcommand', () => {
    const r = makeParser().parse(['swarm', 'start']);
    expect(r.command).toEqual(['swarm', 'start']);
  });

  it('parses --key=value long flags', () => {
    const r = makeParser().parse(['init', '--preset=full']);
    expect(r.flags.preset).toBe('full');
  });

  it('parses space-separated long flag values', () => {
    const r = makeParser().parse(['init', '--preset', 'minimal']);
    expect(r.flags.preset).toBe('minimal');
  });

  it('parses short flags', () => {
    const r = makeParser().parse(['init', '-f']);
    expect(r.flags.force).toBe(true);
  });

  it('parses short flag with value', () => {
    const r = makeParser().parse(['init', '-p', 'full']);
    expect(r.flags.preset).toBe('full');
  });

  it('parses --no- boolean negation', () => {
    const r = makeParser().parse(['init', '--no-force']);
    expect(r.flags.force).toBe(false);
  });

  it('collects positionals into positional and _', () => {
    const r = makeParser().parse(['init', 'extra', 'args']);
    expect(r.positional).toEqual(['extra', 'args']);
    expect(r.flags._).toEqual(['extra', 'args']);
  });

  it('converts kebab-case flag names to camelCase', () => {
    const p = new CommandParser();
    p.registerCommand({
      name: 'x',
      options: [{ name: 'dry-run', description: 'Dry run', type: 'boolean' }],
    });
    const r = p.parse(['x', '--dry-run']);
    expect(r.flags.dryRun).toBe(true);
  });

  it('applies command defaults', () => {
    const r = makeParser().parse(['init']);
    expect(r.flags.preset).toBe('default');
    expect(r.flags.force).toBe(false);
  });

  it('applies subcommand defaults', () => {
    const r = makeParser().parse(['swarm', 'start']);
    expect(r.flags.agents).toBe(3);
  });

  it('stops flag parsing after --', () => {
    const r = makeParser().parse(['init', '--', '--preset']);
    // defaults still applied; the flag itself is not parsed as a flag
    expect(r.flags.preset).toBe('default');
    expect(r.positional).toContain('--preset');
  });

  it('treats numeric values as numbers', () => {
    const r = makeParser().parse(['swarm', 'start', '--agents', '7']);
    expect(r.flags.agents).toBe(7);
  });

  it('treats negative numbers as flag values, not flags', () => {
    const p = new CommandParser();
    p.registerCommand({
      name: 'route',
      options: [{ name: 'reward', short: 'r', description: 'Reward', type: 'number' }],
    });
    const r = p.parse(['route', '-r', '-1.0']);
    expect(r.flags.reward).toBe(-1);
  });

  it('handles combined short boolean flags', () => {
    const p = new CommandParser();
    p.registerCommand({
      name: 'x',
      options: [
        { name: 'alpha', short: 'a', description: 'A', type: 'boolean' },
        { name: 'beta', short: 'b', description: 'B', type: 'boolean' },
      ],
    });
    const r = p.parse(['x', '-ab']);
    expect(r.flags.alpha).toBe(true);
    expect(r.flags.beta).toBe(true);
  });
});

describe('validateFlags', () => {
  it('flags missing required options', () => {
    const p = new CommandParser();
    p.registerCommand({
      name: 'x',
      options: [{ name: 'name', description: 'Name', type: 'string', required: true }],
    });
    const errors = p.validateFlags({}, p.getCommand('x'));
    expect(errors).toContainEqual(expect.stringContaining('--name'));
  });

  it('rejects values outside choices', () => {
    const errors = makeParser().validateFlags({ preset: 'bogus' }, initCmd);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns no errors for valid flags', () => {
    const errors = makeParser().validateFlags({ preset: 'full', force: true }, initCmd);
    expect(errors).toEqual([]);
  });
});
