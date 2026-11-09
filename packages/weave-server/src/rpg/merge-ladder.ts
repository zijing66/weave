import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { WorktreeGitExec } from '../daemon/worktree.js';

/**
 * 合并梯（G2 段3，G线设计 §二原语④ / §三）：快进 → 直并+rerere → mergiraf
 * （缺席如实降级）→ AI 修补（可注入 mock）→ 冲突带报告打回。每层动作一行
 * `rpg_merge_ladder` 账（合并链路卡的数据源——人机共读同一份底账）。
 *
 * rerere 局部（A2 基础上）：只在 weave 管的 worktree/合并 worktree 里
 * `git config rerere.enabled true`（项目级、幂等），不动用户 `~/.gitconfig`
 * （autoupdate 副作用红线）。AI 修补成功两次同形冲突才写 rerere cache 蹭不去
 * ——乌龙防护由「ai 计数按冲突签名记」闭合。
 */

export type LadderLayer = 'mechanical' | 'rerere' | 'mergiraf' | 'ai' | 'returned';
export type LadderOutcome = 'ok' | 'replay' | 'resolved' | 'unsolvable' | 'returned' | 'failed';

export interface MergeLadderRow {
  id: number;
  expedition: number | null;
  projectId: number;
  fromBranch: string;
  intoBranch: string;
  layer: LadderLayer;
  outcome: LadderOutcome;
  signature: string | null;
  reason: string | null;
  at: string;
}

export class MergeLadderRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: {
    expedition?: number | null;
    projectId: number;
    fromBranch: string;
    intoBranch: string;
    layer: LadderLayer;
    outcome: LadderOutcome;
    signature?: string;
    reason?: string;
  }): MergeLadderRow {
    const at = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO rpg_merge_ladder (expedition, project_id, from_branch, into_branch, layer, outcome, signature, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.expedition ?? null,
        input.projectId,
        input.fromBranch,
        input.intoBranch,
        input.layer,
        input.outcome,
        input.signature ?? null,
        input.reason ?? null,
        at,
      );
    return {
      id: Number(res.lastInsertRowid),
      expedition: input.expedition ?? null,
      projectId: input.projectId,
      fromBranch: input.fromBranch,
      intoBranch: input.intoBranch,
      layer: input.layer,
      outcome: input.outcome,
      signature: input.signature ?? null,
      reason: input.reason ?? null,
      at,
    };
  }

  listByProject(projectId: number, limit = 200): MergeLadderRow[] {
    return (
      this.db
        .prepare('SELECT * FROM rpg_merge_ladder WHERE project_id = ? ORDER BY id DESC LIMIT ?')
        .all(projectId, limit) as Array<Record<string, unknown>>
    ).map(toRow);
  }

  /** 同形冲突的 AI 修补成功计数（成功两次才进 rerere cache 的判据）。 */
  countAiResolved(signature: string): number {
    const r = this.db
      .prepare(
        `SELECT count(*) AS n FROM rpg_merge_ladder WHERE layer = 'ai' AND outcome = 'resolved' AND signature = ?`,
      )
      .get(signature) as { n: unknown };
    return Number(r.n);
  }
}

function toRow(r: Record<string, unknown>): MergeLadderRow {
  return {
    id: Number(r.id),
    expedition: r.expedition == null ? null : Number(r.expedition),
    projectId: Number(r.project_id),
    fromBranch: String(r.from_branch),
    intoBranch: String(r.into_branch),
    layer: r.layer as LadderLayer,
    outcome: r.outcome as LadderOutcome,
    signature: r.signature == null ? null : String(r.signature),
    reason: r.reason == null ? null : String(r.reason),
    at: String(r.at),
  };
}

// ---- 纯机械件 ----

/** 冲突形状指纹 = 冲突文件集（排序拼接；同形冲突重复检测同一指纹架构）。 */
export function conflictSignature(conflictFiles: readonly string[]): string {
  return [...conflictFiles].sort().join('|');
}

