import { generateAutoMemoryHook as generate } from '@weavecode/harness';
import { WEAVE_VERSION } from '@weavecode/server';

/**
 * 脚本生成器已迁 `@weavecode/harness`（版本号由调用方注入，生成器保持纯字符串）。
 * 这里绑上 cli 自己的 `WEAVE_VERSION`，存量调用点与测试零改动。
 */
export function generateAutoMemoryHook(): string {
  return generate(WEAVE_VERSION);
}
