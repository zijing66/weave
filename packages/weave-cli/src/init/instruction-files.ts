import path from 'node:path';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { HARNESS_LOCAL_INSTRUCTION_FILES, INSTRUCTION_FILES } from '@weavecode/core';
import {
  generateClaudeMd,
  generateClaudeMdSection,
  mergeClaudeMd,
  type ClaudeMdTemplate,
} from './claudemd-gen.js';
import { t } from '../i18n/index.js';

/**
 * Step 8 的落盘策略（local-first，细节见 executor.ts Step 8 注释）：
 *
 * - claude：托管块恒写 `CLAUDE.local.md`（宿主追加语义，与 CLAUDE.md 叠加，
 *   项目共享文件零污染）。
 * - codex：根目录已有 AGENTS.md（真文件或 symlink）→ 块并入它（用户已接受
 *   这点污染；同目录 override 会压掉 AGENTS.md，见 codex-rs agents_md.rs）；
 *   没有 → 写 `AGENTS.override.md`（本机文件，走 exclude）。
 *
 * 两条路径都幂等：块已在则原位替换，不在则尾部追加，块外内容逐字节保留。
 */

const AGENTS = INSTRUCTION_FILES[1];

export interface InstructionFilesInput {
  claude: boolean;
  codex: boolean;
  template: ClaudeMdTemplate;
  projectName: string;
}

export interface InstructionFilesResult {
  created: string[];
  merged: string[];
  /** i18n 已渲染的提示行（fresh local / 并入共享文件）。 */
  notes: string[];
}

async function mergeInto(file: string, input: InstructionFilesInput): Promise<'created' | 'merged'> {
  const section = generateClaudeMdSection(input);
  const existing = await readFile(file, 'utf-8').catch(() => null);
  if (existing === null) {
    await writeFile(file, generateClaudeMd(input), 'utf-8');
    return 'created';
  }
  await writeFile(file, mergeClaudeMd(existing, section), 'utf-8');
  return 'merged';
}

export async function writeInstructionFiles(
  dir: string,
  input: InstructionFilesInput,
): Promise<InstructionFilesResult> {
  const created: string[] = [];
  const merged: string[] = [];
  const notes: string[] = [];

  if (input.claude) {
    const file = path.join(dir, HARNESS_LOCAL_INSTRUCTION_FILES.claude.file);
    const outcome = await mergeInto(file, input);
    (outcome === 'created' ? created : merged).push(file);
    if (outcome === 'created') {
      notes.push(t('init.instruction.localCreated', { file: HARNESS_LOCAL_INSTRUCTION_FILES.claude.file }));
    }
  }

  if (input.codex) {
    const agentsPath = path.join(dir, AGENTS);
    const overridePath = path.join(dir, HARNESS_LOCAL_INSTRUCTION_FILES.codex.file);
    const st = await lstat(agentsPath).catch(() => null);
    const shareWithAgents = st !== null && (st.isFile() || st.isSymbolicLink());
    const file = shareWithAgents ? agentsPath : overridePath;
    const outcome = await mergeInto(file, input);
    (outcome === 'created' ? created : merged).push(file);
    if (shareWithAgents) {
      notes.push(t('init.instruction.agentsMerged', { file: AGENTS }));
    } else if (outcome === 'created') {
      notes.push(t('init.instruction.localCreated', { file: HARNESS_LOCAL_INSTRUCTION_FILES.codex.file }));
    }
  }

  return { created, merged, notes };
}
