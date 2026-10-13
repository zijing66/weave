import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import type { PluginStateSurface } from '../driver.js';
import { CODEX_ASSETS } from './assets.js';
import { CodexTomlCorruptError, upsertCodexPluginEnabledInText } from './toml.js';

/**
 * Codex 插件启用态表面：`~/.codex/config.toml` 的 `[plugins."<key>"] enabled`
 * （P2 从 server/install/global-config.ts 迁入——codex 的配置表示法是 harness
 * 知识；Codex 无安装/市场面，故走更窄的 pluginState 槽而非 plugins）。
 */

const pathExists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

/** `[plugins]` 段的布尔 enabled 过滤读（缺失/损坏 → 空对象）。 */
async function readEnabled(file: string): Promise<Record<string, boolean>> {
  if (!(await pathExists(file))) return {};
  try {
    const parsed = parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
    const plugins = parsed.plugins;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(plugins as Record<string, unknown>)) {
      if (v && typeof v === 'object' && typeof (v as { enabled?: unknown }).enabled === 'boolean') {
        out[k] = (v as { enabled: boolean }).enabled;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export const CODEX_PLUGIN_STATE: PluginStateSurface = {
  readGlobalEnabled: () => readEnabled(CODEX_ASSETS.userConfigFile(homedir())),

  async writeGlobalEnabled(key, enabled) {
    const file = CODEX_ASSETS.userConfigFile(homedir());
    let text = '';
    if (await pathExists(file)) {
      text = await readFile(file, 'utf-8');
      try {
        parse(text);
      } catch (e) {
        throw new CodexTomlCorruptError(
          `${file} is not valid TOML — refusing to write: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, upsertCodexPluginEnabledInText(text, key, enabled), 'utf-8');
  },
};
