import { logger } from '@weavecode/core';
import { t } from '../i18n/index.js';

/**
 * PromptPort（批 5，图①）：init 的交互出口。confirm 自既有 `confirmPrompt`
 * 迁入（范式不变——非交互/非 TTY 直接取默认值，`weave init` 保持可脚本化）；
 * multiselect 供 `--harness` 缺省时的 TTY 多选。executor 可注入假实现供测试。
 */
export interface PromptPort {
  confirm(question: string, detail?: string): Promise<boolean>;
  multiselect<T extends string>(options: readonly T[], defaults: readonly T[]): Promise<T[]>;
}

/**
 * Ask a yes/no question, defaulting to yes.
 *
 * Returns the default without prompting when the run is non-interactive or
 * stdin is not a terminal — `weave init` must stay scriptable, and the default
 * action is always the one the user asked for (replace AGENTS.md with a link).
 */
export async function confirmPrompt(
  question: string,
  detail: string,
  interactive: boolean,
): Promise<boolean> {
  if (!interactive || !process.stdin.isTTY || !process.stdout.isTTY) return true;

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\n  ${question}\n  ${detail}\n  ${t('init.proceed')} `,
    );
    return !/^n(o)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** 绑定 interactive 的 PromptPort 工厂：内部再查 TTY，双保险保持静默默认。 */
export function createPromptPort(interactive: boolean): PromptPort {
  const canPrompt = () =>
    interactive && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  return {
    confirm: (question, detail = '') => confirmPrompt(question, detail, interactive),

    async multiselect<T extends string>(options: readonly T[], defaults: readonly T[]): Promise<T[]> {
      if (!canPrompt()) return [...defaults];
      if (options.length === 0) return [];

      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(`\n  ${t('init.multiselect.title')}`);
        options.forEach((opt, i) => console.log(`    ${i + 1}) ${opt}`));
        const answer = (
          await rl.question(`  ${t('init.multiselect.hint', { defaults: defaults.join(',') })} `)
        ).trim();
        if (!answer) return [...defaults];

        const picked: T[] = [];
        const invalid: string[] = [];
        for (const token of answer.split(/[,\s]+/).filter(Boolean)) {
          const byIndex = /^\d+$/.test(token) ? options[Number(token) - 1] : undefined;
          const hit = byIndex ?? options.find((o) => o.toLowerCase() === token.toLowerCase());
          if (hit === undefined) invalid.push(token);
          else if (!picked.includes(hit)) picked.push(hit);
        }
        if (invalid.length > 0) {
          logger.warn(t('init.multiselect.invalid', { keys: invalid.join(', ') }));
        }
        // 全非法（或空）回落默认——与 --harness 全非法回落同一语义
        return picked.length > 0 ? picked : [...defaults];
      } finally {
        rl.close();
      }
    },
  };
}
