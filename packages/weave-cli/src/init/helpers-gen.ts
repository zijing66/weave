import { WEAVE_VERSION } from '@weavecode/server';

export function generateAutoMemoryHook(): string {
  return `#!/usr/bin/env node
/**
 * weave auto-memory-hook
 * Triggered on UserPromptSubmit to record user context.
 * @version weave@${WEAVE_VERSION}
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
