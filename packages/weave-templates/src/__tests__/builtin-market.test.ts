import { describe, it, expect } from 'vitest';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinMarketRoot, builtinPacksRoot, builtinRulesRoot } from '../index';

/** 内置仓的事实源是**源码树**（不是 dist 副本）——结构断言必须打在源上。 */
const REPO = fileURLToPath(new URL('../resources/weave-market/', import.meta.url));

async function dirsIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** `plugins/<scope>/<pack>/` 下带 CC 清单的包名 → 市场仓相对 source。 */
async function ccPacksInRepo(): Promise<{ name: string; source: string }[]> {
  const out: { name: string; source: string }[] = [];
  for (const scope of await dirsIn(path.join(REPO, 'plugins'))) {
    for (const pack of await dirsIn(path.join(REPO, 'plugins', scope))) {
      const rel = `./plugins/${scope}/${pack}`;
      const manifest = path.join(REPO, 'plugins', scope, pack, '.claude-plugin', 'plugin.json');
      if (!(await exists(manifest))) continue;
      const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { name?: string };
      out.push({ name: parsed.name ?? pack, source: rel });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

describe('内置仓结构（resources/weave-market）', () => {
  it('三区齐备，且 plugins/ 的直接子目录必须是 scope（层级是硬约束）', async () => {
    expect((await dirsIn(REPO)).sort()).toEqual(['.claude-plugin', 'init', 'plugins', 'rules']);
    // toolkit 扫描根的直接子目录 = scope；包在这一层之下。若有人按市场惯例
    // 压平或再插一层，包会落到 MAX_SCAN_LEVEL 之外而**全部不可见**，故在此钉死：
    // scope 层不得自身是包（无 .claude-plugin/ 无 weave-plugin.json）。
    for (const scope of await dirsIn(path.join(REPO, 'plugins'))) {
      expect(await exists(path.join(REPO, 'plugins', scope, '.claude-plugin'))).toBe(false);
      expect(await exists(path.join(REPO, 'plugins', scope, 'weave-plugin.json'))).toBe(false);
    }
  });

  it('rules/ 是平铺的规则包根（不进 toolkit 列表）', async () => {
    const packs = await dirsIn(path.join(REPO, 'rules'));
    expect(packs.sort()).toEqual([
      'weave-cross-project-touch',
      'weave-doc-update-check',
      'weave-stop-summary',
    ]);
    for (const pack of packs) {
      expect(await exists(path.join(REPO, 'rules', pack, 'weave-plugin.json'))).toBe(true);
    }
  });

  it('init/ 只含 commands 与 agents（非包：不被包谓词命中）', async () => {
    expect((await dirsIn(path.join(REPO, 'init'))).sort()).toEqual(['agents', 'commands']);
  });

  it('仓内所有 agents/*.md 都带合法 frontmatter（无 name+description 宿主不注册）', async () => {
    const agentFiles: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (entry.isFile() && dir.endsWith(`${path.sep}agents`) && entry.name.endsWith('.md'))
          agentFiles.push(abs);
      }
    };
    await walk(REPO);
    expect(agentFiles.length).toBeGreaterThan(0);
    for (const file of agentFiles) {
      const text = await readFile(file, 'utf8');
      // 不写正则（避免转义坑）：去掉 CR 后按 --- 行切 frontmatter
      const normalized = text.split(String.fromCharCode(13)).join('');
      const closed = normalized.indexOf('\n---\n');
      const fm = normalized.startsWith('---\n') && closed > 0 ? normalized.slice(4, closed) : null;
      expect(fm, `${file} 缺 frontmatter`).toBeTruthy();
      expect(fm, `${file} frontmatter 缺 name`).toMatch(/^name:\s*\S+/m);
      expect(fm, `${file} frontmatter 缺 description`).toMatch(/^description:\s*\S+/m);
    }
  });


  it('仓内所有 skills/*/SKILL.md 都带 name+description frontmatter（与外部 skills 仓同格式）', async () => {
    const skillFiles: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (
          entry.isFile() &&
          entry.name === 'SKILL.md' &&
          path.basename(path.dirname(abs)) !== '' &&
          dir.endsWith(`${path.sep}skills${path.sep}${path.basename(path.dirname(abs))}`)
        )
          skillFiles.push(abs);
      }
    };
    await walk(path.join(REPO, 'plugins'));
    expect(skillFiles.length).toBeGreaterThan(0);
    for (const file of skillFiles) {
      const text = await readFile(file, 'utf8');
      // 不写正则（避免转义坑）：去掉 CR 后按 --- 行切 frontmatter
      const normalized = text.split(String.fromCharCode(13)).join('');
      const fm = normalized.startsWith('---\n') ? normalized.slice(4, normalized.indexOf('\n---\n')) : null;
      expect(fm, `${file} 缺 frontmatter`).toBeTruthy();
      expect(fm!, `${file} frontmatter 缺 name`).toMatch(/^name:\s*\S+/m);
      expect(fm!, `${file} frontmatter 缺 description`).toMatch(/^description:\s*\S+/m);
    }
  });
  it('清单与 plugins/ 下的 CC 包双向一致', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { name: string; plugins: { name: string; source?: string }[] };
    expect(manifest.name).toBe('weave');

    const listed = manifest.plugins
      .map((p) => ({ name: p.name, source: p.source ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const actual = await ccPacksInRepo();
    expect(listed).toEqual(actual);
  });

  it('清单内每个 source 指向仓内**实体**目录（H3：validate 不跟随链接，须自校真实路径）', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { plugins: { name: string; source?: string }[] };

    for (const plugin of manifest.plugins) {
      const target = path.join(REPO, plugin.source ?? '');
      expect(path.relative(REPO, target).startsWith('..')).toBe(false); // 不逃出仓
      const st = await lstat(target);
      expect(st.isDirectory()).toBe(true);
      expect(st.isSymbolicLink()).toBe(false);
    }
  });
});

describe('内置仓布局导出（开发态与发布态同表达式）', () => {
  it('三个导出根都落在仓内且互为兄弟', () => {
    const root = builtinMarketRoot();
    expect(builtinPacksRoot()).toBe(path.join(root, 'plugins'));
    expect(builtinRulesRoot()).toBe(path.join(root, 'rules'));
  });
});
