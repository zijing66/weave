import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

/**
 * 内置仓落地的装配守卫（结构断言，不是行为测试）。
 *
 * 教训来自本项目已踩过的坑：`dev-entry.ts` 曾**漏装配整条 hook 管道**，因为
 * 装配写在两个入口里各写一遍。内置仓落地同理 —— 两个入口都必须、且必须在
 * 装载插件之前调用；顺序错了 `loadAllPlugins` 会去读一个还不存在的扫描根，
 * 表现是「内置包全部消失」却不报错。
 */

const ENTRIES = ['start.ts', 'dev-entry.ts'] as const;

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(`../${file}`, import.meta.url), 'utf8');
}

describe('内置仓落地的装配守卫', () => {
  it('两个入口都调用 ensureBuiltinMarket，且都排在 loadAllPlugins 之前', async () => {
    for (const entry of ENTRIES) {
      const src = await sourceOf(entry);
      const ensureAt = src.indexOf('ensureBuiltinMarket(');
      const loadAt = src.indexOf('loadAllPlugins(');
      expect(ensureAt, `${entry} 必须调用 ensureBuiltinMarket`).toBeGreaterThan(-1);
      expect(loadAt, `${entry} 应调用 loadAllPlugins`).toBeGreaterThan(-1);
      expect(ensureAt, `${entry} 中落地必须先于装载`).toBeLessThan(loadAt);
    }
  });

  it('入口不自拼落地逻辑：链接原语只出现在 market/builtin.ts', async () => {
    for (const entry of ENTRIES) {
      const src = await sourceOf(entry);
      expect(src).not.toContain('linkOrCopy(');
      expect(src).not.toContain('removeInstalled(');
    }
    const builtin = await sourceOf('../market/builtin.ts');
    expect(builtin).toContain('linkOrCopy(');
    expect(builtin).toContain('removeInstalled(');
  });

  it('落点 id 与 harness 的缺省市场同名，不另抄字符串', async () => {
    const builtin = await sourceOf('../market/builtin.ts');
    expect(builtin).toContain('WEAVE_MARKETPLACE');
    expect(builtin).not.toMatch(/BUILTIN_MARKET_ID\s*=\s*'weave'/);
  });
});
