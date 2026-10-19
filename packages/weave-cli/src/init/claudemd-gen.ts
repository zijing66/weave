import { t } from '../i18n/index.js';

export type ClaudeMdTemplate = 'minimal' | 'standard' | 'full';

export interface ClaudeMdGeneratorInput {
  template: ClaudeMdTemplate;
  projectName: string;
}

/**
 * Instruction-file generator.
 *
 * weave writes ONE instruction file and links the other name to it
 * (`AGENTS.md -> CLAUDE.md`, see instruction-link.ts), so this content has to
 * serve every agent that reads either name — Claude Code and Codex both.
 *
 * The block text lives in the CLI dictionary (`claudemd.*`) and renders in the
 * active locale. What belongs here is anything the agent needs to work in THIS
 * project. weave's own engineering notes (internal paths, module layout, dev
 * workflow) do not.
 */

/** Delimit weave's managed block so re-init can replace it in place. */
export const WEAVE_BLOCK_START = '<!-- weave:start -->';
export const WEAVE_BLOCK_END = '<!-- weave:end -->';

/**
 * weave 生成的整个文件都带这条 header——uninstall 据此判「整文件是 weave 的」，
 * 所以它是**判据**而非文案：保持英文、不随 locale 变。
 */
export const WEAVE_MANAGED_HEADER = '> This file is managed by [weave](https://github.com/zijing66/weave) — a coding-agent harness.';

function header(name: string): string {
  return `# ${name}

> This file is managed by [weave](https://github.com/zijing66/weave) — a coding-agent harness.
> Re-run \`weave init\` to regenerate.

`;
}

/**
 * Weave's managed block — everything weave may write into a CLAUDE.md is
 * delimited by these markers. When the target file already contains the
 * block, re-init replaces the block instead of appending a second copy.
 */
export function generateClaudeMdSection(input: ClaudeMdGeneratorInput): string {
  const { template } = input;

  let content = `${WEAVE_BLOCK_START}\n`;
  content += t('claudemd.rules');

  if (template === 'standard' || template === 'full') {
    content += t('claudemd.files');
  }

  if (template === 'full') {
    content += t('claudemd.security');
  }

  content += t('claudemd.skills');
  content += `${WEAVE_BLOCK_END}\n`;
  return content;
}

/** A fresh, weave-generated CLAUDE.md: title header + the managed block. */
export function generateClaudeMd(input: ClaudeMdGeneratorInput): string {
  return header(input.projectName) + generateClaudeMdSection(input);
}

/**
 * Merge weave's managed block into an existing user CLAUDE.md.
 *
 * Policy (weave init never overwrites user files, append-only):
 * - content outside the weave markers is preserved byte-for-byte
 * - when the block already exists it is replaced in place (weave's own
 *   block is the one thing that may be refreshed)
 * - otherwise the block is appended at the end
 *
 * Idempotent: merging the same section twice yields the same content.
 */
export function mergeClaudeMd(existing: string, section: string): string {
  const startIdx = existing.indexOf(WEAVE_BLOCK_START);
  const endIdx = existing.indexOf(WEAVE_BLOCK_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return existing.slice(0, startIdx) + section.trimEnd() + existing.slice(endIdx + WEAVE_BLOCK_END.length);
  }

  return existing.replace(/\s+$/, '') + '\n\n' + section.trimEnd() + '\n';
}
