export type ClaudeMdTemplate = 'minimal' | 'standard' | 'full';

export interface ClaudeMdGeneratorInput {
  template: ClaudeMdTemplate;
  projectName: string;
}

/** Delimit weave's managed block so re-init can replace it in place. */
const WEAVE_BLOCK_START = '<!-- weave:start -->';
const WEAVE_BLOCK_END = '<!-- weave:end -->';

function header(name: string): string {
  return `# ${name}

> This file is managed by [weave](https://github.com/weave) — a Claude Code harness.
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
