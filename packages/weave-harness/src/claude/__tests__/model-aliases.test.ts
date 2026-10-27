import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  aliasOfModel,
  bareModelName,
  defaultPermissionModeOf,
  defaultModelOf,
  effortLevelOf,
  modelAliasTargets,
  permissionModeOf,
  startedModelOf,
  switchedModelOf,
  type ModelAliasTarget,
} from '../model-aliases.js';

const aliases = ['default', 'opus', 'sonnet'] as const;

describe('modelAliasTargets', () => {
  it('进程 env 里有就照它换成真名', () => {
    const t = modelAliasTargets(aliases, { ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-model' }, '/nope');
    expect(t).toEqual([
      { alias: 'default', actual: 'default' },
      { alias: 'opus', actual: 'opus-model' },
      { alias: 'sonnet', actual: 'sonnet' },
    ]);
  });

  it('_MODEL_NAME 变体也算数', () => {
    const t = modelAliasTargets(['haiku'], { ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'GLM-5.3-Flash' }, '/nope');
    expect(t[0]).toEqual({ alias: 'haiku', actual: 'GLM-5.3-Flash' });
  });

it('默认权限模式读自 permissions.defaultMode（计划确认面的行数靠它）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-pm-'));
    fs.mkdirSync(path.join(home, '.claude'));
    const write = (value: unknown): void =>
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(value));
    write({ permissions: { defaultMode: 'bypassPermissions' } });
    expect(defaultPermissionModeOf(home)).toBe('bypassPermissions');
    write({ permissions: {} });
    expect(defaultPermissionModeOf(home)).toBeNull();
    write({});
    expect(defaultPermissionModeOf(home)).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('settings.json 的 env 块压过进程 env（daemon 是独立进程、未必带宿主那套 env）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-ma-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-model', ANTHROPIC_API_KEY: 'sk-keep-out' } }),
    );
    const t = modelAliasTargets(
      ['opus'],
      { ANTHROPIC_DEFAULT_OPUS_MODEL: 'should-lose' },
      home,
    );
    expect(t).toEqual([{ alias: 'opus', actual: 'opus-model' }]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('两处都没有就原样回落别名（`/model opus` 仍然认）', () => {
    const t = modelAliasTargets(['opus'], {}, '/nope');
    expect(t).toEqual([{ alias: 'opus', actual: 'opus' }]);
  });
});

describe('switchedModelOf', () => {
  it('PostModelSwitch 的 to_model 就是此刻真跑的模型（附带切换前的 from_model）', () => {
    expect(switchedModelOf('PostModelSwitch', { from_model: 'opus-model', to_model: 'sonnet-model' })).toEqual({
      from: 'opus-model',
      to: 'sonnet-model',
    });
    // 没带 from_model：新值照答，拿什么跟转录比我（重启后回读）不知道就 null
    expect(switchedModelOf('PostModelSwitch', { to_model: 'opus-model' })).toEqual({ from: null, to: 'opus-model' });
  });

  it('别的动静 / 没带真名一律 null（不猜）', () => {
    expect(switchedModelOf('PreModelSwitch', { to_model: 'sonnet-model' })).toBeNull();
    expect(switchedModelOf('Stop', { to_model: 'sonnet-model' })).toBeNull();
    expect(switchedModelOf('PostModelSwitch', { to_model: '' })).toBeNull();
    expect(switchedModelOf('PostModelSwitch', null)).toBeNull();
  });
});

describe('defaultModelOf', () => {
  const home = () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-ma-'));
    fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
    return h;
  };

  it('env 块的 ANTHROPIC_MODEL 压过顶层 model 键（实测：新会话 startup 落在 env 那个）', () => {
    const h = home();
    fs.writeFileSync(
      path.join(h, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_MODEL: 'opus-model' }, model: 'sonnet' }),
    );
    expect(defaultModelOf(h, {})).toBe('opus-model');
    fs.rmSync(h, { recursive: true, force: true });
  });

  it('没有 env 就用顶层 model 键：别名经 ANTHROPIC_DEFAULT_<别名>_MODEL 换真名，非别名照原样回落', () => {
    const h = home();
    fs.writeFileSync(
      path.join(h, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-model' } }),
    );
    expect(defaultModelOf(h, {})).toBe('sonnet-model');
    fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify({ model: 'opus-model' }));
    expect(defaultModelOf(h, {})).toBe('opus-model');
    fs.rmSync(h, { recursive: true, force: true });
  });

  it('两处都没配就答宿主内建默认 sonnet 档；进程 env 只做兜底', () => {
    const h = home(); // 无 settings.json
    expect(defaultModelOf(h, {})).toBe('sonnet');
    expect(defaultModelOf(h, { ANTHROPIC_MODEL: 'GLM-5.3-Flash' })).toBe('GLM-5.3-Flash');
    fs.rmSync(h, { recursive: true, force: true });
  });
});

