/**
 * auto-memory hook 脚本生成。版本号由调用方注入（cli/server 各带自己的
 * `WEAVE_VERSION`）——生成器保持纯字符串，不反向依赖发包侧。
 */
export function generateAutoMemoryHook(version: string): string {
  return `#!/usr/bin/env node
/**
 * weave auto-memory-hook
 * Triggered on UserPromptSubmit to record user context.
 * @version weave@${version}
 */
'use strict';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    process.stderr.write('[weave] auto-memory: session active\\n');
  } catch {
    // ignore
  }
  process.exit(0);
});
`;
}
