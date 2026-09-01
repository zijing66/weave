export type AgentsMdTemplate = 'minimal' | 'standard' | 'full';

export interface AgentsMdGeneratorInput {
  template: AgentsMdTemplate;
  projectName: string;
}

/**
 * AGENTS.md generator — the cross-agent instruction file (agents.md standard,
 * read natively by Codex and a growing set of coding agents).
 *
 * Mirrors claudemd-gen: pure functions, a weave-delimited managed block, and
 * the same append-only merge policy for existing user files.
 */

/** Delimit weave's managed block so re-init can replace it in place. */
const WEAVE_BLOCK_START = '<!-- weave:start -->';
const WEAVE_BLOCK_END = '<!-- weave:end -->';

function header(name: string): string {
  return `# ${name}

> This file is managed by [weave](https://github.com/weave) — a coding-agent harness.
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

function skillsNote(): string {
  return `## Skills

Reusable skills live in \`skills/\` (agent skills standard: one directory per
skill with a \`SKILL.md\`). Invoke a skill by name when the task matches one.

`;
}

/** Weave's managed block — see claudemd-gen for the marker contract. */
export function generateAgentsMdSection(input: AgentsMdGeneratorInput): string {
  const { template } = input;

  let content = `${WEAVE_BLOCK_START}\n`;
  content += behavioralRules();

  if (template === 'standard' || template === 'full') {
    content += fileRules();
  }

  if (template === 'full') {
    content += securityRules();
  }

  content += skillsNote();
  content += `${WEAVE_BLOCK_END}\n`;
  return content;
}

/** A fresh, weave-generated AGENTS.md: title header + the managed block. */
export function generateAgentsMd(input: AgentsMdGeneratorInput): string {
  return header(input.projectName) + generateAgentsMdSection(input);
}

/**
 * Merge weave's managed block into an existing user AGENTS.md.
 *
 * Same policy as mergeClaudeMd (append-only, weave's own block refreshable):
 * - content outside the weave markers is preserved byte-for-byte
 * - when the block already exists it is replaced in place
 * - otherwise the block is appended at the end
 *
 * Idempotent: merging the same section twice yields the same content.
 */
export function mergeAgentsMd(existing: string, section: string): string {
  const startIdx = existing.indexOf(WEAVE_BLOCK_START);
  const endIdx = existing.indexOf(WEAVE_BLOCK_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return existing.slice(0, startIdx) + section.trimEnd() + existing.slice(endIdx + WEAVE_BLOCK_END.length);
  }

  return existing.replace(/\s+$/, '') + '\n\n' + section.trimEnd() + '\n';
}