describe('startedModelOf', () => {
  it('SessionStart 带 model（startup / compact）就报真名', () => {
    expect(startedModelOf('SessionStart', { source: 'startup', model: 'opus-model' })).toEqual({ model: 'opus-model' });
  });

  it('resume 不带 model 就答全局配置里的默认模型（重开 = 宿主落回默认）', () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-ma-'));
    fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(h, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_MODEL: 'opus-model' }, model: 'sonnet' }),
    );
    expect(startedModelOf('SessionStart', { source: 'resume' }, h, {})).toEqual({ model: 'opus-model' });
    expect(startedModelOf('SessionStart', null, h, {})).toEqual({ model: 'opus-model' });
    fs.rmSync(h, { recursive: true, force: true });
  });

  it('非宿主启动源（rollout 兜底）不触发默认闩——别把 claude 默认模型错标到别家会话', () => {
    expect(startedModelOf('SessionStart', { source: 'rollout' })).toBeNull();
  });

  it('别的动静一律 null', () => {
    expect(startedModelOf('SessionEnd', { model: 'opus-model' })).toBeNull();
    expect(startedModelOf('Stop', null)).toBeNull();
  });
});

describe('aliasOfModel', () => {
  const targets: ModelAliasTarget[] = [
    { alias: 'opus', actual: 'opus-model' },
    { alias: 'sonnet', actual: 'sonnet-model' },
    { alias: 'haiku', actual: 'haiku' },
  ];

  it('真名认回别名', () => {
    expect(aliasOfModel(targets, 'opus-model')).toBe('opus');
    expect(aliasOfModel(targets, 'sonnet-model')).toBe('sonnet');
    expect(aliasOfModel(targets, 'haiku')).toBe('haiku');
  });

  it('转录里的网关前缀剥掉再认', () => {
    expect(aliasOfModel(targets, 'gw/opus-model')).toBe('opus');
    expect(bareModelName('gw/sonnet-model')).toBe('sonnet-model');
    expect(bareModelName('opus-model')).toBe('opus-model');
  });

  it('上下文窗标注（[1M]，大小写不定）剥掉再认——settings env 带它、转录照会不带', () => {
    const ctx: ModelAliasTarget[] = [
      { alias: 'opus', actual: 'opus-model[1M]' },
      { alias: 'sonnet', actual: 'sonnet-model[1M]' },
    ];
    expect(aliasOfModel(ctx, 'sonnet-model')).toBe('sonnet');
    expect(aliasOfModel(ctx, 'gw/opus-model')).toBe('opus');
    expect(bareModelName('sonnet-model[1m]')).toBe('sonnet-model');
    expect(bareModelName('sonnet-model[1M]')).toBe('sonnet-model');
  });

  it('认不出 / 没值都回 null，不猜', () => {
    expect(aliasOfModel(targets, 'gpt-unknown')).toBeNull();
    expect(aliasOfModel(targets, null)).toBeNull();
    expect(aliasOfModel([], 'opus-model')).toBeNull();
  });
});

describe('effortLevelOf', () => {
  it('取 hook 里的 effort.level（statusline thinking 块同一个事实）', () => {
    expect(effortLevelOf({ effort: { level: 'high' } })).toBe('high');
  });

  it('没有 / 空串 / 形状不对都回 null', () => {
    expect(effortLevelOf({})).toBeNull();
    expect(effortLevelOf({ effort: {} })).toBeNull();
    expect(effortLevelOf({ effort: { level: '' } })).toBeNull();
    expect(effortLevelOf(null)).toBeNull();
  });
});

describe('permissionModeOf', () => {
  it('取 hook 里的 permission_mode（每条事件都带，答「此刻」的模式）', () => {
    expect(permissionModeOf({ permission_mode: 'plan' })).toBe('plan');
  });

  it('没有 / 空串 / 形状不对都回 null', () => {
    expect(permissionModeOf({})).toBeNull();
    expect(permissionModeOf({ permission_mode: '' })).toBeNull();
    expect(permissionModeOf({ permission_mode: 3 })).toBeNull();
    expect(permissionModeOf(null)).toBeNull();
  });
});
