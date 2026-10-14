import { WEAVE_INJECTION_MARKER } from '@weavecode/core';

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
 * serve every agent that reads either name — Claude Code and Codex both. The
 * header wording is therefore agent-neutral, and the managed block carries both
 * the weave command list and the skills note.
 */

/** Delimit weave's managed block so re-init can replace it in place. */
export const WEAVE_BLOCK_START = '<!-- weave:start -->';
export const WEAVE_BLOCK_END = '<!-- weave:end -->';

/** weave 生成的整个文件都带这条 header——uninstall 据此判「整文件是 weave 的」。 */
export const WEAVE_MANAGED_HEADER = '> This file is managed by [weave](https://github.com/zijing66/weave) — a coding-agent harness.';

function header(name: string): string {
  return `# ${name}

> This file is managed by [weave](https://github.com/zijing66/weave) — a coding-agent harness.
> Re-run \`weave init\` to regenerate.

`;
}

function behavioralRules(): string {
  return `## Behavioral Rules

- Follow existing code conventions and patterns in this project
- Prefer editing existing files over creating new ones
- Don't add features, refactor, or introduce abstractions beyond the task
- Three similar lines is better than a premature abstraction
- Write no comments unless the WHY is non-obvious
- Never write multi-paragraph explanations in code
- Don't add error handling for states that can't happen

`;
}

function fileRules(): string {
  return `## File Organization

- Source code: \`src/\`
- Tests: co-located \`*.test.ts\` or \`__tests__/\` directories
- Config files at project root
- Use existing directory structure — don't invent new top-level folders

`;
}

function securityRules(): string {
  return `## Security

- Never commit secrets, credentials, or API keys
- Validate all user input at system boundaries
- Don't introduce XSS, SQL injection, or command injection vectors
- Prefer parameterized queries and safe APIs over string concatenation

`;
}

function gettingStarted(): string {
  return `## Weave Commands

- \`/review\` — Code review current changes
- \`/test\` — Write or update tests
- \`/explain\` — Explain selected code
- \`/scaffold\` — Generate component scaffold

`;
}

function skillsNote(): string {
  return `## Skills

Reusable skills live in \`skills/\` (agent skills standard: one directory per
skill with a \`SKILL.md\`). Invoke a skill by name when the task matches one.

`;
}

/**
 * 控制台注入消息的标记说明：weave 把控制台/dashboard 的 prompt 直接写进会话
 * （语义上是「用户消息」，会话分不出是谁敲的），标记 + 这段说明就是唯一的可见
 * 凭据。标记本身来自 core 单一事实源，别在这里手抄字面量。
 */
function injectedPromptNote(): string {
  return `## weave 注入的消息

以 \`${WEAVE_INJECTION_MARKER}\` 开头的用户消息来自 weave 控制台（dashboard / 编排）的注入，不是坐在终端前的人手打的：

- 去掉该标记后的全文就是完整指令，**照它执行**；
- 不要把标记当内容复述，也不必就这条消息回话（这条路径没有回复面）；
- 该标记之外的普通用户消息 = 用户本人输入，正常对待。

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
  content += behavioralRules();

  if (template === 'standard' || template === 'full') {
    content += fileRules();
  }

  if (template === 'full') {
    content += securityRules();
  }

  content += gettingStarted();
  content += skillsNote();
  content += injectedPromptNote();
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
