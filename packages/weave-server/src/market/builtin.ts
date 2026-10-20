import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { builtinMarketRoot } from '@weavecode/templates';
import { WEAVE_MARKETPLACE } from '@weavecode/harness';
import { marketDir } from './manifest.js';
import { linkOrCopy, removeInstalled, type InstallLinkMode } from './install-link.js';
import type { LibraryRepository } from '../repositories/libraries.js';

/**
 * 内置仓在市场里的 id。它**必须**等于 harness 的注册键缺省市场
 * （`PluginSurface.pluginKey` 的 `name@weave` 里那个 `weave`）——`marketIdOf`
 * 会把 `<dataRoot>/market/weave/<...>` 下的包判成 `name@weave`，两边同名才使得
 * 「内置仓落地前回落自建市场 / 落地后判成 weaver 市场」得到**同一个键**。
 * 故这里直接引 harness 的常量，不另抄一个字符串。
 */
export const BUILTIN_MARKET_ID = WEAVE_MARKETPLACE;

/** 内置仓在数据目录里的落点：`<dataRoot>/market/weave/`。 */
export function builtinMarketDir(dataRoot: string): string {
  return path.join(marketDir(dataRoot), BUILTIN_MARKET_ID);
}

/** 内置工具包扫描根（仓内 `plugins/`）——`ToolkitSource.root` 用。 */
export function builtinPacksDir(dataRoot: string): string {
  return path.join(builtinMarketDir(dataRoot), 'plugins');
}

/** 内置 SPI 规则包装载根（仓内 `rules/`）。 */
export function builtinRulesDir(dataRoot: string): string {
  return path.join(builtinMarketDir(dataRoot), 'rules');
}

export function isBuiltinMarketDir(candidate: string, dataRoot: string): boolean {
  return path.resolve(candidate) === path.resolve(builtinMarketDir(dataRoot));
}

export interface BuiltinMarketResult {
  /** 本次是否重铺（false = 既有落点已指向当前源，未动盘）。 */
  changed: boolean;
  /** 链接或复制；重铺失败时为 undefined。 */
  form?: InstallLinkMode;
  error?: string;
}

/**
 * 把 `@weavecode/templates` 随包发布的内置仓落到 `<dataRoot>/market/weave/`，
 * 并登记为一条 `libraries` 行（`/market` 与资源管理页据此把它当一个仓库渲染）。
 *
 * **落点用链接（失败回退复制）**：这是「公共全局位置优先链接」的直接落实 ——
 * 落点不是数据，而是随包发布的只读内容，链接既不复制一份、也让「改仓即改内置」
 * 在开发态（源 = `src/resources`）真正即时生效。故**不得**往落点写任何东西
 * （清单/扫描缓存都不落这里：扫描缓存写 `<dataRoot>/market/.weave-scans/`，
 * 是市场根的**兄弟**目录）。
 *
 * 幂等：落点已是指向当前源的链接则不动盘；源变更（换包版本 / 开发态换目录）或
 * 落点是旧的复制件时重铺 —— 重铺走 `removeInstalled`（lstat 判定），
 * 绝不会把链接当目录递归删而删穿到包内。
 */
export async function ensureBuiltinMarket(deps: {
  libraries: Pick<LibraryRepository, 'add' | 'dataRoot'>;
}): Promise<BuiltinMarketResult> {
  const dataRoot = deps.libraries.dataRoot;
  const source = builtinMarketRoot();
  const target = builtinMarketDir(dataRoot);

  // 行先登记（INSERT OR IGNORE 幂等）：DB 重建/落点被清后，仓库仍能被列出。
  deps.libraries.add({ path: target, kind: 'both' });

  const want = await realpath(source);
  const stat = await lstat(target).catch(() => null);
  if (stat) {
    if (stat.isSymbolicLink()) {
      const have = await realpath(target).catch(() => null);
      if (have === want) return { changed: false, form: 'link' };
    }
    await removeInstalled(target);
  }
  try {
    const form = await linkOrCopy(source, target);
    return { changed: true, form };
  } catch (e) {
    // 不抛：内置仓缺失只应降级（工具包列表少几项），不该拦住 daemon 启动。
    return { changed: false, error: e instanceof Error ? e.message : String(e) };
  }
}
