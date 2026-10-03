import { describe, it, expect } from 'vitest';
import { createPromptPort, confirmPrompt } from '../init/prompt';

/** 测试进程非 TTY——PromptPort 必须静默取默认，不得挂起等输入。 */
describe('PromptPort（非 TTY 默认）', () => {
  it('multiselect：非 TTY → 静默返回 defaults', async () => {
    const port = createPromptPort(true);
    await expect(port.multiselect(['claude', 'codex'], ['claude'])).resolves.toEqual(['claude']);
  });

  it('multiselect：interactive=false（--no-interactive）→ 返回 defaults', async () => {
    const port = createPromptPort(false);
    await expect(port.multiselect(['claude', 'codex'], ['codex'])).resolves.toEqual(['codex']);
  });

  it('confirm：非 TTY → 取默认 yes，不提问', async () => {
    const port = createPromptPort(true);
    await expect(port.confirm('Q?', 'detail')).resolves.toBe(true);
  });

  it('confirm：interactive=false → 取默认 yes（confirmPrompt 既有语义迁入）', async () => {
    await expect(confirmPrompt('Q?', 'detail', false)).resolves.toBe(true);
  });
});
