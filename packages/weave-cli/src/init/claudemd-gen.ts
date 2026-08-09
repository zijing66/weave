export type ClaudeMdTemplate = 'minimal' | 'standard' | 'full';

export interface ClaudeMdGeneratorInput {
  template: ClaudeMdTemplate;
  projectName: string;
}

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

export function generateClaudeMd(input: ClaudeMdGeneratorInput): string {
  const { template, projectName } = input;

  let content = header(projectName);
  content += behavioralRules();

  if (template === 'standard' || template === 'full') {
    content += fileRules();
  }

  if (template === 'full') {
    content += securityRules();
  }

  content += gettingStarted();
  return content;
}