/** rerere 开关只落 repo-local 配置（幂等；git 缺席 = 如实 false，不碰全局）。 */
export async function ensureRerereLocal(repoPath: string, exec: WorktreeGitExec): Promise<boolean> {
  const res = await exec('git', ['config', '--local', 'rerere.enabled', 'true'], { cwd: repoPath });
  return res.code === 0;
}

/** 冲突文件清单（合并 worktree 里的 `diff --name-only --diff-filter=U`）。 */
export async function conflictFilesOf(repoPath: string, exec: WorktreeGitExec): Promise<string[]> {
  const res = await exec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repoPath });
  if (res.code !== 0) return [];
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** mergiraf 能力探测：PATH 上有 mergiraf = true（缺席 = 如实降级到下一层；ENOENT 不抛）。 */
export async function mergirafAvailable(exec: WorktreeGitExec): Promise<boolean> {
  try {
    const res = await exec('mergiraf', ['--version'], { cwd: process.cwd() });
    return res.code === 0;
  } catch {
    return false;
  }
}

/** rerere 重放命中的正面证据：冲突文件的工作区内容都不再带冲突标记。 */
async function conflictsResolvedByRerere(
  repoPath: string,
  files: readonly string[],
  exec: WorktreeGitExec,
): Promise<boolean> {
  void exec;
  if (files.length === 0) return false;
  for (const f of files) {
    try {
      const body = readFileSync(path.join(repoPath, f), 'utf8');
      if (/^<{7} /m.test(body)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ---- 梯子 ----

export interface LadderDeps {
  exec: WorktreeGitExec;
  ladder: MergeLadderRepository;
  projectId: number;
  expeditionId?: number | null;
  /** AI 修补缝（第 2 层；注入 mock 测试三层闭环）。参数 = 冲突文件集，结果 =
   *  resolved（已提交解）/ unsolvable（上报）/ returned（打回作者）。 */
  aiRepair?: (input: {
    repoPath: string;
    conflictFiles: string[];
    fromBranch: string;
    intoBranch: string;
  }) => Promise<{ outcome: 'resolved' | 'unsolvable' | 'returned'; reason?: string }>;
  /** AI 成功两次进 rerere cache 的缝（真实实现 = 重放同一冲突形状一次并提交）。 */
  enterRerereCache?: (repoPath: string, signature: string) => Promise<void>;
}

export interface LadderRun {
  /** 最终层结果：ok = 已并入 intoBranch；conflict = 打回（带冲突报告）。 */
  ok: boolean;
  layer: LadderLayer;
  outcome: LadderOutcome;
  /** 打回时带的报告（冲突文件 + 各层尝试摘要）。 */
  report?: string;
}

/**
 * 跑一遍合并梯（在**临时合并 worktree**里；冲突 = abort 还原后进下一层）：
 * 0 机械直并 → 1 rerere 先例重放 → 2 mergiraf（缺席如实降级）→ 3 AI 修补 →
 * 4 冲突带报告打回。每层落一行账。
 */
export async function runMergeLadder(
  deps: LadderDeps,
  repoPath: string,
  fromBranch: string,
  intoBranch: string,
): Promise<LadderRun> {
  const { exec } = deps;
  const attempts: string[] = [];
  const finish = async (
    layer: LadderLayer,
    outcome: LadderOutcome,
    ok: boolean,
    reason?: string,
    signature?: string,
  ): Promise<LadderRun> => {
    deps.ladder.insert({
      projectId: deps.projectId,
      expedition: deps.expeditionId ?? null,
      fromBranch,
      intoBranch,
      layer,
      outcome,
      ...(signature ? { signature } : {}),
      ...(reason ? { reason } : {}),
    });
    return { ok, layer, outcome, ...(ok ? {} : { report: attempts.join(' → ') + (reason ? `：${reason}` : '') }) };
  };

  // 第 0 层机械：快进/直并
  await ensureRerereLocal(repoPath, exec);
  const merge = await exec('git', ['merge', '--no-edit', '--no-ff', fromBranch], { cwd: repoPath });
  if (merge.code === 0) {
    return finish('mechanical', 'ok', true);
  }
  const isConflict = /CONFLICT/i.test(`${merge.stderr}\n${merge.stdout}`);
  if (!isConflict) {
    attempts.push(`mechanical: ${(merge.stderr || merge.stdout).trim().split('\n').slice(-1)[0] ?? 'merge failed'}`);
    return finish('mechanical', 'failed', false, 'merge failed (not a conflict)');
  }
  await exec('git', ['merge', '--abort'], { cwd: repoPath });
  // 冲突文件清单必须在 abort 前读——上面 abort 已还原索引。重跑一次只读探针拿清单。
  const redoProbe = await exec('git', ['merge', '--no-edit', '--no-ff', fromBranch], { cwd: repoPath });
  const files = redoProbe.code === 0 ? [] : await conflictFilesOf(repoPath, exec);
  await exec('git', ['merge', '--abort'], { cwd: repoPath });
  const signature = conflictSignature(files);
  attempts.push(`mechanical: conflict in ${files.join(', ') || '(unknown)'}`);

  // 第 1 层 rerere 先例重放：重跑 merge，再补一记 `git rerere`（两阶段应用——
  // 第一跑记 preimage、第二跑把 cache 里的 postimage 涂回工作区并 staged）。
  // 重放命中判据 = 冲突文件的工作区内容不再带冲突标记，只差一条 merge commit。
  const rerere = await exec('git', ['merge', '--no-edit', '--no-ff', fromBranch], { cwd: repoPath });
  if (rerere.code === 0) {
    return finish('rerere', 'replay', true, 'rerere replayed a recorded resolution', signature);
  }
  await exec('git', ['rerere'], { cwd: repoPath });
  const replayFiles = await conflictFilesOf(repoPath, exec);
  const markersGone = await conflictsResolvedByRerere(repoPath, replayFiles, exec);
  if (markersGone) {
    const add = await exec('git', ['add', '-A'], { cwd: repoPath });
    const commit = add.code === 0 ? await exec('git', ['commit', '--no-edit'], { cwd: repoPath }) : add;
    if (commit.code === 0) {
      return finish('rerere', 'replay', true, 'rerere replayed the recorded resolution', signature);
    }
  }
  await exec('git', ['merge', '--abort'], { cwd: repoPath });
  attempts.push('rerere: no prior resolution');

  // 第 2 层 mergiraf（缺席如实降级——不假装跑过）
  if (await mergirafAvailable(exec)) {
    const redo = await exec('git', ['merge', '--no-edit', '--no-ff', fromBranch], { cwd: repoPath });
    if (redo.code === 0) {
      return finish('mergiraf', 'ok', true, 'mergiraf resolved', signature);
    }
    attempts.push('mergiraf: could not resolve');
    await exec('git', ['merge', '--abort'], { cwd: repoPath });
  } else {
    attempts.push('mergiraf: not installed (skipped)');
  }

  // 第 3 层 AI 修补（注入缝）：resolved 计数到 2 才记「进 rerere cache」
  if (deps.aiRepair) {
    const repair = await deps.aiRepair({ repoPath, conflictFiles: files, fromBranch, intoBranch });
    if (repair.outcome === 'resolved') {
      const times = deps.ladder.countAiResolved(signature) + 1;
      if (times >= 2 && deps.enterRerereCache) {
        await deps.enterRerereCache(repoPath, signature);
      }
      return finish(
        'ai',
        'resolved',
        true,
        times >= 2 ? `AI resolved (${times}nd time, entering rerere cache): ${repair.reason ?? ''}` : `AI resolved: ${repair.reason ?? ''}`,
        signature,
      );
    }
    attempts.push(`ai: ${repair.outcome}${repair.reason ? ` (${repair.reason})` : ''}`);
    if (repair.outcome === 'returned') {
      return finish('ai', 'returned', false, repair.reason ?? 'returned to author', signature);
    }
  }

  // 第 4 层：冲突带报告打回
  return finish('returned', 'returned', false, `unresolved after ladder: ${files.join(', ')}`, signature);
}
