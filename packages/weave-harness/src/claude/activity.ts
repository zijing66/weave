import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ActivityAgentRow,
  ActivitySurface,
  ActivityTaskRow,
  NarrationText,
} from '../driver.js';
import { readNewLines, readTail, transcriptSize, type LineCursor } from './transcript-cursor.js';
import { assistantTextOf } from './narration.js';

/**
 * 会话活动（claude）：三类运行态的文件面事实——
 * - 子 agent：转录目录旁的 `subagents/agent-<id>.jsonl` + `.meta.json`（宿主在
 *   spawn 时落，SubagentStop 的 raw.agent_transcript_path 也直接给绝对路径）。
 *   文件在 = 曾活过；running/completed 的分野归 server 的事件账（SubagentStop）。
 * - 任务清单：`~/.claude/tasks/<会话id>/<N>.json`。**易失**——任务收尾后宿主会
 *   清目录（2026-11-04 实测 4994bf90 整目录空），读不到时 server 从事件账兜底。
 * - 后台 shell：输出文件在 `<tmp>/claude/<cwdSlug>/<raw会话id>/tasks/<taskId>.output`。
 *   路径**只从盘上扫**——resume 后会话 id 会换（实测 84ac7ff3 的输出落在 6e3e6094
 *   目录下），由 id 拼路径必错；扫描目录本身就是白名单。
 */

const AGENT_FILE = /^agent-([A-Za-z0-9-]+)\.jsonl$/;
const TASK_FILE = /^\d+\.json$/;

/** 会话 cwd → 宿主 tmp 目录名（`D:\GitRepo\AIRepo\weave` → `D--GitRepo-AIRepo-weave`）。 */
function cwdSlugOf(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9.-]+/g, '-');
}

interface AgentMeta {
  agentType?: unknown;
  description?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** 首行 timestamp = 子 agent 出生时刻（转录 append-only，第一行最早）。 */
function firstTimestampOf(path: string): string | null {
  try {
    const head = readFileSync(path, 'utf8');
    const nl = head.indexOf('\n');
    const line = nl >= 0 ? head.slice(0, nl) : head;
    const entry = JSON.parse(line) as Record<string, unknown>;
    return str(entry.timestamp);
  } catch {
    return null;
  }
}

function tasksDirOf(sessionId: string): string | null {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (!home) return null;
  return join(home, '.claude', 'tasks', sessionId);
}

function readTasks(tasksDir: string): ActivityTaskRow[] | null {
  let names: string[];
  try {
    names = readdirSync(tasksDir);
  } catch {
    return null; // 目录不存在 = 没有任务清单痕迹（与空目录同义：宿主清过）
  }
  const rows: ActivityTaskRow[] = [];
  for (const name of names) {
    if (!TASK_FILE.test(name)) continue;
    try {
      const j = JSON.parse(readFileSync(join(tasksDir, name), 'utf8')) as Record<string, unknown>;
      const subject = str(j.subject);
      if (!subject) continue;
      rows.push({
        id: String(j.id ?? name.replace(/\.json$/, '')),
        subject,
        ...(str(j.activeForm) ? { activeForm: str(j.activeForm)! } : {}),
        status: str(j.status) ?? 'pending',
        blocks: Array.isArray(j.blocks) ? j.blocks.map(String) : [],
        blockedBy: Array.isArray(j.blockedBy) ? j.blockedBy.map(String) : [],
      });
    } catch {
      // 半行/坏文件跳过
    }
  }
  return rows;
}

export const CLAUDE_ACTIVITY: ActivitySurface = {
  async sessionActivity({ sessionId, transcriptPath }) {
    const agents: ActivityAgentRow[] = [];
    const dir = this.subagentsDirOf(transcriptPath);
    if (dir) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        names = [];
      }
      for (const name of names) {
        const m = AGENT_FILE.exec(name);
        if (!m) continue;
        const agentId = m[1]!;
        const file = join(dir, name);
        let agentType: string | undefined;
        let description: string | undefined;
        try {
          const meta = JSON.parse(
            readFileSync(join(dir, `agent-${agentId}.meta.json`), 'utf8'),
          ) as AgentMeta;
          agentType = str(meta.agentType) ?? undefined;
          description = str(meta.description) ?? undefined;
        } catch {
          // meta 缺失/半行：只给 id（退化行仍要出现——账上它存在过）
        }
        agents.push({
          agentId,
          ...(agentType ? { agentType } : {}),
          ...(description ? { description } : {}),
          status: 'running', // 终态由 server 的事件账翻转（SubagentStop）
          transcriptPath: file,
          startedAt: firstTimestampOf(file),
        });
      }
    }
    const tasksDir = tasksDirOf(sessionId);
    const rows = tasksDir ? readTasks(tasksDir) : null;
    return {
      agents,
      ...(rows && rows.length > 0 ? { tasks: { rows, source: 'file' as const } } : { tasks: null }),
    };
  },

  async agentTranscript({ transcriptPath, offset }) {
    const size = transcriptSize(transcriptPath);
    if (size === null) return null;
    const cur: LineCursor = { offset: offset ?? 0 };
    const lines = readNewLines(transcriptPath, cur, size);
    if (lines === null) return null;
    const segs: NarrationText[] = [];
    for (const line of lines) {
      // 预筛同主转录旁白：assistant 条目行才值得 parse。子 agent 转录里
      // isSidechain 恒真——不过滤（那是主链旁白的语义，见 narration.ts）。
      if (!line.includes('"type":"assistant"')) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type !== 'assistant') continue;
      const seg = assistantTextOf(entry);
      if (seg) segs.push(seg);
    }
    return { segs, nextOffset: cur.offset >= size ? null : cur.offset };
  },

  async shellOutput({ taskId, cwd, sessionId, bytes }) {
    if (!cwd) return null;
    const dir = resolve(
      tmpdir(),
      'claude',
      cwdSlugOf(cwd),
      sessionId,
      'tasks',
    );
    const file = join(dir, `${taskId}.output`);
    // 白名单：命中文件必须就是扫描目录里那个（防 taskId 带 .. 之类逃逸）
    if (resolve(file) !== file || !file.startsWith(dir + (dir.endsWith('\\') || dir.endsWith('/') ? '' : '\\'))) {
      return null;
    }
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return null;
    }
    const cap = bytes ?? 32 * 1024;
    const text = readTail(file, cap);
    if (text === null) return null;
    return { text, truncated: size > cap };
  },

  subagentsDirOf(transcriptPath) {
    if (!transcriptPath) return null;
    return join(transcriptPath, '..', 'subagents');
  },
};
