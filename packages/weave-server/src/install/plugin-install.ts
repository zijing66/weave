import path from 'node:path';
import type { PluginInstallInfo, PluginSurface } from '@weavecode/harness';
import { marketIdOf } from '../market/identity.js';
import { marketDir } from '../market/manifest.js';

/**
 * user 档安装（globalInstall）的服务端唯一编排：市场身份判据（marketIdOf 的
 * 唯一实现）+ marketplace 落点拼装收在此——toolkit 管线与安装路由同源取用，
 * 不得各自内联。server 只给面传语义参数（包名 + 市场身份），表示法留 harness。
 */
export async function installPluginPack(
  surface: PluginSurface,
  pack: { dir: string; name: string; version?: string; description?: string },
): Promise<PluginInstallInfo> {
  const market = marketIdOf(pack.dir);
  return surface.globalInstall(pack.dir, {
    name: pack.name,
    version: pack.version,
    description: pack.description,
    ...(market ? { marketplace: { name: market, dir: path.join(marketDir(), market) } } : {}),
  });
}
