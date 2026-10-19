import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  aliasOfModel,
  modelAliasTargets,
  startedModelOf,
  switchedModelOf,
  type ModelAliasTarget,
} from '../model-aliases.js';

const aliases = ['default', 'opus', 'sonnet'] as const;

describe('modelAliasTargets', () => {
  it('进程 env 里有就照它换成真名', () => {
    const t = modelAliasTargets(aliases, { ANTHROPIC_DEFAULT_OPUS_MODEL: 'ftm' }, '/nope');
    expect(t).toEqual([
      { alias: 'default', actual: 'default' },
      { alias: 'opus', actual: 'ftm' },
      { alias: 'sonnet', actual: 'sonnet' },
    ]);
  });

  it('_MODEL_NAME 变体也算数', () => {
    const t = modelAliasTargets(['haiku'], { ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'GLM-5.3-Flash' }, '/nope');
    expect(t[0]).toEqual({ alias: 'haiku', actual: 'GLM-5.3-Flash' });
  });

  it('settings.json 的 env 块压过进程 env（daemon 是独立进程、未必带宿主那套 env）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-ma-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'ftm', ANTHROPIC_API_KEY: 'sk-keep-out' } }),
    );
    const t = modelAliasTargets(
      ['opus'],
      { ANTHROPIC_DEFAULT_OPUS_MODEL: 'should-lose' },
      home,
    );
    expect(t).toEqual([{ alias: 'opus', actual: 'ftm' }]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('两处都没有就原样回落别名（`/model opus` 仍然认）', () => {
    const t = modelAliasTargets(['opus'], {}, '/nope');
    expect(t).toEqual([{ alias: 'opus', actual: 'opus' }]);
  });
});

describe('switchedModelOf', () => {
  it('PostModelSwitch 的 to_model 就是此刻真跑的模型', () => {
    expect(switchedModelOf('PostModelSwitch', { from_model: 'ftm', to_model: 'deepseek-flash' })).toBe(
      'deepseek-flash',
    );
  });

  it('别的动静 / 没带真名一律 null（不猜）', () => {
    expect(switchedModelOf('PreModelSwitch', { to_model: 'deepseek-flash' })).toBeNull();
    expect(switchedModelOf('Stop', { to_model: 'deepseek-flash' })).toBeNull();
    expect(switchedModelOf('PostModelSwitch', { to_model: '' })).toBeNull();
    expect(switchedModelOf('PostModelSwitch', null)).toBeNull();
  });
});

describe('startedModelOf', () => {
  it('SessionStart 带 model（startup / compact）就报真名', () => {
    expect(startedModelOf('SessionStart', { source: 'startup', model: 'ftm' })).toEqual({ model: 'ftm' });
  });

  it('resume 不带 model 也要报一声：null = 旧答案作废、重读（不是「不知道」）', () => {
    expect(startedModelOf('SessionStart', { source: 'resume' })).toEqual({ model: null });
    expect(startedModelOf('SessionStart', null)).toEqual({ model: null });
  });

  it('别的动静一律 null', () => {
    expect(startedModelOf('SessionEnd', { model: 'ftm' })).toBeNull();
    expect(startedModelOf('Stop', null)).toBeNull();
  });
});

describe('aliasOfModel', () => {
  const targets: ModelAliasTarget[] = [
    { alias: 'opus', actual: 'ftm' },
    { alias: 'sonnet', actual: 'deepseek-flash' },
    { alias: 'haiku', actual: 'haiku' },
  ];

  it('真名认回别名', () => {
    expect(aliasOfModel(targets, 'ftm')).toBe('opus');
    expect(aliasOfModel(targets, 'deepseek-flash')).toBe('sonnet');
    expect(aliasOfModel(targets, 'haiku')).toBe('haiku');
  });

  it('转录里的网关前缀剥掉再认', () => {
    expect(aliasOfModel(targets, 'custom_openai/ftm')).toBe('opus');
  });

  it('认不出 / 没值都回 null，不猜', () => {
    expect(aliasOfModel(targets, 'gpt-unknown')).toBeNull();
    expect(aliasOfModel(targets, null)).toBeNull();
    expect(aliasOfModel([], 'ftm')).toBeNull();
  });
});
